export type ExactModelScopeModel = {
	provider?: string;
	id?: string;
};

export function getExactModelKey(model: ExactModelScopeModel | undefined): string | undefined {
	if (!model?.provider || !model.id) return undefined;
	return `${model.provider}/${model.id}`;
}

export function isExactModelAllowed(
	model: ExactModelScopeModel | undefined,
	allowlist: readonly string[],
): boolean {
	const modelKey = getExactModelKey(model);
	return modelKey !== undefined && allowlist.includes(modelKey);
}
