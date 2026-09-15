import { describe, expect, it } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { ensureSchema, ensureSchemaOnce, INIT_SQL } from '$lib/server/db/init-sql';

/**
 * The bootstrap DDL is what a cold Worker runs before anything else, and until
 * now no test executed a single one of its statements. Running it against real
 * SQLite (via the same libsql driver the other tests use) proves the SQL is
 * valid, creates the tables the app queries, and stays idempotent on the
 * migration path an existing database takes.
 */
function d1Shim(client: Client): D1Database {
	const run = (sql: string, args: unknown[] = []) =>
		client.execute({ sql, args: args as never }) as Promise<unknown>;
	return {
		exec: (sql: string) => client.executeMultiple(sql) as unknown as Promise<unknown>,
		prepare: (sql: string) => {
			const stmt = (bindArgs: unknown[] = []) => ({
				run: () => run(sql, bindArgs),
				all: async () => {
					const res = (await client.execute({ sql, args: bindArgs as never })) as {
						rows: unknown[];
					};
					return { results: res.rows, success: true, meta: {} };
				},
				first: async () => {
					const res = (await client.execute({ sql, args: bindArgs as never })) as {
						rows: unknown[];
					};
					return res.rows[0] ?? null;
				},
				bind: (...args: unknown[]) => stmt(args)
			});
			return stmt();
		}
	} as unknown as D1Database;
}

async function freshDb() {
	const client = createClient({ url: ':memory:' });
	return { client, binding: d1Shim(client) };
}

async function tableNames(client: Client): Promise<string[]> {
	const res = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
	return res.rows.map((r) => String((r as unknown as { name: string }).name));
}

describe('ensureSchema', () => {
	it('creates the full schema on an empty database', async () => {
		const { client, binding } = await freshDb();
		await ensureSchema(binding);

		const names = await tableNames(client);
		for (const table of [
			'users',
			'drafts',
			'draft_variants',
			'draft_media',
			'connections',
			'publish_targets',
			'publish_attempts',
			'sessions',
			'oauth_pending',
			'api_keys',
			'mfa_challenges',
			'totp_backup_codes',
			'notification_state'
		]) {
			expect(names).toContain(table);
		}
		client.close();
	});

	it('is idempotent, including the migration path', async () => {
		const { client, binding } = await freshDb();
		await ensureSchema(binding);
		// Second call takes the "users already exists" branch: column adds,
		// the rewritten DDL, index creation and the unique-index dance.
		await expect(ensureSchema(binding)).resolves.toBeUndefined();
		const names = await tableNames(client);
		expect(names.filter((n) => n === 'publish_targets')).toHaveLength(1);

		const indexes = await client.execute(
			"SELECT name FROM sqlite_master WHERE type='index' AND name='publish_targets_draft_conn_idx'"
		);
		expect(indexes.rows).toHaveLength(1);
		client.close();
	});

	it('runs the bootstrap once per binding and retries after a failure', async () => {
		const { client, binding } = await freshDb();
		let calls = 0;
		const counting = new Proxy(binding as unknown as Record<string, unknown>, {
			get(target, prop, receiver) {
				if (prop === 'prepare') {
					return (sql: string) => {
						calls += 1;
						return (target.prepare as (s: string) => unknown).call(target, sql);
					};
				}
				return Reflect.get(target, prop, receiver);
			}
		}) as unknown as D1Database;

		await ensureSchemaOnce(counting);
		const first = calls;
		expect(first).toBeGreaterThan(0);
		// Memoized: the second request in the same isolate does no DDL.
		await ensureSchemaOnce(counting);
		expect(calls).toBe(first);
		client.close();

		// A failure must not be cached, or a transient D1 error would wedge the
		// isolate for its whole lifetime.
		let attempts = 0;
		const failing = {
			exec: async () => {},
			prepare: () => {
				attempts += 1;
				return {
					run: async () => {},
					all: async () => ({ results: [] }),
					first: async () => {
						throw new Error('D1_ERROR: unavailable');
					},
					bind: () => ({ run: async () => {}, all: async () => ({ results: [] }) })
				};
			}
		} as unknown as D1Database;
		await expect(ensureSchemaOnce(failing)).rejects.toThrow(/D1_ERROR/);
		await expect(ensureSchemaOnce(failing)).rejects.toThrow(/D1_ERROR/);
		expect(attempts).toBeGreaterThan(1);
	});

	it('keeps the bootstrap DDL statement-splittable', async () => {
		// execStatements splits on `;`, so a stray semicolon inside a literal
		// would break one statement into fragments.
		expect(INIT_SQL).not.toMatch(/;\s*;/);
		const statements = INIT_SQL.split(';').filter((s) => s.trim().length > 0);
		expect(statements.length).toBeGreaterThan(10);
		for (const statement of statements) {
			expect(statement.trim().toUpperCase()).toMatch(/^(CREATE|INSERT|DROP|ALTER)/);
		}
	});
});
