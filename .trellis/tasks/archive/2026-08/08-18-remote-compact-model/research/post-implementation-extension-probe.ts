import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mergeProviderHeaders } from "../../../../src/provider-headers";
import type { NativeCompactionDetails } from "../../../../src/types";

type HookHandler = (event: unknown, ctx: unknown) => Promise<unknown>;

type ProbeModel = {
	provider: string;
	api: string;
	id: string;
	baseUrl?: string;
	headers?: Record<string, string | null>;
};

type ProbeCompactionResult = {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details: NativeCompactionDetails;
};

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

function createSecret(label: string): string {
	return `${label}-${randomBytes(16).toString("hex")}`;
}

function createUserMessage(text: string) {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function createMessageEntry(id: string, message: ReturnType<typeof createUserMessage>) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message,
	};
}

function createPersistedCompactionEntry(id: string, compaction: ProbeCompactionResult) {
	return {
		type: "compaction",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		summary: compaction.summary,
		firstKeptEntryId: compaction.firstKeptEntryId,
		tokensBefore: compaction.tokensBefore,
		details: compaction.details,
		fromHook: true,
	};
}

function buildResponsesUrl(baseUrl: string): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	return normalized.endsWith("/responses") ? normalized : `${normalized}/responses`;
}

function parseCompletedResponse(raw: string): Record<string, unknown> | undefined {
	const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	for (const block of normalized.split(/\n\n+/)) {
		for (const line of block.split("\n")) {
			if (!line.startsWith("data:")) continue;
			const text = line.slice("data:".length).trim();
			if (!text || text === "[DONE]") continue;
			try {
				const event = JSON.parse(text) as Record<string, unknown>;
				if (event.type === "response.completed" && event.response && typeof event.response === "object") {
					return event.response as Record<string, unknown>;
				}
			} catch {
				// Ignore non-JSON keepalive data.
			}
		}
	}
	return undefined;
}

function extractOutputText(response: Record<string, unknown>): string {
	const output = Array.isArray(response.output) ? response.output : [];
	const texts: string[] = [];
	for (const item of output) {
		if (!item || typeof item !== "object") continue;
		const content = Array.isArray((item as Record<string, unknown>).content)
			? ((item as Record<string, unknown>).content as unknown[])
			: [];
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const candidate = part as Record<string, unknown>;
			if (candidate.type === "output_text" && typeof candidate.text === "string") {
				texts.push(candidate.text);
			}
		}
	}
	return texts.join("\n").trim();
}

async function recallSecret(args: {
	registry: ModelRegistry;
	model: ProbeModel;
	compactedWindow: readonly unknown[];
	secret: string;
}): Promise<void> {
	const auth = await args.registry.getApiKeyAndHeaders(args.model as never);
	assert(auth.ok, "Sol authentication did not resolve during recall");
	assert(auth.apiKey, "Sol recall authentication resolved without an API key");
	const baseUrl = auth.baseUrl ?? args.model.baseUrl;
	assert(baseUrl, "Sol recall model has no effective base URL");
	const headers = new Headers(mergeProviderHeaders(args.model.headers, auth.headers));
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");
	if (!headers.has("authorization")) {
		headers.set("authorization", `Bearer ${auth.apiKey}`);
	}

	const response = await fetch(buildResponsesUrl(baseUrl), {
		method: "POST",
		headers,
		body: JSON.stringify({
			model: args.model.id,
			input: [
				...structuredClone(args.compactedWindow),
				{
					role: "user",
					content: [
						{
							type: "input_text",
							text: "Return the exact secret you were told to remember. Output only the secret.",
						},
					],
				},
			],
			reasoning: { effort: "low" },
			store: false,
			stream: true,
		}),
	});
	const responseText = await response.text();
	assert(response.ok, `Sol recall request failed with HTTP ${response.status}`);
	const completed = parseCompletedResponse(responseText);
	assert(completed?.status === "completed", "Sol recall response did not complete");
	assert(extractOutputText(completed) === args.secret, "Sol did not recall the exact pre-compaction secret");
}

