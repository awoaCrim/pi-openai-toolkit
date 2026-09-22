import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_PATH, loadToolkitConfig, resolveToolkitConfig, type ResolvedToolkitConfig } from "./config";
import { previewToolkitMigration } from "./config/migration";
import { formatConfigIssues } from "./config/notifications";
import { redactValue } from "./debug";

const registered = new WeakSet<object>();
const MAX_REPORT_CHARS = 24_000;

function boundedReport(text: string): string {
	// Even known string fields may accidentally contain credentials. Never show them unredacted.
	const redacted = redactValue(text);
	const safe = typeof redacted === "string" ? redacted : "Configuration report unavailable.";
	return safe.length <= MAX_REPORT_CHARS ? safe : `${safe.slice(0, MAX_REPORT_CHARS)}\n[Report truncated; do not use truncated JSON as a configuration file.]`;
}
function readLeaf(value: unknown, fieldPath: string): unknown {
	for (const key of fieldPath.split(".")) {
		if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, key)) return undefined;
		value = Reflect.get(value, key);
	}
	return value;
}

export function describeToolkitConfig(resolved: ResolvedToolkitConfig): string {
	const lines = [
		`Toolkit configuration: ${resolved.source ?? CONFIG_PATH}`,
		`Format: ${resolved.format}; model: ${resolved.modelKey ?? "not selected"}`,
		`Invalid selected features: ${resolved.invalidFeatures.join(", ") || "none"}`,
		"Configuration intent only. Tool registration and backend capability are not verified.",
	];
	for (const [field, origin] of Object.entries(resolved.origins)) {
		const value = JSON.stringify(readLeaf(resolved.policy, field));
		lines.push(`${field} = ${value} [${origin.kind}${origin.path ? `: ${origin.path}` : ""}]`);
	}
	if (resolved.issues.length) lines.push("", formatConfigIssues(resolved.issues, 30));
	return boundedReport(lines.join("\n"));
}

/** Human-only local inspection. Registration does not load config or call action APIs. */
export function registerToolkitConfigCommand(pi: ExtensionAPI, loadConfig: typeof loadToolkitConfig = loadToolkitConfig): void {
	if (registered.has(pi) || typeof pi.registerCommand !== "function") return;
	registered.add(pi);
	pi.registerCommand("toolkit-config", {
		description: "Read-only global configuration: /toolkit-config [show|validate|migration-preview]",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) throw new Error("/toolkit-config requires an interactive or RPC UI; it does not write reports to stdout.");
			const action = args.trim() || "show";
			if (!["show", "validate", "migration-preview"].includes(action)) {
				ctx.ui.notify("Usage: /toolkit-config [show|validate|migration-preview]", "warning");
				return;
			}
			const loaded = loadConfig();
			const resolved = resolveToolkitConfig(loaded, ctx.model);
			if (action === "show") {
				ctx.ui.notify(describeToolkitConfig(resolved), resolved.invalidFeatures.length ? "warning" : "info");
			} else if (action === "validate") {
				ctx.ui.notify(boundedReport(resolved.issues.length
					? `Toolkit configuration: ${loaded.document?.configPath ?? loaded.source ?? CONFIG_PATH}\n${formatConfigIssues(resolved.issues, 80)}`
					: "Toolkit configuration is valid. Backend support has not been tested."),
					resolved.issues.length ? "warning" : "info");
			} else {
				const preview = previewToolkitMigration(loaded);
				ctx.ui.notify(boundedReport([
					`Migration preview: ${preview.status}. No file was changed.`,
					...preview.reasons,
					...(preview.unmappedPaths.length ? [`Unmapped/dormant paths (unknown names masked): ${preview.unmappedPaths.join(", ")}`] : []),
					"Before any future manual apply, back up the original bytes and verify all installed Toolkit copies support v2.",
					...(preview.candidate ? ["Candidate (review required):", JSON.stringify(preview.candidate, null, 2)] : []),
				].join("\n")), preview.status === "needs-review" ? "warning" : "info");
			}
		},
	});
}
