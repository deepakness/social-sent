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
	skipTotp: false
};

export async function createTestDb(): Promise<{ db: AppDb; close: () => void }> {
	const client = createClient({ url: ':memory:' });
	const dir = join(here, '../../../../drizzle');
	const files = readdirSync(dir)
		.filter((name) => name.endsWith('.sql'))
		.sort();
	for (const file of files) {
		await client.executeMultiple(readFileSync(join(dir, file), 'utf8'));
	}
	await client.execute('PRAGMA foreign_keys = ON');
	const db = drizzle(client, { schema }) as unknown as AppDb;
	return {
		db,
		close: () => client.close()
	};
}

export function createTestMedia() {
	return memoryMediaStore();
}
