import { setIcon, Platform } from "obsidian";
import { STATUS_COLOR_PALETTE } from "./constants";
import { statusGlyph, priorityGlyph } from "./icons";
import type { KanbanBoard } from "./view";

/**
 * Lightweight floating popovers honoring the Codex animation guide: surfaces
 * fade + scale(0.98→1) + 2px slide on a 150ms ease-enter, with the transform
 * origin tied to the trigger edge. Exit is the snappier ease-out curve.
 */

interface PopoverHandle {
	close(): void;
}

function mountPopover(
	anchor: HTMLElement,
	build: (body: HTMLElement, close: () => void) => void
): PopoverHandle {
	const rect = anchor.getBoundingClientRect();
	// Mount inside the modal container when invoked from a modal, so the modal's
	// focus trap doesn't fight the popover's search input — that focus war is the
	// cause of the open/close flicker. Falls back to the body on the board.
	const host = anchor.closest<HTMLElement>(".modal-container") ?? activeDocument.body;
	// Hide until positioned so the entrance never paints at the wrong spot.
	const el = host.createDiv("bk-popover motion-surface bk-popover-hidden");

	// Decide vertical placement; prefer opening downward.
	const below = rect.bottom + 8;
	const openUp = below + 260 > window.innerHeight && rect.top > window.innerHeight - rect.bottom;
	el.dataset.side = openUp ? "top" : "bottom";

	let closed = false;
	let attachTimer = 0;
	const close = () => {
		if (closed) return;
		closed = true;
		window.clearTimeout(attachTimer);
		el.dataset.state = "closed";
		activeDocument.removeEventListener("pointerdown", onDown, true);
		activeDocument.removeEventListener("keydown", onKey, true);
		window.setTimeout(() => el.remove(), 160);
	};

	build(el, close);

	// Position after content sizing, then reveal and start the entrance.
	const w = el.offsetWidth || 220;
	let left = rect.left;
	if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
	el.style.left = `${Math.max(8, left)}px`;
	if (openUp) {
		el.style.top = `${rect.top - 8 - el.offsetHeight}px`;
		el.setCssProps({ "--motion-transform-origin": "bottom left" });
	} else {
		el.style.top = `${below}px`;
		el.setCssProps({ "--motion-transform-origin": "top left" });
	}
	el.removeClass("bk-popover-hidden");
	el.dataset.state = "open";

	const onDown = (e: PointerEvent) => {
		if (!el.contains(e.target as Node) && e.target !== anchor) close();
	};
	const onKey = (e: KeyboardEvent) => {
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			close();
		}
	};
	// Defer listener attach so the opening click doesn't immediately close it.
	// Guard against the popover being closed before the timer fires.
	attachTimer = window.setTimeout(() => {
		if (closed) return;
		activeDocument.addEventListener("pointerdown", onDown, true);
		activeDocument.addEventListener("keydown", onKey, true);
	}, 0);

	return { close };
}

function searchHeader(body: HTMLElement, placeholder: string, autofocus = true): HTMLInputElement {
	const head = body.createDiv("bk-popover-search");
	const input = head.createEl("input", { type: "text", placeholder });
	// On touch, autofocusing opens the keyboard, which covers the list — skip it.
	if (autofocus) window.setTimeout(() => input.focus(), 10);
	return input;
}

interface DrawerItem {
	value: string;
	label: string;
	glyph?: () => Node;
}

/**
 * A bottom sheet that slides up for choosing a single option on touch. Replaces
 * both the floating popover (which the keyboard obscured) and the native
 * <select> (unreliable in the mobile webview). No text input, so no keyboard —
 * and unlike a native select it can render the real status/priority glyphs.
 */
function openOptionDrawer(
	items: DrawerItem[],
	current: string,
	onPick: (value: string) => void | Promise<void>
): void {
	const root = activeDocument.body.createDiv("bk-drawer-root");
	const backdrop = root.createDiv("bk-drawer-backdrop");
	const sheet = root.createDiv("bk-drawer");
	sheet.createDiv("bk-drawer-handle");
	const list = sheet.createDiv("bk-drawer-list");

	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		root.removeClass("is-open");
		window.setTimeout(() => root.remove(), 240);
	};

	for (const it of items) {
		const row = list.createDiv("bk-drawer-item");
		if (it.glyph) row.appendChild(it.glyph());
		row.createSpan({ cls: "bk-drawer-label", text: it.label });
		if (it.value === current) {
			row.addClass("is-selected");
			setIcon(row.createSpan("bk-drawer-check"), "check");
		}
		row.onclick = () => {
			void onPick(it.value);
			close();
		};
	}

	backdrop.onclick = close;
	// Two frames so the browser paints the off-screen state before transitioning.
	activeWindow.requestAnimationFrame(() =>
		activeWindow.requestAnimationFrame(() => root.addClass("is-open"))
	);
}

