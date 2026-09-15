import { utf8ByteLength } from '$lib/domain/bytes';
import { extractFirstUrl } from '$lib/domain/links';
import { fetchOgImage, fetchOpenGraph } from '../opengraph';
import { isBlockedInstanceHost } from '$lib/domain/instance-host';
import { validateBlueskyText } from '$lib/domain/validation/text';
import type {
	ConnectionCredentials,
	FetchLike,
	MediaAttachment,
	NormalizedPost,
	PlatformProvider,
	PublishResult,
	ValidationIssue
} from './types';
import {
	mediaByteLength,
	providerErrorForStatus,
	ProviderError,
	PublishPartialError
} from './types';
import { providerFetch } from './timed-fetch';

const DEFAULT_PDS = 'https://bsky.social';

// Validate a user-supplied PDS host. Without this, an authenticated user can
// make the server POST to an arbitrary host/port (`pdsHost` SSRF) and read
// the error body. Mirrors the Mastodon instance check.
export function sanitizeBlueskyPdsHost(raw: string, allowLocal = false): string {
	let u = raw.trim().replace(/\/$/, '');
	if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
	const parsed = new URL(u);
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		throw new Error('PDS URL must be http(s)');
	}
	if (!allowLocal && parsed.protocol !== 'https:') {
		throw new Error('PDS URL must use https');
	}
	if (isBlockedInstanceHost(parsed.hostname, { allowLocal })) {
		throw new Error('PDS host not allowed');
	}
	return `${parsed.protocol}//${parsed.host}`;
}

// Attach the upstream HTTP status so the API layer can map 401/429 instead of
// collapsing everything to 500, and cap remote bodies (log/history hygiene).
// 401/403/429 classify into typed codes (auth/forbidden/rate_limited) so
// publish can decide expiry without regexing messages.
function upstreamError(prefix: string, status: number, body: string): ProviderError {
	return providerErrorForStatus(prefix, status, body);
}

function pds(creds: ConnectionCredentials): string {
	// Stored rows predate validation; re-check on every use (fail closed).
	return sanitizeBlueskyPdsHost(creds.pdsHost || DEFAULT_PDS);
}

export function buildLinkFacets(text: string): Array<{
	index: { byteStart: number; byteEnd: number };
	features: Array<{ $type: string; uri: string }>;
}> {
	const facets: Array<{
		index: { byteStart: number; byteEnd: number };
		features: Array<{ $type: string; uri: string }>;
	}> = [];
	const re = /https?:\/\/[^\s]+/gi;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		const url = match[0].replace(/[.,);:!?]+$/, '');
		const byteStart = utf8ByteLength(text.slice(0, match.index));
		const byteEnd = byteStart + utf8ByteLength(url);
		facets.push({
			index: { byteStart, byteEnd },
			features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }]
		});
	}
	return facets;
}

async function ensureSession(
	creds: ConnectionCredentials,
	fetchImpl: FetchLike
): Promise<ConnectionCredentials> {
	if (creds.accessJwt && creds.did) return creds;
	if (!creds.handle || !creds.appPassword) {
		throw new ProviderError('Bluesky credentials require handle and appPassword (or accessJwt)', {
			code: 'auth'
		});
	}
	const res = await fetchImpl(`${pds(creds)}/xrpc/com.atproto.server.createSession`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ identifier: creds.handle, password: creds.appPassword })
	});
	if (!res.ok) {
		throw upstreamError('Bluesky createSession', res.status, await res.text());
	}
	const data = (await res.json()) as {
		accessJwt: string;
		refreshJwt: string;
		did: string;
		handle: string;
	};
	return {
		...creds,
		accessJwt: data.accessJwt,
		refreshJwt: data.refreshJwt,
		did: data.did,
		handle: data.handle
	};
}

