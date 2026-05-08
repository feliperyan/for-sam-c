import { Container, ContainerProxy, getContainer } from "@cloudflare/containers";

// ContainerProxy must be exported for outbound interception to work.
export { ContainerProxy };

export class MyContainer extends Container {
	defaultPort = 8080;
	sleepAfter = "10m";
}

// The container calls http://my.r2/<key> and this handler intercepts it,
// reads the object from R2 (which the container cannot access directly),
// and returns the content back to the container.
MyContainer.outboundByHost = {
	"my.r2": async (request: Request, env: Env) => {
		const key = new URL(request.url).pathname.slice(1); // strip leading /
		const object = await env.MY_BUCKET.get(key);
		if (!object) {
			return new Response(`R2 object "${key}" not found`, { status: 404 });
		}
		return new Response(object.body);
	},
};

async function handleDynamicWorker(request: Request, env: Env): Promise<Response> {
	// Use get() with a stable ID so the isolate stays warm across requests.
	// The callback only fires when the isolate isn't cached — that's when we fetch from R2.
	const worker = env.LOADER.get("react-ssr-v1", async () => {
		const object = await env.MY_BUCKET.get("server-worker-bundle.js");
		if (!object) {
			throw new Error("server-worker-bundle.js not found in R2");
		}
		const code = await object.text();

		return {
			compatibilityDate: "2026-05-07",
			compatibilityFlags: ["nodejs_compat"],
			mainModule: "src/index.js",
			modules: {
				"src/index.js": code,
			},
		};
	});

	return worker.getEntrypoint().fetch(request);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/dynamic-worker") {
			return handleDynamicWorker(request, env);
		}
		if (url.pathname === "/container") {
			return getContainer(env.MY_CONTAINER).fetch(request);
		}

		// All other requests return instructions
		return new Response("Visit either /dynamic-worker or /container", { status: 200 });
		
	},
} satisfies ExportedHandler<Env>;
