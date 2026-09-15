import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type AppDb } from '$lib/server/db/client';
import { draftMedia, drafts, users } from '$lib/server/db/schema';
import { createTestDb, createTestMedia } from '$lib/server/db/test';
import { POST as mediaPOST } from '../src/routes/api/drafts/[id]/media/+server';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('POST /api/drafts/[id]/media quotas', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	let draftId: string;
	const media = createTestMedia();

	const localsFor = () => ({
		db,
		media,
		user: {
			id: userId,
			email: 'quota@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		}
	});

	function upload(toDraft: string, files: number) {
		const form = new FormData();
		form.set('segmentIndex', '0');
		for (let i = 0; i < files; i++) {
			form.append('files', new File([PNG], `q${i}.png`, { type: 'image/png' }));
		}
		return mediaPOST({
			params: { id: toDraft },
			request: new Request('http://localhost/api/drafts/x/media', {
				method: 'POST',
				body: form
			}),
			locals: localsFor()
		} as never) as Promise<Response>;
	}

	async function freshDraft() {
		const now = new Date();
		const id = newId();
		await db.insert(drafts).values({
			id,
			userId,
			baseBody: 'quota probe',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		return id;
	}

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'quota@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		draftId = newId();
		await db.insert(drafts).values({
			id: draftId,
			userId,
			baseBody: 'quota probe',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
	});

	afterAll(() => close());

	it('accepts a normal upload', async () => {
		const res = await upload(draftId, 1);
		expect(res.status).toBe(201);
	});

	it('rejects past the per-draft cap', async () => {
		const now = new Date();
		for (let i = 0; i < 31; i++) {
			await db.insert(draftMedia).values({
				id: newId(),
				draftId,
				storageKey: `seed-${i}`,
				mime: 'image/png',
				size: 8,
				sortOrder: 10 + i,
				segmentIndex: 1,
				createdAt: now
			});
		}
		const res = await upload(draftId, 1);
		expect(res.status).toBe(413);
		expect(await res.json()).toMatchObject({ error: expect.stringMatching(/per draft/) });
	});

	it('rejects past the per-account cap', async () => {
		const spill = await freshDraft();
		const now = new Date();
		for (let i = 0; i < 1000; i++) {
			await db.insert(draftMedia).values({
				id: newId(),
				draftId: spill,
				storageKey: `bulk-${i}`,
				mime: 'image/png',
				size: 8,
				sortOrder: 100 + i,
				segmentIndex: 2,
				createdAt: now
			});
		}
		const res = await upload(await freshDraft(), 1);
		expect(res.status).toBe(413);
		expect(await res.json()).toMatchObject({ error: expect.stringMatching(/per account/) });
	});
});
