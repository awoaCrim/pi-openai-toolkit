import { afterEach, describe, expect, test } from "bun:test";
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
});
