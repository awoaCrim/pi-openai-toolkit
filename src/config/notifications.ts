import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedToolkitConfig } from "../config";
import type { ConfigIssue } from "./policy";
import { redactValue } from "../debug";

const lastNotice = new WeakMap<object, string>();

export function formatConfigIssues(issues: readonly ConfigIssue[], limit = 12): string {
	const lines = issues.slice(0, limit).map((issue) => `${issue.severity}: ${issue.path.slice(0, 220)} — ${issue.code}`);
	if (issues.length > limit) lines.push(`${issues.length - limit} more issue(s); inspect the configuration file.`);
	return String(redactValue(lines.join("\n")));
}

/** Per-session bounded notice, independent of feature enablement/debug. Never logs raw config. */
export function notifyConfigIssues(ctx: ExtensionContext, resolved: ResolvedToolkitConfig): void {
	const owner = ctx.sessionManager ?? ctx;
	if (resolved.issues.length === 0) {
		lastNotice.delete(owner);
		return;
	}
	if (!ctx.hasUI || typeof ctx.ui?.notify !== "function") return;
	const message = formatConfigIssues(resolved.issues, 4);
	const fingerprint = `${resolved.source ?? "defaults"}\n${resolved.modelKey ?? ""}\n${message}`;
	if (lastNotice.get(owner) === fingerprint) return;
	lastNotice.set(owner, fingerprint);
	ctx.ui.notify(`Toolkit configuration:\n${message}\nUse /toolkit-config validate for details.`,
		resolved.issues.some((issue) => issue.severity === "error") ? "error" : "warning");
}
