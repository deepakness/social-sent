import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import type { AppEnv } from '../env';
import { memoryMediaStore } from '../media';
import * as schema from './schema';
import type { AppDb } from './client';

const here = dirname(fileURLToPath(import.meta.url));

export const TEST_ENV: AppEnv = {
	APP_URL: 'http://localhost:5173',
	APP_NAME: 'SocialSent',
	APP_ENCRYPTION_KEY: 'feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface',
	AUTH_SECRET: 'test-auth-secret-at-least-8',
	ADMIN_EMAIL: 'admin@localhost',
	ADMIN_PASSWORD: 'admin123',
	skipTotp: false,
	// The in-progress LinkedIn video path stays off in tests unless a test
	// opts in with { ...TEST_ENV, videoUploadEnabled: true }.
	videoUploadEnabled: false
};

export interface TestDb {
	db: AppDb;
	close: () => void;
	/** Statements executed so far — D1's per-invocation budget is counted, not timed. */
	count: () => number;
	reset: () => void;
}

export async function createTestDb(): Promise<TestDb> {
	const client = createClient({ url: ':memory:' });
	const dir = join(here, '../../../../drizzle');
	const files = readdirSync(dir)
		.filter((name) => name.endsWith('.sql'))
		.sort();
	for (const file of files) {
		await client.executeMultiple(readFileSync(join(dir, file), 'utf8'));
	}
	await client.execute('PRAGMA foreign_keys = ON');
	// Count like D1 does: a batch counts as its statements, not one round trip.
	let queries = 0;
	const orig = client.execute.bind(client);
	client.execute = (async (...args: Parameters<typeof orig>) => {
		queries += 1;
		return orig(...args);
	}) as typeof orig;
	const batchOrig = client.batch.bind(client) as (stmts: unknown[]) => Promise<unknown>;
	(client as unknown as Record<string, unknown>).batch = (async (stmts: unknown[]) => {
		queries += (stmts as unknown[]).length;
		return batchOrig(stmts as never);
	}) as typeof batchOrig;
	const db = drizzle(client, { schema }) as unknown as AppDb;
	return {
		db,
		close: () => client.close(),
		count: () => queries,
		reset: () => (queries = 0)
	};
}

export function createTestMedia() {
	return memoryMediaStore();
}
