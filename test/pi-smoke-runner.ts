import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Context,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";

interface OfficialPackageManifest {
	name?: unknown;
	version?: unknown;
}

const packageDir = resolve(import.meta.dir, "..");
const officialPackageDir = resolve(packageDir, "node_modules/@earendil-works/pi-coding-agent");
const targetByName: Record<string, string> = {
	compaction: join(packageDir, "extensions/compaction.ts"),
	inline_compaction: join(packageDir, "extensions/compaction.ts"),
	web_search: join(packageDir, "extensions/web-search.ts"),
	image_generation: join(packageDir, "extensions/image-generation.ts"),
	package: packageDir,
};
const targetName = process.argv[2];
const target = targetName ? targetByName[targetName] : undefined;
if (!target) {
	throw new Error(`Unknown Pi smoke target: ${targetName ?? "<missing>"}`);
}

const manifest = JSON.parse(
	await readFile(join(officialPackageDir, "package.json"), "utf8"),
) as OfficialPackageManifest;
if (manifest.name !== "@earendil-works/pi-coding-agent" || manifest.version !== "0.84.3") {
	throw new Error(`Unexpected local Pi runtime: ${String(manifest.name)}@${String(manifest.version)}`);
}

const isolatedHome = await mkdtemp(join(tmpdir(), "pi-openai-toolkit-home-"));
const isolatedProject = await mkdtemp(join(tmpdir(), "pi-openai-toolkit-project-"));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.env.APPDATA = join(isolatedHome, "AppData", "Roaming");
process.env.LOCALAPPDATA = join(isolatedHome, "AppData", "Local");
const agentDir = join(isolatedHome, ".pi", "agent");
const inlineSmoke = targetName === "inline_compaction";
const faux = fauxProvider({
	provider: "faux",
	api: "faux",
	models: [{ id: "faux-1", contextWindow: inlineSmoke ? 256 : 128_000, maxTokens: 128 }],
});
let inlineNextMessages: Context["messages"] | undefined;
let inlineCompactionCountAtNextRequest: number | undefined;
let inlineSessionManager: SessionManager | undefined;
let inlineAdapterMarker:
	| {
		adapters?: WeakMap<object, { adapter?: { state?: unknown } }>;
		version?: unknown;
	}
	| undefined;
if (inlineSmoke) {
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("first_tool", { value: "a" }, { id: "call-first" }),
				fauxToolCall("second_tool", { value: "b" }, { id: "call-second" }),
			],
			{ stopReason: "toolUse", timestamp: 1_800_000_000_100 },
		),
		fauxAssistantMessage("COMPACTED-SUMMARY", { timestamp: 1_800_000_000_200 }),
		(context) => {
			inlineNextMessages = structuredClone(context.messages);
			inlineCompactionCountAtNextRequest = inlineSessionManager
				?.getBranch()
				.filter((entry) => entry.type === "compaction").length;
			return fauxAssistantMessage("INLINE-DONE", { timestamp: 1_800_000_000_300 });
		},
	]);
} else {
	faux.setResponses([fauxAssistantMessage("OK")]);
}

