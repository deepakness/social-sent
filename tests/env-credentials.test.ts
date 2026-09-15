import { describe, expect, it } from 'vitest';
import { envCredentialsMatch } from '$lib/domain/env-credentials';

describe('envCredentialsMatch', () => {
	it('accepts matching email and password', () => {
		expect(
			envCredentialsMatch('admin@localhost', 'change-me', 'admin@localhost', 'change-me')
		).toBe(true);
	});

	it('treats email as case-insensitive', () => {
		expect(envCredentialsMatch('Admin@Localhost', 'secret', 'admin@localhost', 'secret')).toBe(
			true
		);
	});

	it('rejects wrong password', () => {
		expect(envCredentialsMatch('admin@localhost', 'nope', 'admin@localhost', 'change-me')).toBe(
			false
		);
	});

	it('rejects wrong email even with correct password', () => {
		expect(
			envCredentialsMatch('other@localhost', 'change-me', 'admin@localhost', 'change-me')
		).toBe(false);
	});
});
