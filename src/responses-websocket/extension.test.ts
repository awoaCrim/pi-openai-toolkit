import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getApiProvider, resetApiProviders } from "@earendil-works/pi-ai/compat";
import { loadToolkitConfig } from "../config";
import { installResponsesWebSocketTransport } from "./extension";

const tempDirs: string[] = [];

function configFile(raw: unknown): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "responses-websocket-config-"));
	tempDirs.push(dir);
	const file = path.join(dir, "config.json");
	fs.writeFileSync(file, JSON.stringify(raw), "utf8");
	return file;
}

afterEach(() => {
	resetApiProviders();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Responses WebSocket extension", () => {
	test("does not replace the generic Responses adapter when the flag is omitted", () => {
		const original = getApiProvider("openai-responses");
		expect(original).toBeDefined();
		const installed = installResponsesWebSocketTransport(() => loadToolkitConfig(configFile({ schemaVersion: 2 })));
		expect(installed).toBe(false);
		expect(getApiProvider("openai-responses")).toBe(original);
	});

	test("installs the adapter only for an explicitly enabled valid v2 policy", () => {
		const original = getApiProvider("openai-responses");
		expect(original).toBeDefined();
		const installed = installResponsesWebSocketTransport(() => loadToolkitConfig(configFile({
			schemaVersion: 2,
			defaults: { responsesWebSocket: { enabled: true } },
		})));
		expect(installed).toBe(true);
		expect(getApiProvider("openai-responses")).not.toBe(original);
	});

	test("restores a usable generic provider after disabling a previous wrapper", () => {
		const original = getApiProvider("openai-responses");
		expect(original).toBeDefined();
		expect(installResponsesWebSocketTransport(() => loadToolkitConfig(configFile({
			schemaVersion: 2,
			defaults: { responsesWebSocket: { enabled: true } },
		})))).toBe(true);
		const enabled = getApiProvider("openai-responses");
		expect(enabled).toBeDefined();
		expect(installResponsesWebSocketTransport(() => loadToolkitConfig(configFile({ schemaVersion: 2 })))).toBe(false);
		const restored = getApiProvider("openai-responses");
		expect(restored).toBeDefined();
		expect(restored).not.toBe(enabled);
	});

	test("invalid config also removes the wrapper without losing the provider", () => {
		const enabledConfig = () => loadToolkitConfig(configFile({
			schemaVersion: 2,
			defaults: { responsesWebSocket: { enabled: true } },
		}));
		expect(installResponsesWebSocketTransport(enabledConfig)).toBe(true);
		expect(installResponsesWebSocketTransport(() => loadToolkitConfig(configFile({
			schemaVersion: 2,
			defaults: { responsesWebSocket: { enabled: "yes" } },
		})))).toBe(false);
		expect(getApiProvider("openai-responses")).toBeDefined();
	});

	test("survives independent extension module reloads", async () => {
		const enabledConfig = () => loadToolkitConfig(configFile({
			schemaVersion: 2,
			defaults: { responsesWebSocket: { enabled: true } },
		}));
		const first = await import(`./extension.ts?reload=${randomUUID()}`);
		expect(first.installResponsesWebSocketTransport(enabledConfig)).toBe(true);
		const firstProvider = getApiProvider("openai-responses");
		expect(firstProvider).toBeDefined();

		const second = await import(`./extension.ts?reload=${randomUUID()}`);
		expect(second.installResponsesWebSocketTransport(enabledConfig)).toBe(true);
		const secondProvider = getApiProvider("openai-responses");
		expect(secondProvider).toBeDefined();
		expect(secondProvider).not.toBe(firstProvider);

		expect(second.installResponsesWebSocketTransport(() => loadToolkitConfig(configFile({ schemaVersion: 2 })))).toBe(false);
		expect(getApiProvider("openai-responses")).toBeDefined();
	});

	test("rebinds the builtin provider after a host compat reset", () => {
		const enabledConfig = () => loadToolkitConfig(configFile({
			schemaVersion: 2,
			defaults: { responsesWebSocket: { enabled: true } },
		}));
		expect(installResponsesWebSocketTransport(enabledConfig)).toBe(true);
		resetApiProviders();
		expect(getApiProvider("openai-responses")).toBeDefined();
		expect(installResponsesWebSocketTransport(enabledConfig)).toBe(true);
		expect(getApiProvider("openai-responses")).toBeDefined();
	});
});
