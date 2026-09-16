/**
 * Instance values that are discovered at runtime instead of configured.
 *
 * The one today is the public URL. It cannot be set at deploy time — the
 * Worker's hostname does not exist until it is deployed — so `hooks.server.ts`
 * records the origin from the first authenticated browser visit, and the
 * invocations that have no request of their own (the cron tick, queue
 * consumers) read it back here.
 *
 * Cached per database handle in module scope: a deployment that pins APP_URL
 * never reads at all, and one that does not should pay for it once per isolate
 * rather than once per request. The cache is keyed weakly so a stale value
 * cannot outlive the binding it came from (tests, hot reloads).
 */
import { eq } from 'drizzle-orm';
import { first, type AppDb } from './db/client';
import { appSettings } from './db/schema';

export const APP_URL_SETTING = 'app_url';

type CacheKey = object;

const cache = new WeakMap<CacheKey, string | null>();

/** The drizzle handle is rebuilt per request; the D1 binding behind it is not. */
function cacheKey(db: AppDb): CacheKey | null {
	const session = (db as unknown as { session?: { client?: unknown } }).session;
	const client = session?.client;
	return client && typeof client === 'object' ? (client as CacheKey) : null;
}

/** The remembered origin, or null when nothing has been recorded yet. */
export async function readStoredAppUrl(db: AppDb): Promise<string | null> {
	const key = cacheKey(db);
	if (key) {
		const cached = cache.get(key);
		if (cached !== undefined) return cached;
	}
	try {
		const row = await first(
			db.select().from(appSettings).where(eq(appSettings.key, APP_URL_SETTING))
		);
		const value = row?.value ?? null;
		if (key) cache.set(key, value);
		return value;
	} catch {
		// Schema not bootstrapped yet, or an older database without the table:
		// "nothing recorded" is a valid answer, not an error.
		return null;
	}
}

/** Record the origin the instance is actually served from. Best effort. */
export async function rememberAppUrl(db: AppDb, url: string): Promise<void> {
	if (!url) return;
	const key = cacheKey(db);
	if (key && cache.get(key) === url) return;
	if (key) cache.set(key, url);
	try {
		await db
			.insert(appSettings)
			.values({ key: APP_URL_SETTING, value: url, updatedAt: new Date() })
			.onConflictDoUpdate({
				target: appSettings.key,
				set: { value: url, updatedAt: new Date() }
			});
	} catch {
		// Non-fatal, and not remembered: the next request derives the same URL
		// again and retries the write.
		if (key) cache.delete(key);
	}
}
