<script lang="ts">
	import { formatDistanceToNow } from 'date-fns';
	import { onMount } from 'svelte';
	import { Pencil, User } from '@lucide/svelte';
	import AccountAvatar from '$lib/components/AccountAvatar.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import { humanizeError } from '$lib/domain/human-error';
	import { accountLabel, displayHandle, platformRank } from '$lib/domain/platforms';
	import { isValidProfilePictureUrl, PROFILE_PICTURE_URL_MAX } from '$lib/domain/profile-settings';

	let { data } = $props();
	let msg = $state<string | null>(null);
	let err = $state<string | null>(null);
	let totpOn = $state(false);
	let backupRemaining = $state(0);
	let rotateOpen = $state(false);
	let rotateCode = $state('');
	let rotateSecret = $state('');
	let rotateQr = $state('');
	let rotateBackups = $state<string[]>([]);
	let rotateSaved = $state(false);
	let rotateConfirm = $state('');
	let rotateBusy = $state(false);
	let prefVisibility = $state('public');
	let prefAccounts = $state<string[]>([]);
	let allAccounts = $state<
		{
			id: string;
			platform: string;
			handle: string | null;
			displayName: string | null;
			avatarUrl: string | null;
		}[]
	>([]);
	let prefSaved = $state<string | null>(null);
	let prefBusy = $state(false);
	let displayName = $state('');
	let profilePictureUrl = $state('');
	// The name the server last accepted: the profile form's Save button stays
	// disabled until the draft drifts from it. The picture is not tracked here
	// because it saves from its own dialog.
	let savedDisplayName = $state('');
	let pictureBroken = $state(false);
	let isPictureDialogOpen = $state(false);
	let pictureDialogUrl = $state('');
	// Set once the user has tried to save a bad URL, so the message appears on
	// demand and then keeps up as they edit.
	let pictureTouched = $state(false);
	let pictureServerError = $state<string | null>(null);
	let pictureBusy = $state(false);
	let profileSaved = $state<string | null>(null);
	let profileSavedTimer: ReturnType<typeof setTimeout> | null = null;
	let profileBusy = $state(false);
	const nameDirty = $derived(displayName.trim() !== savedDisplayName);
	const pictureMessage = $derived(
		pictureServerError ?? (pictureTouched ? pictureUrlError(pictureDialogUrl) : null)
	);
	type KeyMeta = {
		prefix: string;
		createdAt: string;
		lastUsedAt: string | null;
		scopes?: string[] | null;
	};
	let keyActive = $state<KeyMeta | null>(null);
	let keyLoading = $state(true);
	// The stored key status actually arrived: without it a failed fetch would
	// render "No active key" and invite a rotation that was never needed.
	let keyLoaded = $state(false);
	let keyBusy = $state(false);
	let keyRevealed = $state<string | null>(null);
	let keyCopied = $state(false);
	let keyConfirm: 'rotate' | 'revoke' | null = $state(null);
	let keyJustRotated = $state(false);
	// The form stays disabled until the first load resolves: applying slow
	// fetch results over user edits (and then saving them) would silently
	// reset their choices. `prefsLoaded` separates "the request finished" from
	// "the stored values arrived", so a failed load cannot leave the form
	// editing — and saving — the compile-time defaults.
	let prefsLoading = $state(true);
	let prefsLoaded = $state(false);
	// Client-only preference, mirrored with the editor via localStorage.
	const SKIP_ASK_KEY = 'socialsent-skip-publish-confirm';
	let askPublish = $state(true);

	async function load() {
		if (!prefsLoaded) prefsLoading = true;
		if (!keyLoaded) keyLoading = true;
		err = null;
		try {
			const [totp, settings, conns, key] = await Promise.all([
				fetch('/api/auth/totp/status'),
				fetch('/api/settings'),
				fetch('/api/connections'),
				fetch('/api/key')
			]);
			if (totp.ok) {
				const t = await totp.json();
				totpOn = Boolean(t.enabled);
				backupRemaining = t.backupRemaining ?? 0;
			}
			if (settings.ok) {
				const s = await settings.json();
				prefVisibility = s.settings?.mastoVisibility ?? 'public';
				prefAccounts = s.settings?.defaultAccountIds ?? [];
				displayName = s.displayName ?? '';
				profilePictureUrl = s.settings?.profilePictureUrl ?? '';
				savedDisplayName = displayName.trim();
				pictureBroken = false;
				prefsLoaded = true;
			}
			if (conns.ok) {
				const c = await conns.json();
				allAccounts = [...(c.connections || [])].sort(
					(a, b) => platformRank(a.platform) - platformRank(b.platform)
				);
			}
			if (key.ok) {
				const k = await key.json();
				keyActive = k.active;
				keyLoaded = true;
			}
			// A 5xx resolves rather than rejecting, so check the status too.
			if (!settings.ok || !key.ok) err = 'Could not load your settings';
		} catch {
			err = humanizeError('fetch failed');
		} finally {
			prefsLoading = false;
			keyLoading = false;
		}
	}

	async function saveProfile(e: Event) {
		e.preventDefault();
		profileBusy = true;
		err = null;
		clearProfileSaved();
		try {
			// This card owns the name only. Sending the picture or the new-post
			// defaults would commit edits the user never saved in those sections.
			const res = await fetch('/api/settings', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ displayName: displayName.trim() })
			});
			const payload = await res.json();
			if (!res.ok) throw new Error(payload.error || 'Could not save');
			displayName = payload.displayName ?? '';
			savedDisplayName = displayName.trim();
			flashProfileSaved('Profile saved');
		} catch (e) {
			err = humanizeError(e instanceof Error ? e.message : 'Could not save');
		} finally {
			profileBusy = false;
		}
	}

	/** Same rules as the server, so a typo never costs the user their other edits. */
	function pictureUrlError(value: string): string | null {
		const trimmed = value.trim();
		if (!trimmed) return null;
		if (trimmed.length > PROFILE_PICTURE_URL_MAX) {
			return `URL is too long (max ${PROFILE_PICTURE_URL_MAX} characters)`;
		}
		return isValidProfilePictureUrl(trimmed) ? null : 'Enter an https:// image URL';
	}

	async function commitPictureUrl(url: string) {
		pictureBusy = true;
		pictureServerError = null;
		try {
			const res = await fetch('/api/settings', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ profilePictureUrl: url })
			});
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(payload.error || 'Could not save picture');
			profilePictureUrl = payload.settings?.profilePictureUrl ?? '';
			pictureBroken = false;
			pictureTouched = false;
			isPictureDialogOpen = false;
			flashProfileSaved(url ? 'Profile picture saved' : 'Profile picture removed');
		} catch (e) {
			pictureServerError = humanizeError(e instanceof Error ? e.message : 'Could not save picture');
		} finally {
			pictureBusy = false;
		}
	}

	function savePicture() {
		// Enter in the URL field reaches this too, bypassing the dialog's busy button.
		if (pictureBusy) return;
		if (pictureUrlError(pictureDialogUrl)) {
			pictureTouched = true;
			return;
		}
		void commitPictureUrl(pictureDialogUrl.trim());
	}

	function removePicture() {
		void commitPictureUrl('');
	}

	function flashProfileSaved(text: string) {
		clearProfileSaved();
		profileSaved = text;
		profileSavedTimer = setTimeout(() => {
			profileSaved = null;
			profileSavedTimer = null;
		}, 4000);
	}

	function clearProfileSaved() {
		if (profileSavedTimer) clearTimeout(profileSavedTimer);
		profileSavedTimer = null;
		profileSaved = null;
	}

	async function savePrefs(e: Event) {
		e.preventDefault();
		prefBusy = true;
		err = null;
		prefSaved = null;
		try {
			const res = await fetch('/api/settings', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mastoVisibility: prefVisibility,
					defaultAccountIds: prefAccounts
				})
			});
			const payload = await res.json();
			if (!res.ok) throw new Error(payload.error || 'Could not save');
			prefSaved = 'Defaults saved';
		} catch (e) {
			err = humanizeError(e instanceof Error ? e.message : 'Could not save');
		} finally {
			prefBusy = false;
		}
	}

	function togglePrefAccount(id: string) {
		prefAccounts = prefAccounts.includes(id)
			? prefAccounts.filter((a) => a !== id)
			: [...prefAccounts, id];
	}

	async function startRotate(e: Event) {
		e.preventDefault();
		rotateBusy = true;
		err = null;
		try {
			const res = await fetch('/api/auth/totp/rotate/start', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ code: rotateCode })
			});
			const payload = await res.json();
			if (!res.ok) throw new Error(payload.error || 'Invalid code');
			rotateSecret = payload.secret;
			rotateQr = payload.qrSvg;
			rotateBackups = payload.backupCodes;
		} catch (e) {
			err = humanizeError(e instanceof Error ? e.message : 'Invalid code');
		} finally {
			rotateBusy = false;
		}
	}

	async function confirmRotate(e: Event) {
		e.preventDefault();
		rotateBusy = true;
		err = null;
		try {
			const res = await fetch('/api/auth/totp/enroll/confirm', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ code: rotateConfirm })
			});
			const payload = await res.json();
			if (!res.ok) throw new Error(payload.error || 'Invalid code');
			rotateOpen = false;
			rotateQr = '';
			rotateCode = '';
			rotateConfirm = '';
			rotateSaved = false;
			msg = 'Authenticator updated';
			await load();
		} catch (e) {
			err = humanizeError(e instanceof Error ? e.message : 'Invalid code');
		} finally {
			rotateBusy = false;
		}
	}

	async function rotateKey() {
		keyBusy = true;
		err = null;
		try {
			const res = await fetch('/api/key', { method: 'POST' });
			const payload = await res.json();
			if (!res.ok) throw new Error(payload.error || 'Could not create key');
			// The raw key exists only in this response — show it once.
			keyRevealed = payload.key;
			keyCopied = false;
			keyJustRotated = Boolean(keyActive);
			keyConfirm = null;
			await load();
		} catch (e) {
			err = humanizeError(e instanceof Error ? e.message : 'Could not create key');
		} finally {
			keyBusy = false;
		}
	}

	async function revokeKey() {
		keyBusy = true;
		err = null;
		try {
			const res = await fetch('/api/key', { method: 'DELETE' });
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(payload.error || 'Could not revoke key');
			keyConfirm = null;
			keyRevealed = null;
			msg = 'API key revoked';
			await load();
		} catch (e) {
			err = humanizeError(e instanceof Error ? e.message : 'Could not revoke key');
		} finally {
			keyBusy = false;
		}
	}

	async function copyKey() {
		if (!keyRevealed) return;
		try {
			await navigator.clipboard.writeText(keyRevealed);
			keyCopied = true;
		} catch {
			err = 'Copy failed — select the key manually';
		}
	}

	function dismissRevealed() {
		// Deliberately one-way: once dismissed the raw key is unrecoverable.
		keyRevealed = null;
		keyCopied = false;
		keyJustRotated = false;
	}

	function keyDate(iso: string | null): string {
		if (!iso) return 'never';
		const d = new Date(iso);
		return Number.isNaN(d.getTime()) ? 'never' : formatDistanceToNow(d, { addSuffix: true });
	}

	onMount(() => {
		void load();
		try {
			askPublish = localStorage.getItem(SKIP_ASK_KEY) !== '1';
		} catch {
			// storage unavailable: default holds
		}
		return () => {
			if (profileSavedTimer) clearTimeout(profileSavedTimer);
		};
	});

	function setAskPublish(on: boolean) {
		askPublish = on;
		try {
			if (on) localStorage.removeItem(SKIP_ASK_KEY);
			else localStorage.setItem(SKIP_ASK_KEY, '1');
		} catch {
			// prefs are cosmetic
		}
	}
