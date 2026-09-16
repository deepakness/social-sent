#!/usr/bin/env node
// One-command setup for a self-hosted instance: Cloudflare resources, secrets,
// migrations and the first deploy — in the order that actually works.
//
// Safe to re-run. It creates only what is missing, reuses the secrets already
// in `.dev.vars` when they look real (rotating APP_ENCRYPTION_KEY would orphan
// every stored credential), and never deletes anything.
//
// Usage:
//   npm run setup                       # interactive
//   npm run setup -- --dry-run          # read-only: checks auth, prints the plan
//   npm run setup -- --yes              # no prompts: generates secrets, prints them once
//   npm run setup -- --skip-deploy      # everything except the deploy
//   npm run setup -- --name my-sent --bucket my-sent-media --db my-sent
//
// The "Deploy to Cloudflare" button in the README covers the same ground in a
// browser. This script exists for people who prefer a terminal and want APP_URL
// set to the real URL on the first deploy instead of after it.
//
// Everything it writes to your Cloudflare account: one D1 database, one R2
// bucket, the Worker, its secrets and its migrations. Everything it writes
// locally: `wrangler.personal.jsonc` (gitignored) and `.dev.vars` (gitignored).

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const value = (name, fallback) => {
	const i = argv.indexOf(name);
	const next = argv[i + 1];
	return i >= 0 && next && !next.startsWith('--') ? next : fallback;
};

const DRY = has('--dry-run');
const ASSUME_YES = has('--yes');
const SKIP_DEPLOY = has('--skip-deploy');

const PERSONAL_CONFIG = 'wrangler.personal.jsonc';
const DEV_VARS = '.dev.vars';
const DEV_VARS_EXAMPLE = '.dev.vars.example';

/** Values that ship with the repo and must never reach a deployment. */
const PLACEHOLDERS = new Set([
	'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
	'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
	'change-me',
	'admin@example.com',
	''
]);

const info = (message) => console.log(`  ${message}`);
/** Reports an action that happened; silent in a dry run, where nothing did. */
const did = (message) => {
	if (!DRY) info(message);
};
/** Reports an action that would happen; only shown in a dry run. */
const would = (message) => {
	if (DRY) info(message);
};
const warn = (message) => console.log(`  ! ${message}`);

function say(message) {
	console.log(`\n${message}`);
}

function fail(message) {
	console.error(`\n✘ ${message}`);
	process.exit(1);
}

/**
 * Run a command. `readOnly` marks the few calls that are also safe in a dry
 * run; everything else is printed but skipped.
 */
function run(cmd, cmdArgs, opts = {}) {
	if (DRY && !opts.readOnly) {
		console.log(`  $ ${cmd} ${cmdArgs.join(' ')}   (skipped: dry run)`);
		return { status: 0, stdout: '', stderr: '' };
	}
	console.log(`  $ ${cmd} ${cmdArgs.join(' ')}`);
	// Always captured (some callers parse it) and always echoed, so the output
	// ordering is predictable and nothing is hidden.
	const result = spawnSync(cmd, cmdArgs, { encoding: 'utf8', input: opts.input });
	const stdout = result.stdout ?? '';
	const stderr = result.stderr ?? '';
	if (stdout.trim() && !opts.quiet) console.log(stdout.trimEnd());
	if (stderr.trim() && !opts.quiet) console.error(stderr.trimEnd());
	if (result.status !== 0 && !opts.allowFailure) {
		fail(`${cmd} ${cmdArgs.join(' ')} failed.`);
	}
	return { status: result.status ?? 0, stdout, stderr };
}

/** Always through the repo wrapper, so `wrangler.personal.jsonc` and
 *  `WRANGLER_PROFILE` apply exactly as they do for the npm scripts. */
const wrangler = (cmdArgs, opts) => run('node', ['scripts/wrangler.mjs', ...cmdArgs], opts);

/** Minimal JSONC reader: the committed config carries comments. */
function readJsonc(file) {
	const text = readFileSync(file, 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/.*$/gm, '$1')
		.replace(/,(\s*[}\]])/g, '$1');
	return JSON.parse(text);
}

async function ask(question, fallback) {
	if (ASSUME_YES || !process.stdin.isTTY) return fallback;
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = (await rl.question(`  ${question}${fallback ? ` [${fallback}]` : ''}: `)).trim();
		return answer || fallback;
	} finally {
		rl.close();
	}
}

const generateHex = (bytes = 32) => randomBytes(bytes).toString('hex');

function readDevVars() {
	const values = new Map();
	if (!existsSync(DEV_VARS)) return values;
	for (const line of readFileSync(DEV_VARS, 'utf8').split('\n')) {
		const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
		if (match) values.set(match[1], match[2]);
	}
	return values;
}

