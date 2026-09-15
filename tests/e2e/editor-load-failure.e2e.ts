import { expect, test } from '@playwright/test';
import { e2eVars } from './e2e-env';

const vars = e2eVars();

test.beforeEach(async ({ page }) => {
	await page.goto('/compose');
	if (/\/login$/.test(new URL(page.url()).pathname)) {
		await page.getByLabel('Email').fill(vars.ADMIN_EMAIL);
		await page.getByLabel('Password').fill(vars.ADMIN_PASSWORD);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page).toHaveURL(/\/compose$/, { timeout: 20000 });
	}
});

/**
 * A draft whose fetch fails used to leave `savedSnapshot` unset, which the
 * autosave effect treated as "nothing saved yet" and baselined the *empty*
 * editor. The first keystroke then PATCHed that empty body over the stored
 * draft. The handler now refuses to save until the stored copy arrives, and
 * says so.
 */
test('a draft that fails to load is never overwritten, and retry recovers it', async ({ page }) => {
	// Save a draft with known content.
	await page.goto('/compose');
	const box = page.getByTestId('segment-input-0');
	await box.click();
	await box.pressSequentially('stored copy', { delay: 10 });
	await expect
		.poll(() => new URL(page.url()).searchParams.get('id'), { timeout: 30000 })
		.toBeTruthy();
	const id = new URL(page.url()).searchParams.get('id')!;
	const storedBody = async () => {
		const res = await page.request.get(`/api/drafts/${id}`);
		const body = (await res.json()) as { draft?: { baseBody?: string } };
		return body.draft?.baseBody;
	};
	await expect.poll(storedBody, { timeout: 30000 }).toBe('stored copy');
	// Let the autosave debounce settle so nothing is in flight.
	await page.waitForTimeout(2000);
	await expect.poll(storedBody, { timeout: 30000 }).toBe('stored copy');

	// Re-open it with the read failing.
	await page.route(`**/api/drafts/${id}`, async (route) => {
		if (route.request().method() === 'GET') {
			await route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: '{"error":"boom"}'
			});
			return;
		}
		await route.continue();
	});
	await page.goto('/posts');
	await page.goto(`/compose?id=${id}`);
	const box2 = page.getByTestId('segment-input-0');
	await expect(box2).toBeVisible({ timeout: 20000 });

	// The whole point: typing must not autosave over the draft that never loaded.
	await box2.click();
	await box2.pressSequentially('typed into a draft that never loaded', { delay: 10 });
	await page.waitForTimeout(3500);
	expect(await storedBody()).toBe('stored copy');
	// …and the editor explains why nothing is being saved.
	await expect(page.getByTestId('draft-load-error')).toBeVisible({ timeout: 20000 });

	// Retry loads it: the notice clears and the stored copy is what it shows.
	await page.unroute(`**/api/drafts/${id}`);
	await page.getByRole('button', { name: 'Retry' }).click();
	await expect(page.getByTestId('draft-load-error')).toBeHidden({ timeout: 20000 });
	await expect(box2).toHaveValue('stored copy');
});
