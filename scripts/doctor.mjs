#!/usr/bin/env node
/**
 * Read-only preflight for a deployment: everything `npm run setup` would check,
 * without changing anything.
 *
 * Run it before a first deploy, or whenever the app misbehaves. It never
 * writes to Cloudflare, never applies migrations and never sets a secret — the
 * only network calls are reads, plus an unauthenticated GET of the app's own
 * `/api/health` when a URL is known.
 *
 * Usage:
 *   npm run doctor
 *   npm run doctor -- --app-url https://sent.example.com
 *
 * Exit code is 1 when something is broken (✗), 0 when only warnings (!) or
 * everything passed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * @typedef {{ id: string, status: 'ok' | 'warn' | 'fail' | 'skip', label: string, detail?: string, fix?: string }} Check
 * @typedef {{ status: number, stdout: string, stderr: string }} RunResult
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PERSONAL_CONFIG = 'wrangler.personal.jsonc';
const COMMITTED_CONFIG = 'wrangler.jsonc';
const DEV_VARS = '.dev.vars';
const MIN_NODE = [22, 12, 0];

/** Example values that must never reach a deployment (see src/lib/server/env.ts). */
const PLACEHOLDER_SECRETS = new Set([
	'change-me',
	'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
	'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
	'dev-auth-secret-change-me',
	'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
]);

/** Minimal JSONC reader: the configs carry comments. */
/** @param {string} file @returns {any} */
export function readJsonc(file) {
	const text = readFileSync(file, 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/.*$/gm, '$1')
		.replace(/,(\s*[}\]])/g, '$1');
	return JSON.parse(text);
}

/** `.dev.vars` values as dotenv would read them: unquoted, comments stripped. */
/** @param {string} file @returns {Map<string, string>} */
export function readDevVars(file) {
	const values = new Map();
	if (!existsSync(file)) return values;
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
		if (!match) continue;
		let raw = match[2].trim();
		// Strip a trailing comment first, then unquote: dotenv accepts
		// `KEY="value" # comment`, and the value is the quoted part.
		const comment = raw.search(/\s+#/);
		if (comment !== -1) raw = raw.slice(0, comment).trim();
		if (/^".*"$/.test(raw) || /^'.*'$/.test(raw)) raw = raw.slice(1, -1);
		if (raw) values.set(match[1], raw);
	}
	return values;
}

/** Everything that can be judged from the files alone. */
/**
 * @param {any} config
 * @param {{ configFile?: string, devVars?: Map<string, string> | null }} [options]
 * @returns {Check[]}
 */
export function evaluateConfig(config, { configFile, devVars } = {}) {
	/** @type {Check[]} */
	const checks = [];
	const name = config?.name;
	checks.push(
		name
			? { id: 'config', status: 'ok', label: `Worker name: ${name}`, detail: configFile }
			: {
					id: 'config',
					status: 'fail',
					label: 'No Worker name in the config',
					fix: `Set "name" in ${configFile ?? COMMITTED_CONFIG}`
				}
	);

	const d1 = config?.d1_databases?.[0];
	if (!d1?.binding) {
		checks.push({
			id: 'd1-binding',
			status: 'fail',
			label: 'No D1 binding',
			fix: 'Add a d1_databases entry with binding "DB"'
		});
	} else if (d1.database_id) {
		checks.push({ id: 'd1-binding', status: 'ok', label: `D1 binding DB → ${d1.database_name}` });
	} else {
		checks.push({
			id: 'd1-binding',
			status: 'ok',
			label: `D1 binding DB → ${d1.database_name ?? '(named by Wrangler)'}`,
			detail: 'no database_id: Wrangler creates or adopts it on deploy'
		});
	}

	const bucket = config?.r2_buckets?.[0];
	checks.push(
		bucket?.bucket_name
			? { id: 'r2-binding', status: 'ok', label: `R2 binding MEDIA → ${bucket.bucket_name}` }
			: {
					id: 'r2-binding',
					status: 'warn',
					label: 'R2 binding has no bucket_name',
					detail: 'Wrangler derives one from the Worker name',
					fix: 'Set bucket_name so every path uses the same bucket'
				}
	);

	const crons = config?.triggers?.crons ?? [];
	checks.push(
		crons.length > 0
			? {
					id: 'cron',
					status: 'ok',
					label: `Cron trigger: ${crons.join(', ')}`,
					detail: 'one of the five per account the Workers free plan allows'
				}
			: {
					id: 'cron',
					status: 'warn',
					label: 'No cron trigger configured',
					detail: 'scheduled posts will not fire by themselves',
					fix: 'Add "triggers": { "crons": ["* * * * *"] }, or point an external cron at POST /api/internal/tick using the token from Settings -> Scheduled publishing'
				}
	);

	const key = devVars?.get('APP_ENCRYPTION_KEY');
	if (!devVars) {
		// No local file: nothing to judge, and that is normal for a deployment.
	} else if (!key) {
		checks.push({
			id: 'local-key',
			status: 'warn',
			label: `${DEV_VARS} has no APP_ENCRYPTION_KEY`,
			detail: 'local dev and `npm run secrets:put` need one',
			fix: 'openssl rand -hex 32 → APP_ENCRYPTION_KEY in .dev.vars'
		});
	} else if (PLACEHOLDER_SECRETS.has(key)) {
		// Fine for localhost, refused on a real host (env.ts), so it never breaks
		// a deployment — it just must not be the value that gets deployed.
		checks.push({
			id: 'local-key',
			status: 'warn',
			label: `${DEV_VARS} has the example APP_ENCRYPTION_KEY`,
			detail: 'localhost works with it; a deployment refuses it',
			fix: 'openssl rand -hex 32 → replace APP_ENCRYPTION_KEY in .dev.vars before deploying'
		});
	} else {
		checks.push({ id: 'local-key', status: 'ok', label: `${DEV_VARS} has an APP_ENCRYPTION_KEY` });
	}

	return checks;
}

