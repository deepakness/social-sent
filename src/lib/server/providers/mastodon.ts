import { isBlockedInstanceHost } from '$lib/domain/instance-host';
import { validatePollConfig } from '$lib/domain/poll';
import { validateMastodonText } from '$lib/domain/validation/text';
import { mediaByteLength } from './types';
import type {
	ConnectionCredentials,
	ConnectionMeta,
	FetchLike,
	MediaAttachment,
	NormalizedPost,
	PlatformProvider,
	PublishResult,
	ValidationIssue
} from './types';
import { ProviderError, PublishPartialError } from './types';
import { providerFetch } from './timed-fetch';

function normalizeInstance(url: string, allowLocal: boolean): string {
	let u = url.trim();
	if (!u.startsWith('http://') && !u.startsWith('https://')) u = `https://${u}`;
	const parsed = new URL(u);
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		throw new Error('Instance URL must be http(s)');
	}
	// Credentials travel as bearer tokens: never allow cleartext http outside
	// explicitly local development.
	if (!allowLocal && parsed.protocol !== 'https:') {
		throw new Error('Instance URL must use https');
	}
	if (isBlockedInstanceHost(parsed.hostname, { allowLocal })) {
		throw new Error('Instance host not allowed');
	}
	return `${parsed.protocol}//${parsed.host}`.replace(/\/$/, '');
}

export function sanitizeMastodonInstanceUrl(url: string, allowLocal = false): string {
	return normalizeInstance(url, allowLocal);
}

async function loadMediaBytes(
	media: MediaAttachment,
	load?: (key: string) => Promise<Uint8Array | null>
) {
	if (media.bytes) return media.bytes;
	if (media.storageKey && load) {
		const bytes = await load(media.storageKey);
		if (bytes) return bytes;
	}
	throw new Error('Media requires bytes or storageKey');
}