export function statusPopover(
	anchor: HTMLElement,
	board: KanbanBoard,
	current: string,
	onPick: (key: string) => void | Promise<void>
): void {
	if (Platform.isMobile) {
		openOptionDrawer(
			board.cfg.statuses.map((s) => ({
				value: s.key,
				label: s.label,
				glyph: () => statusGlyph(s),
			})),
			current,
			onPick
		);
		return;
	}
	mountPopover(anchor, (body, close) => {
		const input = searchHeader(body, "Change status to...");
		const list = body.createDiv("bk-popover-list");
		const render = (q: string) => {
			list.empty();
			for (const s of board.cfg.statuses.filter((s) => s.label.toLowerCase().includes(q))) {
				const row = list.createDiv("bk-popover-item");
				row.appendChild(statusGlyph(s));
				row.createSpan({ cls: "bk-popover-label", text: s.label });
				if (s.key === current) markSelected(row);
				row.onclick = () => {
					void onPick(s.key);
					close();
				};
			}
		};
		render("");
		input.oninput = () => render(input.value.toLowerCase());
	});
}

export function priorityPopover(
	anchor: HTMLElement,
	board: KanbanBoard,
	current: string,
	onPick: (key: string) => void | Promise<void>
): void {
	if (Platform.isMobile) {
		openOptionDrawer(
			board.cfg.priorities.map((p) => ({
				value: p.key,
				label: p.label,
				glyph: () => priorityGlyph(p),
			})),
			current,
			onPick
		);
		return;
	}
	mountPopover(anchor, (body, close) => {
		const input = searchHeader(body, "Set priority to...");
		const list = body.createDiv("bk-popover-list");
		const render = (q: string) => {
			list.empty();
			for (const p of board.cfg.priorities.filter((p) => p.label.toLowerCase().includes(q))) {
				const row = list.createDiv("bk-popover-item");
				row.appendChild(priorityGlyph(p));
				row.createSpan({ cls: "bk-popover-label", text: p.label });
				if (p.key === current) markSelected(row);
				if (board.isCustomPriority(p.key)) {
					addDeleteBtn(row, async () => {
						await board.deletePriority(p.key);
						render(input.value.toLowerCase());
					});
				}
				row.onclick = () => {
					void onPick(p.key);
					close();
				};
			}
		};
		render("");
		input.oninput = () => render(input.value.toLowerCase());
	});
}

export function labelPopover(
	anchor: HTMLElement,
	board: KanbanBoard,
	selected: string[],
	onCommit: (labels: string[]) => void | Promise<void>
): void {
	mountPopover(anchor, (body, close) => {
		const chosen = new Set(selected);
		// Multi-select stays a popover (no good native equivalent), but on mobile
		// we skip autofocus so the keyboard doesn't hide the checklist.
		const input = searchHeader(body, "Add label...", !Platform.isMobile);
		const list = body.createDiv("bk-popover-list");
		const commit = () => void onCommit(Array.from(chosen));

		const render = (q: string) => {
			list.empty();
			const all = uniqueSorted([...board.knownLabels, ...chosen]);
			for (const label of all.filter((l) => l.toLowerCase().includes(q))) {
				const def = board.labelDef(label);
				const row = list.createDiv("bk-popover-item");
				const box = row.createSpan("bk-check");
				if (chosen.has(label)) {
					box.addClass("is-checked");
					setIcon(box, "check");
				}
				const dot = row.createSpan("bk-label-dot");
				if (def?.color) dot.style.background = def.color;
				row.createSpan({ cls: "bk-popover-label", text: label });
				if (board.isCustomLabel(label)) {
					addEditBtn(row, () =>
						colorForm(
							body,
							label,
							close,
							(color) => board.updateLabel(label, "", color),
							def?.color ?? STATUS_COLOR_PALETTE[0]
						)
					);
					addDeleteBtn(row, async () => {
						await board.deleteLabel(label);
						chosen.delete(label);
						commit();
						render(input.value.toLowerCase());
					});
				}
				row.onclick = () => {
					if (chosen.has(label)) chosen.delete(label);
					else chosen.add(label);
					commit();
					render(input.value.toLowerCase());
				};
			}
			const q2 = input.value.trim();
			if (
				q2 &&
				!uniqueSorted([...board.knownLabels, ...chosen]).some(
					(l) => l.toLowerCase() === q2.toLowerCase()
				)
			) {
				const row = list.createDiv("bk-popover-item bk-popover-create");
				setIcon(row.createSpan("bk-check"), "plus");
				row.createSpan({ cls: "bk-popover-label", text: `Create “${q2}”` });
				row.onclick = () =>
					colorForm(body, q2, close, async (color) => {
						await board.addLabel(q2, "", color);
						chosen.add(q2);
						commit();
					});
			}
		};
		render("");
		input.oninput = () => render(input.value.toLowerCase());
	});
}

