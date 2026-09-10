import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createSmokeEnvironment } from "./pi-smoke-environment";

const packageDir = resolve(import.meta.dirname, "..");
const targetByName: Record<string, string> = {
	compaction: join(packageDir, "extensions/compaction.ts"),
	web_search: join(packageDir, "extensions/web-search.ts"),
	image_generation: join(packageDir, "extensions/image-generation.ts"),
	auto_mode: join(packageDir, "extensions/auto-mode.ts"),
	codex_astra: join(packageDir, "extensions/codex-astra.ts"),
	package: packageDir,
};
const targetName = process.argv[2];
const target = targetByName[targetName];
if (!target) throw new Error(`Unknown Pi smoke target: ${targetName}`);
const env = await createSmokeEnvironment();
try {
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
		await import("@earendil-works/pi-coding-agent");
	const { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } =
		await import("@earendil-works/pi-ai");
	const manifest = JSON.parse(await readFile(join(packageDir, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
	if (manifest.version !== "0.85.1") throw new Error(`Unexpected local Pi version: ${manifest.version}`);
	const imageSmoke = targetName === "image_generation";
	if (imageSmoke) {
		const configDir = join(env.agentDir, "extensions/pi-openai-toolkit");
		await mkdir(configDir, { recursive: true });
		await writeFile(
			join(configDir, "config.json"),
			JSON.stringify({
				imageGeneration: { enabled: true, models: ["gpt-image-2.5", "grok-imagine-image-2.0"] },
			}),
		);
	}
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null,
		refreshOnCreate: false, allowModelNetwork: false,
	});
	for (const provider of ["openai", "openai-codex"]) {
		if (!modelRuntime.getModel(provider, "gpt-6-astra")) throw new Error(`Pi is missing ${provider}/gpt-6-astra`);
	}
	const faux = fauxProvider({ provider: "faux", api: imageSmoke ? "openai-responses" : "faux" });
	faux.setResponses([fauxAssistantMessage("OK")]);
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }, { projectTrusted: true });
	const resourceLoader = new DefaultResourceLoader({
		cwd: env.cwd, agentDir: env.agentDir, settingsManager, additionalExtensionPaths: [target],
		noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
	});
	await resourceLoader.reload();
	if (resourceLoader.getExtensions().errors.length) throw new Error(`Pi extension load failed: ${JSON.stringify(resourceLoader.getExtensions().errors)}`);
	const { session } = await createAgentSession({
		cwd: env.cwd, agentDir: env.agentDir, modelRuntime, settingsManager, resourceLoader,
		sessionManager: SessionManager.inMemory(env.cwd), model: faux.getModel(),
		noTools: imageSmoke ? "builtin" : "all",
	});
	try {
		if (imageSmoke) {
			if (!session.getActiveToolNames().includes("openai_generate_image")) throw new Error("Image tool was not active");
			if (
				!session.systemPrompt.includes(
					"Generate or edit PNG images through the current Responses-capable model and a configured imageGeneration.models entry.",
				)
			)
				throw new Error("Missing image tool description");
			if (!session.systemPrompt.includes("Use openai_generate_image when the user explicitly asks")) throw new Error("Missing image tool guidelines");
		}
		await session.prompt("Reply with the single word OK.");
		const last = session.messages.at(-1);
		if (last?.role !== "assistant" || last.content.filter((block) => block.type === "text").map((block) => block.text).join("") !== "OK") throw new Error("Unexpected faux response");
		if (faux.state.callCount !== 1 || session.messages.some((message) => message.role === "toolResult")) throw new Error("Loading smoke unexpectedly ran another request/tool");
		env.assertNoNetwork();
	} finally {
		session.dispose();
	}
	process.stdout.write("OK\n");
} finally {
	await env.dispose();
}
