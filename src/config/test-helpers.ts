import { DEFAULT_TOOLKIT_CONFIG, type LoadedToolkitConfig } from "../types";

/** Explicit reader seam: no global-file access, auth, provider registry or network. */
export function v2Fixture(raw: Record<string, unknown>): LoadedToolkitConfig {
	return {
		config: structuredClone(DEFAULT_TOOLKIT_CONFIG),
		source: "/fixture/config.json",
		warnings: [],
		document: { format: "v2", configPath: "/fixture/config.json", raw: { schemaVersion: 2, ...raw }, issues: [] },
	};
}
