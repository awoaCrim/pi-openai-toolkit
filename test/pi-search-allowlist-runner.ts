import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSmokeEnvironment } from "./pi-smoke-environment";

const env = await createSmokeEnvironment(process.env.PI_TOOLKIT_SMOKE_ROOT);
try {
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, parseArgs } = await import("@earendil-works/pi-coding-agent");
	const { InMemoryCredentialStore, InMemoryModelsStore } = await import("@earendil-works/pi-ai");
	const args = parseArgs(process.argv.slice(2));
	const configDir = join(env.agentDir, "extensions/pi-openai-toolkit");
	await mkdir(configDir, { recursive: true });
	await writeFile(join(configDir, "config.json"), JSON.stringify({ webSearch: { defaultRoute: "standalone-alpha" } }));
	await writeFile(join(env.cwd, "fixture.txt"), "LOCAL-TOOL-OK");
	const { CONFIG_PATH, loadToolkitConfig } = await import("../src/config");
	const { registerWebSearchExtension } = await import("../src/web-search/extension");
	assert.equal(CONFIG_PATH, join(configDir, "config.json"), "Smoke config must be isolated");
	assert.equal(loadToolkitConfig().config.webSearch.defaultRoute, "standalone-alpha");
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null,
		refreshOnCreate: false, allowModelNetwork: false,
	});
	modelRuntime.registerProvider("openai", {
		api: "openai-responses", apiKey: "synthetic-key", baseUrl: "https://toolkit-search-smoke.invalid/v1",
		models: [{ id: "gpt-6-astra", name: "Search smoke", reasoning: true, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 512 }],
	});
	const model = modelRuntime.getModel("openai", "gpt-6-astra");
	assert(model);
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }, { projectTrusted: true });
	const resourceLoader = new DefaultResourceLoader({
		cwd: env.cwd, agentDir: env.agentDir, settingsManager,
		// This SDK fixture explicitly uses Pi-parsed flags as its session policy.
		extensionFactories: [(pi) => registerWebSearchExtension(pi, loadToolkitConfig, undefined, undefined, process.argv.slice(2))],
		noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
		systemPrompt: "Read fixture.txt and finish.",
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const { session } = await createAgentSession({
		cwd: env.cwd, agentDir: env.agentDir, modelRuntime, settingsManager, resourceLoader,
		sessionManager: SessionManager.inMemory(env.cwd), model, tools: args.tools, excludeTools: args.excludeTools,
	});
	const searchAllowed = args.tools?.includes("web_run") === true && !args.excludeTools?.includes("web_run");
	let requests = 0;
	let requestTools: unknown;
	const deniedFetch = globalThis.fetch;
	globalThis.fetch = (async (input, init) => {
		const request = new Request(input, init);
		if (request.url !== "https://toolkit-search-smoke.invalid/v1/responses") return deniedFetch(input, init);
		const body = await request.json() as { tools: Array<{ name?: string; type: string }>; input: unknown[] };
		requests++;
		requestTools = body.tools;
		assert(requests <= 2);
		assert.equal(body.tools.some((tool) => tool.name === "web_run"), searchAllowed);
		assert(!body.tools.some((tool) => tool.type === "web_search" || tool.name === "web_search"));
		assert(body.tools.some((tool) => tool.name === "read"), JSON.stringify(body.tools));
		if (requests === 2) assert(JSON.stringify(body.input).includes("LOCAL-TOOL-OK"));
		const output = requests === 1
			? [{ type: "function_call", id: "fc_read", call_id: "call_read", name: "read", arguments: JSON.stringify({ path: "fixture.txt" }) }]
			: [{ type: "message", id: "msg_done", role: "assistant", status: "completed", content: [{ type: "output_text", text: "DONE", annotations: [] }] }];
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
	try {
		await session.prompt("Read fixture.txt and finish.");
		assert.equal(requests, 2, JSON.stringify({ last: session.messages.at(-1), requestTools }));
		assert.equal(session.getAllTools().some((tool) => tool.name === "web_run"), searchAllowed);
		const result = session.messages.find((message) => message.role === "toolResult");
		assert(result?.role === "toolResult" && !result.isError && result.toolName === "read");
		const last = session.messages.at(-1);
		assert(last?.role === "assistant" && last.stopReason === "stop");
		assert.equal(last.content.filter((block) => block.type === "text").map((block) => block.text).join(""), "DONE");
		env.assertNoNetwork();
	} finally {
		session.dispose();
	}
	process.stdout.write("OK\n");
} finally {
	await env.dispose();
}
