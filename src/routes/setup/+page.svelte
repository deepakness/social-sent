<script lang="ts">
	import { goto } from '$app/navigation';

	let { data } = $props();

	let email = $state('');
	let password = $state('');
	let confirm = $state('');
	let error = $state<string | null>(null);
	let loading = $state(false);

	async function onSubmit(e: Event) {
		e.preventDefault();
		error = null;
		if (password !== confirm) {
			error = 'Passwords do not match';
			return;
		}
		loading = true;
		try {
			const res = await fetch('/api/setup', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email, password })
			});
			const payload = (await res.json().catch(() => ({}))) as { error?: string };
			if (!res.ok) throw new Error(payload.error || 'Could not create the account');
			// Sign in normally: the next step is enrolling an authenticator.
			await goto('/login');
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not create the account';
		} finally {
			loading = false;
		}
	}
</script>

<div class="flex min-h-dvh items-center justify-center bg-stone-50 px-4">
	<div class="w-full max-w-sm">
		<div class="mb-8 text-center">
			<div
				class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-stone-900 text-xl font-bold text-white shadow-md"
			>
				{data.appName.charAt(0)}
			</div>
			<h1 class="text-2xl font-extrabold tracking-tight text-stone-900">{data.appName}</h1>
			<p class="mt-1 text-sm font-medium text-stone-500">Create the account for this instance.</p>
		</div>
		<form
			onsubmit={onSubmit}
			class="space-y-4 rounded-[2rem] border border-stone-200/80 bg-white p-6 shadow-[0_8px_30px_-12px_rgb(28_25_23/0.06)]"
		>
			<p class="text-[12px] leading-relaxed font-medium text-stone-500">
				Anyone who opens this page first becomes the owner, so finish signing up now. The email and
				password can be changed later in Settings.
			</p>
			{#if error}
				<p class="rounded-xl bg-red-50 px-3 py-2 text-[13px] font-medium text-red-700" role="alert">
					{error}
				</p>
			{/if}
			<label class="block text-sm">
				<span class="text-[11px] font-bold tracking-widest text-stone-500 uppercase">Email</span>
				<input
					type="email"
					autocomplete="username"
					placeholder="you@example.com"
					bind:value={email}
					class="mt-1.5 w-full rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-2.5 text-sm font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none"
					required
				/>
			</label>
			<label class="block text-sm">
				<span class="text-[11px] font-bold tracking-widest text-stone-500 uppercase">Password</span>
				<input
					type="password"
					autocomplete="new-password"
					minlength="8"
					bind:value={password}
					class="mt-1.5 w-full rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-2.5 text-sm font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none"
					required
				/>
			</label>
			<label class="block text-sm">
				<span class="text-[11px] font-bold tracking-widest text-stone-500 uppercase"
					>Confirm password</span
				>
				<input
					type="password"
					autocomplete="new-password"
					bind:value={confirm}
					class="mt-1.5 w-full rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-2.5 text-sm font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none"
					required
				/>
			</label>
			<button
				type="submit"
				disabled={loading}
				class="w-full rounded-full bg-stone-900 px-6 py-2.5 text-[13px] font-bold text-white shadow-md transition-all hover:bg-stone-800 disabled:opacity-50"
			>
				{loading ? 'Creating…' : 'Create account'}
			</button>
		</form>
	</div>
</div>