try {
	const modelRuntime = await ModelRuntime.create({
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = SettingsManager.inMemory(
		inlineSmoke
			? {
				compaction: {
					enabled: true,
					reserveTokens: 192,
					keepRecentTokens: 48,
				},
			}
			: {},
		{ projectTrusted: true },
	);
	const resourceLoader = new DefaultResourceLoader({
		cwd: isolatedProject,
		agentDir,
		settingsManager,
		additionalExtensionPaths: [target],
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	if (resourceLoader.getExtensions().errors.length > 0) {
		throw new Error(`Pi extension load failed: ${JSON.stringify(resourceLoader.getExtensions().errors)}`);
	}

	const sessionManager = SessionManager.inMemory(isolatedProject);
	if (inlineSmoke) {
		inlineSessionManager = sessionManager;
		for (const [index, userText, assistantText] of [
			[0, `STALE-PRE-COMPACTION-${"x".repeat(300)}`, "Old answer one."],
			[1, `SECOND-OLD-TURN-${"y".repeat(300)}`, "Old answer two."],
		] as const) {
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: userText }],
				timestamp: 1_800_000_000_000 + index * 20,
			});
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: assistantText }],
				api: faux.getModel().api,
				provider: faux.getModel().provider,
				model: faux.getModel().id,
				usage: {
					input: 5,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 10,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 1_800_000_000_010 + index * 20,
			});
		}
	}

	const firstTool = defineTool({
		name: "first_tool",
		label: "First tool",
		description: "Return the first deterministic smoke result.",
		parameters: Type.Object({ value: Type.String() }),
		execute: async (_toolCallId, params) => ({
			content: [{ type: "text", text: `first:${params.value}` }],
			details: {},
		}),
	});
	const secondTool = defineTool({
		name: "second_tool",
		label: "Second tool",
		description: "Return the second deterministic smoke result.",
		parameters: Type.Object({ value: Type.String() }),
		execute: async (_toolCallId, params) => ({
			content: [{ type: "text", text: `second:${params.value}` }],
			details: {},
		}),
	});

	const { session } = await createAgentSession({
		cwd: isolatedProject,
		agentDir,
		modelRuntime,
		settingsManager,
		resourceLoader,
		sessionManager,
		model: faux.getModel(),
		...(inlineSmoke
			? {
				tools: ["first_tool", "second_tool"],
				customTools: [firstTool, secondTool],
			}
			: { noTools: "all" as const }),
	});
	try {
		if (inlineSmoke) {
			const prototype = Object.getPrototypeOf(session) as Record<PropertyKey, unknown>;
			const marker = prototype[Symbol.for("pi-openai-toolkit.inline-compaction.adapter.v1")];
			if (!marker || typeof marker !== "object") {
				throw new Error("Inline compaction did not patch the actual official AgentSession prototype");
			}
			inlineAdapterMarker = marker as typeof inlineAdapterMarker;
		}
		await session.prompt(inlineSmoke ? "Run both tools and continue." : "Reply with the single word OK.");
		const lastMessage = session.messages.at(-1);
		if (!lastMessage || lastMessage.role !== "assistant") {
			throw new Error("Pi smoke did not produce an assistant message");
		}
		const text = lastMessage.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("");
		if (!inlineSmoke && text !== "OK") {
			throw new Error(`Unexpected faux response: ${text}`);
		}
		if (inlineSmoke) {
			if (text !== "INLINE-DONE") {
				const adapterState = inlineAdapterMarker?.adapters?.get(session)?.adapter?.state;
				const branchSnapshot = sessionManager.getBranch();
				throw new Error(
					`Inline continuation did not finish the original loop: ${text}; ` +
						`calls=${faux.state.callCount}; capturedNext=${Boolean(inlineNextMessages)}; ` +
						`usage=${JSON.stringify(session.getContextUsage())}; ` +
						`messages=${JSON.stringify(session.messages.map((message) => ({ role: message.role, content: message.content })))}; ` +
						`captured=${JSON.stringify(inlineNextMessages)}; ` +
						`branch=${JSON.stringify(branchSnapshot)}; ` +
						`adapter=${JSON.stringify(adapterState)}`,
				);
			}
			if (
				faux.state.callCount !== 3 ||
				!inlineNextMessages ||
				inlineCompactionCountAtNextRequest !== 1
			) {
				throw new Error(
					`Unexpected inline provider sequence: calls=${faux.state.callCount}; ` +
						`compactionsAtNextRequest=${String(inlineCompactionCountAtNextRequest)}`,
				);
			}
			const serializedContext = JSON.stringify(inlineNextMessages);
			if (serializedContext.includes("STALE-PRE-COMPACTION")) {
				throw new Error("The next provider request reused the stale pre-compaction context");
			}
			if (!serializedContext.includes("COMPACTED-SUMMARY")) {
				throw new Error("The next provider request did not contain the compacted host context");
			}
			const toolResults = inlineNextMessages.filter((message) => message.role === "toolResult");
			if (
				toolResults.length !== 2 ||
				toolResults[0]?.toolCallId !== "call-first" ||
				toolResults[1]?.toolCallId !== "call-second"
			) {
				throw new Error(`Multi-tool results were not preserved as a complete ordered batch: ${JSON.stringify(toolResults)}`);
			}
			const branch = sessionManager.getBranch();
			if (branch.filter((entry) => entry.type === "compaction").length !== 1) {
				throw new Error("Inline smoke expected exactly one official compaction entry");
			}
			if (
				branch.some(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === "pi-openai-toolkit.inline-compaction-follow-up.v1",
				)
			) {
				throw new Error("Inline mode unexpectedly used the public hidden follow-up fallback");
			}
		}
	} finally {
		session.dispose();
	}
	console.log("OK");
} finally {
	await rm(isolatedProject, { recursive: true, force: true });
	await rm(isolatedHome, { recursive: true, force: true });
}
