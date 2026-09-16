import { readFileSync, writeFileSync } from 'node:fs';

const dest = '.svelte-kit/cloudflare/_worker.js';
let src = readFileSync(dest, 'utf8');
if (src.includes('__SOCIALSENT_HANDLERS__')) process.exit(0);

const handlers = `
/* __SOCIALSENT_HANDLERS__ */
/**
 * Bearer for the internal tick/publish calls: an explicit secret, the API
 * token, or the value derived from APP_ENCRYPTION_KEY — the same derivation the
 * Worker itself uses (src/lib/server/derived-secrets.ts). The label below is
 * part of that contract and a unit test pins it to the app's constant.
 */
async function socialsentSchedulerSecret(env) {
	if (env.SCHEDULER_SECRET) return env.SCHEDULER_SECRET;
	if (env.API_TOKEN) return env.API_TOKEN;
	if (!env.APP_ENCRYPTION_KEY) return null;
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(env.APP_ENCRYPTION_KEY),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign(
		'HMAC',
		key,
		encoder.encode('subkey:scheduler-secret:v1')
	);
	return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function socialsentInternal(worker, env, ctx, path, body) {
	const secret = await socialsentSchedulerSecret(env);
	if (!secret) return null;
	const req = new Request('https://socialsent.internal' + path, {
		method: 'POST',
		headers: {
			Authorization: 'Bearer ' + secret,
			'Content-Type': 'application/json'
		},
		body: body ? JSON.stringify(body) : undefined
	});
	return worker.fetch(req, env, ctx);
}

export default {
	fetch: (...args) => worker_default.fetch(...args),
	scheduled(controller, env, ctx) {
		if (env.ENABLE_CF_CRON !== '1') return;
		// The internal call authenticates as a pinger would; with nothing to
		// authenticate with it is a no-op rather than a 401 every minute.
		if (!env.SCHEDULER_SECRET && !env.API_TOKEN && !env.APP_ENCRYPTION_KEY) return;
		ctx.waitUntil(socialsentInternal(worker_default, env, ctx, '/api/internal/tick'));
	},
	async queue(batch, env, ctx) {
		for (const msg of batch.messages) {
			const res = await socialsentInternal(worker_default, env, ctx, '/api/internal/publish', msg.body);
			if (!res || !res.ok) msg.retry();
			else msg.ack();
		}
	}
};
`;

const replaced = src.replace(/export\s*\{\s*worker_default as default\s*\};?/, handlers);
if (replaced === src) {
	console.error('wrap-worker: could not find default export to wrap');
	process.exit(1);
}
writeFileSync(dest, replaced);
console.log('wrap-worker: attached scheduled + queue handlers');
