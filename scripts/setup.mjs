#!/usr/bin/env node
// One-command setup for a self-hosted instance: Cloudflare resources, secrets,
// migrations and the first deploy — in the order that actually works.
//
// Safe by default. It creates only what is missing, and it will not change a
// value a running deployment already has:
//
//   * resources that exist are reused, and an existing `database_id` in your
//     config is never replaced;
//   * a secret that is already set on the Worker is left alone, because
//     rotating APP_ENCRYPTION_KEY orphans every stored credential and changing
//     ADMIN_EMAIL deletes the old user row and everything cascading from it.
//     Use `--rotate-secrets` / `--set-admin` when that is what you want.
//
// Usage:
//   npm run setup                       # interactive
//   npm run setup -- --dry-run          # read-only: checks auth, prints the plan
//   npm run setup -- --yes              # no prompts: generates secrets, prints them once
//   npm run setup -- --skip-deploy      # everything except the deploy
//   npm run setup -- --rotate-secrets   # also overwrite APP_ENCRYPTION_KEY (rotates the derived secrets too)
//   npm run setup -- --set-admin        # also overwrite ADMIN_EMAIL/ADMIN_PASSWORD
//   npm run setup -- --name my-sent --bucket my-sent-media --db my-sent
//   npm run setup -- --admin-email you@example.com --admin-password '…'
//
// The "Deploy to Cloudflare" button in the README covers the same ground in a
// browser. This script exists for people who prefer a terminal: it can pin
// APP_URL to the URL it just deployed to, which the browser flow cannot know.
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
const ROTATE_SECRETS = has('--rotate-secrets');
const SET_ADMIN = has('--set-admin');

const PERSONAL_CONFIG = 'wrangler.personal.jsonc';
const COMMITTED_CONFIG = 'wrangler.jsonc';
const DEV_VARS = '.dev.vars';
const DEV_VARS_EXAMPLE = '.dev.vars.example';

/**
 * Values that ship with the repo and must never reach a deployment. Keep in
 * sync with PLACEHOLDER_SECRETS in src/lib/server/env.ts — a unit test compares
 * the two lists.
 */
const PLACEHOLDERS = new Set([
	'change-me',
	'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
	'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
	'dev-auth-secret-change-me',
	'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
	'admin@example.com'
]);

/** Minimum lengths the app's own env schema enforces. */
const MIN_LENGTH = {
	APP_ENCRYPTION_KEY: 32,
	ADMIN_PASSWORD: 8,
	ADMIN_EMAIL: 3
};

const info = (message) => console.log(`  ${message}`);
const warn = (message) => console.log(`  ! ${message}`);

/** Reports an action that happened; silent in a dry run, where nothing did. */
const did = (message) => {
	if (!DRY) info(message);
};
/** Reports an action that would happen; only shown in a dry run. */
const would = (message) => {
	if (DRY) info(message);
};

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
	// Always captured (some callers parse it) and always echoed, unless the
	// output is machine-readable noise.
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

/** Minimal JSONC reader: the configs carry comments. */
function readJsonc(file) {
	const text = readFileSync(file, 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/.*$/gm, '$1')
		.replace(/,(\s*[}\]])/g, '$1');
	return JSON.parse(text);
}

async function ask(question, fallback) {
	if (DRY || ASSUME_YES || !process.stdin.isTTY) return fallback;
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = (await rl.question(`  ${question}${fallback ? ` [${fallback}]` : ''}: `)).trim();
		return answer || fallback;
	} finally {
		rl.close();
	}
}

const generateHex = (bytes = 32) => randomBytes(bytes).toString('hex');

