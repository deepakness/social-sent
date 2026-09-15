import {
	base64ToBytes,
	bytesToBase64,
	hexToBytes,
	randomBytes,
	utf8Bytes
} from '$lib/domain/bytes';

/** Workers Web Crypto rejects PBKDF2 iteration counts above 100_000. */
const PBKDF2_ITERS = 100_000;
const TAG_BYTES = 16;

async function sha256(data: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
}

async function keyFromEnv(hexOrSecret: string): Promise<CryptoKey> {
	const raw = /^[0-9a-fA-F]{64}$/.test(hexOrSecret)
		? hexToBytes(hexOrSecret)
		: await sha256(utf8Bytes(hexOrSecret));
	return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, [
		'encrypt',
		'decrypt'
	]);
}

export async function encryptSecret(plaintext: string, encryptionKey: string): Promise<string> {
	const key = await keyFromEnv(encryptionKey);
	const iv = randomBytes(12);
	const packed = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv: iv as BufferSource },
			key,
			utf8Bytes(plaintext) as BufferSource
		)
	);
	const data = packed.subarray(0, packed.length - TAG_BYTES);
	const tag = packed.subarray(packed.length - TAG_BYTES);
	return `v1:${bytesToBase64(iv)}:${bytesToBase64(tag)}:${bytesToBase64(data)}`;
}

export async function decryptSecret(payload: string, encryptionKey: string): Promise<string> {
	const parts = payload.split(':');
	if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Invalid encrypted payload');
	const [, ivB64, tagB64, dataB64] = parts;
	const key = await keyFromEnv(encryptionKey);
	const iv = base64ToBytes(ivB64);
	const tag = base64ToBytes(tagB64);
	const data = base64ToBytes(dataB64);
	const packed = new Uint8Array(data.length + tag.length);
	packed.set(data, 0);
	packed.set(tag, data.length);
	try {
		const dec = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: iv as BufferSource },
			key,
			packed as BufferSource
		);
		return new TextDecoder().decode(dec);
	} catch {
		throw new Error('Invalid encrypted payload');
	}
}

export async function encryptJson<T>(value: T, encryptionKey: string): Promise<string> {
	return encryptSecret(JSON.stringify(value), encryptionKey);
}

export async function decryptJson<T>(payload: string, encryptionKey: string): Promise<T> {
	return JSON.parse(await decryptSecret(payload, encryptionKey)) as T;
}

export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const key = await crypto.subtle.importKey(
		'raw',
		utf8Bytes(password) as BufferSource,
		'PBKDF2',
		false,
		['deriveBits']
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: PBKDF2_ITERS },
		key,
		256
	);
	return `pbkdf2$${PBKDF2_ITERS}$${bytesToBase64(salt)}$${bytesToBase64(new Uint8Array(bits))}`;
}

export async function hmacHex(secret: string, value: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		utf8Bytes(secret) as BufferSource,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', key, utf8Bytes(value) as BufferSource);
	return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}
