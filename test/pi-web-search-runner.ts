import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as zlib from "node:zlib";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createSmokeEnvironment } from "./pi-smoke-environment";

const packageDir = resolve(import.meta.dirname, "..");
const api = process.argv[2];
assert(api === "openai-responses" || api === "openai-codex-responses");
const env = await createSmokeEnvironment();

function record(value: unknown): Record<string, unknown> {
	assert(value && typeof value === "object" && !Array.isArray(value));
	return value as Record<string, unknown>;
}

function streamResponse(output: Array<Record<string, unknown>>, id: string): Response {
	const events = [{ type: "response.created", response: { id, status: "in_progress", output: [] } }];
	const items = output.flatMap((item, output_index) => [
		{ type: "response.output_item.added", output_index, item },
		{ type: "response.output_item.done", output_index, item },
	]);
	const completed = { type: "response.completed", response: {
		id, status: "completed", output, created_at: 1800000000,
		usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
	} };
	return new Response([...events, ...items, completed].map((event) =>
		`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		status: 200, headers: { "content-type": "text/event-stream" },
	});
}

function textResponse(text: string): Response {
	return streamResponse([{
		type: "message", id: `msg_${text}`, role: "assistant", status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	}], `resp_${text}`);
}

function assertReply(session: AgentSession, expected: string): void {
	const last = session.messages.at(-1);
	assert(last?.role === "assistant");
	assert.equal(last.stopReason, "stop", last.errorMessage);
	assert.equal(last.content.filter((block) => block.type === "text").map((block) => block.text).join(""), expected);
}

try {
	// Pi captures config paths at import time; import only after isolation.
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
		await import("@earendil-works/pi-coding-agent");
	const { InMemoryCredentialStore, InMemoryModelsStore } = await import("@earendil-works/pi-ai");
	const manifest = JSON.parse(await readFile(join(packageDir, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
	const packageManifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
	assert.equal(manifest.version, packageManifest.devDependencies["@earendil-works/pi-coding-agent"]);
	const configDir = join(env.agentDir, "extensions/pi-openai-toolkit");
	await mkdir(configDir, { recursive: true });
	await writeFile(join(configDir, "config.json"), JSON.stringify({
		compaction: { enabled: false },
		webSearch: { enabled: true, models: [], defaultRoute: "standalone-alpha" },
	}));
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null,
		refreshOnCreate: false, allowModelNetwork: false,
	});
	const baseUrl = "https://toolkit-search-smoke.invalid/v1";
	// The real Codex encoder requires an account claim even for mock HTTP.
	const claim = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64");
	const apiKey = api === "openai-codex-responses" ? `smoke.${claim}.signature` : "synthetic-search-key";
	modelRuntime.registerProvider("standalone-smoke", {
		api, apiKey, baseUrl,
		models: [{ id: "gpt-5.5", name: "Standalone search smoke", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 512 }],
	});
	const model = modelRuntime.getModel("standalone-smoke", "gpt-5.5");
	assert(model);
	const settingsManager = SettingsManager.inMemory({
		transport: "sse", retry: { enabled: false, provider: { maxRetries: 0 } }, compaction: { enabled: false },
	}, { projectTrusted: true });
	const resourceLoader = new DefaultResourceLoader({
		cwd: env.cwd, agentDir: env.agentDir, settingsManager,
		additionalExtensionPaths: [join(packageDir, "src/web-search/extension.ts")],
		noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
		systemPromptOverride: () => "Follow the deterministic smoke instructions.",
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const { session } = await createAgentSession({
		cwd: env.cwd, agentDir: env.agentDir, modelRuntime, settingsManager, resourceLoader, model,
		sessionManager: SessionManager.inMemory(env.cwd), noTools: "builtin",
	});
	const events: AgentSessionEvent[] = [];
	const unsubscribe = session.subscribe((event) => events.push(event));
	const deniedFetch = globalThis.fetch;
	const responsesUrl = `${baseUrl}/${api === "openai-codex-responses" ? "codex/responses" : "responses"}`;
	const liveBodies: Array<Record<string, unknown>> = [];
	const searchBodies: Array<Record<string, unknown>> = [];
	let requestFailure: unknown;
	globalThis.fetch = (async (input, init) => {
		try {
			const request = new Request(input, init);
			if (request.method !== "POST" || ![responsesUrl, `${baseUrl}/alpha/search`].includes(request.url)) {
				return await deniedFetch(input, init);
			}
			const bytes = Buffer.from(await request.arrayBuffer());
			// Official Codex SSE may compress its request; validate the actual wire body.
			const encoding = request.headers.get("content-encoding");
			assert(encoding === null || encoding === "zstd");
			const decoded = encoding === "zstd" ? zlib.zstdDecompressSync(bytes) : bytes;
			const body = record(JSON.parse(decoded.toString("utf8")));
			assert.equal(request.headers.get("authorization"), `Bearer ${apiKey}`);
			assert.equal(body.model, model.id);
			if (request.url.endsWith("/alpha/search")) {
				searchBodies.push(body);
				assert.equal(liveBodies.length, 2, "search must come from the model's tool call");
				assert.equal(searchBodies.length, 1, "standalone search must not retry or duplicate dispatch");
				assert.deepEqual(Object.keys(body).sort(), ["commands", "id", "max_output_tokens", "model"]);
				assert.deepEqual(body.commands, { search_query: [{ q: "fixture search" }], response_length: "short" });
				return new Response(JSON.stringify({ id: "alpha-smoke", output: "SEARCH-RESULT-FIXTURE" }), {
					status: 200, headers: { "content-type": "application/json" },
				});
			}

			liveBodies.push(body);
			assert(Array.isArray(body.tools));
			const tools = body.tools.map(record);
			for (const tool of tools) {
				assert.equal(tool.type, "function", "standalone must not inject hosted search");
				assert.equal(typeof tool.name, "string");
				assert.match(tool.name as string, /^[a-zA-Z0-9_-]+$/, "Issue #5: invalid provider function name");
			}
			assert.deepEqual(tools.map((tool) => tool.name), ["web_run"]);
			assert.match(JSON.stringify({ instructions: body.instructions, input: body.input }), /The `web_run` tool is available/);
			assert(!JSON.stringify(body).includes("web.run"), "dotted callable must not leak into a new session");
			if (liveBodies.length === 1) return textResponse("PLAIN-DONE");
			if (liveBodies.length === 2) {
				return streamResponse([{
					type: "function_call", id: "fc_search_smoke", call_id: "search_smoke", name: "web_run",
					arguments: JSON.stringify({ search_query: [{ q: "fixture search" }], response_length: "short" }),
				}], "resp_search_call");
			}
			assert.equal(liveBodies.length, 3, "unexpected retry or hidden follow-up");
			assert.equal(searchBodies.length, 1);
			assert(Array.isArray(body.input));
			const items = body.input.map(record);
			const calls = items.filter((item) => item.type === "function_call");
			assert.deepEqual(calls.map((call) => ({ name: call.name, call_id: call.call_id })), [{ name: "web_run", call_id: "search_smoke" }]);
			const results = items.filter((item) => item.type === "function_call_output");
			assert.equal(results.length, 1);
			assert.equal(results[0].call_id, "search_smoke");
			assert.match(JSON.stringify(results[0].output), /SEARCH-RESULT-FIXTURE/);
			return textResponse("SEARCH-DONE");
		} catch (error) {
			// Preserve the precise transport assertion if the SDK wraps fetch errors.
			requestFailure ??= error;
			throw error;
		}
	}) as typeof fetch;
	try {
		await session.prompt("Reply without searching.");
		if (requestFailure) throw requestFailure;
		assertReply(session, "PLAIN-DONE");
		assert.equal(liveBodies.length, 1);
		assert.equal(searchBodies.length, 0);
		assert.equal(session.messages.filter((message) => message.role === "toolResult").length, 0);

		await session.prompt("Search for fixture search, then report the result.");
		if (requestFailure) throw requestFailure;
		assertReply(session, "SEARCH-DONE");
		assert.equal(liveBodies.length, 3);
		assert.equal(searchBodies.length, 1);
		const results = session.messages.filter((message) => message.role === "toolResult");
		assert.equal(results.length, 1);
		assert.equal(results[0].toolName, "web_run");
		assert.equal(results[0].isError, false);
		assert.deepEqual(results[0].content, [{ type: "text", text: "SEARCH-RESULT-FIXTURE" }]);
		assert.deepEqual(events.filter((event) => event.type === "tool_execution_start").map((event) => event.toolName), ["web_run"]);
		assert.deepEqual(events.filter((event) => event.type === "tool_execution_end").map((event) => event.isError), [false]);
		env.assertNoNetwork();
	} finally {
		unsubscribe();
		session.dispose();
	}
	process.stdout.write("OK\n");
} finally {
	await env.dispose();
}
