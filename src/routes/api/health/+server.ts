import { json } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	try {
		await locals.db.run(sql`SELECT 1`);
		return json({ ok: true, service: 'socialsent', time: new Date().toISOString() });
	} catch (err) {
		// Never leak driver internals on a public endpoint.
		console.error('[health] db probe failed', err);
		return json({ ok: false, error: 'unavailable' }, { status: 503 });
	}
};
