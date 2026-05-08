import http from "node:http";
import os from "node:os";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const PORT = 8080;

// Cache the bundle after first fetch — it doesn't change between requests.
let cachedBundle = null;

async function fetchBundle() {
  if (cachedBundle) return cachedBundle;

  const r2Res = await fetch("http://my.r2/server-bundle.js");
  if (!r2Res.ok) {
    throw new Error(`R2 fetch failed: ${r2Res.status} ${r2Res.statusText}`);
  }
  cachedBundle = await r2Res.text();
  return cachedBundle;
}

function renderReact(bundleCode, data) {
  const sandbox = {
    __INITIAL_DATA__: data,
    module: { exports: {} },
    exports: {},
    require,
    process,
    console,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    URL,
    TextEncoder,
    TextDecoder,
  };
  vm.createContext(sandbox);
  vm.runInContext(bundleCode, sandbox, { filename: "server-bundle.js" });
  return sandbox.module.exports;
}

const server = http.createServer(async (req, res) => {
  let html = null;
  let renderError = null;

  try {
    const bundleCode = await fetchBundle();
    html = renderReact(bundleCode, { user: "Sam Cooke" });
  } catch (err) {
    renderError = err.message;
  }

  if (renderError) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: renderError }, null, 2));
    return;
  }

  // Wrap the rendered HTML string in a full page shell.
  const page = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>React in a Box</title>
  </head>
  <body>
    <div id="root">${html}</div>
    <!-- Rendered server-side by NodeVM inside a Cloudflare Container -->
    <!-- Container: ${process.env.CLOUDFLARE_DURABLE_OBJECT_ID ?? "local"} @ ${process.env.CLOUDFLARE_LOCATION ?? os.hostname()} -->
  </body>
</html>`;

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(page);
});

server.listen(PORT, () => {
  console.log(`Container server listening on port ${PORT}`);
});