async function refreshSession(
	creds: ConnectionCredentials,
	fetchImpl: FetchLike
): Promise<ConnectionCredentials> {
	if (!creds.refreshJwt) {
		return ensureSession({ ...creds, accessJwt: undefined }, fetchImpl);
	}
	const res = await fetchImpl(`${pds(creds)}/xrpc/com.atproto.server.refreshSession`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${creds.refreshJwt}` }
	});
	if (!res.ok) {
		return ensureSession({ ...creds, accessJwt: undefined, refreshJwt: undefined }, fetchImpl);
	}
	const data = (await res.json()) as { accessJwt: string; refreshJwt: string; did: string };
	return { ...creds, accessJwt: data.accessJwt, refreshJwt: data.refreshJwt, did: data.did };
}

async function loadMediaBytes(media: MediaAttachment): Promise<Uint8Array> {
	if (media.bytes) return media.bytes;
	throw new Error('Media requires bytes');
}

async function uploadBlob(
	creds: ConnectionCredentials,
	media: MediaAttachment,
	fetchImpl: FetchLike
) {
	const bytes = await loadMediaBytes(media);
	const res = await fetchImpl(`${pds(creds)}/xrpc/com.atproto.repo.uploadBlob`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${creds.accessJwt}`,
			'Content-Type': media.mime
		},
		body: bytes as unknown as BodyInit
	});
	if (!res.ok) {
		throw upstreamError('Bluesky uploadBlob', res.status, await res.text());
	}
	const data = (await res.json()) as {
		blob: { $type: string; ref: { $link: string }; mimeType: string; size: number };
	};
	return data.blob;
}

async function createPostRecord(
	creds: ConnectionCredentials,
	post: {
		text: string;
		createdAt: string;
		facets?: ReturnType<typeof buildLinkFacets>;
		embed?: unknown;
		reply?: { root: { uri: string; cid: string }; parent: { uri: string; cid: string } };
	},
	fetchImpl: FetchLike
): Promise<{ uri: string; cid: string }> {
	const res = await fetchImpl(`${pds(creds)}/xrpc/com.atproto.repo.createRecord`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${creds.accessJwt}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			repo: creds.did,
			collection: 'app.bsky.feed.post',
			record: { $type: 'app.bsky.feed.post', ...post }
		})
	});
	if (!res.ok) {
		throw upstreamError('Bluesky createRecord', res.status, await res.text());
	}
	return (await res.json()) as { uri: string; cid: string };
}

async function resolveRecordCid(
	creds: ConnectionCredentials,
	uri: string,
	fetchImpl: FetchLike
): Promise<string> {
	const parts = uri.replace('at://', '').split('/');
	const repo = parts[0];
	const rkey = parts[parts.length - 1];
	const collection = parts.slice(1, -1).join('/');
	const url =
		`${pds(creds)}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(repo)}` +
		`&collection=${encodeURIComponent(collection)}&rkey=${encodeURIComponent(rkey)}`;
	const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${creds.accessJwt}` } });
	if (!res.ok) {
		throw upstreamError('Bluesky checkpoint lookup', res.status, await res.text());
	}
	const data = (await res.json()) as { cid?: string };
	if (!data.cid) throw new Error('Bluesky checkpoint lookup returned no record id');
	return data.cid;
}

function publicUrl(uri: string, handle?: string): string {
	const parts = uri.replace('at://', '').split('/');
	const rkey = parts[parts.length - 1];
	const actor = handle || parts[0];
	return `https://bsky.app/profile/${actor}/post/${rkey}`;
}

async function resolveExternalEmbed(
	text: string,
	session: ConnectionCredentials,
	fetchImpl: FetchLike
): Promise<unknown | undefined> {
	// One embed per post: images win, external card only when no media.
	// Matches bsky.app + Buffer/Typefully composer convention.
	const url = extractFirstUrl(text || '');
	if (!url) return undefined;
	let og;
	try {
		og = await fetchOpenGraph(url, fetchImpl);
	} catch {
		return undefined;
	}
	const title = (og.title || og.siteName || url).slice(0, 300);
	const description = (og.description || og.title || url).slice(0, 1000);
	if (!title || !description) return undefined;
	let thumb;
	if (og.image) {
		try {
			const img = await fetchOgImage(og.image, fetchImpl);
			// Lexicon: external thumb blob image/* max 1MB. Exclude SVG
			// (vector, PDS rejects it as a raster thumb — skip, keep card).
			if (
				img &&
				img.bytes.length <= 1000000 &&
				img.mime.startsWith('image/') &&
				img.mime !== 'image/svg+xml'
			) {
				thumb = await uploadBlob(session, { bytes: img.bytes, mime: img.mime }, fetchImpl);
			}
		} catch {
			// Thumb is optional — card without image still renders.
		}
	}
	return {
		$type: 'app.bsky.embed.external',
		external: { uri: url, title, description, ...(thumb ? { thumb } : {}) }
	};
}

