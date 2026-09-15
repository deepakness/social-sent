import { timingSafeEqual, utf8Bytes } from './bytes';

/** Live login check against Worker env — not the hashed row in D1. */
export function envCredentialsMatch(
	email: string,
	password: string,
	adminEmail: string,
	adminPassword: string
): boolean {
	const emailOk = email.trim().toLowerCase() === adminEmail.trim().toLowerCase();
	const provided = utf8Bytes(password);
	const expected = utf8Bytes(adminPassword);
	let passwordOk = false;
	if (provided.length === expected.length) {
		passwordOk = timingSafeEqual(provided, expected);
	} else {
		timingSafeEqual(expected, expected);
	}
	return emailOk && passwordOk;
}
