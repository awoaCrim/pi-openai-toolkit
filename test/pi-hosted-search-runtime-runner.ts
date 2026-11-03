import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createSmokeEnvironment } from "./pi-smoke-environment";

const packageDir = resolve(import.meta.dirname, "..");
const runtimeDir = resolve(process.argv[2]!);
const expectedVersion = process.argv[3]!;
assert(["0.87.0", "0.99.0"].includes(expectedVersion));
const supported = expectedVersion === "0.99.0";
const env = await createSmokeEnvironment();
let session: any;
try {
	const sdk = await import(pathToFileURL(join(runtimeDir, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href);
	const ai = await import(pathToFileURL(join(runtimeDir, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
	assert.equal(sdk.VERSION, expectedVersion, "Compatibility probe must use the requested published runtime");
	const extension = join(env.cwd, "hosted-history.ts");
	await writeFile(extension, `
		import { registerHostedSearchHistory } from ${JSON.stringify(join(packageDir, "src/web-search/history-extension.ts"))};
		export default function(pi) {
			pi.on("provider_stream_event", e => pi.appendEntry("compat:raw-event", { type: e.data?.type }));
			pi.on("before_provider_request", event => ({ ...event.payload, tools: [{ type: "web_search" }] }));
			registerHostedSearchHistory(pi);
		}
	`);
	const settings = sdk.SettingsManager.inMemory({
		transport: "sse", retry: { enabled: false, provider: { maxRetries: 0 } },
		compaction: { enabled: false },
	}, { projectTrusted: true });
	const runtime = await sdk.ModelRuntime.create({
		credentials: new ai.InMemoryCredentialStore(), modelsStore: new ai.InMemoryModelsStore(),
		modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
	});
	const baseUrl = "https://hosted-history-compat.invalid/v1";
	runtime.registerProvider("history-compat", { api: "openai-responses", apiKey: "synthetic-key", baseUrl,
		models: [{ id: "gpt-5.5", name: "Compatibility fixture", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 256 }] });
	const resourceLoader = new sdk.DefaultResourceLoader({
		cwd: env.cwd, agentDir: env.agentDir, settingsManager: settings,
		additionalExtensionPaths: [extension], noSkills: true, noPromptTemplates: true,
		noContextFiles: true, noThemes: true, systemPromptOverride: () => "Offline compatibility fixture.",
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	({ session } = await sdk.createAgentSession({
		cwd: env.cwd, agentDir: env.agentDir, settingsManager: settings, resourceLoader,
		modelRuntime: runtime, model: runtime.getModel("history-compat", "gpt-5.5"),
		sessionManager: sdk.SessionManager.inMemory(env.cwd), noTools: "all",
	}));
	const call = { type: "web_search_call", id: "ws_compat", status: "completed",
		action: { type: "search", query: "offline fixture" } };
	const answer = { type: "message", id: "msg_compat", role: "assistant", status: "completed",
		content: [{ type: "output_text", text: "Fixture answer", annotations: [] }] };
	let requests = 0;
	let failure: unknown;
	const deniedFetch = globalThis.fetch;
	globalThis.fetch = (async (input, init) => {
		try {
			const request = new Request(input, init);
			if (request.url !== baseUrl + "/responses" || request.method !== "POST") return deniedFetch(input, init);
			const body = JSON.parse(await request.text());
			requests++;
			if (requests === 2) assert.equal(
				body.input.some((item: any) => item.type === "web_search_call"), supported);
			const output = requests === 1 ? [call, answer] : [{ ...answer, id: "msg_next" }];
			const response = { id: requests === 1 ? "resp_compat" : "resp_next", status: "completed", output,
				usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } };
			const events = [
				{ type: "response.created", response: { id: response.id, status: "in_progress", output: [] } },
				...output.flatMap((item, output_index) => [
					{ type: "response.output_item.added", output_index, item },
					{ type: "response.output_item.done", output_index, item }]),
				{ type: "response.completed", response },
			];
			return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
				{ headers: { "content-type": "text/event-stream" } });
		} catch (error) { failure = error; throw error; }
	}) as typeof fetch;
	await session.prompt("Search the offline fixture.");
	if (failure) throw failure;
	assert.equal(session.messages.filter((message: any) => message.role === "assistant").at(-1)?.stopReason, "stop");
	const records = session.sessionManager.getBranch().filter((entry: any) =>
		entry.type === "custom" && entry.customType === "pi-openai-toolkit:hosted-search");
	assert.equal(records.length, supported ? 1 : 0);
	assert.equal(session.sessionManager.getBranch().some((entry: any) =>
		entry.type === "custom" && entry.customType === "compat:raw-event"), supported);
	if (supported) assert.equal(records[0].data.calls[0].id, call.id);
	await session.prompt("Continue with the same fixture.");
	if (failure) throw failure;
	assert.equal(requests, 2);
	env.assertNoNetwork();
	process.stdout.write(`OK Pi ${sdk.VERSION}: capture=${supported}\n`);
} finally {
	session?.dispose();
	await env.dispose();
}
