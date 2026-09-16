#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

function run(cmd, args, opts = {}) {
	console.log(`\n$ ${cmd} ${args.join(' ')}`);
	const result = spawnSync(cmd, args, {
		stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
		encoding: 'utf8'
	});
	if (result.status !== 0) {
		if (opts.capture) {
			if (result.stdout) process.stdout.write(result.stdout);
			if (result.stderr) process.stderr.write(result.stderr);
		}
		process.exit(result.status ?? 1);
	}
	return result;
}

function d1Json(sql) {
	const result = spawnSync(
		'node',
		['scripts/wrangler.mjs', 'd1', 'execute', 'DB', '--remote', '--json', '--command', sql],
		{ encoding: 'utf8' }
	);
	if (result.status !== 0) {
		process.stderr.write(result.stderr || result.stdout || 'd1 execute failed\n');
		process.exit(result.status ?? 1);
	}
	const parsed = JSON.parse(result.stdout);
	return parsed[0]?.results ?? [];
}

run('npx', ['vitest', 'run']);

const tables = d1Json("SELECT name FROM sqlite_master WHERE type='table'").map((row) => row.name);
const applied = tables.includes('d1_migrations')
	? d1Json('SELECT name FROM d1_migrations').map((row) => row.name)
	: [];

// First-request bootstrap (init-sql.ts) squashes migrations into the initial
// DDL, so replaying them via `migrations apply` would abort (duplicate
// column / duplicate index). But a blanket "mark everything applied" is
// WRONG for DBs bootstrapped by an older INIT_SQL that did not squash a given
// migration (seen live: 0006 marked but its index missing). So mark each
// migration only when its postcondition is already true in the remote DB;
// anything unmarked runs for real via `migrations apply` below.
function markApplied(name) {
	console.log(`\nRemote D1 already satisfies ${name}; recording as applied.`);
	d1Json(`INSERT INTO d1_migrations (name) VALUES ('${name}')`);
}

if (tables.includes('users')) {
	const userCols = new Set(
		d1Json("SELECT name FROM pragma_table_info('users')").map((row) => row.name)
	);
	const targetIndexes = d1Json(
		"SELECT name, [unique] AS u FROM pragma_index_list('publish_targets')"
	);
	const hasDraftConnIdx = (unique) =>
		targetIndexes.some(
			(row) => row.name === 'publish_targets_draft_conn_idx' && (!unique || row.u === 1)
		);
	const oauthIndexes = tables.includes('oauth_pending')
		? new Set(d1Json("SELECT name FROM pragma_index_list('oauth_pending')").map((row) => row.name))
		: new Set();
	const hasConnStatusIdx = targetIndexes.some(
		(row) => row.name === 'publish_targets_conn_status_idx'
	);
	const apiKeyCols = tables.includes('api_keys')
		? new Set(d1Json("SELECT name FROM pragma_table_info('api_keys')").map((row) => row.name))
		: new Set();
	const draftCols = new Set(
		d1Json("SELECT name FROM pragma_table_info('drafts')").map((row) => row.name)
	);

	const satisfied = {
		'0001_init.sql': true,
		'0002_totp.sql': userCols.has('totp_enabled'),
		'0003_publish_targets_draft_conn_idx.sql': hasDraftConnIdx(false),
		'0004_publish_targets_draft_conn_uq.sql': hasDraftConnIdx(true),
		'0005_profile_settings.sql': userCols.has('settings_json'),
		'0006_oauth_pending_fk.sql': oauthIndexes.has('oauth_pending_user_idx'),
		'0007_api_keys.sql': tables.includes('api_keys'),
		'0008_display_name.sql': userCols.has('display_name'),
		'0009_publish_targets_conn_status_idx.sql': hasConnStatusIdx,
		'0010_api_keys_scopes.sql': apiKeyCols.has('scopes')
	};
	satisfied['0014_notification_digest.sql'] = tables.includes('notification_state');
	satisfied['0015_draft_selected_connections.sql'] = draftCols.has('selected_connection_ids');
	for (const [name, ok] of Object.entries(satisfied)) {
		if (ok && !applied.includes(name)) markApplied(name);
	}
}

run('node', ['scripts/wrangler.mjs', 'd1', 'migrations', 'apply', 'DB', '--remote']);
run('npm', ['run', 'build']);
run('node', ['scripts/wrangler.mjs', 'deploy']);

console.log('\nDeploy finished.');
console.log('Set a script token if you have not already: npm run secrets:put -- API_TOKEN');
console.log('Scheduled posts tick from the Worker cron trigger (wrangler.jsonc → triggers).');
console.log('If you would rather ping /api/internal/tick yourself, set SCHEDULER_SECRET.');
