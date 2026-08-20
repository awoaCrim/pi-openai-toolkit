import { MAX_SEGMENT_LENGTH } from "./types";

export type SegmentationResult = {
	segments: string[];
	remainder: string;
};

function isNaturalBoundaryCharacter(character: string): boolean {
	return "\n.!?。！？；;".includes(character);
}

function findLatestNaturalBoundary(source: string, limit: number): number | undefined {
	const end = Math.min(limit, source.length);
	for (let index = end - 1; index >= 0; index--) {
		if (!isNaturalBoundaryCharacter(source[index])) continue;
		let boundary = index + 1;
		while (boundary < end && /\s/u.test(source[boundary])) boundary++;
		return boundary;
	}
	return undefined;
}

function addSegment(segments: string[], candidate: string): void {
	if (candidate.trim().length > 0) segments.push(candidate);
}

/**
 * Extract complete thinking segments without changing their source text. Natural
 * boundaries are preferred; long unbroken text is cut at the hard UTF-16 limit.
 */
export function segmentThinkingSource(source: string, flush = false): SegmentationResult {
	let remainder = source;
	const segments: string[] = [];

	while (remainder.length > 0) {
		const boundary = findLatestNaturalBoundary(remainder, MAX_SEGMENT_LENGTH);
		if (boundary !== undefined) {
			addSegment(segments, remainder.slice(0, boundary));
			remainder = remainder.slice(boundary);
			continue;
		}
		if (remainder.length > MAX_SEGMENT_LENGTH) {
			addSegment(segments, remainder.slice(0, MAX_SEGMENT_LENGTH));
			remainder = remainder.slice(MAX_SEGMENT_LENGTH);
			continue;
		}
		break;
	}

	if (flush && remainder.trim().length > 0) {
		addSegment(segments, remainder);
		remainder = "";
	}

	return { segments, remainder };
}

export function flushThinkingSource(source: string): SegmentationResult {
	return segmentThinkingSource(source, true);
}