export function templatePopover(
	anchor: HTMLElement,
	board: KanbanBoard,
	current: string | null,
	onPick: (name: string) => void | Promise<void>
): void {
	if (Platform.isMobile && board.plugin.listTemplates().length > 0) {
		openOptionDrawer(
			board.plugin.listTemplates().map((t) => ({ value: t.name, label: t.name })),
			current ?? "",
			onPick
		);
		return;
	}
	mountPopover(anchor, (body, close) => {
		const templates = board.plugin.listTemplates();
		if (templates.length === 0) {
			const empty = body.createDiv("bk-popover-empty");
			empty.setText("No templates — add them in settings.");
			return;
		}
		const input = searchHeader(body, "Apply template...");
		const list = body.createDiv("bk-popover-list");
		const render = (q: string) => {
			list.empty();
			for (const t of templates.filter((t) => t.name.toLowerCase().includes(q))) {
				const row = list.createDiv("bk-popover-item");
				setIcon(row.createSpan("bk-popover-icon"), "file-text");
				row.createSpan({ cls: "bk-popover-label", text: t.name });
				if (t.name === current) markSelected(row);
				row.onclick = () => {
					void onPick(t.name);
					close();
				};
			}
		};
		render("");
		input.oninput = () => render(input.value.toLowerCase());
	});
}

/** Small trash button revealed on a row for user-defined entries. */
function addDeleteBtn(row: HTMLElement, onDelete: () => void | Promise<void>): void {
	const del = row.createSpan("bk-popover-del");
	setIcon(del, "trash-2");
	del.setAttr("aria-label", "Delete");
	del.onclick = (e) => {
		e.stopPropagation();
		void onDelete();
	};
}

/** Replace the popover body with a color picker for a label (create or edit). */
function colorForm(
	body: HTMLElement,
	name: string,
	close: () => void,
	onConfirm: (color: string) => void | Promise<void>,
	initialColor?: string
): void {
	body.empty();
	const isEdit = initialColor !== undefined;
	const form = body.createDiv("bk-defform");
	form.createDiv({ cls: "bk-defform-title", text: `${isEdit ? "Edit" : "New"} label “${name}”` });

	let chosen = initialColor ?? STATUS_COLOR_PALETTE[0];
	const swatches = form.createDiv("bk-swatches");
	for (const color of STATUS_COLOR_PALETTE) {
		const sw = swatches.createDiv("bk-swatch");
		sw.style.background = color;
		if (color === chosen) sw.addClass("is-selected");
		sw.onclick = () => {
			chosen = color;
			swatches
				.querySelectorAll(".bk-swatch")
				.forEach((e) => (e as HTMLElement).removeClass("is-selected"));
			sw.addClass("is-selected");
		};
	}

	const btn = form.createEl("button", {
		cls: "bk-defform-btn mod-cta",
		text: isEdit ? "Save" : "Create",
	});
	btn.onclick = () => {
		void onConfirm(chosen);
		close();
	};
}

/** Small pencil button revealed on a row for editing a user-defined entry. */
function addEditBtn(row: HTMLElement, onEdit: () => void): void {
	const edit = row.createSpan("bk-popover-edit");
	setIcon(edit, "pencil");
	edit.setAttr("aria-label", "Edit");
	edit.onclick = (e) => {
		e.stopPropagation();
		onEdit();
	};
}

export function datePopover(
	anchor: HTMLElement,
	current: string | null,
	onPick: (value: string | null) => void | Promise<void>
): void {
	mountPopover(anchor, (body, close) => {
		const input = body.createEl("input", { type: "date", cls: "bk-date-input" });
		if (current) input.value = current;
		window.setTimeout(() => {
			input.focus();
			// Open the native calendar where supported.
			(input as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
		}, 10);
		input.onchange = () => {
			void onPick(input.value || null);
			close();
		};
		const clear = body.createDiv("bk-popover-item bk-date-clear");
		setIcon(clear.createSpan("bk-popover-check"), "x");
		clear.createSpan({ cls: "bk-popover-label", text: "Clear date" });
		clear.onclick = () => {
			void onPick(null);
			close();
		};
	});
}

function markSelected(row: HTMLElement): void {
	row.addClass("is-selected");
	const check = row.createSpan("bk-popover-check");
	setIcon(check, "check");
}

function uniqueSorted(values: string[]): string[] {
	return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}
