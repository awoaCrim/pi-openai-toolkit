import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createSmokeEnvironment } from "./pi-smoke-environment";

const packageDir = resolve(import.meta.dirname, "..");
const targetByName: Record<string, string> = {
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
	const packageManifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
	const expectedPiVersion = packageManifest.devDependencies?.["@earendil-works/pi-coding-agent"];
	if (manifest.version !== expectedPiVersion) {
		throw new Error(`Unexpected local Pi version: ${manifest.version}; expected ${expectedPiVersion}`);
	}
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null,
		refreshOnCreate: false, allowModelNetwork: false,
	});
	for (const provider of ["openai", "openai-codex"]) {
		if (!modelRuntime.getModel(provider, "gpt-6-astra")) throw new Error(`Pi is missing ${provider}/gpt-6-astra`);
	}
	const faux = fauxProvider({ provider: "faux", api: "faux" });
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
		noTools: "all",
	});
	try {
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
