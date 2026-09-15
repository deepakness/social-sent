import { describe, expect, it } from 'vitest';
import { decryptJson, decryptSecret, encryptJson, encryptSecret } from '$lib/server/crypto';

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('crypto', () => {
	it('round-trips secrets', async () => {
		const plain = 'super-secret-token';
		const enc = await encryptSecret(plain, KEY);
		expect(enc).not.toContain(plain);
		expect(await decryptSecret(enc, KEY)).toBe(plain);
	});

	it('round-trips json credentials', async () => {
		const creds = { accessToken: 'abc', instanceUrl: 'https://x' };
		const enc = await encryptJson(creds, KEY);
		expect(await decryptJson<typeof creds>(enc, KEY)).toEqual(creds);
	});

	it('rejects tampered payload', async () => {
		const enc = await encryptSecret('hello', KEY);
		await expect(decryptSecret(enc.slice(0, -2) + 'aa', KEY)).rejects.toThrow();
	});
});
