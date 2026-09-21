import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_TOOLKIT_CONFIG, DEFAULT_WEB_SEARCH_CONFIG } from "../src/types";
import { registerWebSearchExtension } from "../src/web-search/extension";

/** Loaded by the actual Pi CLI, including the unbundled entry Trellis uses. */
export default function searchCliFixture(pi: ExtensionAPI) {
	const root = process.env.PI_TOOLKIT_SMOKE_ROOT;
	assert(root, "CLI smoke requires a prepared isolated root");
	const fixture = join(root, "fixture.txt");
	writeFileSync(fixture, "LOCAL-CLI-TOOL-OK");
	registerWebSearchExtension(pi, () => ({
		config: { ...DEFAULT_TOOLKIT_CONFIG, webSearch: { ...DEFAULT_WEB_SEARCH_CONFIG, defaultRoute: "standalone-alpha" } },
		warnings: [],
	}));
	pi.registerProvider("toolkit-smoke", {
		api: "openai-responses", apiKey: "synthetic-key", baseUrl: "https://toolkit-cli-smoke.invalid/v1",
		models: [{ id: "local", name: "Local CLI smoke", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 512 }],
	});
	let requests = 0;
	const previousFetch = globalThis.fetch;
	pi.on("session_start", () => {
		assert.deepEqual(pi.getActiveTools(), ["read"]);
		assert(!pi.getAllTools().some((tool) => tool.name === "web_run"));
		globalThis.fetch = (async (input, init) => {
			const request = new Request(input, init);
			assert.equal(request.url, "https://toolkit-cli-smoke.invalid/v1/responses");
			const body = await request.json() as { tools: Array<{ name: string }>; input: unknown[] };
			assert.deepEqual(body.tools.map((tool) => tool.name), ["read"]);
			requests++;
			assert(requests <= 2);
			if (requests === 2) assert(JSON.stringify(body.input).includes("LOCAL-CLI-TOOL-OK"));
			const output = requests === 1
				? [{ type: "function_call", id: "fc_read", call_id: "call_read", name: "read", arguments: JSON.stringify({ path: fixture }) }]
				: [{ type: "message", id: "msg_done", role: "assistant", status: "completed", content: [{ type: "output_text", text: "CLI-DONE", annotations: [] }] }];
			const id = `resp_${requests}`;
			const events = [
				{ type: "response.created", response: { id, status: "in_progress", output: [] } },
				...output.flatMap((item, output_index) => [
					{ type: "response.output_item.added", output_index, item },
					{ type: "response.output_item.done", output_index, item },
				]),
				{ type: "response.completed", response: { id, status: "completed", created_at: 1800000000, output,
					usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } },
			];
			return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
				{ headers: { "content-type": "text/event-stream" } });
		}) as typeof fetch;
	});
	pi.on("session_shutdown", () => { globalThis.fetch = previousFetch; });
}
