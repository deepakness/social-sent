/** Dead-isolate TTL. Not a request timeout. Slow live publishes must finish under this. */
export const STALE_CLAIM_MS = 15 * 60_000;

export type SchedulableTarget = {
	id: string;
	status: string;
	scheduledFor: Date | string | null;
	remotePostId?: string | null;
	updatedAt?: Date | string | null;
};

function asTime(value: Date | string | number | null | undefined): number | null {
	if (value == null) return null;
	if (typeof value === 'number') return Number.isNaN(value) ? null : value;
	const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
	return Number.isNaN(t) ? null : t;
}

/** True while a live isolate still owns the row. Missing updatedAt is treated as stale. */
export function isFreshPublishing(
	target: {
		status: string;
		updatedAt?: Date | string | number | null;
		remotePostId?: string | null;
	},
	now: Date = new Date()
): boolean {
	if (target.remotePostId) return false;
	if (target.status !== 'publishing') return false;
	const updated = asTime(target.updatedAt);
	if (updated == null) return false;
	return now.getTime() - updated < STALE_CLAIM_MS;
}

/** Default grace is 0 — never fire early. Pass a positive window only for catch-up. */
export function selectDueScheduledTargets<T extends SchedulableTarget>(
	targets: T[],
	now: Date = new Date(),
	graceMs = 0
): T[] {
	return targets.filter((t) => {
		if (t.remotePostId) return false;
		const when = asTime(t.scheduledFor);
		if (when != null && when > now.getTime() + graceMs) return false;

		if (t.status === 'publishing') {
			const updated = asTime(t.updatedAt);
			if (updated == null) return false;
			return updated <= now.getTime() - STALE_CLAIM_MS;
		}

		if (!t.scheduledFor || when == null) return false;
		return t.status === 'scheduled' || t.status === 'pending';
	});
}
