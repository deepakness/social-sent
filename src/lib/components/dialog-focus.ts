import type { Action } from 'svelte/action';

const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(node: HTMLElement): HTMLElement[] {
	return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
		(el) => el.getClientRects().length > 0 || el === document.activeElement
	);
}

export interface DialogFocusParams {
	/** Escape handler. Omit to leave Escape to the caller. */
	onEscape?: () => void;
	/** What to focus on open. Defaults to the first focusable element. */
	initial?: HTMLElement | null;
}

/**
 * The modal keyboard contract, extracted from ConfirmDialog so the dialogs that
 * are hand-rolled cannot drift from it: focus moves inside on open, Tab cycles
 * within the dialog instead of escaping into the page behind it, Escape closes,
 * and focus returns to whatever was focused before.
 */
export const dialogFocus: Action<HTMLElement, DialogFocusParams | undefined> = (node, params) => {
	let current = params ?? {};
	const previouslyFocused = document.activeElement as HTMLElement | null;
	(current.initial ?? focusables(node)[0] ?? node).focus();

	const onKey = (e: KeyboardEvent) => {
		if (e.key === 'Escape') {
			if (!current.onEscape) return;
			e.preventDefault();
			current.onEscape();
			return;
		}
		if (e.key !== 'Tab') return;
		const items = focusables(node);
		if (items.length === 0) {
			e.preventDefault();
			return;
		}
		const first = items[0];
		const last = items[items.length - 1];
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	};
	window.addEventListener('keydown', onKey);
	return {
		update(next: DialogFocusParams | undefined) {
			current = next ?? {};
		},
		destroy() {
			window.removeEventListener('keydown', onKey);
			previouslyFocused?.focus?.();
		}
	};
};