async function publishOne(
	content: NormalizedPost,
	creds: ConnectionCredentials,
	fetchImpl: FetchLike,
	reply?: { root: { uri: string; cid: string }; parent: { uri: string; cid: string } }
): Promise<{ uri: string; cid: string }> {
	let session = await ensureSession(creds, fetchImpl);
	const media = content.media ?? [];
	let embed: unknown;
	if (media.length > 0) {
		const images = [];
		for (const m of media.slice(0, 4)) {
			if ((m.mime || '').toLowerCase().startsWith('video/')) {
				throw new Error('Bluesky does not support video — post it to LinkedIn');
			}
			const blob = await uploadBlob(session, m, fetchImpl);
			images.push({
				alt: m.alt || '',
				image: blob,
				...(m.width && m.height ? { aspectRatio: { width: m.width, height: m.height } } : {})
			});
		}
		embed = { $type: 'app.bsky.embed.images', images };
	} else {
		try {
			embed = await resolveExternalEmbed(content.text || '', session, fetchImpl);
		} catch {
			embed = undefined;
		}
	}
	const facets = buildLinkFacets(content.text);
	try {
		return await createPostRecord(
			session,
			{
				text: content.text,
				createdAt: new Date().toISOString(),
				facets: facets.length ? facets : undefined,
				embed,
				reply
			},
			fetchImpl
		);
	} catch (err) {
		// Only an expired token justifies a refresh + single retry. Retrying on
		// 400/429/500 masks the real error and burns an extra PDS round trip.
		if ((err as { status?: number } | null)?.status !== 401) throw err;
		session = await refreshSession(session, fetchImpl);
		Object.assign(creds, session);
		return createPostRecord(
			session,
			{
				text: content.text,
				createdAt: new Date().toISOString(),
				facets: facets.length ? facets : undefined,
				embed,
				reply
			},
			fetchImpl
		);
	}
}