/** Upsert the keys we manage, leaving every other line (and its comments) alone. */
function writeDevVars(updates) {
	const original = existsSync(DEV_VARS)
		? readFileSync(DEV_VARS, 'utf8')
		: readFileSync(DEV_VARS_EXAMPLE, 'utf8');
	const pending = new Map(Object.entries(updates));
	const lines = original.split('\n').map((line) => {
		const match = line.match(/^\s*([A-Z0-9_]+)\s*=/);
		if (!match || !pending.has(match[1])) return line;
		const value = pending.get(match[1]);
		pending.delete(match[1]);
		return `${match[1]}=${value}`;
	});
	for (const [key, value] of pending) lines.push(`${key}=${value}`);
	writeFileSync(DEV_VARS, lines.join('\n'));
}

/** Patch the personal config in place so its comments survive. */
function patchPersonalConfig({ name, databaseId, bucket }) {
	let text = readFileSync(PERSONAL_CONFIG, 'utf8');
	const patch = (pattern, replacement, label) => {
		if (!pattern.test(text)) {
			warn(`could not find ${label} in ${PERSONAL_CONFIG} — set it by hand`);
			return;
		}
		text = text.replace(pattern, replacement);
	};
	if (name) patch(/("name"\s*:\s*)"[^"]*"/, `$1"${name}"`, 'the Worker name');
	if (databaseId) patch(/("database_id"\s*:\s*)"[^"]*"/, `$1"${databaseId}"`, 'database_id');
	if (bucket) {
		if (/"bucket_name"\s*:/.test(text)) {
			patch(/("bucket_name"\s*:\s*)"[^"]*"/, `$1"${bucket}"`, 'bucket_name');
		} else {
			patch(
				/(\b"binding"\s*:\s*"MEDIA")/,
				`$1,\n\t\t\t"bucket_name": "${bucket}"`,
				'the R2 binding'
			);
		}
	}
	writeFileSync(PERSONAL_CONFIG, text);
}

