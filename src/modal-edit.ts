import { Modal, Notice, setIcon } from "obsidian";
import type { KanbanBoard } from "./view";
import { Task, setTitle, setStatus, setPriority, setLabels, setDate, readBody, setBody } from "./data";
import { statusGlyph, priorityGlyph } from "./icons";
import { statusPopover, priorityPopover, labelPopover, datePopover } from "./pickers";

const DATE_FMT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };

function fmtDate(iso: string): string {
	const d = new Date(`${iso}T00:00:00`);
	return isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, DATE_FMT);
}

/**
 * Touch-first edit sheet for an existing task. Mirrors the create modal — title,
 * description, and a row of tag pills (status, priority, labels, dates) — but
 * pre-filled from the task and committing back to the note on Save.
 */
export class EditTaskModal extends Modal {
	private board: KanbanBoard;
	private task: Task;

	private title: string;
	private status: string;
	private priority: string;
	private labels: string[];
	private startDate: string | null;
	private endDate: string | null;

	// The note body, loaded asynchronously after the modal opens.
	private description = "";
	private originalDescription = "";
	private descLoaded = false;
	private descInput!: HTMLTextAreaElement;

	private statusPill!: HTMLElement;
	private priorityPill!: HTMLElement;
	private labelPill!: HTMLElement;
	private startPill!: HTMLElement;
	private endPill!: HTMLElement;

	private animatingClose = false;

	constructor(board: KanbanBoard, task: Task) {
		super(board.app);
		this.board = board;
		this.task = task;
		this.title = task.title;
		this.status = task.status || board.cfg.defaultStatus;
		this.priority = task.priority || "no priority";
		this.labels = [...task.labels];
		this.startDate = task.startDate;
		this.endDate = task.endDate;
	}

	// Play an exit animation (inverse of the entrance) before tearing down.
	close(): void {
		if (this.animatingClose) {
			super.close();
			return;
		}
		this.animatingClose = true;
		this.modalEl.addClass("bk-dialog-closing");
		this.containerEl.querySelector(".modal-bg")?.addClass("bk-overlay-closing");
		// Skip the exit-animation wait entirely for reduced-motion users.
		const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		window.setTimeout(() => super.close(), reduce ? 0 : 150);
	}

	onOpen(): void {
		const { modalEl, contentEl } = this;
		modalEl.addClass("bk-create-modal", "bk-edit-modal", "motion-dialog");
		contentEl.empty();

		// Header breadcrumb.
		const header = contentEl.createDiv("bk-create-header");
		const crumb = header.createDiv("bk-create-crumb");
		setIcon(crumb.createSpan("bk-create-crumb-icon"), "square-pen");
		crumb.createSpan({ text: "Edit task" });

		// Title.
		const titleInput = contentEl.createEl("input", {
			cls: "bk-create-title",
			type: "text",
			placeholder: "Task title",
		});
		titleInput.value = this.title;
		titleInput.oninput = () => (this.title = titleInput.value);
		titleInput.onkeydown = (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.descInput.focus();
			}
		};

		// Description (the note body). Loaded async, so it starts disabled with a
		// "Loading…" hint and unlocks once the file is read.
		const descInput = contentEl.createEl("textarea", { cls: "bk-create-desc" });
		descInput.setAttr("placeholder", "Loading…");
		descInput.disabled = true;
		descInput.oninput = () => (this.description = descInput.value);
		this.descInput = descInput;
		void this.loadBody();

		// Pill row — status is just another tag, matching the create modal.
		const pills = contentEl.createDiv("bk-create-pills");
		this.statusPill = pills.createDiv("bk-pill");
		this.priorityPill = pills.createDiv("bk-pill");
		this.labelPill = pills.createDiv("bk-pill");
		this.startPill = pills.createDiv("bk-pill");
		this.endPill = pills.createDiv("bk-pill");
		this.refresh();