// POST /api/v2/media answers 202 while the full-size file is still processing
// (url is null until done), and a status referencing such an id fails
// upstream. GET /api/v1/media/:id reports 206 while processing and 200 once
// usable, so poll instead of burning an attempt and a retry on "media not
// processed".
const MEDIA_PROCESS_POLL_ATTEMPTS = 10;
const MEDIA_PROCESS_POLL_MS = 2000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadMedia(
	instanceUrl: string,
	token: string,
	media: MediaAttachment,
	fetchImpl: FetchLike,
	load?: (key: string) => Promise<Uint8Array | null>
): Promise<string> {
	const bytes = await loadMediaBytes(media, load);
	const form = new FormData();
	form.append('file', new Blob([bytes as BlobPart], { type: media.mime }), 'upload');
	if (media.alt) form.append('description', media.alt);
	const res = await fetchImpl(`${instanceUrl}/api/v2/media`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}` },
		body: form
	});
	if (!res.ok) {
		throw Object.assign(
			new Error(
				`Mastodon media upload failed (${res.status}): ${(await res.text()).slice(0, 300)}`
			),
			{ status: res.status }
		);
	}
	const data = (await res.json()) as { id: string };
	if (res.status !== 202) return data.id;
	// 202: the full-size file is still processing; wait until it is usable.
	await waitForMastodonMedia(instanceUrl, token, data.id, fetchImpl);
	return data.id;
}

/**
 * Wait for an asynchronously processed media attachment to become usable.
 * `GET /api/v1/media/:id` answers 206 while processing and 200 once ready, and
 * a status created in between fails upstream — polling here trades a short
 * wait for a burned attempt and a user-visible failure.
 */
export async function waitForMastodonMedia(
	instanceUrl: string,
	token: string,
	mediaId: string,
	fetchImpl: FetchLike,
	opts: { attempts?: number; delayMs?: number } = {}
): Promise<void> {
	const attempts = opts.attempts ?? MEDIA_PROCESS_POLL_ATTEMPTS;
	const delayMs = opts.delayMs ?? MEDIA_PROCESS_POLL_MS;
	for (let attempt = 0; attempt < attempts; attempt++) {
		await sleep(delayMs);
		const poll = await fetchImpl(`${instanceUrl}/api/v1/media/${encodeURIComponent(mediaId)}`, {
			headers: { Authorization: `Bearer ${token}` }
		});
		if (poll.status === 200) return;
		if (poll.status === 206) continue;
		if (!poll.ok) {
			throw Object.assign(
				new Error(
					`Mastodon media processing failed (${poll.status}): ${(await poll.text()).slice(0, 300)}`
				),
				{ status: poll.status }
			);
		}
		return;
	}
	throw new Error('Mastodon is still processing the uploaded image — retry in a moment');
}

async function postStatus(
	instanceUrl: string,
	token: string,
	params: {
		status: string;
		media_ids?: string[];
		in_reply_to_id?: string;
		visibility?: string;
		spoiler_text?: string;
		poll?: { options: string[]; expires_in: number; multiple?: boolean; hide_totals?: boolean };
	},
	fetchImpl: FetchLike
): Promise<{ id: string; url: string }> {
	const res = await fetchImpl(`${instanceUrl}/api/v1/statuses`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(params)
	});
	if (!res.ok) {
		throw Object.assign(
			new Error(
				`Mastodon status create failed (${res.status}): ${(await res.text()).slice(0, 300)}`
			),
			{ status: res.status }
		);
	}
	return (await res.json()) as { id: string; url: string };
}

export const mastodonProvider: PlatformProvider = {
	id: 'mastodon',
	capabilities: {
		maxImages: 4,
		maxImageBytes: 16_000_000,
		supportsCW: true,
		supportsVisibility: true,
		supportsThreads: true
	},

	validate(content: NormalizedPost, meta?: ConnectionMeta): ValidationIssue[] {
		const issues: ValidationIssue[] = [];
		const max = meta?.maxCharacters ?? 500;
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
			const check = validateMastodonText(seg.text || '', max);
			if (!check.ok) {
				issues.push({
					field: `thread[${i}].text`,
					message: check.message || 'Text too long',
					code: 'max_length'
				});
			}
			if ((seg.media?.length ?? 0) > 4) {
				issues.push({
					field: `thread[${i}].media`,
					message: 'Mastodon allows max 4 images',
					code: 'max_images'
				});
			}
			for (const m of seg.media ?? []) {
				if ((m.mime || '').toLowerCase().startsWith('video/')) {
					issues.push({
						field: `thread[${i}].media`,
						message: 'Mastodon video is not supported yet — post it to LinkedIn',
						code: 'no_video'
					});
				} else if (mediaByteLength(m) > 16_000_000) {
					issues.push({
						field: `thread[${i}].media`,
						message: 'Mastodon allows max 16MB per image',
						code: 'max_image_bytes'
					});
				}
			}
			// Polls ride on the first post only; every segment shares options.
			if (i === 0 && seg.options?.poll) {
				const poll = validatePollConfig(seg.options.poll);
				if (!poll.ok) {
					issues.push({
						field: `thread[${i}].poll`,
						message: poll.error,
						code: 'invalid_poll'
					});
				} else if (hasMedia) {
					issues.push({
						field: `thread[${i}].poll`,
						message: 'Mastodon polls cannot be combined with images',
						code: 'poll_with_media'
					});
				}
			}
		}
		return issues;
	},

	async publish(content, creds, _meta, fetchImpl = providerFetch, opts): Promise<PublishResult> {
		if (!creds.accessToken || !creds.instanceUrl) {
			throw new ProviderError('Mastodon credentials require accessToken and instanceUrl', {
				code: 'auth'
			});
		}
		// The caller decides (publish.ts passes APP_URL locality). Defaulting to
		// false keeps SSRF blocking on: never assume "local is fine".
		const allowLocal = opts?.allowLocalHosts ?? false;
		const instanceUrl = normalizeInstance(creds.instanceUrl, allowLocal);
		const segments = content.thread && content.thread.length > 0 ? content.thread : [content];
		const resumeIds = opts?.resume?.segmentIds ?? [];
		const startAt = Math.min(resumeIds.length, segments.length);
		const segmentIds = resumeIds.slice(0, startAt);
		let replyTo = segmentIds.at(-1);
		let firstUrl = opts?.resume?.remoteUrl || undefined;

		for (let i = startAt; i < segments.length; i++) {
			try {
				const seg = segments[i];
				const mediaIds: string[] = [];
				for (const m of (seg.media ?? []).slice(0, 4)) {
					if ((m.mime || '').toLowerCase().startsWith('video/')) {
						throw new Error('Mastodon video is not supported yet — post it to LinkedIn');
					}
					mediaIds.push(await uploadMedia(instanceUrl, creds.accessToken, m, fetchImpl));
				}
				const pollOptions = i === 0 ? (seg.options?.poll ?? content.options?.poll) : undefined;
				const pollCheck = pollOptions ? validatePollConfig(pollOptions) : null;
				if (pollOptions && !pollCheck?.ok) {
					throw new Error(pollCheck?.error ?? 'Invalid poll');
				}
				const result = await postStatus(
					instanceUrl,
					creds.accessToken,
					{
						status: seg.text || '',
						media_ids: mediaIds.length ? mediaIds : undefined,
						in_reply_to_id: replyTo,
						visibility: seg.options?.visibility || content.options?.visibility || 'public',
						spoiler_text: seg.options?.spoilerText || content.options?.spoilerText || undefined,
						poll: pollCheck?.ok
							? {
									options: pollCheck.config.options,
									expires_in: pollCheck.config.expiresIn,
									multiple: pollCheck.config.multiple,
									hide_totals: pollCheck.config.hideTotals
								}
							: undefined
					},
					fetchImpl
				);
				segmentIds.push(result.id);
				if (!firstUrl) firstUrl = result.url;
				await opts?.checkpoint?.({
					segmentIds: [...segmentIds],
					remoteUrl: firstUrl ?? opts?.resume?.remoteUrl ?? null
				});
				replyTo = result.id;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (segmentIds.length) {
					throw new PublishPartialError(message, {
						segmentIds,
						remoteUrl: firstUrl ?? opts?.resume?.remoteUrl ?? null
					});
				}
				throw err;
			}
			if (i < segments.length - 1) await new Promise((r) => setTimeout(r, 50));
		}

		return {
			remotePostId: segmentIds[0],
			remoteUrl: firstUrl,
			segmentIds
		};
	}
};

export async function mastodonRegisterApp(
	instanceUrl: string,
	appUrl: string,
	fetchImpl: FetchLike = providerFetch,
	allowLocal = false
): Promise<{ clientId: string; clientSecret: string; instanceUrl: string }> {
	const base = normalizeInstance(instanceUrl, allowLocal);
	const res = await fetchImpl(`${base}/api/v1/apps`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			client_name: 'SocialSent',
			redirect_uris: `${appUrl.replace(/\/$/, '')}/api/connections/mastodon/callback`,
			scopes: 'read write:statuses write:media',
			website: appUrl
		})
	});
	if (!res.ok) {
		throw Object.assign(
			new Error(
				`Mastodon app register failed (${res.status}): ${(await res.text()).slice(0, 300)}`
			),
			{ status: res.status }
		);
	}
	const data = (await res.json()) as { client_id: string; client_secret: string };
	return { clientId: data.client_id, clientSecret: data.client_secret, instanceUrl: base };
}

export function mastodonAuthorizeUrl(
	instanceUrl: string,
	clientId: string,
	appUrl: string,
	state: string,
	allowLocal = false
): string {
	const base = normalizeInstance(instanceUrl, allowLocal);
	const redirect = `${appUrl.replace(/\/$/, '')}/api/connections/mastodon/callback`;
	const params = new URLSearchParams({
		client_id: clientId,
		scope: 'read write:statuses write:media',
		redirect_uri: redirect,
		response_type: 'code',
		state
	});
	return `${base}/oauth/authorize?${params.toString()}`;
}

export async function mastodonExchangeCode(
	instanceUrl: string,
	clientId: string,
	clientSecret: string,
	code: string,
	appUrl: string,
	fetchImpl: FetchLike = providerFetch,
	allowLocal = false
): Promise<ConnectionCredentials & ConnectionMeta> {
	const base = normalizeInstance(instanceUrl, allowLocal);
	const redirect = `${appUrl.replace(/\/$/, '')}/api/connections/mastodon/callback`;
	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		code,
		client_id: clientId,
		client_secret: clientSecret,
		redirect_uri: redirect,
		scope: 'read write:statuses write:media'
	});
	const res = await fetchImpl(`${base}/oauth/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body
	});
	if (!res.ok) {
		throw Object.assign(
			new Error(
				`Mastodon token exchange failed (${res.status}): ${(await res.text()).slice(0, 300)}`
			),
			{ status: res.status }
		);
	}
	const token = (await res.json()) as { access_token: string };

	const meRes = await fetchImpl(`${base}/api/v1/accounts/verify_credentials`, {
		headers: { Authorization: `Bearer ${token.access_token}` }
	});
	if (!meRes.ok)
		throw Object.assign(new Error(`Mastodon verify_credentials failed (${meRes.status})`), {
			status: meRes.status
		});
	const me = (await meRes.json()) as {
		username: string;
		display_name: string;
		avatar: string;
		acct: string;
	};

	let maxCharacters = 500;
	try {
		const inst = await fetchImpl(`${base}/api/v2/instance`);
		if (inst.ok) {
			const info = (await inst.json()) as {
				configuration?: { statuses?: { max_characters?: number } };
			};
			maxCharacters = info.configuration?.statuses?.max_characters ?? 500;
		}
	} catch {
		/* fallback 500 */
	}

	return {
		accessToken: token.access_token,
		clientId,
		clientSecret,
		instanceUrl: base,
		handle: me.acct || me.username,
		displayName: me.display_name || me.username,
		avatarUrl: me.avatar,
		maxCharacters
	};
}