/** `.dev.vars` values as dotenv would read them: unquoted, comments stripped. */
function readDevVars() {
	const values = new Map();
	if (!existsSync(DEV_VARS)) return values;
	for (const line of readFileSync(DEV_VARS, 'utf8').split('\n')) {
		const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
		if (!match) continue;
		let raw = match[2].trim();
		if (/^".*"$/.test(raw) || /^'.*'$/.test(raw)) raw = raw.slice(1, -1);
		else raw = raw.replace(/\s+#.*$/, '').trim();
		values.set(match[1], raw);
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

function isPlaceholder(value) {
	return value === undefined || PLACEHOLDERS.has(value.trim());
}

/** Everything the app would reject at boot, caught before it is uploaded. */
function validateSecret(key, value) {
	if (isPlaceholder(value)) return 'still an example value';
	if (value.length < (MIN_LENGTH[key] ?? 1)) return `shorter than ${MIN_LENGTH[key]} characters`;
	if (key === 'ADMIN_EMAIL' && !value.includes('@')) return 'not an email address';
	return null;
}

/** Patch the personal config in place so its comments survive. */
function patchPersonalConfig({ name, databaseId, bucket, databaseIdIsSet }) {
	let text = readFileSync(PERSONAL_CONFIG, 'utf8');
	const patch = (pattern, replacement, label) => {
		if (!pattern.test(text)) {
			warn(`could not find ${label} in ${PERSONAL_CONFIG} — set it by hand`);
			return;
		}
		text = text.replace(pattern, replacement);
	};
	if (name) patch(/("name"\s*:\s*)"[^"]*"/, `$1"${name}"`, 'the Worker name');
	// Never replace a database id that is already set: it points at the database
	// holding the instance's data.
	if (databaseId && !databaseIdIsSet) {
		patch(/("database_id"\s*:\s*)"[^"]*"/, `$1"${databaseId}"`, 'database_id');
	}
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
	if (who.status !== 0) fail('wrangler could not read your account.');
	let account;
	try {
		account = JSON.parse(who.stdout);
	} catch {
		fail('could not parse `wrangler whoami --json`. Update wrangler and try again.');
	}
	if (!account.loggedIn) {
		if (DRY || !process.stdin.isTTY) {
			fail(
				'You are not signed in. Run `npx wrangler login` (an OAuth login — no API token needed).'
			);
		}
		info('not signed in yet — starting the browser login');
		wrangler(['login']);
		const after = wrangler(['whoami', '--json'], { readOnly: true, quiet: true });
		account = JSON.parse(after.stdout || '{}');
		if (!account.loggedIn) fail('Still not signed in. Run `npx wrangler login` and try again.');
	}
	info(`signed in as ${account.email}`);
	const accounts = account.accounts ?? [];
	if (accounts.length === 0) fail('This login has no Cloudflare account.');
	info(`account: ${accounts.map((a) => a.name).join(', ')}`);
	if (accounts.length > 1) {
		warn('several accounts are available; wrangler picks the default one');
		warn('set WRANGLER_PROFILE to choose another (see README → Keeping your deployment separate)');
	}

	// 2. Names, from the config that will actually be deployed.
	say('2. Configuration');
	const personalExists = existsSync(PERSONAL_CONFIG);
	// `wrangler.personal.jsonc` wins over the committed config, exactly as the
	// wrapper applies it — reading only the committed file would create a second
	// database next to the one an existing deployment already uses.
	const effective = readJsonc(personalExists ? PERSONAL_CONFIG : COMMITTED_CONFIG);
	const name = value('--name', effective.name);
	const databaseName = value('--db', effective.d1_databases[0].database_name);
	const databaseId = effective.d1_databases[0].database_id || '';
	const bucket = value('--bucket', effective.r2_buckets[0].bucket_name || `${name}-media`);
	info(`config:   ${personalExists ? PERSONAL_CONFIG : COMMITTED_CONFIG}`);
	info(`worker:   ${name}`);
	info(`database: ${databaseName}${databaseId ? ` (${databaseId})` : ' (not created yet)'}`);
	info(`bucket:   ${bucket}`);

	if (!personalExists) {
		would(`would create ${PERSONAL_CONFIG} with those names and your resource ids`);
		if (!DRY) {
			copyFileSync(COMMITTED_CONFIG, PERSONAL_CONFIG);
			patchPersonalConfig({ name, databaseId, bucket, databaseIdIsSet: Boolean(databaseId) });
			info(`created ${PERSONAL_CONFIG} (gitignored — keeps your names out of upstream)`);
		}
	} else if (!effective.r2_buckets[0].bucket_name && !DRY) {
		// The binding has no bucket name; without this the first deploy would
		// auto-provision its own and leave the bucket below unused.
		patchPersonalConfig({ bucket });
		info(`recorded ${bucket} in ${PERSONAL_CONFIG}`);
	}

	// 3. D1.
	say('3. D1 database');
	let resolvedDatabaseId = databaseId;
	if (resolvedDatabaseId) {
		info(`${databaseName} is already bound (${resolvedDatabaseId}) — left untouched`);
	} else {
		const list = wrangler(['d1', 'list', '--json'], { readOnly: true, quiet: true });
		if (list.status === 0) {
			try {
				const found = JSON.parse(list.stdout).find((db) => db.name === databaseName);
				if (found) {
					resolvedDatabaseId = found.uuid;
					info(`${databaseName} already exists (${resolvedDatabaseId})`);
				}
			} catch {
				warn('could not read the database list; will try to create it');
			}
		}
		if (!resolvedDatabaseId) {
			would(`would create the database ${databaseName}`);
			if (!DRY) {
				const created = wrangler(['d1', 'create', databaseName], { allowFailure: true });
				const text = `${created.stdout}${created.stderr}`;
				const found = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
				if (created.status !== 0 || !found) {
					fail(
						`could not create ${databaseName}. If it already exists, put its id in ${PERSONAL_CONFIG} by hand (npx wrangler d1 list).\n${text}`
					);
				}
				resolvedDatabaseId = found[0];
				did(`created ${databaseName} (${resolvedDatabaseId})`);
				patchPersonalConfig({ databaseId: resolvedDatabaseId, databaseIdIsSet: false });
			}
		}
	}

	// 4. R2.
	say('4. R2 bucket');
	would(`would create the bucket ${bucket} (an existing bucket is fine)`);
	if (!DRY) {
		const created = wrangler(['r2', 'bucket', 'create', bucket], { allowFailure: true });
		const text = `${created.stdout}${created.stderr}`;
		if (created.status !== 0 && !/already exists|10004|10073/i.test(text)) {
			fail(`could not create ${bucket}:\n${text}`);
		}
		did(created.status === 0 ? `created ${bucket}` : `${bucket} already exists`);
	}

	// 5. Work out which secrets to upload, and which to leave alone.
	say('5. Secrets');
	const vars = readDevVars();
	const reusable = (key) => {
		const current = vars.get(key);
		return current && !isPlaceholder(current) ? current : null;
	};
	// Fails when the Worker does not exist yet, which simply means "no secrets".
	const listed = wrangler(['secret', 'list', '--json'], {
		readOnly: true,
		quiet: true,
		allowFailure: true
	});
	let existingSecrets = new Set();
	if (listed.status === 0) {
		try {
			existingSecrets = new Set(JSON.parse(listed.stdout).map((entry) => entry.name));
		} catch {
			warn('could not read the Worker secret list; assuming none are set');
		}
	}
	const uploads = {};

	const existingPassword = reusable('ADMIN_PASSWORD');
	const suggestedPassword = existingPassword ?? generateHex(12);
	const adminEmail = await ask(
		'Admin email (the login)',
		value('--admin-email', null) ?? reusable('ADMIN_EMAIL') ?? 'admin@example.com'
	);
	const adminPasswordFlag = value('--admin-password', null);
	const adminPassword = await ask(
		existingPassword
			? 'Admin password (leave empty to keep the current one)'
			: 'Admin password (pick a long one)',
		adminPasswordFlag ?? suggestedPassword
	);

	for (const [key, fallback] of Object.entries({
		APP_ENCRYPTION_KEY: () => reusable('APP_ENCRYPTION_KEY') ?? generateHex(),
		ADMIN_EMAIL: () => adminEmail,
		ADMIN_PASSWORD: () => adminPassword
	})) {
		const wantsOverwrite = key.startsWith('ADMIN_') ? SET_ADMIN : ROTATE_SECRETS;
		if (existingSecrets.has(key) && !wantsOverwrite) {
			// Overwriting APP_ENCRYPTION_KEY orphans stored credentials and
			// rotates the secrets derived from it (sessions sign out), and
			// changing ADMIN_EMAIL deletes the existing user row (drafts,
			// connections, keys) on the next request. Neither is a setup step.
			warn(`${key} is already set on the Worker — left alone`);
			continue;
		}
		const candidate = fallback();
		const problem = validateSecret(key, candidate);
		if (problem) {
			const message = `${key} ${problem}. Set it in ${DEV_VARS} (or pass --admin-email / --admin-password) before a real run.`;
			if (DRY) {
				warn(message);
				continue;
			}
			fail(message);
		}
		uploads[key] = candidate;
	}

	if (!DRY && Object.keys(uploads).length > 0) {
		writeDevVars(uploads);
		info(`wrote the generated values to ${DEV_VARS}`);
	}
	const generatedPassword = !existingPassword && adminPassword === suggestedPassword;

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
     secrets and pins APP_URL to the deployed URL.`);
		return;
	}

	// 8. Upload the secrets (the Worker exists now) and set APP_URL.
	say('8. Upload secrets');
	for (const [key, value] of Object.entries(uploads)) {
		wrangler(['secret', 'put', key], { input: `${value}\n` });
		did(`${key} set`);
	}
	if (Object.keys(uploads).length === 0) warn('nothing to upload — every secret already exists');

	if (!siteUrl && !DRY) {
		const answer = await ask(
			'Public URL of this deployment (leave empty to set APP_URL later)',
			''
		);
		siteUrl = answer && /^https:\/\//.test(answer) ? answer.replace(/\/$/, '') : '';
	}
	if (siteUrl) {
		// Pin APP_URL to the URL this run deployed to. Optional — an unset
		// APP_URL follows the host each request arrives on — but pinning makes
		// absolute links and OAuth redirect URIs deterministic from the first
		// scheduled tick, before anyone has opened the app.
		if (!existingSecrets.has('APP_URL')) {
			wrangler(['secret', 'put', 'APP_URL'], { input: `${siteUrl}\n` });
			did(`APP_URL pinned to ${siteUrl}`);
		} else {
			warn(`APP_URL is already set on the Worker — left alone (expected ${siteUrl})`);
		}
	} else {
		info('APP_URL left unset — the app follows the host each request arrives on.');
	}

	// 9. Deploy again so the secrets are live, then report.
	say('9. Redeploy with the secrets');
	wrangler(['deploy']);

	say(DRY ? 'Dry run finished — nothing was created or changed.' : 'Done.');
	if (!DRY) {
		console.log(`
Next:
  1. Open ${siteUrl || 'your Worker URL'} and sign in with ${adminEmail}
     ${generatedPassword ? `password: ${adminPassword}  (also in ${DEV_VARS})` : ''}
  2. Enrol an authenticator app when asked, and save the backup codes.
  3. Connect accounts (Accounts → Connect new).
  4. Scheduled posts publish themselves: the Worker's cron trigger runs every
     minute; AUTH_SECRET and SCHEDULER_SECRET are derived from APP_ENCRYPTION_KEY.
     To drive the tick from somewhere else, set SCHEDULER_SECRET
     (\`openssl rand -hex 32\`) and POST ${siteUrl || 'APP_URL'}/api/internal/tick with
     it as the bearer — see README → Scheduling.
  5. Local dev uses the same secrets in ${DEV_VARS}; run \`npm run dev\`.`);
	}
}

main().catch((err) => fail(err?.message ?? String(err)));
