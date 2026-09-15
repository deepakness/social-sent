#!/usr/bin/env node
// Repair Threads publish rows stored before the permalink fix.
//
// Pre-fix rows hold remote_url built from the numeric media id
// (https://www.threads.net/@user/post/18021145505922992), which Threads
// renders as a not-found page. Public links use a shortcode
// (https://www.threads.com/@user/post/DdHkaqrEruo), which
// GET /{threads-media-id}?fields=permalink,shortcode resolves.
//
// Usage:
//   node scripts/backfill-threads-links.mjs                 # dry run (default)
//   node scripts/backfill-threads-links.mjs --apply         # write fixes
//   node scripts/backfill-threads-links.mjs --apply --null-missing
//
// --null-missing also clears remote_url when Meta says the media no longer
// exists (deleted post): a missing link beats a link that 404s. Rows that
// fail transiently (network/5xx/429) are always left untouched.
//
// The stored connection tokens are decrypted with APP_ENCRYPTION_KEY from the
// environment or .dev.vars. Tokens are never printed.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const apply = flag('--apply');
const nullMissing = flag('--null-missing');
const profile = option('--profile', 'personal');
// The D1 binding name resolves from whichever config wrangler loads.
const dbName = option('--db', 'DB');

function d1Json(sql) {
	const result = spawnSync(
		'npx',
		[
			'wrangler',
			'--profile',
			profile,
			'd1',
			'execute',
			dbName,
			'--remote',
			'--json',
			'--command',
			sql
		],
		{ encoding: 'utf8' }
	);
	if (result.status !== 0) {
		process.stderr.write(result.stderr || result.stdout || 'd1 execute failed\n');
		process.exit(result.status ?? 1);
	}
	return JSON.parse(result.stdout)[0]?.results ?? [];
}

function encryptionKey() {
	if (option('--key')) return option('--key');
	if (process.env.APP_ENCRYPTION_KEY) return process.env.APP_ENCRYPTION_KEY;
	const vars = readFileSync(resolve(root, '.dev.vars'), 'utf8');
	const line = vars.split('\n').find((l) => l.startsWith('APP_ENCRYPTION_KEY='));
	if (!line) throw new Error('APP_ENCRYPTION_KEY not found in environment or .dev.vars');
	return line
		.slice('APP_ENCRYPTION_KEY='.length)
		.trim()
		.replace(/^["']|["']$/g, '');
}

const base64ToBytes = (value) => new Uint8Array(Buffer.from(value, 'base64'));

async function decryptSecret(payload, keyHex) {
	const [, iv, tag, data] = payload.split(':');
	const raw = /^[0-9a-fA-F]{64}$/.test(keyHex)
		? new Uint8Array(Buffer.from(keyHex, 'hex'))
		: new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(keyHex)));
	const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
	const packed = new Uint8Array([...base64ToBytes(data), ...base64ToBytes(tag)]);
	const plain = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: base64ToBytes(iv) },
		key,
		packed
	);
	return new TextDecoder().decode(plain);
}

// Mirrors isThreadsPermalink in src/lib/server/providers/threads.ts.
function isThreadsPermalink(value) {
	if (!value) return false;
	try {
		const url = new URL(value);
		if (url.protocol !== 'https:') return false;
		if (!/^(www\.)?threads\.(com|net)$/.test(url.hostname)) return false;
		const code = url.pathname.match(/\/post\/([^/]+)\/?$/)?.[1];
		return Boolean(code && !/^\d+$/.test(code));
	} catch {
		return false;
	}
}

const sqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;

const rows = d1Json(`
	SELECT pt.id AS target_id, pt.remote_post_id, pt.remote_url,
	       c.handle, c.credentials_encrypted
	FROM publish_targets pt
	JOIN connections c ON c.id = pt.connection_id
	WHERE c.platform = 'threads' AND pt.remote_post_id IS NOT NULL AND pt.remote_post_id != ''
	ORDER BY pt.created_at
`);

if (!rows.length) {
	console.log('No Threads publish rows with a remote post id.');
	process.exit(0);
}

const key = encryptionKey();
const tokens = new Map();
for (const row of rows) {
	if (tokens.has(row.credentials_encrypted)) continue;
	const creds = JSON.parse(await decryptSecret(row.credentials_encrypted, key));
	tokens.set(row.credentials_encrypted, creds.accessToken);
}

let fixed = 0;
let unchanged = 0;
let missing = 0;
let failed = 0;

for (const row of rows) {
	const token = tokens.get(row.credentials_encrypted);
	const seen = `${row.target_id}  ${row.remote_post_id}  ${row.remote_url ?? '(none)'}`;
	let status;
	try {
		const res = await fetch(
			`https://graph.threads.net/v1.0/${encodeURIComponent(row.remote_post_id)}?fields=permalink,shortcode&access_token=${encodeURIComponent(token)}`
		);
		const body = await res.json().catch(() => ({}));
		if (res.ok) {
			const permalink =
				typeof body.permalink === 'string' && isThreadsPermalink(body.permalink)
					? body.permalink
					: null;
			const shortcode =
				typeof body.shortcode === 'string' && body.shortcode && !/^\d+$/.test(body.shortcode)
					? body.shortcode
					: null;
			const handle = (row.handle || '').replace(/^@/, '');
			const resolved =
				permalink ??
				(shortcode && handle ? `https://www.threads.net/@${handle}/post/${shortcode}` : null);
			if (!resolved) {
				status = 'unresolved';
				failed += 1;
			} else if (resolved === row.remote_url) {
				status = 'unchanged';
				unchanged += 1;
			} else {
				if (apply) {
					d1Json(
						`UPDATE publish_targets SET remote_url = ${sqlString(resolved)} WHERE id = ${sqlString(row.target_id)}`
					);
				}
				status = apply ? `fixed -> ${resolved}` : `would fix -> ${resolved}`;
				fixed += 1;
			}
		} else if (body?.error?.code === 100) {
			// Meta no longer has the media (deleted post); a permission problem
			// on a live post is indistinguishable, so this only clears the link
			// when asked to.
			if (nullMissing && apply) {
				d1Json(
					`UPDATE publish_targets SET remote_url = NULL WHERE id = ${sqlString(row.target_id)}`
				);
				status = 'cleared (media no longer exists)';
			} else {
				status = `missing at Meta (${body.error.error_subcode ?? 'no subcode'})`;
			}
			missing += 1;
		} else {
			status = `error: HTTP ${res.status}`;
			failed += 1;
		}
	} catch (err) {
		status = `error: ${err instanceof Error ? err.message : String(err)}`;
		failed += 1;
	}
	console.log(`${seen}\n    ${status}`);
}

console.log(
	`\n${apply ? 'Applied' : 'Dry run'}: ${fixed} fixable, ${unchanged} unchanged, ${missing} missing at Meta, ${failed} need attention.`
);
if (!apply) console.log('Re-run with --apply to write the fixes.');
