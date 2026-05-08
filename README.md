# What this project does

A Cloudflare Worker routes incoming requests to one of two rendering paths:

| Endpoint | Renderer |
|---|---|
| `/container` | Cloudflare Container running Node.js + `node:vm` |
| `/dynamic-worker` | Cloudflare Dynamic Worker (V8 isolate) |

Both endpoints fetch a pre-built React bundle from R2 and return a server-rendered HTML page. The interesting part is _how_ they do it — and why they differ.

---

## Architecture

```
Browser
  │
  ▼
Cloudflare Worker (src/index.ts)
  │
  ├── /container ──────────────────────────────────────────────────────────────┐
  │       │                                                                     │
  │       ▼                                                                     │
  │   MyContainer (Durable Object + Container)                                 │
  │       │                                                                     │
  │       │  fetch("http://my.r2/server-bundle.js")                            │
  │       │       │                                                             │
  │       │       ▼  outboundByHost handler (back in Worker runtime)           │
  │       │   env.MY_BUCKET.get("server-bundle.js")  ←── R2                   │
  │       │                                                                     │
  │       ▼                                                                     │
  │   node:vm  →  renderToString(<App />)  →  HTML string  →  Response        │
  │                                                                             │
  └── /dynamic-worker ─────────────────────────────────────────────────────────┘
          │
          ▼
      env.LOADER.get("react-ssr-v1", callback)
          │
          │  callback fires on cold start only:
          │  env.MY_BUCKET.get("server-worker-bundle.js")  ←── R2
          │
          ▼
      Dynamic Worker isolate (V8)
          │
          ▼
      renderToReadableStream(<App />)  →  ReadableStream  →  Response
```

---

## Project structure

```
sam-cooke/
├── src/
│   └── index.ts              # Cloudflare Worker — routing, Container class,
│                             # R2 outbound handler, Dynamic Worker loader
├── container/
│   ├── server.js             # Node.js HTTP server running inside the Container
│   └── package.json          # Container-only deps (none currently)
├── react-code/
│   ├── App.jsx               # Original client-side React app (not used by either path)
│   ├── server-entry.jsx      # React entry point for the Container / node:vm path
│   ├── server-bundle.js      # Built from server-entry.jsx — CJS, stored in R2
│   ├── server-worker-entry.jsx   # React entry point for the Dynamic Worker path
│   └── server-worker-bundle.js  # Built from server-worker-entry.jsx — ESM, stored in R2
├── Dockerfile                # Container image — node:22-alpine
├── hello.txt                 # Original R2 test file
└── wrangler.jsonc            # Wrangler config — bindings for Container, R2, Dynamic Worker
```

---

## The two React entry points

### `server-entry.jsx` — for the Container + `node:vm` path

```jsx
module.exports = renderToString(<App />);
```

**Format:** CommonJS (`module.exports`)  
**Built with:** `esbuild --platform=node --format=cjs`  
**React API:** `renderToString` from `react-dom/server`

The Container runs Node.js, so the bundle is evaluated using `node:vm`'s `runInContext`. The CJS format is required because `node:vm` expects `module` and `exports` to be present in the sandbox — it models the CommonJS module evaluation context. The bundle executes as a side effect at load time, and the rendered HTML string is returned via `module.exports`.

`renderToString` is the right choice here: it's synchronous, returns a plain string, and Node has had native support for it since React 16. The result is embedded in an HTML shell template before being sent as the HTTP response.

**Caching:** The bundle is fetched from R2 once and stored in a module-level variable (`cachedBundle`). `node:vm` creates a fresh context per request (required because `__INITIAL_DATA__` differs per request), but the R2 round trip is avoided after the first call.

---

### `server-worker-entry.jsx` — for the Dynamic Worker path

```jsx
export default {
  async fetch(request) {
    const stream = await renderToReadableStream(<html>...</html>);
    return new Response(stream, { headers: { "Content-Type": "text/html" } });
  },
};
```

**Format:** ES Module (`export default`)  
**Built with:** `esbuild --platform=browser --format=esm`  
**React API:** `renderToReadableStream` from `react-dom/server`

The Dynamic Worker runtime is a V8 isolate — the same environment as any other Cloudflare Worker. It expects an ES module with an exported `fetch` handler, not a CJS module that executes at load time.

Two deliberate differences from the container version:

**1. `renderToReadableStream` instead of `renderToString`**