async function main(): Promise<void> {
	const realHome = os.homedir();
	const agentDir = path.join(realHome, ".pi", "agent");
	const runtime = await ModelRuntime.create({
		authPath: path.join(agentDir, "auth.json"),
		modelsPath: path.join(agentDir, "models.json"),
		modelsStorePath: path.join(agentDir, "models-store.json"),
		allowModelNetwork: false,
	});
	const registry = new ModelRegistry(runtime);
	const sol = registry.find("uwoacrimson", "gpt-5.6-sol") as ProbeModel | undefined;
	const luna = registry.find("uwoacrimson", "gpt-5.6-luna") as ProbeModel | undefined;
	assert(sol, "Sol model was not found in the Pi model registry");
	assert(luna, "Luna model was not found in the Pi model registry");

	const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-compact-probe-"));
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;

	try {
		const configDir = path.join(tempHome, ".pi", "agent", "extensions", "pi-openai-toolkit");
		const configPath = path.join(configDir, "config.json");
		fs.mkdirSync(configDir, { recursive: true });
		const writeProbeConfig = (remoteCompactModel: string | null) => {
			fs.writeFileSync(
				configPath,
				`${JSON.stringify(
					{
						compaction: {
							enabled: true,
							allowCompactionContinuityBreak: false,
							remoteCompactModel,
							model: null,
							thinkingLevel: "off",
							responsesApis: ["openai-responses"],
							notifyOnLoad: false,
							debug: false,
							logProviderPayloads: false,
							logCompactResponses: false,
							redactSensitiveData: true,
							artifactRoot: path.join(tempHome, "artifacts"),
						},
						webSearch: { enabled: false, models: [] },
					},
					null,
					2,
				)}\n`,
				"utf8",
			);
		};

		writeProbeConfig("uwoacrimson/gpt-5.6-luna");
		const handlers = new Map<string, HookHandler>();
		const extensionModule = await import(`../../../../src/extension-runtime.ts?probe=${crypto.randomUUID()}`);
		extensionModule.default({
			on: (eventName: string, handler: HookHandler) => handlers.set(eventName, handler),
		} as never);
		const sessionBeforeCompact = handlers.get("session_before_compact");
		assert(sessionBeforeCompact, "session_before_compact hook did not register");

		let branchEntries: unknown[] = [];
		let sessionMessages: unknown[] = [];
		const ctx = {
			cwd: process.cwd(),
			hasUI: false,
			ui: { notify: () => undefined },
			model: sol,
			modelRegistry: registry,
			getSystemPrompt: () => "Preserve all exact user-provided facts across compaction.",
			sessionManager: {
				getBranch: () => branchEntries,
				buildSessionContext: () => ({ messages: sessionMessages, thinkingLevel: "off", model: null }),
				getSessionId: () => "remote-compact-model-probe",
				getSessionFile: () => undefined,
				getSessionDir: () => tempHome,
			},
		};

		const compact = async (args: {
			firstKeptEntryId: string;
			tokensBefore: number;
			previousSummary?: string;
			messagesToSummarize?: unknown[];
		}) => {
			const hookResult = (await sessionBeforeCompact(
				{
					reason: "manual",
					signal: new AbortController().signal,
					customInstructions: undefined,
					preparation: {
						tokensBefore: args.tokensBefore,
						firstKeptEntryId: args.firstKeptEntryId,
						previousSummary: args.previousSummary,
						messagesToSummarize: args.messagesToSummarize ?? [],
						turnPrefixMessages: [],
					},
				},
				ctx,
			)) as { compaction?: ProbeCompactionResult } | undefined;
			assert(hookResult?.compaction, "extension hook did not return a remote compaction result");
			assert(ctx.model === sol, "extension changed the active Sol model");
			return hookResult.compaction;
		};

		const firstSecret = createSecret("luna-sol");
		const firstUserMessage = createUserMessage(`Remember this exact secret: ${firstSecret}`);
		const firstUserEntry = createMessageEntry("probe-first-user", firstUserMessage);
		branchEntries = [firstUserEntry];
		sessionMessages = [firstUserMessage];
		const firstCompaction = await compact({
			firstKeptEntryId: firstUserEntry.id,
			tokensBefore: 512,
			messagesToSummarize: [firstUserMessage],
		});
		assert(firstCompaction.details.model === sol.id, "first checkpoint consumer identity is not Sol");
		assert(firstCompaction.details.compactionModel?.model === luna.id, "first checkpoint producer identity is not Luna");
		await recallSecret({
			registry,
			model: sol,
			compactedWindow: firstCompaction.details.compactedWindow,
			secret: firstSecret,
		});

		const firstPersisted = createPersistedCompactionEntry("probe-first-compaction", firstCompaction);
		const recursiveTailMessage = createUserMessage("Keep the remembered secret available after another compaction.");
		const recursiveTailEntry = createMessageEntry("probe-recursive-tail", recursiveTailMessage);
		branchEntries = [firstUserEntry, firstPersisted, recursiveTailEntry];
		sessionMessages = [recursiveTailMessage];
		const recursiveCompaction = await compact({
			firstKeptEntryId: recursiveTailEntry.id,
			tokensBefore: 768,
			previousSummary: firstCompaction.summary,
		});
		assert(recursiveCompaction.details.model === sol.id, "recursive checkpoint consumer identity is not Sol");
		assert(recursiveCompaction.details.compactionModel?.model === luna.id, "recursive checkpoint producer identity is not Luna");
		await recallSecret({
			registry,
			model: sol,
			compactedWindow: recursiveCompaction.details.compactedWindow,
			secret: firstSecret,
		});

		const handoffSecret = createSecret("sol-luna-handoff");
		const handoffUserMessage = createUserMessage(`Remember this exact secret: ${handoffSecret}`);
		const handoffUserEntry = createMessageEntry("probe-handoff-user", handoffUserMessage);
		writeProbeConfig(null);
		branchEntries = [handoffUserEntry];
		sessionMessages = [handoffUserMessage];
		const solCompaction = await compact({
			firstKeptEntryId: handoffUserEntry.id,
			tokensBefore: 512,
			messagesToSummarize: [handoffUserMessage],
		});
		assert(solCompaction.details.compactionModel?.model === sol.id, "handoff baseline checkpoint was not produced by Sol");

		writeProbeConfig("uwoacrimson/gpt-5.6-luna");
		const solPersisted = createPersistedCompactionEntry("probe-sol-compaction", solCompaction);
		const handoffTailMessage = createUserMessage("Transfer this checkpoint chain to Luna without losing the secret.");
		const handoffTailEntry = createMessageEntry("probe-handoff-tail", handoffTailMessage);
		branchEntries = [handoffUserEntry, solPersisted, handoffTailEntry];
		sessionMessages = [handoffTailMessage];
		const handoffCompaction = await compact({
			firstKeptEntryId: handoffTailEntry.id,
			tokensBefore: 768,
			previousSummary: solCompaction.summary,
		});
		assert(handoffCompaction.details.model === sol.id, "handoff checkpoint consumer identity is not Sol");
		assert(handoffCompaction.details.compactionModel?.model === luna.id, "handoff replacement checkpoint was not produced by Luna");
		await recallSecret({
			registry,
			model: sol,
			compactedWindow: handoffCompaction.details.compactedWindow,
			secret: handoffSecret,
		});

		console.log(
			JSON.stringify({
				firstLunaToSol: "PASS",
				recursiveLunaToSol: "PASS",
				existingSolCheckpointHandoff: "PASS",
				activeModel: `${sol.provider}/${sol.id}`,
				remoteCompactModel: `${luna.provider}/${luna.id}`,
			}),
		);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		fs.rmSync(tempHome, { recursive: true, force: true });
	}
}

await main();
