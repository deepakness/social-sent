import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId, type AppDb } from '$lib/server/db/client';
import { connections, drafts, users } from '$lib/server/db/schema';
import { createTestDb, createTestMedia, TEST_ENV } from '$lib/server/db/test';
import { GET as draftGET, PATCH as draftPATCH } from '../src/routes/api/drafts/[id]/+server';
import { POST as draftsPOST } from '../src/routes/api/drafts/+server';
import { POST as duplicatePOST } from '../src/routes/api/drafts/[id]/duplicate/+server';

describe('draft selected accounts', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	let connA: string;
	let connB: string;
	const media = createTestMedia();

	const localsFor = () => ({
		db,
		env: TEST_ENV,
		media,
		user: {
			id: userId,
			email: 'selection@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		}
	});

	async function createDraft(body: Record<string, unknown>) {
		const res = (await draftsPOST({
			request: new Request('http://localhost/api/drafts', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			}),
			locals: localsFor()
		} as never)) as Response;
		return {
			res,
			body: (await res.json()) as { draft: { id: string; selectedConnectionIds: unknown } }
		};
	}

	async function patchDraft(id: string, body: Record<string, unknown>) {
		const res = (await draftPATCH({
			params: { id },
			request: new Request(`http://localhost/api/drafts/${id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			}),
			locals: localsFor()
		} as never)) as Response;
		return res;
	}

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'selection@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		connA = newId();
		connB = newId();
		await db.insert(connections).values([
			{
				id: connA,
				userId,
				platform: 'x',
				handle: '@a',
				credentialsEncrypted: '{}',
				metaJson: '{}',
				status: 'active',
				createdAt: now,
				updatedAt: now
			},
			{
				id: connB,
				userId,
				platform: 'mastodon',
				handle: 'b@test',
				credentialsEncrypted: '{}',
				metaJson: '{}',
				status: 'active',
				createdAt: now,
				updatedAt: now
			}
		]);
	});

	afterAll(() => close());

	it('stores the selection when a draft is created', async () => {
		const { res, body } = await createDraft({
			baseBody: 'hello',
			selectedConnectionIds: [connA, connB, connA]
		});
		expect(res.status).toBe(201);
		expect(body.draft.selectedConnectionIds).toEqual([connA, connB]);
	});

	it('stores an explicit empty selection as [] and omits null', async () => {
		const empty = await createDraft({ baseBody: 'none', selectedConnectionIds: [] });
		expect(empty.body.draft.selectedConnectionIds).toEqual([]);
		const omitted = await createDraft({ baseBody: 'legacy' });
		expect(omitted.body.draft.selectedConnectionIds).toBeNull();
	});

	it('accepts more accounts than one publish may target', async () => {
		// Publish caps destinations at 10, but autosaving a larger selection
		// must not fail: the account list itself can be bigger.
		const { res, body } = await createDraft({
			baseBody: 'many',
			selectedConnectionIds: Array.from({ length: 12 }, (_, i) => `conn-${i}`)
		});
		expect(res.status).toBe(201);
		expect(body.draft.selectedConnectionIds).toHaveLength(12);
	});

	it('rejects malformed or oversized selections without creating a draft', async () => {
		const notArray = await createDraft({ baseBody: 'x', selectedConnectionIds: 'nope' });
		expect(notArray.res.status).toBe(400);
		const mixed = await createDraft({ baseBody: 'x', selectedConnectionIds: [1] });
		expect(mixed.res.status).toBe(400);
		const many = await createDraft({
			baseBody: 'x',
			selectedConnectionIds: Array.from({ length: 51 }, (_, i) => `conn-${i}`)
		});
		expect(many.res.status).toBe(400);
		const rows = await db.select().from(drafts).where(eq(drafts.userId, userId));
		expect(rows.some((r) => r.baseBody === 'x')).toBe(false);
	});

	it('updates the selection on PATCH and leaves it alone when omitted', async () => {
		const { body } = await createDraft({ baseBody: 'patch me', selectedConnectionIds: [connA] });
		const id = body.draft.id;
		await patchDraft(id, { selectedConnectionIds: [connB] });
		let [row] = await db.select().from(drafts).where(eq(drafts.id, id));
		expect(row?.selectedConnectionIds).toBe(JSON.stringify([connB]));
		// Body-only autosave must not clobber the stored selection.
		await patchDraft(id, { baseBody: 'patched' });
		[row] = await db.select().from(drafts).where(eq(drafts.id, id));
		expect(row?.selectedConnectionIds).toBe(JSON.stringify([connB]));
		expect(row?.baseBody).toBe('patched');
	});

	it('returns 400 for an invalid PATCH selection and writes nothing', async () => {
		const { body } = await createDraft({ baseBody: 'before', selectedConnectionIds: [connA] });
		const id = body.draft.id;
		const res = await patchDraft(id, { baseBody: 'after', selectedConnectionIds: 'nope' });
		expect(res.status).toBe(400);
		const [row] = await db.select().from(drafts).where(eq(drafts.id, id));
		expect(row?.baseBody).toBe('before');
		expect(row?.selectedConnectionIds).toBe(JSON.stringify([connA]));
	});

	it('exposes the selection on GET and copies it on duplicate', async () => {
		const { body } = await createDraft({ baseBody: 'clone me', selectedConnectionIds: [connA] });
		const id = body.draft.id;
		const getRes = (await draftGET({
			params: { id },
			locals: localsFor()
		} as never)) as Response;
		const getBody = (await getRes.json()) as { draft: { selectedConnectionIds: unknown } };
		expect(getBody.draft.selectedConnectionIds).toEqual([connA]);

		const dupRes = (await duplicatePOST({
			params: { id },
			locals: localsFor()
		} as never)) as Response;
		expect(dupRes.status).toBe(201);
		const dupBody = (await dupRes.json()) as { draft: { selectedConnectionIds: unknown } };
		expect(dupBody.draft.selectedConnectionIds).toEqual([connA]);
	});
});