export const blueskyProvider: PlatformProvider = {
	id: 'bluesky',
	capabilities: {
		maxImages: 4,
		maxImageBytes: 1_000_000,
		supportsCW: false,
		supportsVisibility: false,
		supportsThreads: true
	},

	validate(content: NormalizedPost): ValidationIssue[] {
		const issues: ValidationIssue[] = [];
		const segments = content.thread && content.thread.length > 0 ? content.thread : [content];
		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i];
			const hasMedia = (seg.media?.length ?? 0) > 0;
			if (!seg.text?.trim() && !hasMedia) {
				issues.push({
					field: `thread[${i}]`,
					message: 'Segment needs text or media',
					code: 'empty'
				});
			}
			const textCheck = validateBlueskyText(seg.text || '');
			if (!textCheck.ok && (seg.text || '').length > 0) {
				issues.push({
					field: `thread[${i}].text`,
					message: textCheck.message || 'Text too long',
					code: 'max_length'
				});
			}
			if ((seg.media?.length ?? 0) > 4) {
				issues.push({
					field: `thread[${i}].media`,
					message: 'Bluesky allows max 4 images',
					code: 'max_images'
				});
			}
			for (const m of seg.media ?? []) {
				if ((m.mime || '').toLowerCase().startsWith('video/')) {
					issues.push({
						field: `thread[${i}].media`,
						message: 'Bluesky does not support video — post it to LinkedIn',
						code: 'no_video'
					});
				} else if (mediaByteLength(m) > 1_000_000) {
					issues.push({
						field: `thread[${i}].media`,
						message: 'Bluesky allows max 1MB per image',
						code: 'max_image_bytes'
					});
				}
			}
		}
		return issues;
	},

	async publish(content, creds, _meta, fetchImpl = providerFetch, opts): Promise<PublishResult> {
		const segments = content.thread && content.thread.length > 0 ? content.thread : [content];
		const resumeIds = opts?.resume?.segmentIds ?? [];
		const resumeCids = opts?.resume?.segmentCids ?? [];
		const startAt = Math.min(resumeIds.length, segments.length);
		const segmentIds = resumeIds.slice(0, startAt);
		const segmentCids = resumeCids.slice(0, startAt);
		// Old checkpoints may lack record CIDs; resolve the real ones so reply
		// references stay valid instead of sending a fabricated id.
		if (segmentIds.some((_, i) => !segmentCids[i])) {
			const session = await ensureSession(creds, fetchImpl);
			for (let i = 0; i < segmentIds.length; i++) {
				if (!segmentCids[i])
					segmentCids[i] = await resolveRecordCid(session, segmentIds[i], fetchImpl);
			}
		}
		const cidAt = (i: number): string => {
			const cid = segmentCids[i];
			if (!cid) throw new Error('Bluesky checkpoint is missing record ids; cannot resume safely');
			return cid;
		};
		let root: { uri: string; cid: string } | null = segmentIds[0]
			? { uri: segmentIds[0], cid: cidAt(0) }
			: null;
		let parent: { uri: string; cid: string } | null = segmentIds.at(-1)
			? { uri: segmentIds[segmentIds.length - 1], cid: cidAt(segmentCids.length - 1) }
			: null;

		for (let i = startAt; i < segments.length; i++) {
			try {
				const reply = root && parent ? { root, parent } : undefined;
				const result = await publishOne(segments[i], creds, fetchImpl, reply);
				segmentIds.push(result.uri);
				segmentCids.push(result.cid);
				if (!root) root = result;
				parent = result;
				await opts?.checkpoint?.({
					segmentIds: [...segmentIds],
					segmentCids: [...segmentCids],
					remoteUrl: opts?.resume?.remoteUrl || publicUrl(segmentIds[0], creds.handle)
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (segmentIds.length) {
					throw new PublishPartialError(message, {
						segmentIds,
						segmentCids,
						remoteUrl: opts?.resume?.remoteUrl || publicUrl(segmentIds[0], creds.handle)
					});
				}
				throw err;
			}
			if (i < segments.length - 1) await new Promise((r) => setTimeout(r, 50));
		}

		const first = segmentIds[0];
		return {
			remotePostId: first,
			remoteUrl: opts?.resume?.remoteUrl || publicUrl(first, creds.handle),
			segmentIds,
			segmentCids
		};
	},

	async refreshIfNeeded(creds, fetchImpl = providerFetch) {
		return refreshSession(creds, fetchImpl);
	}
};

export async function blueskyCreateSession(
	handle: string,
	appPassword: string,
	pdsHost = DEFAULT_PDS,
	fetchImpl: FetchLike = providerFetch
): Promise<ConnectionCredentials & { displayName?: string; avatarUrl?: string }> {
	const host = sanitizeBlueskyPdsHost(pdsHost);
	const res = await fetchImpl(`${host}/xrpc/com.atproto.server.createSession`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ identifier: handle, password: appPassword })
	});
	if (!res.ok) {
		throw upstreamError('Bluesky login', res.status, await res.text());
	}
	const data = (await res.json()) as {
		accessJwt: string;
		refreshJwt: string;
		did: string;
		handle: string;
	};

	let displayName = data.handle;
	let avatarUrl: string | undefined;
	try {
		const profRes = await fetchImpl(
			`${host}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(data.did)}`,
			{ headers: { Authorization: `Bearer ${data.accessJwt}` } }
		);
		if (profRes.ok) {
			const profile = (await profRes.json()) as {
				displayName?: string;
				avatar?: string;
				handle?: string;
			};
			if (profile.displayName) displayName = profile.displayName;
			else if (profile.handle) displayName = profile.handle;
			if (profile.avatar) avatarUrl = profile.avatar;
		}
	} catch {
		/* optional */
	}

	return {
		handle: data.handle,
		appPassword,
		accessJwt: data.accessJwt,
		refreshJwt: data.refreshJwt,
		did: data.did,
		pdsHost: host,
		displayName,
		avatarUrl
	};
}
