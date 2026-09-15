<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		open = false,
		title,
		body = null,
		details = null,
		confirmLabel = 'Confirm',
		cancelLabel = 'Keep',
		tone = 'danger',
		busy = false,
		idPrefix = 'confirm-dialog',
		onConfirm,
		onCancel
	}: {
		open: boolean;
		title: string;
		body?: string | null;
		details?: Snippet | null;
		confirmLabel?: string;
		cancelLabel?: string;
		tone?: 'danger' | 'primary';
		busy?: boolean;
		idPrefix?: string;
		onConfirm: () => void;
		onCancel: () => void;
	} = $props();

	const titleId = $derived(`${idPrefix}-title`);
	const bodyId = $derived(`${idPrefix}-body`);

	let confirmBtn: HTMLButtonElement | null = $state(null);
	let dialogEl: HTMLDivElement | null = $state(null);
	const confirmClass = $derived(
		tone === 'danger'
			? 'bg-red-600 text-white hover:bg-red-700'
			: 'bg-stone-900 text-white hover:bg-stone-800'
	);

	$effect(() => {
		if (open) {
			const previouslyFocused = document.activeElement as HTMLElement | null;
			confirmBtn?.focus();
			const onKey = (e: KeyboardEvent) => {
				if (e.key === 'Escape') {
					e.preventDefault();
					onCancel();
					return;
				}
				if (e.key !== 'Tab' || !dialogEl) return;
				const focusables = Array.from(
					dialogEl.querySelectorAll<HTMLElement>(
						'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
					)
				).filter((el) => el.getClientRects().length > 0 || el === document.activeElement);
				if (focusables.length === 0) {
					e.preventDefault();
					return;
				}
				const first = focusables[0];
				const last = focusables[focusables.length - 1];
				if (e.shiftKey && document.activeElement === first) {
					e.preventDefault();
					last.focus();
				} else if (!e.shiftKey && document.activeElement === last) {
					e.preventDefault();
					first.focus();
				}
			};
			window.addEventListener('keydown', onKey);
			return () => {
				window.removeEventListener('keydown', onKey);
				previouslyFocused?.focus?.();
			};
		}
	});
</script>

{#if open}
	<div
		role="presentation"
		class="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
		onclick={(e) => {
			if (e.target === e.currentTarget) onCancel();
		}}
	>
		<div
			bind:this={dialogEl}
			role="alertdialog"
			aria-modal="true"
			aria-labelledby={titleId}
			aria-describedby={body ? bodyId : undefined}
			class="max-h-[85dvh] w-full max-w-sm overflow-y-auto rounded-[1.5rem] border border-stone-200/80 bg-white/95 p-5 shadow-[0_16px_40px_-12px_rgb(28_25_23/0.15)] backdrop-blur-xl"
		>
			<h2 id={titleId} class="text-sm font-semibold">{title}</h2>
			{#if body}
				<p id={bodyId} class="mt-1 text-sm text-[var(--muted)]">{body}</p>
			{/if}
			{#if details}
				<div class="mt-3">
					{@render details()}
				</div>
			{/if}
			<div class="mt-4 flex justify-end gap-2">
				<button
					type="button"
					onclick={onCancel}
					disabled={busy}
					data-testid="confirm-dialog-cancel"
					class="rounded-full border border-stone-200 px-4 py-1.5 text-sm font-bold text-stone-500 transition-colors hover:border-stone-300 hover:text-stone-900 disabled:opacity-50"
				>
					{cancelLabel}
				</button>
				<button
					type="button"
					bind:this={confirmBtn}
					onclick={onConfirm}
					disabled={busy}
					data-testid="confirm-dialog-ok"
					class="rounded-full px-4 py-1.5 text-sm font-medium disabled:opacity-50 {confirmClass}"
				>
					{busy ? 'Working…' : confirmLabel}
				</button>
			</div>
		</div>
	</div>
{/if}
