import { readFileSync, writeFileSync } from 'node:fs';

const dest = '.svelte-kit/cloudflare/_worker.js';
let src = readFileSync(dest, 'utf8');
if (src.includes('__SOCIALSENT_HANDLERS__')) process.exit(0);

const handlers = `
/* __SOCIALSENT_HANDLERS__ */
async function socialsentInternal(worker, env, ctx, path, body) {
	const secret = env.SCHEDULER_SECRET || env.API_TOKEN;
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
		ctx.waitUntil(socialsentInternal(worker_default, env, ctx, '/api/internal/tick'));
	},
	async queue(batch, env, ctx) {
		for (const msg of batch.messages) {
			const res = await socialsentInternal(worker_default, env, ctx, '/api/internal/publish', msg.body);
			if (!res.ok) msg.retry();
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
