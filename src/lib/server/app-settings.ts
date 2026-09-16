/**
 * Instance values that are discovered or set at runtime instead of at deploy
 * time.
 *
 * Two live here: the public URL (recorded from the first signed-in visit, so a
 * deployment does not have to know its own hostname before it exists) and the
 * display name (set in Settings → Instance, so renaming an instance is a form
 * field rather than a redeploy).
 *
 * Cached per database handle in module scope: a deployment that pins APP_URL
 * never reads for it, and everything else should pay once per isolate rather
 * than once per request. The cache is keyed weakly so a stale value cannot
 * outlive the binding it came from (tests, hot reloads).
 */
import { eq } from 'drizzle-orm';
import { first, type AppDb } from './db/client';
import { appSettings } from './db/schema';

export const APP_URL_SETTING = 'app_url';
export const APP_NAME_SETTING = 'app_name';

type CacheKey = object;

const cache = new WeakMap<CacheKey, Map<string, string | null>>();

/** The drizzle handle is rebuilt per request; the D1 binding behind it is not. */
function cacheKey(db: AppDb): CacheKey | null {
	const session = (db as unknown as { session?: { client?: unknown } }).session;
	const client = session?.client;
	return client && typeof client === 'object' ? (client as CacheKey) : null;
}

function memoFor(db: AppDb): Map<string, string | null> | null {
	const key = cacheKey(db);
	if (!key) return null;
	const existing = cache.get(key);
	if (existing) return existing;
	const created = new Map<string, string | null>();
	cache.set(key, created);
	return created;
}

/** A stored value, or null when it is missing or blank. */
async function readSetting(db: AppDb, key: string): Promise<string | null> {
	const memo = memoFor(db);
	const cached = memo?.get(key);
	if (cached !== undefined) return cached;
	try {
		const row = await first(db.select().from(appSettings).where(eq(appSettings.key, key)));
		const value = row?.value?.trim() ? row.value : null;
		memo?.set(key, value);
		return value;
	} catch {
		// Schema not bootstrapped yet, or an older database without the table:
		// "nothing recorded" is a valid answer, not an error.
		return null;
	}
}

/** Store a value, or clear it when blank. Best effort. */
async function writeSetting(db: AppDb, key: string, value: string): Promise<void> {
	const stored = value.trim();
	const memo = memoFor(db);
	if (memo?.get(key) === (stored || null)) return;
	memo?.set(key, stored || null);
	try {
		await db
			.insert(appSettings)
			.values({ key, value: stored, updatedAt: new Date() })
			.onConflictDoUpdate({
				target: appSettings.key,
				set: { value: stored, updatedAt: new Date() }
			});
	} catch {
		// Non-fatal, and not remembered: the next request retries the write.
		memo?.delete(key);
	}
}

/** The remembered origin, or null when nothing has been recorded yet. */
export function readStoredAppUrl(db: AppDb): Promise<string | null> {
	return readSetting(db, APP_URL_SETTING);
}

/** Record the origin the instance is actually served from. */
export function rememberAppUrl(db: AppDb, url: string): Promise<void> {
	if (!url) return Promise.resolve();
	return writeSetting(db, APP_URL_SETTING, url);
}

/** The instance name set in Settings → Instance, or null for the default. */
export function readStoredAppName(db: AppDb): Promise<string | null> {
	return readSetting(db, APP_NAME_SETTING);
}

/** Store the instance name; a blank value falls back to the default. */
export function rememberAppName(db: AppDb, name: string): Promise<void> {
	return writeSetting(db, APP_NAME_SETTING, name);
}