/** Names from `wrangler secret list --json`, or null when the output is unusable. */
/** @param {string} stdout @returns {string[] | null} */
export function parseSecretNames(stdout) {
	try {
		const parsed = JSON.parse(stdout);
		if (!Array.isArray(parsed)) return null;
		return parsed.map((entry) => entry?.name).filter((name) => typeof name === 'string');
	} catch {
		return null;
	}
}

/** Databases from `wrangler d1 list --json`; [] when the output is unusable. */
/** @param {string} stdout @returns {any[]} */
export function parseD1List(stdout) {
	try {
		const parsed = JSON.parse(stdout);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/** AWS-style table output: look for the bucket name as a whole token. */
/** @param {string} stdout @param {string | undefined} bucketName @returns {boolean} */
export function bucketWasListed(stdout, bucketName) {
	if (!bucketName) return false;
	return new RegExp(
		`(^|[^\\w-])${bucketName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`
	).test(stdout);
}

/** Number of unapplied migrations from `wrangler d1 migrations list` output. */
/** @param {string} stdout @returns {number | null} */
export function countUnappliedMigrations(stdout) {
	if (/No migrations to apply/i.test(stdout)) return 0;
	if (!/Migrations to be applied/i.test(stdout)) return null;
	return new Set(stdout.match(/[\w.-]+\.sql/g) ?? []).size;
}

/**
 * What a `/api/health` response means. A 503 carrying our own configuration
 * message is the placeholder-secret guard firing, which is a failure with a
 * fix; any other non-200 is a warning (network, proxy, wrong URL).
 */
/** @param {number} status @param {string} [body] @returns {Check} */
export function healthVerdict(status, body = '') {
	if (status === 200) return { id: 'app', status: 'ok', label: 'Deployment answers /api/health' };
	if (status === 503 && /Invalid environment|not configured/i.test(body)) {
		const detail = body.replace(/\s+/g, ' ').trim().slice(0, 200);
		return {
			id: 'app',
			status: 'fail',
			label: 'The deployment is up but not configured',
			detail,
			fix: 'Set real Worker secrets (`npm run secrets:put`), then redeploy'
		};
	}
	return {
		id: 'app',
		status: 'warn',
		label: `Deployment answered HTTP ${status}`,
		detail: body.replace(/\s+/g, ' ').trim().slice(0, 120) || undefined
	};
}

/**
 * What a `/api/scheduler/health` response means.
 *
 * The app cannot read its own cron schedule, so this is inference plus the note
 * the last deploy left in D1: a deployment whose trigger was refused (error
 * 10072) is the one case worth failing the run over, because scheduled posts
 * will silently wait for a tick that never comes.
 */
/** @param {number} status @param {any} body @returns {Check} */
export function schedulerVerdict(status, body = {}) {
	if (status === 401 || status === 403) {
		return {
			id: 'scheduler',
			status: 'warn',
			label: `Scheduler probe rejected (HTTP ${status})`,
			fix: 'API_TOKEN in .dev.vars must match the Worker secret of the same name'
		};
	}
	if (status !== 200) {
		return {
			id: 'scheduler',
			status: 'skip',
			label: `Scheduler check skipped (HTTP ${status})`
		};
	}
	const deploy = body?.deployCron ?? null;
	const lastTick = body?.lastTickAt ? new Date(body.lastTickAt) : null;
	if (body?.ok) {
		return {
			id: 'scheduler',
			status: 'ok',
			label: 'Scheduler ticks are arriving',
			detail:
				lastTick && !Number.isNaN(lastTick.getTime())
					? `last tick ${lastTick.toISOString()}`
					: undefined
		};
	}
	if (deploy?.status === 'unavailable') {
		return {
			id: 'scheduler',
			status: 'fail',
			label: `No cron trigger on the Worker${deploy.code ? ` (Cloudflare error ${deploy.code})` : ''}`,
			detail:
				'the last deploy was refused a schedule: the account is at its cron-trigger limit, so scheduled posts are not being published',
			fix: 'Free a trigger slot (another Worker -> Settings -> Trigger events), upgrade to Workers Paid, or point an external cron at POST /api/internal/tick with the token from Settings -> Scheduled publishing'
		};
	}
	if (deploy?.status === 'disabled') {
		return {
			id: 'scheduler',
			status: 'warn',
			label: 'No cron trigger is configured',
			detail: 'scheduled posts only publish when something calls the tick',
			fix: 'Add "triggers": { "crons": ["* * * * *"] } to the config, or use an external cron with the token from Settings -> Scheduled publishing'
		};
	}
	if (body?.neverTicked) {
		return {
			id: 'scheduler',
			status: 'warn',
			label: 'No tick has arrived yet',
			detail: 'nothing has published a scheduled post on this deployment',
			fix: 'Check the Worker cron trigger (Settings -> Trigger events), or use an external cron with the token from Settings -> Scheduled publishing'
		};
	}
	return {
		id: 'scheduler',
		status: 'warn',
		label: 'The scheduler has gone quiet',
		detail:
			lastTick && !Number.isNaN(lastTick.getTime())
				? `last tick ${lastTick.toISOString()}`
				: undefined,
		fix: 'Check the Worker cron trigger (Settings -> Trigger events), or point an external cron at POST /api/internal/tick'
	};
}

/** Counts for the closing line. */
/** @param {Check[]} checks @returns {{ failed: number, warnings: number, ok: number, skipped: number }} */
export function summarize(checks) {
	return {
		failed: checks.filter((c) => c.status === 'fail').length,
		warnings: checks.filter((c) => c.status === 'warn').length,
		ok: checks.filter((c) => c.status === 'ok').length,
		skipped: checks.filter((c) => c.status === 'skip').length
	};
}

/** @type {Record<Check['status'], string>} */
const SYMBOL = { ok: '✓', warn: '!', fail: '✗', skip: '–' };

/** Human report. Returns the text; the caller decides the exit code. */
/** @param {Check[]} checks @returns {string} */
export function formatReport(checks) {
	const lines = [];
	for (const check of checks) {
		lines.push(`${SYMBOL[check.status] ?? '?'} ${check.label}`);
		if (check.detail) lines.push(`    ${check.detail}`);
		if (check.fix) lines.push(`    fix: ${check.fix}`);
	}
	const { failed, warnings, ok, skipped } = summarize(checks);
	lines.push('');
	lines.push(
		`${ok} ok · ${warnings} warning${warnings === 1 ? '' : 's'} · ${failed} failure${failed === 1 ? '' : 's'}${skipped ? ` · ${skipped} skipped` : ''}`
	);
	lines.push('Nothing was changed.');
	return lines.join('\n');
}

/**
 * Run a command through the repo wrapper, captured and bounded.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ timeout?: number }} [options]
 * @returns {RunResult}
 */
function run(command, args, { timeout = 90_000 } = {}) {
	const result = spawnSync(command, args, { encoding: 'utf8', timeout });
	return {
		status: result.status ?? -1,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? ''
	};
}

/** @param {string[]} args @param {{ timeout?: number }} [opts] @returns {RunResult} */
const wrangler = (args, opts) => run('node', ['scripts/wrangler.mjs', ...args], opts);

/** @returns {Check} */
function checkNode() {
	const [major, minor, patch] = process.versions.node.split('.').map(Number);
	const tooOld =
		major < MIN_NODE[0] ||
		(major === MIN_NODE[0] &&
			(minor < MIN_NODE[1] || (minor === MIN_NODE[1] && patch < MIN_NODE[2])));
	return tooOld
		? {
				id: 'node',
				status: 'fail',
				label: `Node ${process.versions.node} is too old`,
				fix: `Install Node ${MIN_NODE.join('.')} or newer`
			}
		: { id: 'node', status: 'ok', label: `Node ${process.versions.node}` };
}

/** @param {string} appUrl @returns {Promise<Check>} */
async function probeApp(appUrl) {
	try {
		const res = await fetch(`${appUrl.replace(/\/$/, '')}/api/health`, {
			signal: AbortSignal.timeout(10_000)
		});
		const body = await res.text().catch(() => '');
		return healthVerdict(res.status, body);
	} catch (err) {
		return {
			id: 'app',
			status: 'warn',
			label: `Could not reach ${appUrl}`,
			detail: err instanceof Error ? err.message : String(err)
		};
	}
}

async function main() {
	const argv = process.argv.slice(2);
	/** @param {string} name @returns {string | undefined} */
	const flag = (name) => {
		const i = argv.indexOf(name);
		return i >= 0 ? argv[i + 1] : undefined;
	};

	const configFile = existsSync(PERSONAL_CONFIG) ? PERSONAL_CONFIG : COMMITTED_CONFIG;
	const devVars = existsSync(resolve(root, DEV_VARS)) ? readDevVars(resolve(root, DEV_VARS)) : null;
	const checks = [checkNode()];

	let config = null;
	try {
		config = readJsonc(resolve(root, configFile));
	} catch (err) {
		checks.push({
			id: 'config',
			status: 'fail',
			label: `Could not read ${configFile}`,
			detail: err instanceof Error ? err.message : String(err)
		});
	}
	if (config) checks.push(...evaluateConfig(config, { configFile, devVars }));

	const who = wrangler(['whoami', '--json'], { timeout: 60_000 });
	/** @type {any} */
	let account = null;
	try {
		account = JSON.parse(who.stdout);
	} catch {
		// Not JSON: the command failed, so this reads as signed out.
	}
	if (!account?.loggedIn) {
		checks.push({
			id: 'login',
			status: 'fail',
			label: 'Not signed in to Cloudflare',
			fix: 'npx wrangler login (or set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID)'
		});
	} else {
		checks.push({
			id: 'login',
			status: 'ok',
			label: `Signed in as ${account.email ?? '(unknown)'} → ${(account.accounts ?? [])
				.map((/** @type {any} */ a) => a.name)
				.join(', ')}`
		});
	}

	const d1Name = config?.d1_databases?.[0]?.database_name;
	const d1Id = config?.d1_databases?.[0]?.database_id;
	const binding = config?.d1_databases?.[0]?.binding ?? 'DB';
	const bucket = config?.r2_buckets?.[0]?.bucket_name;

	if (account?.loggedIn) {
		const listed = wrangler(['d1', 'list', '--json'], { timeout: 60_000 });
		const databases = parseD1List(listed.stdout);
		const found = databases.find((db) => (d1Id ? db.uuid === d1Id : db.name === d1Name));
		checks.push(
			found
				? { id: 'd1', status: 'ok', label: `D1 database ${found.name} exists` }
				: d1Id
					? {
							id: 'd1',
							status: 'fail',
							label: `D1 id ${d1Id} is not in this account`,
							fix: 'Check the account/profile, or put the right database_id in the config'
						}
					: {
							id: 'd1',
							status: 'warn',
							label: `D1 database ${d1Name ?? '(unnamed)'} does not exist yet`,
							detail: 'Wrangler creates it on the next deploy',
							fix: 'npm run deploy'
						}
		);

		const buckets = wrangler(['r2', 'bucket', 'list'], { timeout: 60_000 });
		if (buckets.status !== 0) {
			checks.push({
				id: 'r2',
				status: 'warn',
				label: 'Could not list R2 buckets',
				detail: (buckets.stderr || buckets.stdout).trim().split('\n')[0] || undefined,
				fix: 'R2 may not be enabled on this account (it needs a payment method on file)'
			});
		} else if (!bucket) {
			checks.push({
				id: 'r2',
				status: 'skip',
				label: 'R2 bucket check skipped (no bucket_name in the config)'
			});
		} else {
			checks.push(
				bucketWasListed(buckets.stdout, bucket)
					? { id: 'r2', status: 'ok', label: `R2 bucket ${bucket} exists` }
					: {
							id: 'r2',
							status: 'warn',
							label: `R2 bucket ${bucket} does not exist yet`,
							detail: 'Wrangler creates it on the next deploy',
							fix: 'npm run deploy (names are global, so change it if the deploy reports a conflict)'
						}
			);
		}

		const secrets = wrangler(['secret', 'list', '--json'], { timeout: 60_000 });
		const names = parseSecretNames(secrets.stdout);
		if (!names) {
			checks.push({
				id: 'secrets',
				status: 'warn',
				label: 'Could not read the Worker secret list',
				detail: 'the Worker may not exist yet',
				fix: 'npm run deploy'
			});
		} else {
			checks.push(
				names.includes('APP_ENCRYPTION_KEY')
					? { id: 'secrets', status: 'ok', label: 'Worker secret APP_ENCRYPTION_KEY is set' }
					: {
							id: 'secrets',
							status: 'fail',
							label: 'Worker secret APP_ENCRYPTION_KEY is missing',
							fix: 'npm run secrets:put (or npm run setup)'
						}
			);
			if (!names.includes('SCHEDULER_SECRET') && !names.includes('API_TOKEN')) {
				checks.push({
					id: 'tick-credential',
					status: 'warn',
					label: 'No SCHEDULER_SECRET or API_TOKEN',
					detail: 'the built-in cron still works; an external pinger cannot authenticate',
					fix: 'Set SCHEDULER_SECRET if you run your own cron'
				});
			}
		}

		const migrations = wrangler(['d1', 'migrations', 'list', binding, '--remote'], {
			timeout: 120_000
		});
		const pending = countUnappliedMigrations(`${migrations.stdout}${migrations.stderr}`);
		if (pending === null) {
			checks.push({
				id: 'migrations',
				status: 'warn',
				label: 'Could not read the migration list',
				detail: `${migrations.stdout}${migrations.stderr}`.trim().split('\n')[0] || undefined
			});
		} else {
			checks.push(
				pending === 0
					? { id: 'migrations', status: 'ok', label: 'D1 migrations are up to date' }
					: {
							id: 'migrations',
							status: 'warn',
							label: `${pending} migration${pending === 1 ? '' : 's'} not applied`,
							fix: 'npm run db:migrate:remote'
						}
			);
		}

		const deployed = wrangler(['deployments', 'status'], { timeout: 60_000 });
		checks.push(
			deployed.status === 0
				? { id: 'worker', status: 'ok', label: 'Worker has a deployment' }
				: {
						id: 'worker',
						status: 'fail',
						label: 'Worker is not deployed yet',
						fix: 'npm run deploy'
					}
		);
	} else {
		const skipped = {
			d1: 'D1 database',
			r2: 'R2 bucket',
			secrets: 'Worker secrets',
			migrations: 'D1 migrations',
			worker: 'Worker deployment'
		};
		for (const [id, name] of Object.entries(skipped)) {
			checks.push({ id, status: 'skip', label: `${name} check skipped (not signed in)` });
		}
	}

	const appUrl = flag('--app-url') ?? devVars?.get('APP_URL') ?? config?.vars?.APP_URL ?? undefined;
	if (appUrl && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(appUrl)) {
		checks.push(await probeApp(appUrl));
		const token = devVars?.get('API_TOKEN');
		if (token) {
			try {
				const res = await fetch(`${appUrl.replace(/\/$/, '')}/api/scheduler/health`, {
					headers: { Authorization: `Bearer ${token}` },
					signal: AbortSignal.timeout(10_000)
				});
				const body = await res.json().catch(() => ({}));
				checks.push(schedulerVerdict(res.status, body));
			} catch {
				checks.push({ id: 'scheduler', status: 'skip', label: 'Scheduler check skipped' });
			}
		} else {
			checks.push({
				id: 'scheduler',
				status: 'skip',
				label: 'Scheduler check skipped (no local API_TOKEN)'
			});
		}
	} else {
		checks.push({
			id: 'app',
			status: 'skip',
			label: appUrl ? `Deployment probe skipped (${appUrl} is local)` : 'Deployment probe skipped',
			detail: 'pass --app-url https://your-worker.example to check the running app'
		});
	}

	console.log(formatReport(checks));
	process.exit(summarize(checks).failed > 0 ? 1 : 0);
}

// Only run when invoked directly: the helpers above are imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err) => {
		console.error(`doctor failed: ${err?.message ?? err}`);
		process.exit(1);
	});
}