The Workers runtime is built around the Web Streams API. `renderToReadableStream` returns a `ReadableStream`, which `Response` accepts directly as its body — no intermediate string, no buffering, no Node stream adapters. The browser begins receiving HTML before the full render is complete.

`renderToString` would also work here with `nodejs_compat` enabled, but it buffers the entire output into memory before sending anything. For a small component the difference is negligible; for a large page it matters.

**2. The full HTML document is expressed as JSX**

With `renderToString`, the HTML string has to be manually wrapped in a `<!DOCTYPE html>...<body>...</body>` template string. With `renderToReadableStream` rendering the full document tree, React owns the entire output — the `<html>`, `<head>`, and `<body>` are all rendered components. This removes the string concatenation shell and keeps all markup in one place.

**Caching:** `env.LOADER.get("react-ssr-v1", callback)` handles caching at the isolate level. The callback (which fetches the bundle from R2) only fires when no warm isolate exists for that ID. Once loaded, the isolate stays resident and subsequent requests skip the R2 fetch entirely — no manual caching variable needed.

---

## How R2 access works from the Container

Containers cannot access Cloudflare bindings (R2, KV, D1, etc.) directly — they're Linux processes with no awareness of the Workers runtime. The bridge is **outbound handlers**.

When the container calls `fetch("http://my.r2/server-bundle.js")`, the Worker's `outboundByHost` intercepts the request before it hits the network:

```ts
MyContainer.outboundByHost = {
  "my.r2": async (request, env) => {
    const key = new URL(request.url).pathname.slice(1);
    const object = await env.MY_BUCKET.get(key);
    return new Response(object.body);
  },
};
```

The handler runs inside the Worker runtime (where `env.MY_BUCKET` is available), not inside the container. The container makes a plain HTTP call; the Worker resolves it using R2. No SDK, no credentials, no special client library needed inside the container.

The Dynamic Worker path doesn't need this mechanism — it runs inside the Worker runtime directly, so `env.MY_BUCKET` is available as a normal binding.

---

## Comparison

| | Container + `node:vm` | Dynamic Worker |
|---|---|---|
| **Runtime** | Node.js 22 in Docker (Alpine) | V8 isolate (Workers runtime) |
| **Bundle format** | CommonJS (`module.exports`) | ES Module (`export default { fetch }`) |
| **React API** | `renderToString` | `renderToReadableStream` |
| **Output** | Buffered string | Native `ReadableStream` |
| **R2 access** | Via outbound handler (HTTP intercept) | Direct binding (`env.MY_BUCKET`) |
| **Cold start** | Seconds (container boot) | Milliseconds |
| **Bundle caching** | Manual module-level variable | Built-in isolate caching (`get(id)`) |
| **Infrastructure** | Docker image, Durable Object, Container | Worker Loader binding only |
| **`node:vm` sandbox** | Yes — manual global shimming required | No — native isolate |

---

## Running locally

Docker must be running (Docker Desktop or Colima).

```bash
# Install dependencies
npm install

# Seed R2 with the React bundles
npx wrangler r2 object put sam-cooke-bucket/server-bundle.js \
  --file ./react-code/server-bundle.js --local

npx wrangler r2 object put sam-cooke-bucket/server-worker-bundle.js \
  --file ./react-code/server-worker-bundle.js --local

# Start local dev server
npx wrangler dev
```

Then visit:
- `http://localhost:8787/container` — Container + node:vm render
- `http://localhost:8787/dynamic-worker` — Dynamic Worker render

Press `r` in the terminal to rebuild the container image after changes to `container/server.js`.

### Rebuilding the React bundles

```bash
cd react-code

# Container bundle (CJS)
npx esbuild server-entry.jsx --bundle --platform=node --format=cjs \
  --outfile=server-bundle.js

# Dynamic Worker bundle (ESM)
npx esbuild server-worker-entry.jsx --bundle --platform=browser --format=esm \
  --outfile=server-worker-bundle.js
```

After rebuilding, re-seed R2 and restart `wrangler dev`.

---

## Deploying to Cloudflare

```bash
# Create the R2 bucket (first time only)
npx wrangler r2 bucket create sam-cooke-bucket

# Upload the React bundles
npx wrangler r2 object put sam-cooke-bucket/server-bundle.js \
  --file ./react-code/server-bundle.js

npx wrangler r2 object put sam-cooke-bucket/server-worker-bundle.js \
  --file ./react-code/server-worker-bundle.js

# Deploy
npx wrangler deploy
```