async function main() {
	console.log(`SocialSent setup${DRY ? ' (dry run — nothing will be created or changed)' : ''}`);

	// 1. Who are we deploying as?
	say('1. Cloudflare account');
	const who = wrangler(['whoami', '--json'], { readOnly: true, quiet: true });
	if (who.status !== 0)
		fail('wrangler could not read your account. Run `npx wrangler login` first.');
	let account;
	try {
		account = JSON.parse(who.stdout);
	} catch {
		fail('could not parse `wrangler whoami --json`. Update wrangler and try again.');
	}
	if (!account.loggedIn) {
		fail('You are not signed in. Run `npx wrangler login` (an OAuth login — no API token needed).');
	}
	info(`signed in as ${account.email}`);
	const accounts = account.accounts ?? [];
	if (accounts.length === 0) fail('This login has no Cloudflare account.');
	info(`account: ${accounts.map((a) => a.name).join(', ')}`);
	if (accounts.length > 1) {
		warn('several accounts are available; wrangler picks the default one');
		warn('set WRANGLER_PROFILE to choose another (see README → Keeping your deployment separate)');
	}

	// 2. Names, and a personal config so nothing upstream is touched.
	say('2. Configuration');
	const committed = readJsonc('wrangler.jsonc');
	const name = value('--name', committed.name);
	const databaseName = value('--db', committed.d1_databases[0].database_name);
	const bucket = value('--bucket', committed.r2_buckets[0].bucket_name || `${name}-media`);
	would(`would create ${PERSONAL_CONFIG} with these names and your resource ids`);
	info(`worker:   ${name}`);
	info(`database: ${databaseName}`);
	info(`bucket:   ${bucket}`);

	if (!existsSync(PERSONAL_CONFIG)) {
		if (DRY) {
			// nothing to do: reported above
		} else {
			copyFileSync('wrangler.jsonc', PERSONAL_CONFIG);
			patchPersonalConfig({ name, bucket });
			info(`created ${PERSONAL_CONFIG} (gitignored — keeps your names out of upstream)`);
		}
	} else {
		info(`using the existing ${PERSONAL_CONFIG}`);
	}

	// 3. D1.
	say('3. D1 database');
	let databaseId = '';
	const list = wrangler(['d1', 'list', '--json'], { readOnly: true, quiet: true });
	if (list.status === 0) {
		try {
			const found = JSON.parse(list.stdout).find((db) => db.name === databaseName);
			if (found) {
				databaseId = found.uuid;
				info(`${databaseName} already exists (${databaseId})`);
			}
		} catch {
			warn('could not read the database list; will try to create it');
		}
	}
	if (!databaseId) {
		if (DRY) {
			info(`would create the database ${databaseName}`);
		} else {
			const created = wrangler(['d1', 'create', databaseName], { allowFailure: true });
			const text = `${created.stdout}${created.stderr}`;
			const found = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
			if (/already exists|7502/i.test(text)) {
				fail(
					`${databaseName} exists but its id could not be read. Put it in ${PERSONAL_CONFIG} by hand (npx wrangler d1 list).`
				);
			} else if (created.status !== 0 || !found) {
				fail(`could not create ${databaseName}:\n${text}`);
			}
			databaseId = found[0];
			did(`created ${databaseName} (${databaseId})`);
			patchPersonalConfig({ databaseId });
		}
	}

	// 4. R2.
	say('4. R2 bucket');
	if (DRY) {
		info(`would create the bucket ${bucket} (an existing bucket is fine)`);
	} else {
		const created = wrangler(['r2', 'bucket', 'create', bucket], { allowFailure: true });
		const text = `${created.stdout}${created.stderr}`;
		if (created.status !== 0 && !/already exists|10004|10073/i.test(text)) {
			fail(`could not create ${bucket}:\n${text}`);
		}
		did(created.status === 0 ? `created ${bucket}` : `${bucket} already exists`);
	}

	// 5. Secrets, reusing anything real already in .dev.vars.
	say('5. Secrets');
	const vars = readDevVars();
	const reusable = (key) => {
		const current = vars.get(key);
		return current && !PLACEHOLDERS.has(current.trim()) ? current.trim() : null;
	};
	const secrets = {
		APP_ENCRYPTION_KEY: reusable('APP_ENCRYPTION_KEY') ?? generateHex(),
		AUTH_SECRET: reusable('AUTH_SECRET') ?? generateHex(),
		SCHEDULER_SECRET: reusable('SCHEDULER_SECRET') ?? generateHex()
	};
	secrets.ADMIN_EMAIL = await ask(
		'Admin email (the login)',
		reusable('ADMIN_EMAIL') ?? 'admin@example.com'
	);
	secrets.ADMIN_PASSWORD = await ask(
		'Admin password (pick a long one)',
		reusable('ADMIN_PASSWORD') ?? generateHex(12)
	);
	if (!DRY) {
		writeDevVars(secrets);
		did(`wrote the generated values to ${DEV_VARS}`);
	}
	const generatedPassword = secrets.ADMIN_PASSWORD === reusable('ADMIN_PASSWORD');

	// 6. Build, then migrations against the real database.
	say('6. Build and migrations');
	if (SKIP_DEPLOY) {
		info('--skip-deploy: stopping before the build');
	} else {
		run('npm', ['run', 'build']);
		wrangler(['d1', 'migrations', 'apply', 'DB', '--remote']);
	}

	// 7. First deploy: creates the Worker (and provisions anything still missing).
	let siteUrl = '';
	if (!SKIP_DEPLOY) {
		say('7. Deploy');
		const deployed = wrangler(['deploy'], { allowFailure: true });
		const text = `${deployed.stdout}${deployed.stderr}`;
		if (deployed.status !== 0) fail(`deploy failed:\n${text}`);
		const found = text.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i);
		if (found) {
			siteUrl = found[0];
			did(`deployed: ${siteUrl}`);
		} else {
			did('deployed, but the URL was not in the output');
		}
	}

	if (SKIP_DEPLOY) {
		say('Done (--skip-deploy).');
		console.log(`
Next:
  1. Deploy the Worker: npm run deploy
  2. Re-run this script (npm run setup): it skips what already exists, uploads the
     secrets and sets APP_URL to the deployed URL.`);
		return;
	}

	// 8. Upload the secrets (the Worker exists now) and set APP_URL.
	say('8. Upload secrets');
	for (const [key, value] of Object.entries(secrets)) {
		wrangler(['secret', 'put', key], { input: `${value}\n` });
		did(`${key} set`);
	}
	if (!siteUrl && !DRY) {
		const answer = await ask(
			'Public URL of this deployment (leave empty to set APP_URL later)',
			''
		);
		siteUrl = answer && /^https:\/\//.test(answer) ? answer.replace(/\/$/, '') : '';
	}
	if (siteUrl) {
		wrangler(['secret', 'put', 'APP_URL'], { input: `${siteUrl}\n` });
		did(`APP_URL set to ${siteUrl}`);
	} else {
		warn('APP_URL not set — the app answers 503 on a real host until you set it:');
		warn(`  node scripts/wrangler.mjs secret put APP_URL`);
	}

	// 9. Deploy again so the secrets are live, then report.
	if (!SKIP_DEPLOY) {
		say('9. Redeploy with the secrets');
		wrangler(['deploy']);
	}

	say(DRY ? 'Dry run finished — nothing was created or changed.' : 'Done.');
	if (!DRY) {
		console.log(`
Next:
  1. Open ${siteUrl || 'your Worker URL'} and sign in with ${secrets.ADMIN_EMAIL}
     ${generatedPassword && !DRY ? `password: ${secrets.ADMIN_PASSWORD}  (also in ${DEV_VARS})` : ''}
  2. Enrol an authenticator app when asked, and save the backup codes.
  3. Connect accounts (Accounts → Connect new).
  4. For scheduled posts, point a cron at POST ${siteUrl || 'APP_URL'}/api/internal/tick with
     Authorization: Bearer ${secrets.SCHEDULER_SECRET} — see README → Scheduling.
  5. Optional: Local dev uses the same secrets in ${DEV_VARS}; run \`npm run dev\`.`);
	}
}

main().catch((err) => fail(err?.message ?? String(err)));
