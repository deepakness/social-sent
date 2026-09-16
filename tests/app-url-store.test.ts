import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppDb } from '$lib/server/db/client';
import { createTestDb } from '$lib/server/db/test';
import { readStoredAppUrl, rememberAppUrl, APP_URL_SETTING } from '$lib/server/app-settings';
import { appSettings } from '$lib/server/db/schema';

/**
 * The remembered origin is what a scheduled invocation has instead of a
 * request: the cron tick builds absolute links (media URLs, the failure
 * digest) from it, and nothing else can tell it where the deployment lives.
 */
describe('remembered app URL', () => {
	let db: AppDb;
	let close: () => void;
	let count: () => number;
	let reset: () => void;

	beforeAll(async () => {
		({ db, close, count, reset } = await createTestDb());
	});
	afterAll(() => close());

	it('is empty until a visit records it', async () => {
		expect(await readStoredAppUrl(db)).toBeNull();
	});

	it('records an origin, and reads it back from the cache', async () => {
		await rememberAppUrl(db, 'https://sent.acct.workers.dev');
		reset();
		expect(await readStoredAppUrl(db)).toBe('https://sent.acct.workers.dev');
		expect(count()).toBe(0);
	});

	it('updates the stored value when the instance moves', async () => {
		await rememberAppUrl(db, 'https://sent.example.com');
		reset();
		expect(await readStoredAppUrl(db)).toBe('https://sent.example.com');
		const rows = await db.select().from(appSettings);
		expect(rows.filter((row) => row.key === APP_URL_SETTING)).toHaveLength(1);
		expect(rows[0]?.value).toBe('https://sent.example.com');
	});

	it('ignores an empty origin', async () => {
		await rememberAppUrl(db, '');
		expect(await readStoredAppUrl(db)).toBe('https://sent.example.com');
	});
});