</script>

<div class="mx-auto flex w-full max-w-2xl flex-1 flex-col">
	<div class="mb-10 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
		<div>
			<p class="text-[11px] font-bold tracking-widest text-stone-500 uppercase">Preferences</p>
			<h1 class="mt-2 text-3xl font-extrabold tracking-tight text-stone-900">Settings</h1>
		</div>
	</div>

	{#if msg || err}
		<div
			class="mb-6 rounded-xl px-3 py-2 text-sm {err
				? 'bg-red-50 text-red-700'
				: 'bg-emerald-50 text-emerald-800'}"
			role="alert"
		>
			{err || msg}
		</div>
	{/if}

	<div class="grid gap-6">
		<div
			class="rounded-[2rem] border border-stone-200/80 bg-white p-6 shadow-[0_8px_30px_-12px_rgb(28_25_23/0.06)] sm:p-8"
		>
			<h2 class="mb-6 text-[17px] font-extrabold tracking-tight text-stone-900">Profile Details</h2>
			<form class="space-y-5" onsubmit={saveProfile}>
				<div class="flex flex-col gap-5 sm:flex-row sm:items-start sm:gap-6">
					<div class="relative shrink-0 self-start">
						{#if profilePictureUrl.trim() && !pictureBroken}
							<img
								src={profilePictureUrl.trim()}
								alt="Profile avatar"
								class="h-20 w-20 rounded-full border border-stone-200 object-cover shadow-sm"
								onerror={() => (pictureBroken = true)}
							/>
						{:else}
							<span
								class="flex h-20 w-20 items-center justify-center rounded-full border border-stone-200 bg-stone-100 text-stone-500 shadow-sm"
								aria-hidden="true"
							>
								<User class="h-7 w-7" />
							</span>
						{/if}
						<button
							type="button"
							onclick={() => {
								pictureDialogUrl = profilePictureUrl;
								pictureTouched = false;
								pictureServerError = null;
								isPictureDialogOpen = true;
							}}
							disabled={prefsLoading || !prefsLoaded}
							aria-label={profilePictureUrl.trim() ? 'Edit profile picture' : 'Add profile picture'}
							title="Edit profile picture"
							class="absolute -right-0.5 -bottom-0.5 flex h-8 w-8 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-600 shadow-sm transition-colors hover:bg-stone-100 hover:text-stone-900 disabled:opacity-50"
						>
							<Pencil class="h-4 w-4" />
						</button>
					</div>
					<div class="flex min-w-0 flex-1 flex-col gap-5">
						<div>
							<label
								for="display-name"
								class="mb-2 block text-[11px] font-bold tracking-widest text-stone-500 uppercase"
								>Display Name</label
							>
							<input
								id="display-name"
								type="text"
								bind:value={displayName}
								placeholder="Your name"
								maxlength="80"
								autocomplete="name"
								disabled={prefsLoading || !prefsLoaded}
								class="w-full rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-2.5 text-[13px] font-bold text-stone-900 shadow-sm transition-all focus:border-stone-900 focus:bg-white focus:ring-2 focus:ring-stone-900 focus:outline-none disabled:opacity-50"
							/>
						</div>
						<div>
							<span
								class="mb-2 block text-[11px] font-bold tracking-widest text-stone-500 uppercase"
								>Email Address</span
							>
							<p class="text-[13px] font-bold text-stone-900">{data.user?.email}</p>
							<p class="mt-1 text-[11px] font-medium text-stone-500">
								Used to sign in — it cannot be changed here.
							</p>
						</div>
					</div>
				</div>
				<div class="flex flex-wrap items-center gap-3 border-t border-stone-100 pt-4">
					<button
						type="submit"
						disabled={profileBusy || prefsLoading || !prefsLoaded || !nameDirty}
						class="inline-flex items-center gap-2 rounded-full bg-stone-900 px-6 py-2.5 text-[13px] font-bold text-white shadow-md transition-all hover:bg-stone-800 disabled:opacity-50"
					>
						{prefsLoading ? 'Loading…' : 'Save Changes'}
					</button>
					{#if profileSaved}
						<span class="text-xs font-bold text-emerald-600" role="status">{profileSaved}</span>
					{/if}
				</div>
			</form>
		</div>

		<div
			class="rounded-[2rem] border border-stone-200/80 bg-white p-6 shadow-[0_8px_30px_-12px_rgb(28_25_23/0.06)] sm:p-8"
		>
			<h2 class="mb-2 text-[17px] font-extrabold tracking-tight text-stone-900">
				New post defaults
			</h2>
			<p class="mb-6 text-[13px] font-medium text-stone-500">
				Applied to new drafts. Deep-linked drafts keep their own accounts.
			</p>
			<form class="space-y-6" onsubmit={savePrefs}>
				<div class="space-y-2">
					<label
						for="masto-visibility"
						class="block text-[11px] font-bold tracking-widest text-stone-500 uppercase"
					>
						Mastodon visibility
					</label>
					<div class="relative max-w-xs">
						<select
							id="masto-visibility"
							bind:value={prefVisibility}
							disabled={prefsLoading || !prefsLoaded}
							class="w-full appearance-none rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-2.5 text-[13px] font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none disabled:opacity-50"
						>
							<option value="public">Public</option>
							<option value="unlisted">Unlisted</option>
							<option value="private">Followers</option>
							<option value="direct">Direct</option>
						</select>
						<div class="pointer-events-none absolute inset-y-0 right-4 flex items-center">
							<svg
								class="h-4 w-4 text-stone-500"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"><path d="m6 9 6 6 6-6" /></svg
							>
						</div>
					</div>
				</div>

				<div class="space-y-2" role="group" aria-labelledby="preselected-label">
					<span
						id="preselected-label"
						class="block text-[11px] font-bold tracking-widest text-stone-500 uppercase"
					>
						Preselected accounts <span class="tracking-normal text-stone-500 normal-case"
							>(empty = all active)</span
						>
					</span>
					<div class="flex flex-col gap-1 pt-1">
						{#each allAccounts as a (a.id)}
							{@const isOn = prefAccounts.includes(a.id)}
							<button
								type="button"
								onclick={() => togglePrefAccount(a.id)}
								disabled={prefsLoading || !prefsLoaded}
								aria-pressed={isOn}
								class="group flex w-full items-center justify-between rounded-xl border border-transparent p-2 text-left transition-colors hover:border-stone-100 hover:bg-stone-50 disabled:opacity-50"
							>
								<div class="flex items-center gap-3 overflow-hidden">
									<div class="shrink-0 transition-transform group-hover:scale-105">
										<AccountAvatar
											platform={a.platform}
											handle={a.handle}
											displayName={a.displayName}
											avatarUrl={a.avatarUrl}
											size={32}
											selected={false}
											title={accountLabel(a.displayName, a.handle) || undefined}
										/>
									</div>
									<div class="flex flex-col overflow-hidden">
										<span class="truncate text-[13px] font-bold text-stone-900"
											>{a.displayName || displayHandle(a.handle) || 'account'}</span
										>
										<span class="truncate text-[11px] font-medium text-stone-500 capitalize"
											>{a.platform}</span
										>
									</div>
								</div>
								<div class="ml-2 shrink-0">
									<!-- Visual Switch -->
									<div
										class="relative inline-flex h-5 w-9 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out {isOn
											? 'bg-stone-900'
											: 'bg-stone-200'}"
									>
										<span
											class="inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out {isOn
												? 'translate-x-4'
												: 'translate-x-0'}"
										></span>
									</div>
								</div>
							</button>
						{/each}
					</div>
				</div>

				<div class="pt-2">
					<!-- Container click is mouse-only convenience; keyboard users toggle via the switch button. -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="flex cursor-pointer items-center gap-3"
						onclick={() => setAskPublish(!askPublish)}
					>
						<button
							type="button"
							role="switch"
							aria-checked={askPublish}
							aria-labelledby="ask-publish-label"
							onclick={(e) => {
								e.stopPropagation();
								setAskPublish(!askPublish);
							}}
							class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none {askPublish
								? 'bg-stone-900'
								: 'bg-stone-200'}"
						>
							<span
								class="pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out {askPublish
									? 'translate-x-4'
									: 'translate-x-0'}"
							></span>
						</button>
						<span id="ask-publish-label" class="text-[13px] font-medium text-stone-600"
							>Ask for confirmation before publishing</span
						>
					</div>
				</div>

				<div class="flex items-center gap-3 border-t border-stone-100 pt-4">
					{#if !prefsLoading && !prefsLoaded}
						<button
							type="button"
							onclick={() => void load()}
							class="rounded-full border border-stone-300 px-6 py-2.5 text-[13px] font-bold text-stone-700 transition-colors hover:bg-stone-100"
							>Retry</button
						>
					{:else}
						<button
							type="submit"
							disabled={prefBusy || prefsLoading || !prefsLoaded}
							class="rounded-full bg-stone-900 px-6 py-2.5 text-[13px] font-bold text-white shadow-md transition-all hover:bg-stone-800 disabled:opacity-50"
							>{prefsLoading ? 'Loading…' : 'Save defaults'}</button
						>
					{/if}
					{#if prefSaved}
						<span class="text-[13px] font-bold text-emerald-600">{prefSaved}</span>
					{/if}
				</div>
			</form>
		</div>

		<div
			class="rounded-[2rem] border border-stone-200/80 bg-white p-6 shadow-[0_8px_30px_-12px_rgb(28_25_23/0.06)] sm:p-8"
			aria-label="API access"
			data-testid="api-key-section"
		>
			<h2 class="mb-2 text-[17px] font-extrabold tracking-tight text-stone-900">API access</h2>
			<p class="mb-6 max-w-md text-[13px] leading-relaxed font-medium text-stone-500">
				Use this personal API key for scripts, Shortcuts, and cron jobs. It grants full programmatic
				access to manage your drafts, publish posts, and view your queue. For security, it cannot be
				used to manage social accounts, change credentials, or generate new API keys. See the
				<a
					href="/api"
					class="font-bold text-stone-900 underline underline-offset-2 hover:text-stone-700"
					>API reference</a
				> for full details.
			</p>
			{#if keyLoading}
				<p class="text-sm font-medium text-stone-500">Loading…</p>
			{:else if keyRevealed}
				<div class="space-y-4" data-testid="api-key-reveal">
					<div class="rounded-xl border border-amber-200/50 bg-amber-50/50 p-4">
						<p class="text-[13px] font-bold text-amber-900">
							{#if keyJustRotated}New key — the old one stopped working.{:else}New key generated.{/if}
						</p>
						<p class="mt-1 text-[13px] font-medium text-amber-700">
							Copy it now: it is never shown again.
						</p>
					</div>
					<code
						class="block rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-3 font-mono text-[13px] break-all text-stone-900 shadow-sm select-all"
						data-testid="api-key-value">{keyRevealed}</code
					>
					<div class="flex flex-wrap items-center gap-2 pt-2">
						<button
							type="button"
							onclick={copyKey}
							class="rounded-full bg-stone-900 px-6 py-2.5 text-[13px] font-bold text-white shadow-md transition-all hover:bg-stone-800"
						>
							{keyCopied ? 'Copied' : 'Copy key'}
						</button>
						<button
							type="button"
							onclick={dismissRevealed}
							class="rounded-full bg-stone-100 px-6 py-2.5 text-[13px] font-bold text-stone-700 transition-all hover:bg-stone-200"
						>
							I have saved it
						</button>
					</div>
				</div>
			{:else if keyActive}
				<div
					class="mb-5 flex flex-col justify-between gap-4 rounded-xl border border-stone-200/80 bg-stone-50/50 p-4 sm:flex-row sm:items-center"
					data-testid="api-key-status"
				>
					<div>
						<p class="flex items-center gap-2 text-[13px] font-extrabold text-stone-900">
							Active key
							<code
								class="rounded bg-emerald-100/50 px-1.5 py-0.5 font-mono text-[12px] text-emerald-700"
							>
								{keyActive.prefix}…
							</code>
						</p>
						<p class="mt-1 text-[11px] font-medium text-stone-500">
							Created {keyDate(keyActive.createdAt)} · Last used {keyDate(keyActive.lastUsedAt)}
						</p>
						<p class="mt-1 text-[11px] font-medium text-stone-500">
							Scope: {(keyActive.scopes ?? ['read', 'write']).includes('write')
								? 'Read + write'
								: 'Read-only'}
						</p>
					</div>
				</div>
				<div class="flex flex-wrap gap-2">
					<button
						type="button"
						onclick={() => (keyConfirm = 'rotate')}
						disabled={keyBusy}
						class="rounded-full bg-stone-100 px-6 py-2.5 text-[13px] font-bold text-stone-700 transition-all hover:bg-stone-200 disabled:opacity-50"
					>
						Generate replacement
					</button>
					<button
						type="button"
						onclick={() => (keyConfirm = 'revoke')}
						disabled={keyBusy}
						class="rounded-full bg-red-50 px-6 py-2.5 text-[13px] font-bold text-red-600 transition-all hover:bg-red-100 disabled:opacity-50"
					>
						Revoke
					</button>
				</div>
			{:else if !keyLoaded}
				<div class="rounded-xl border border-stone-200/80 bg-stone-50/50 p-4">
					<p class="text-[13px] font-medium text-stone-500">Could not load your API key status.</p>
				</div>
				<button
					type="button"
					onclick={() => void load()}
					class="rounded-full border border-stone-300 px-6 py-2.5 text-[13px] font-bold text-stone-700 transition-colors hover:bg-stone-100"
					>Retry</button
				>
			{:else}
				<div
					class="mb-5 rounded-xl border border-stone-200/80 bg-stone-50/50 p-4"
					data-testid="api-key-status"
				>
					<p class="text-[13px] font-medium text-stone-500">
						No active key. Generate one to call the API without logging in.
					</p>
				</div>
				<button
					type="button"
					onclick={() => (keyConfirm = 'rotate')}
					disabled={keyBusy}
					class="rounded-full bg-stone-900 px-6 py-2.5 text-[13px] font-bold text-white shadow-md transition-all hover:bg-stone-800 disabled:opacity-50"
				>
					Generate API key
				</button>
			{/if}
		</div>

		<div
			class="rounded-[2rem] border border-stone-200/80 bg-white p-6 shadow-[0_8px_30px_-12px_rgb(28_25_23/0.06)] sm:p-8"
		>
			<h2 class="mb-2 text-[17px] font-extrabold tracking-tight text-stone-900">
				Two-factor authentication
			</h2>
			<p class="mb-6 max-w-md text-[13px] leading-relaxed font-medium text-stone-500">
				Authenticator app (Google Authenticator, 1Password, Authy, …) plus one-time backup codes.
				This cannot be turned off.
			</p>
			{#if totpOn}
				<div
					class="mb-5 flex items-center gap-3 rounded-xl border border-emerald-200/50 bg-emerald-50/50 p-3"
				>
					<div
						class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-600"
					>
						<svg
							class="h-4 w-4"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="3"
							stroke-linecap="round"
							stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg
						>
					</div>
					<div>
						<p class="text-[13px] font-bold text-emerald-900">Active</p>
						<p class="text-[11px] font-medium text-emerald-700">
							{backupRemaining} backup code{backupRemaining === 1 ? '' : 's'} remaining
						</p>
					</div>
				</div>
			{/if}
			{#if !rotateOpen}
				<button
					type="button"
					onclick={() => (rotateOpen = true)}
					class="rounded-full bg-stone-100 px-6 py-2.5 text-[13px] font-bold text-stone-700 transition-all hover:bg-stone-200"
				>
					Generate new authenticator & codes
				</button>
			{:else if !rotateQr}
				<form class="max-w-sm space-y-4" onsubmit={startRotate}>
					<input
						type="text"
						bind:value={rotateCode}
						placeholder="Current authenticator or backup code"
						aria-label="Current authenticator or backup code"
						class="w-full rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-2.5 text-[13px] font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none"
						required
					/>
					<button
						type="submit"
						disabled={rotateBusy}
						class="rounded-full bg-stone-900 px-6 py-2.5 text-[13px] font-bold text-white shadow-md transition-all hover:bg-stone-800 disabled:opacity-50"
						>Continue</button
					>
				</form>
			{:else}
				<div class="max-w-sm space-y-4">
					<div class="flex justify-center">
						<div class="rounded-xl border border-stone-200/80 bg-white p-3 shadow-sm">
							<div
								class="h-48 w-48 [&>svg]:h-full [&>svg]:w-full"
								role="img"
								aria-label="Authenticator QR code, or enter the key below manually"
							>
								{@html rotateQr}
							</div>
						</div>
					</div>
					<code
						class="block rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-3 text-center text-sm font-bold tracking-widest text-stone-900 shadow-sm"
						>{rotateSecret}</code
					>
					<ul class="grid grid-cols-2 gap-2 font-mono text-sm font-bold text-stone-700">
						{#each rotateBackups as c (c)}
							<li class="rounded-lg border border-stone-200/50 bg-stone-50 px-3 py-1.5 text-center">
								{c}
							</li>
						{/each}
					</ul>
					<!-- Container click is mouse-only convenience; keyboard users toggle via the switch button. -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="flex cursor-pointer items-center gap-3 py-2"
						onclick={() => (rotateSaved = !rotateSaved)}
					>
						<button
							type="button"
							role="switch"
							aria-checked={rotateSaved}
							aria-labelledby="rotate-saved-label"
							onclick={(e) => {
								e.stopPropagation();
								rotateSaved = !rotateSaved;
							}}
							class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none {rotateSaved
								? 'bg-stone-900'
								: 'bg-stone-200'}"
						>
							<span
								class="pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out {rotateSaved
									? 'translate-x-4'
									: 'translate-x-0'}"
							></span>
						</button>
						<span id="rotate-saved-label" class="text-[13px] font-medium text-stone-600"
							>I saved the new backup codes</span
						>
					</div>
					<form class="flex flex-col gap-3 sm:flex-row sm:items-center" onsubmit={confirmRotate}>
						<input
							type="text"
							bind:value={rotateConfirm}
							placeholder="New app code"
							aria-label="New app code"
							class="w-full flex-1 rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-2.5 text-[13px] font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none"
							required
						/>
						<button
							type="submit"
							disabled={rotateBusy || !rotateSaved}
							class="w-full shrink-0 rounded-full bg-stone-900 px-6 py-2.5 text-[13px] font-bold text-white shadow-md transition-all hover:bg-stone-800 disabled:opacity-50 sm:w-auto"
							>Confirm</button
						>
					</form>
				</div>
			{/if}
		</div>
	</div>
</div>

<ConfirmDialog
	open={isPictureDialogOpen}
	idPrefix="picture-dialog"
	title="Profile picture"
	confirmLabel="Save"
	cancelLabel="Cancel"
	tone="primary"
	busy={pictureBusy}
	onConfirm={savePicture}
	onCancel={() => {
		pictureTouched = false;
		pictureServerError = null;
		isPictureDialogOpen = false;
	}}
>
	{#snippet details()}
		<div class="flex flex-col items-stretch gap-3">
			{#key pictureDialogUrl.trim()}
				{#if pictureDialogUrl.trim()}
					<div class="flex justify-center">
						<img
							src={pictureDialogUrl.trim()}
							alt=""
							class="h-16 w-16 rounded-full border border-stone-200 object-cover shadow-sm"
							onerror={(e) => {
								(e.currentTarget as HTMLImageElement).style.display = 'none';
							}}
						/>
					</div>
				{/if}
			{/key}
			<label class="block text-sm">
				<span class="mb-1 block text-[11px] font-bold tracking-widest text-stone-500 uppercase"
					>Image URL</span
				>
				<input
					id="profile-picture-url"
					type="url"
					bind:value={pictureDialogUrl}
					placeholder="https://example.com/avatar.jpg"
					aria-invalid={pictureMessage !== null}
					aria-describedby={pictureMessage ? 'profile-picture-error' : undefined}
					onkeydown={(e) => {
						// The dialog's Save button sits outside this snippet, so Enter
						// has to reach the same handler explicitly.
						if (e.key !== 'Enter') return;
						e.preventDefault();
						savePicture();
					}}
					class="w-full rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-2.5 text-[13px] font-bold text-stone-900 shadow-sm transition-all focus:border-stone-900 focus:bg-white focus:ring-2 focus:ring-stone-900 focus:outline-none"
				/>
			</label>
			{#if pictureMessage}
				<p id="profile-picture-error" class="text-[12px] font-medium text-red-600" role="alert">
					{pictureMessage}
				</p>
			{/if}
			{#if profilePictureUrl.trim()}
				<button
					type="button"
					onclick={removePicture}
					disabled={pictureBusy}
					class="self-start text-[12px] font-bold text-red-600 underline underline-offset-2 hover:text-red-700 disabled:opacity-50"
				>
					Remove picture
				</button>
			{/if}
		</div>
	{/snippet}
</ConfirmDialog>

<ConfirmDialog
	open={keyConfirm !== null}
	idPrefix="api-key-dialog"
	title={keyConfirm === 'revoke' ? 'Revoke API key?' : 'Generate API key?'}
	body={keyConfirm === 'revoke'
		? 'Scripts and automations using the current key stop working immediately.'
		: keyActive
			? 'The current key stops working immediately. The new key is shown once.'
			: 'The new key is shown once. Copy it before closing.'}
	confirmLabel={keyConfirm === 'revoke' ? 'Revoke' : 'Generate'}
	cancelLabel="Keep"
	tone={keyConfirm === 'revoke' ? 'danger' : 'primary'}
	busy={keyBusy}
	onConfirm={() => void (keyConfirm === 'revoke' ? revokeKey() : rotateKey())}
	onCancel={() => (keyConfirm = null)}
/>
