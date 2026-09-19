import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	bucketWasListed,
	countUnappliedMigrations,
	evaluateConfig,
	formatReport,
	healthVerdict,
	parseD1List,
	parseSecretNames,
	readDevVars,
	schedulerVerdict,
	summarize
} from '../scripts/doctor.mjs';

/**
 * `npm run doctor` is the first thing a stuck self-hoster runs, so its
 * judgements are pinned here: the checks are pure functions over command
 * output, and the CLI only prints them.
 */
const goodConfig = {
	name: 'socialsent',
	d1_databases: [{ binding: 'DB', database_name: 'socialsent', database_id: '' }],
	r2_buckets: [{ binding: 'MEDIA', bucket_name: 'socialsent-media' }],
	triggers: { crons: ['* * * * *'] }
};

const ids = (checks: { id: string }[]) => checks.map((c) => c.id);

describe('config checks', () => {
	it('passes a config that has everything the app needs', () => {
		const checks = evaluateConfig(goodConfig, { configFile: 'wrangler.jsonc' });
		expect(summarize(checks)).toEqual({ failed: 0, warnings: 0, ok: 4, skipped: 0 });
		expect(checks.find((c) => c.id === 'd1-binding')?.detail).toMatch(/creates or adopts/);
	});

	it('fails without a Worker name, and flags a missing binding', () => {
		const checks = evaluateConfig({ d1_databases: [], r2_buckets: [] });
		expect(checks.find((c) => c.id === 'config')?.status).toBe('fail');
		expect(checks.find((c) => c.id === 'd1-binding')?.status).toBe('fail');
		expect(checks.find((c) => c.id === 'r2-binding')?.status).toBe('warn');
	});

	it('warns when nothing would run the schedule', () => {
		const checks = evaluateConfig({ ...goodConfig, triggers: { crons: [] } });
		const cron = checks.find((c) => c.id === 'cron');
		expect(cron?.status).toBe('warn');
		expect(cron?.fix).toMatch(/triggers/);
	});

	it('fails when the local .dev.vars still carries the example key', () => {
		const devVars = new Map([
			['APP_ENCRYPTION_KEY', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef']
		]);
		const local = evaluateConfig(goodConfig, { devVars }).find((c) => c.id === 'local-key');
		expect(local?.status).toBe('warn');
		expect(local?.detail).toMatch(/localhost works/);

		const real = new Map([['APP_ENCRYPTION_KEY', 'a'.repeat(64)]]);
		expect(
			evaluateConfig(goodConfig, { devVars: real }).find((c) => c.id === 'local-key')?.status
		).toBe('ok');
		expect(
			evaluateConfig(goodConfig, { devVars: new Map() }).find((c) => c.id === 'local-key')?.status
		).toBe('warn');
	});
});

describe('command output parsing', () => {
	it('reads secret names and tolerates junk', () => {
		expect(
			parseSecretNames(JSON.stringify([{ name: 'APP_ENCRYPTION_KEY' }, { name: 'API_TOKEN' }]))
		).toEqual(['APP_ENCRYPTION_KEY', 'API_TOKEN']);
		expect(parseSecretNames('not json')).toBeNull();
		expect(parseSecretNames('{"name":"nope"}')).toBeNull();
	});

	it('reads the D1 list and returns [] for junk', () => {
		expect(parseD1List(JSON.stringify([{ name: 'socialsent', uuid: 'abc' }]))).toHaveLength(1);
		expect(parseD1List('boom')).toEqual([]);
	});

	it('finds a bucket name in the table output without matching substrings', () => {
		const table = 'name           creation_date\nsocialsent-media  2026-01-01\n';
		expect(bucketWasListed(table, 'socialsent-media')).toBe(true);
		expect(bucketWasListed(table, 'socialsent')).toBe(false);
		expect(bucketWasListed('', 'socialsent-media')).toBe(false);
	});

	it('counts unapplied migrations', () => {
		expect(countUnappliedMigrations('✅ No migrations to apply!')).toBe(0);
		expect(
			countUnappliedMigrations('Migrations to be applied:\n0001_init.sql\n0002_totp.sql\n')
		).toBe(2);
		// The same file listed twice (table + summary) is one migration.
		expect(
			countUnappliedMigrations('Migrations to be applied:\n0001_init.sql\n0001_init.sql')
		).toBe(1);
		expect(countUnappliedMigrations('something else entirely')).toBeNull();
	});
});

describe('health verdict', () => {
	it('treats a 200 as healthy', () => {
		expect(healthVerdict(200, '{"ok":true}')).toMatchObject({ status: 'ok' });
	});

	it('recognises our own not-configured guard and offers the fix', () => {
		const verdict = healthVerdict(
			503,
			'This deployment is not configured: Invalid environment: APP_ENCRYPTION_KEY must not be an example value. Set real Worker secrets...'
		);
		expect(verdict.status).toBe('fail');
		expect(verdict.fix).toMatch(/secrets:put/);
	});

	it('warns on anything else without pretending to know why', () => {
		expect(healthVerdict(502, '<html>gateway</html>')).toMatchObject({ status: 'warn' });
	});
});

describe('scheduler verdict', () => {
	const health = (over: Record<string, unknown> = {}) => ({
		ok: true,
		lastTickAt: '2026-09-17T06:40:00.000Z',
		neverTicked: false,
		message: 'Scheduled publishing is on time',
		deployCron: { status: 'attached', code: null, updatedAt: '2026-09-17T06:30:00.000Z' },
		...over
	});

	it('passes when ticks arrive', () => {
		const check = schedulerVerdict(200, health());
		expect(check.status).toBe('ok');
		expect(check.detail).toContain('2026-09-17');
	});

	it('fails when the deploy could not attach the trigger', () => {
		// The one case worth a non-zero exit: scheduled posts silently wait.
		const check = schedulerVerdict(
			200,
			health({
				ok: false,
				lastTickAt: null,
				neverTicked: true,
				deployCron: { status: 'unavailable', code: '10072', updatedAt: null }
			})
		);
		expect(check.status).toBe('fail');
		expect(check.label).toContain('10072');
		expect(check.fix).toContain('Settings');
	});

	it('warns when no trigger is configured, or nothing has ticked yet', () => {
		expect(
			schedulerVerdict(
				200,
				health({
					ok: false,
					lastTickAt: null,
					neverTicked: true,
					deployCron: { status: 'disabled', code: null, updatedAt: null }
				})
			).status
		).toBe('warn');
		expect(
			schedulerVerdict(
				200,
				health({ ok: false, lastTickAt: null, neverTicked: true, deployCron: null })
			).label
		).toContain('No tick');
	});

	it('warns when the scheduler went quiet after ticking', () => {
		const check = schedulerVerdict(200, health({ ok: false }));
		expect(check.status).toBe('warn');
		expect(check.detail).toContain('2026-09-17');
	});

	it('explains a rejected probe instead of guessing', () => {
		expect(schedulerVerdict(401, {}).fix).toContain('API_TOKEN');
		expect(schedulerVerdict(500, {}).status).toBe('skip');
	});
});

describe('report', () => {
	it('prints every check with its fix, then the summary', () => {
		const report = formatReport([
			{ id: 'a', status: 'ok', label: 'fine' },
			{ id: 'b', status: 'warn', label: 'meh', detail: 'why', fix: 'do this' },
			{ id: 'c', status: 'fail', label: 'broken', fix: 'do that' }
		]);
		expect(report).toContain('✓ fine');
		expect(report).toContain('    fix: do this');
		expect(report).toContain('✗ broken');
		expect(report).toContain('1 ok · 1 warning · 1 failure');
		expect(report).toContain('Nothing was changed.');
	});

	it('pluralises the summary correctly', () => {
		expect(formatReport([{ id: 'a', status: 'ok', label: 'x' }])).toContain(
			'1 ok · 0 warnings · 0 failures'
		);
	});
});

describe('dev vars parsing', () => {
	it('reads values from the committed fixture', () => {
		const values = readDevVars('tests/e2e/fixtures/dev.vars');
		expect(values.get('ADMIN_EMAIL')).toBe('admin@example.com');
		expect(values.get('APP_ENCRYPTION_KEY')).toMatch(/^deadbeef/);
		expect(values.get('SKIP_TOTP')).toBe('1');
	});

	it('strips quotes and trailing comments, and skips blank values', () => {
		const file = join(tmpdir(), `socialsent-doctor-${process.pid}.vars`);
		writeFileSync(
			file,
			[
				'# a comment',
				'QUOTED="a value" # trailing',
				"SINGLE='another'",
				'BLANK=',
				'SPACED=   padded   '
			].join('\n')
		);
		try {
			const values = readDevVars(file);
			expect(values.get('QUOTED')).toBe('a value');
			expect(values.get('SINGLE')).toBe('another');
			expect(values.has('BLANK')).toBe(false);
			expect(values.get('SPACED')).toBe('padded');
		} finally {
			rmSync(file, { force: true });
		}
	});

	it('returns an empty map for a file that does not exist', () => {
		expect([...readDevVars('tests/e2e/fixtures/nope.vars').keys()]).toEqual([]);
	});
});

describe('check ids stay stable', () => {
	it('produces the documented set for a healthy config', () => {
		expect(ids(evaluateConfig(goodConfig, { configFile: 'x.jsonc' }))).toEqual([
			'config',
			'd1-binding',
			'r2-binding',
			'cron'
		]);
	});
});
