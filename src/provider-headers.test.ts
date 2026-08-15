import { expect, test } from "bun:test";
import { mergeProviderHeaders } from "./provider-headers";

test("mergeProviderHeaders applies case-insensitive overrides and null deletions", () => {
	expect(
		mergeProviderHeaders(
			{
				"x-shared": "model",
				"x-delete": "remove-me",
				"x-model-only": "model-value",
			},
			{
				"X-SHARED": "auth",
				"X-DELETE": null,
				"x-auth-only": "auth-value",
			},
		),
	).toEqual({
		"x-shared": "auth",
		"x-model-only": "model-value",
		"x-auth-only": "auth-value",
	});
});
