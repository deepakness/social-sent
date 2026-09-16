#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const keys = process.argv.slice(2);
// The app derives AUTH_SECRET and SCHEDULER_SECRET from APP_ENCRYPTION_KEY and
// takes APP_URL from the request, so those three are only uploaded when they are
// deliberately set locally (the loop below skips anything absent). ADMIN_EMAIL
// and ADMIN_PASSWORD are the optional secrets-managed login: upload them
// together to keep the account out of D1's reach.
const wanted = keys.length
	? keys
	: [
			'APP_ENCRYPTION_KEY',
			'AUTH_SECRET',
			'ADMIN_EMAIL',
			'ADMIN_PASSWORD',
			'APP_URL',
			'API_TOKEN',
			'SCHEDULER_SECRET',
			'LINKEDIN_CLIENT_ID',
			'LINKEDIN_CLIENT_SECRET',
			'THREADS_APP_ID',
			'THREADS_APP_SECRET',
			'X_CLIENT_ID',
			'X_CLIENT_SECRET',
			'MEDIA_PUBLIC_BASE_URL'
		];

function valueFromDevVars(key) {
	const raw = readFileSync('.dev.vars', 'utf8');
	for (const line of raw.split('\n')) {
		if (line.startsWith(`${key}=`)) return line.slice(key.length + 1);
	}
	return null;
}

function valueFromApiTokenFile() {
	try {
		return readFileSync('.api-token', 'utf8').trim();
	} catch {
		return null;
	}
}

function isLocalAppUrl(value) {
	try {
		const host = new URL(value).hostname.toLowerCase();
		return host === 'localhost' || host === '127.0.0.1' || host === '::1';
	} catch {
		return true;
	}
}

for (const key of wanted) {
	const value =
		key === 'API_TOKEN' ? valueFromApiTokenFile() || valueFromDevVars(key) : valueFromDevVars(key);
	if (!value) {
		console.error(`skip ${key}: no local value`);
		continue;
	}
	if (key === 'APP_URL' && isLocalAppUrl(value)) {
		console.error('skip APP_URL: local .dev.vars points at localhost. Set production with:');
		console.error('  node scripts/wrangler.mjs secret put APP_URL');
		console.error('  (your production URL, e.g. https://socialsent.<account>.workers.dev)');
		continue;
	}
	console.log(`uploading ${key}`);
	const result = spawnSync('node', ['scripts/wrangler.mjs', 'secret', 'put', key], {
		input: value,
		stdio: ['pipe', 'inherit', 'inherit']
	});
	if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log('done');
