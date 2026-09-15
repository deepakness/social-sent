import { eq } from 'drizzle-orm';
import type { LayoutServerLoad } from './$types';
import { first } from '$lib/server/db/client';
import { users } from '$lib/server/db/schema';
import { parseProfileSettings } from '$lib/domain/profile-settings';

export const load: LayoutServerLoad = async ({ locals }) => {
	let displayName: string | null = null;
	let profilePictureUrl: string | null = null;
	if (locals.user) {
		const row = await first(
			locals.db
				.select({ displayName: users.displayName, settingsJson: users.settingsJson })
				.from(users)
				.where(eq(users.id, locals.user.id))
		).catch(() => null);
		displayName = row?.displayName ?? null;
		profilePictureUrl = parseProfileSettings(row?.settingsJson).profilePictureUrl;
	}
	return { user: locals.user, displayName, profilePictureUrl, appName: locals.env.APP_NAME };
};