		this.statusPill.onclick = () =>
			statusPopover(this.statusPill, this.board, this.status, (key) => {
				this.status = key;
				this.refresh();
			});
		this.priorityPill.onclick = () =>
			priorityPopover(this.priorityPill, this.board, this.priority, (key) => {
				this.priority = key;
				this.refresh();
			});
		this.labelPill.onclick = () =>
			labelPopover(this.labelPill, this.board, this.labels, (labels) => {
				this.labels = labels;
				this.refresh();
			});
		this.startPill.onclick = () =>
			datePopover(this.startPill, this.startDate, (value) => {
				this.startDate = value;
				this.refresh();
			});
		this.endPill.onclick = () =>
			datePopover(this.endPill, this.endDate, (value) => {
				this.endDate = value;
				this.refresh();
			});

		// Footer.
		const footer = contentEl.createDiv("bk-create-footer");
		const openBtn = footer.createEl("button", { cls: "bk-edit-open", text: "Open note" });
		openBtn.onclick = () => {
			this.close();
			this.board.openFile(this.task.file, new MouseEvent("click"));
		};
		const submit = footer.createEl("button", { cls: "bk-create-submit mod-cta", text: "Save" });
		submit.onclick = () => void this.submit();

		// Cmd/Ctrl+Enter saves from anywhere in the modal.
		this.scope.register(["Mod"], "Enter", (e) => {
			e.preventDefault();
			void this.submit();
		});

		window.setTimeout(() => titleInput.focus(), 20);
	}

	/** Read the note body into the description field, then enable editing. */
	private async loadBody(): Promise<void> {
		const body = await readBody(this.board.app, this.task.file);
		this.description = body;
		this.originalDescription = body;
		this.descInput.value = body;
		this.descInput.disabled = false;
		this.descInput.setAttr("placeholder", "Add description…");
		this.descLoaded = true;
	}

	private refresh(): void {
		const s = this.board.statusByKey.get(this.status);
		this.statusPill.empty();
		if (s) this.statusPill.appendChild(statusGlyph(s));
		this.statusPill.createSpan({ text: s?.label ?? "Status" });

		const p = this.board.priorityByKey.get(this.priority);
		this.priorityPill.empty();
		if (p) this.priorityPill.appendChild(priorityGlyph(p));
		this.priorityPill.createSpan({ text: p?.label ?? "Priority" });

		this.labelPill.empty();
		setIcon(this.labelPill.createSpan("bk-pill-icon"), "tag");
		this.labelPill.createSpan({
			text: this.labels.length === 0 ? "Labels" : this.labels.join(", "),
		});

		this.startPill.empty();
		setIcon(this.startPill.createSpan("bk-pill-icon"), "calendar");
		this.startPill.createSpan({ text: this.startDate ? `Start ${fmtDate(this.startDate)}` : "Start date" });
		this.startPill.toggleClass("is-set", !!this.startDate);

		this.endPill.empty();
		setIcon(this.endPill.createSpan("bk-pill-icon"), "calendar-check");
		this.endPill.createSpan({ text: this.endDate ? `Due ${fmtDate(this.endDate)}` : "End date" });
		this.endPill.toggleClass("is-set", !!this.endDate);
	}

	/** Write only the fields that changed, then close and repaint the board. */
	private async submit(): Promise<void> {
		const { app, cfg } = this.board;
		const file = this.task.file;
		const title = this.title.trim();
		if (title.length === 0) {
			new Notice("Task needs a title");
			return;
		}

		if (title !== this.task.title) await setTitle(app, file, cfg, title);
		if (this.status !== this.task.status) await setStatus(app, file, cfg, this.status);
		if (this.priority !== (this.task.priority || "no priority"))
			await setPriority(app, file, cfg, this.priority);
		if (!sameLabels(this.labels, this.task.labels)) await setLabels(app, file, cfg, this.labels);
		if (this.startDate !== this.task.startDate) await setDate(app, file, cfg, "start", this.startDate);
		if (this.endDate !== this.task.endDate) await setDate(app, file, cfg, "end", this.endDate);
		// Only touch the body once it has actually loaded, so a quick save can't
		// overwrite the note with an empty description.
		if (this.descLoaded && this.description !== this.originalDescription)
			await setBody(app, file, this.description);

		this.close();
		this.board.refresh();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function sameLabels(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	const set = new Set(b);
	return a.every((l) => set.has(l));
}
