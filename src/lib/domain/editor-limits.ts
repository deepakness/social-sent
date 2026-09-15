export function isOverSelectedPlatformLimit(params: {
	selectedPlatforms: Iterable<string>;
	blueskyLen: number;
	mastodonLen: number;
	blueskyMax?: number;
	mastodonMax?: number;
	linkedinLen?: number;
	linkedinMax?: number;
	threadsLen?: number;
	threadsMax?: number;
	xLen?: number;
	xMax?: number;
}): boolean {
	const selected = new Set(params.selectedPlatforms);
	const blueskyMax = params.blueskyMax ?? 300;
	const mastodonMax = params.mastodonMax ?? 500;
	const linkedinMax = params.linkedinMax ?? 3000;
	const threadsMax = params.threadsMax ?? 500;
	const xMax = params.xMax ?? 280;
	if (selected.has('bluesky') && params.blueskyLen > blueskyMax) return true;
	if (selected.has('mastodon') && params.mastodonLen > mastodonMax) return true;
	if (selected.has('linkedin') && (params.linkedinLen ?? 0) > linkedinMax) return true;
	if (selected.has('threads') && (params.threadsLen ?? 0) > threadsMax) return true;
	if (selected.has('x') && (params.xLen ?? 0) > xMax) return true;
	return false;
}
