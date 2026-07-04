import { setIcon, Keymap } from "obsidian";
import type { KanbanBoard } from "./view";
import { Task, setStatus, setPriority, setLabels, setDate } from "./data";
import { statusGlyph, priorityGlyph, rollupRing } from "./icons";
import { statusPopover, priorityPopover, labelPopover, datePopover } from "./pickers";
import { startCardDrag } from "./dnd";

function fmtDate(iso: string): string {
	const d = new Date(`${iso}T00:00:00`);
	return isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, DATE_FMT);
}

/** A due date in the past on a not-yet-finished task is overdue. */
function isOverdue(iso: string, status: string): boolean {
	if (status === "done" || status === "canceled") return false;
	const due = new Date(`${iso}T23:59:59`);
	return !isNaN(due.getTime()) && due.getTime() < Date.now();
}

const DATE_FMT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };

/** Render one task as a Linear-style card. */
export function renderCard(board: KanbanBoard, task: Task): HTMLElement {
	const cfg = board.cfg;
	const cardEl = createDiv("bk-card");
	cardEl.dataset.path = task.file.path;

	// Row 1: breadcrumb (parent) — only when this is a sub-task.
	const parentTitle = board.parentTitleFor(task);
	if (parentTitle) {
		const crumbEl = cardEl.createDiv("bk-card-breadcrumb");
		crumbEl.createSpan({ cls: "bk-crumb-parent", text: parentTitle });
		const chevron = crumbEl.createSpan("bk-crumb-sep");
		setIcon(chevron, "chevron-right");
	}

	// Row 2: status glyph + title.
	const titleRow = cardEl.createDiv("bk-card-title-row");
	const statusBtn = titleRow.createSpan("bk-card-status");
	const status = board.statusByKey.get(task.status) ?? board.statusByKey.get(cfg.defaultStatus);
	if (status) statusBtn.appendChild(statusGlyph(status));
	statusBtn.setAttr("aria-label", "Change status");
	statusBtn.onclick = (e) => {
		e.stopPropagation();
		statusPopover(statusBtn, board, task.status, (key) =>
			setStatus(board.app, task.file, board.cfg, key)
		);
	};
	titleRow.createSpan({ cls: "bk-card-title", text: task.title });

	// Row 3: meta — priority, labels, sub-task rollup.
	const metaRow = cardEl.createDiv("bk-card-meta");

	const prioBtn = metaRow.createSpan("bk-card-priority");
	const prio = board.priorityByKey.get(task.priority) ?? board.priorityByKey.get("no priority")!;
	prioBtn.appendChild(priorityGlyph(prio));
	prioBtn.setAttr("aria-label", `Priority: ${prio.label}`);
	prioBtn.onclick = (e) => {
		e.stopPropagation();
		priorityPopover(prioBtn, board, task.priority, (key) =>
			setPriority(board.app, task.file, board.cfg, key)
		);
	};

	const children = board.childrenOf(task);
	const collapsed = board.isCollapsed(task.file.path);
	const rollup = board.rollupFor(task);
	if (rollup) {
		const pill = metaRow.createSpan("bk-card-rollup");
		if (children.length > 0) {
			pill.addClass("is-toggle");
			const chev = pill.createSpan("bk-rollup-chevron");
			setIcon(chev, collapsed ? "chevron-right" : "chevron-down");
			pill.setAttr("aria-label", collapsed ? "Expand sub-tasks" : "Collapse sub-tasks");
			pill.onclick = (e) => {
				e.stopPropagation();
				board.toggleCollapsed(task.file.path);
			};
		}
		pill.appendChild(rollupRing(rollup.done, rollup.total));
		pill.createSpan({ text: `${rollup.done}/${rollup.total}` });
	}

	if (task.startDate) {
		const pill = metaRow.createSpan("bk-card-date-pill");
		setIcon(pill.createSpan("bk-pill-icon"), "calendar");
		pill.createSpan({ text: fmtDate(task.startDate) });
		pill.setAttr("aria-label", "Start date");
		pill.onclick = (e) => {
			e.stopPropagation();
			datePopover(pill, task.startDate, (v) => setDate(board.app, task.file, cfg, "start", v));
		};
	}
	if (task.endDate) {
		const overdue = isOverdue(task.endDate, task.status);
		const pill = metaRow.createSpan("bk-card-date-pill");
		pill.toggleClass("is-overdue", overdue);
		setIcon(pill.createSpan("bk-pill-icon"), "calendar-check");
		pill.createSpan({ text: fmtDate(task.endDate) });
		pill.setAttr("aria-label", "Due date");
		pill.onclick = (e) => {
			e.stopPropagation();
			datePopover(pill, task.endDate, (v) => setDate(board.app, task.file, cfg, "end", v));
		};
	}

	for (const label of task.labels) {
		const def = board.labelDef(label);
		const chip = metaRow.createSpan("bk-card-label");
		if (def?.emoji) {
			chip.createSpan({ cls: "bk-emoji", text: def.emoji });
		} else {
			const dot = chip.createSpan("bk-label-dot");
			if (def?.color) dot.style.background = def.color;
		}
		chip.createSpan({ text: label });
	}

	const addLabel = metaRow.createSpan("bk-card-addlabel");
	setIcon(addLabel, "tag");
	addLabel.setAttr("aria-label", "Edit labels");
	addLabel.onclick = (e) => {
		e.stopPropagation();
		labelPopover(addLabel, board, task.labels, async (labels) => {
			await setLabels(board.app, task.file, cfg, labels);
		});
	};

	// Row 4: footer — created date + add-sub-task affordance.
	const footer = cardEl.createDiv("bk-card-footer");
	footer.createSpan({
		cls: "bk-card-date",
		text: `Created ${new Date(task.file.stat.ctime).toLocaleDateString(undefined, DATE_FMT)}`,
	});
	const footerActions = footer.createDiv("bk-card-footer-actions");
	if (!task.endDate) {
		const dueBtn = footerActions.createSpan("bk-card-subadd");
		setIcon(dueBtn, "calendar-plus");
		dueBtn.setAttr("aria-label", "Set due date");
		dueBtn.onclick = (e) => {
			e.stopPropagation();
			datePopover(dueBtn, null, (v) => setDate(board.app, task.file, cfg, "end", v));
		};
	}
	const subBtn = footerActions.createSpan("bk-card-subadd");
	setIcon(subBtn, "git-branch-plus");
	subBtn.setAttr("aria-label", "Add sub-task");
	subBtn.onclick = (e) => {
		e.stopPropagation();
		board.openCreateModal(board.cfg.defaultStatus, task.file);
	};

	// Plain click opens the edit modal; Cmd/Ctrl-click jumps straight to the note.
	cardEl.onclick = (e) => {
		if (
			(e.target as HTMLElement).closest(
				".bk-card-status, .bk-card-priority, .bk-card-addlabel, .bk-card-subadd, .bk-card-date-pill, .bk-card-rollup, .bk-sublist"
			)
		)
			return;
		if (Keymap.isModEvent(e)) board.openFile(task.file, e);
		else board.openEditModal(task);
	};

	// Pointer-based drag (Linear-style floating card + live insertion gap).
	// Disabled in the narrow layout — status changes go through the edit sheet.
	cardEl.addEventListener("pointerdown", (e) => {
		if (board.isNarrow()) return;
		if ((e.target as HTMLElement).closest(
			".bk-card-status, .bk-card-priority, .bk-card-addlabel, .bk-card-subadd, .bk-card-date-pill, .bk-card-rollup, .bk-sublist"
		))
			return;
		startCardDrag(board, task, cardEl, e);
	});

	// Nested sub-tasks, rendered inside the parent card.
	if (children.length > 0 && !collapsed) {
		const sublist = cardEl.createDiv("bk-sublist");
		for (const child of children) sublist.appendChild(renderSubRow(board, child));
	}

	return cardEl;
}

