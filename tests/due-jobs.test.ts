import { describe, expect, it } from 'vitest';
import { STALE_CLAIM_MS, isFreshPublishing, selectDueScheduledTargets } from '$lib/domain/due-jobs';

describe('selectDueScheduledTargets', () => {
	const now = new Date('2026-08-17T12:00:00Z');

	it('selects scheduled items that are due or past', () => {
		const due = selectDueScheduledTargets(
			[
				{ id: 'a', status: 'scheduled', scheduledFor: new Date('2026-08-17T11:00:00Z') },
				{ id: 'b', status: 'scheduled', scheduledFor: new Date('2026-08-17T18:00:00Z') },
				{ id: 'c', status: 'published', scheduledFor: new Date('2026-08-17T11:00:00Z') },
				{
					id: 'd',
					status: 'scheduled',
					scheduledFor: new Date('2026-08-17T11:00:00Z'),
					remotePostId: 'already'
				}
			],
			now
		);
		expect(due.map((t) => t.id)).toEqual(['a']);
	});

	it('includes items within an explicit grace window', () => {
		const due = selectDueScheduledTargets(
			[{ id: 'soon', status: 'scheduled', scheduledFor: new Date('2026-08-17T12:00:30Z') }],
			now,
			60_000
		);
		expect(due.map((t) => t.id)).toEqual(['soon']);
	});

	it('does not fire a minute early with the default grace', () => {
		const due = selectDueScheduledTargets(
			[{ id: 'later', status: 'scheduled', scheduledFor: new Date('2026-08-17T12:00:30Z') }],
			now
		);
		expect(due.map((t) => t.id)).toEqual([]);
	});

	it('selects stale publishing rows that are due', () => {
		const due = selectDueScheduledTargets(
			[
				{
					id: 'stale',
					status: 'publishing',
					scheduledFor: new Date('2026-08-17T11:00:00Z'),
					updatedAt: new Date('2026-08-17T11:40:00Z')
				},
				{
					id: 'fresh',
					status: 'publishing',
					scheduledFor: new Date('2026-08-17T11:00:00Z'),
					updatedAt: new Date('2026-08-17T11:50:00Z')
				}
			],
			now
		);
		expect(due.map((t) => t.id)).toEqual(['stale']);
	});

	it('reclaims stale publishing even without scheduledFor', () => {
		const due = selectDueScheduledTargets(
			[
				{
					id: 'stuck-now',
					status: 'publishing',
					scheduledFor: null,
					updatedAt: new Date('2026-08-17T11:40:00Z')
				},
				{
					id: 'fresh-now',
					status: 'publishing',
					scheduledFor: null,
					updatedAt: new Date('2026-08-17T11:50:00Z')
				}
			],
			now
		);
		expect(due.map((t) => t.id)).toEqual(['stuck-now']);
	});
});

describe('isFreshPublishing', () => {
	const now = new Date('2026-08-17T12:00:00Z');

	it('is true only for a recent publishing row without a remote id', () => {
		expect(
			isFreshPublishing({ status: 'publishing', updatedAt: new Date('2026-08-17T11:50:00Z') }, now)
		).toBe(true);
		expect(
			isFreshPublishing(
				{ status: 'publishing', updatedAt: new Date(now.getTime() - STALE_CLAIM_MS - 1) },
				now
			)
		).toBe(false);
		expect(
			isFreshPublishing({ status: 'publishing', updatedAt: now, remotePostId: 'at://already' }, now)
		).toBe(false);
		expect(isFreshPublishing({ status: 'pending', updatedAt: now }, now)).toBe(false);
		expect(isFreshPublishing({ status: 'publishing' }, now)).toBe(false);
	});
});
