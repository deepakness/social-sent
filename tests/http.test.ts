import { describe, expect, it } from 'vitest';
import { handleError } from '$lib/server/http';

describe('handleError', () => {
	it('keeps the 401 message from the thrown error', async () => {
		const res = handleError(
			Object.assign(new Error('Setup expired — sign in again'), { status: 401 })
		);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: 'Setup expired — sign in again' });
	});

	it('returns 400 body without rewriting as reconnect', async () => {
		const res = handleError(Object.assign(new Error('Invalid code'), { status: 400 }));
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'Invalid code' });
	});
});