/** A compact, indented row for a nested sub-task (recurses for deeper levels). */
function renderSubRow(board: KanbanBoard, task: Task): HTMLElement {
	const cfg = board.cfg;
	const wrap = createDiv("bk-subrow-wrap");
	const row = wrap.createDiv("bk-subrow");
	row.dataset.path = task.file.path;

	const statusBtn = row.createSpan("bk-subrow-status");
	const status = board.statusByKey.get(task.status) ?? board.statusByKey.get(cfg.defaultStatus);
	if (status) statusBtn.appendChild(statusGlyph(status));
	statusBtn.setAttr("aria-label", "Change status");
	statusBtn.onclick = (e) => {
		e.stopPropagation();
		statusPopover(statusBtn, board, task.status, (key) =>
			setStatus(board.app, task.file, board.cfg, key)
		);
	};

	row.createSpan({ cls: "bk-subrow-title", text: task.title });

	const prio = board.priorityByKey.get(task.priority);
	if (prio && prio.icon !== "none") {
		const prioBtn = row.createSpan("bk-subrow-priority");
		prioBtn.appendChild(priorityGlyph(prio));
		prioBtn.setAttr("aria-label", `Priority: ${prio.label}`);
		prioBtn.onclick = (e) => {
			e.stopPropagation();
			priorityPopover(prioBtn, board, task.priority, (key) =>
				setPriority(board.app, task.file, board.cfg, key)
			);
		};
	}

	if (task.endDate) {
		const due = row.createSpan("bk-subrow-date");
		due.toggleClass("is-overdue", isOverdue(task.endDate, task.status));
		due.setText(fmtDate(task.endDate));
	}

	row.onclick = (e) => {
		if ((e.target as HTMLElement).closest(".bk-subrow-status, .bk-subrow-priority")) return;
		if (Keymap.isModEvent(e)) board.openFile(task.file, e);
		else board.openEditModal(task);
	};

	// Recurse for grandchildren.
	const grandkids = board.childrenOf(task);
	if (grandkids.length > 0) {
		const sublist = wrap.createDiv("bk-sublist");
		for (const child of grandkids) sublist.appendChild(renderSubRow(board, child));
	}

	return wrap;
}
