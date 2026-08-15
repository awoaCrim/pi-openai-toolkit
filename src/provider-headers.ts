import type { ProviderHeaders } from "@earendil-works/pi-ai";

/**
 * Merge Pi provider headers while preserving its nullable deletion semantics.
 * Later sources override earlier ones case-insensitively; null removes a header.
 */
export function mergeProviderHeaders(
	...sources: Array<ProviderHeaders | undefined>
): Record<string, string> {
	const headers = new Headers();

	for (const source of sources) {
		for (const [name, value] of Object.entries(source ?? {})) {
			if (value === null) {
				headers.delete(name);
			} else {
				headers.set(name, value);
			}
		}
	}

	return Object.fromEntries(headers.entries());
}
