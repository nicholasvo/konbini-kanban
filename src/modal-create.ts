import { Modal, TFile, setIcon, Notice } from "obsidian";
import type { KanbanBoard } from "./view";
import { ConfirmModal } from "./modal-confirm";
import { createTask, PendingAttachment } from "./data";
import { statusGlyph, priorityGlyph } from "./icons";
import {
	statusPopover,
	priorityPopover,
	labelPopover,
	datePopover,
	templatePopover,
} from "./pickers";

const DATE_FMT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };

function fmtDate(iso: string): string {
	const d = new Date(`${iso}T00:00:00`);
	return isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, DATE_FMT);
}

interface CreateOptions {
	status: string;
	parent: TFile | null;
	folder: string;
}

/** Linear-style "New task" modal: title, description, and a row of pills. */
export class CreateTaskModal extends Modal {
	private board: KanbanBoard;
	private opts: CreateOptions;

	private title = "";
	private description = "";
	private status: string;
	private priority = "no priority";
	private labels: string[] = [];
	private startDate: string | null = null;
	private endDate: string | null = null;
	private attachments: PendingAttachment[] = [];
	private template: string | null = null;
	private createMore = false;

	private statusPill!: HTMLElement;
	private priorityPill!: HTMLElement;
	private labelPill!: HTMLElement;
	private startPill!: HTMLElement;
	private endPill!: HTMLElement;
	private templatePill!: HTMLElement;
	private descInput!: HTMLTextAreaElement;
	private attachmentsEl!: HTMLElement;
	private fileInput!: HTMLInputElement;

	private animatingClose = false;

	constructor(board: KanbanBoard, opts: CreateOptions) {
		super(board.app);
		this.board = board;
		this.opts = opts;
		this.status = opts.status;
	}

	// Play an exit animation (the inverse of the entrance) before tearing down.
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
		modalEl.addClass("bk-create-modal", "motion-dialog");
		contentEl.empty();

		// Header breadcrumb.
		const header = contentEl.createDiv("bk-create-header");
		const crumb = header.createDiv("bk-create-crumb");
		setIcon(crumb.createSpan("bk-create-crumb-icon"), "square-pen");
		crumb.createSpan({ text: this.opts.parent ? this.parentName() : "New task" });
		if (this.opts.parent) {
			const sep = crumb.createSpan("bk-crumb-sep");
			setIcon(sep, "chevron-right");
			crumb.createSpan({ text: "New sub-task" });
		}

		// Title.
		const titleInput = contentEl.createEl("input", {
			cls: "bk-create-title",
			type: "text",
			placeholder: this.opts.parent ? "Sub-task title" : "Task title",
		});
		titleInput.oninput = () => (this.title = titleInput.value);
		titleInput.onkeydown = (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				descInput.focus();
			}
		};

		// Description. Set placeholder explicitly — createEl's option is unreliable
		// for <textarea>, which is why it wasn't showing.
		const descInput = contentEl.createEl("textarea", { cls: "bk-create-desc" });
		descInput.setAttr("placeholder", "Add description…");
		descInput.oninput = () => (this.description = descInput.value);
		this.descInput = descInput;

		// Pill row.
		const pills = contentEl.createDiv("bk-create-pills");

		this.statusPill = pills.createDiv("bk-pill");
		this.priorityPill = pills.createDiv("bk-pill");
		this.labelPill = pills.createDiv("bk-pill");
		this.startPill = pills.createDiv("bk-pill");
		this.endPill = pills.createDiv("bk-pill");
		this.templatePill = pills.createDiv("bk-pill");
		this.refreshPills();

		this.statusPill.onclick = () =>
			statusPopover(this.statusPill, this.board, this.status, (key) => {
				this.status = key;
				this.refreshPills();
			});
		this.priorityPill.onclick = () =>
			priorityPopover(this.priorityPill, this.board, this.priority, (key) => {
				this.priority = key;
				this.refreshPills();
			});
		this.labelPill.onclick = () =>
			labelPopover(this.labelPill, this.board, this.labels, (labels) => {
				this.labels = labels;
				this.refreshPills();
			});
		this.startPill.onclick = () =>
			datePopover(this.startPill, this.startDate, (value) => {
				this.startDate = value;
				this.refreshPills();
			});
		this.endPill.onclick = () =>
			datePopover(this.endPill, this.endDate, (value) => {
				this.endDate = value;
				this.refreshPills();
			});
		this.templatePill.onclick = () =>
			templatePopover(this.templatePill, this.board, this.template, (name) =>
				this.applyTemplate(name)
			);

		// Attachments preview + hidden file input.
		this.attachmentsEl = contentEl.createDiv("bk-create-attachments");
		this.fileInput = contentEl.createEl("input", { type: "file", cls: "bk-file-input" });
		this.fileInput.setAttr("multiple", "true");
		this.fileInput.onchange = () => {
			if (this.fileInput.files) void this.addFiles(this.fileInput.files);
			this.fileInput.value = "";
		};
		this.renderAttachments();

		// Footer.
		const footer = contentEl.createDiv("bk-create-footer");
		const left = footer.createDiv("bk-create-footer-left");

		const attachBtn = left.createDiv("bk-attach-btn");
		setIcon(attachBtn, "paperclip");
		attachBtn.setAttr("aria-label", "Attach files");
		attachBtn.onclick = () => this.fileInput.click();

		const more = left.createDiv("bk-create-more");
		const toggle = more.createDiv("bk-toggle");
		toggle.onclick = () => {
			this.createMore = !this.createMore;
			toggle.toggleClass("is-on", this.createMore);
		};
		more.createSpan({ text: "Create more" });

		const submit = footer.createEl("button", {
			cls: "bk-create-submit mod-cta",
			text: "Create task",
		});
		submit.onclick = () => void this.submit();

		// Cmd/Ctrl+Enter submits from anywhere in the modal.
		this.scope.register(["Mod"], "Enter", (e) => {
			e.preventDefault();
			void this.submit();
		});

		// Drag-and-drop files anywhere onto the modal, and paste images.
		this.modalEl.addEventListener("dragover", (e) => {
			if (e.dataTransfer?.types.includes("Files")) {
				e.preventDefault();
				this.modalEl.addClass("bk-drag-over");
			}
		});
		this.modalEl.addEventListener("dragleave", (e) => {
			if (!this.modalEl.contains(e.relatedTarget as Node))
				this.modalEl.removeClass("bk-drag-over");
		});
		this.modalEl.addEventListener("drop", (e) => {
			this.modalEl.removeClass("bk-drag-over");
			if (e.dataTransfer?.files.length) {
				e.preventDefault();
				void this.addFiles(e.dataTransfer.files);
			}
		});
		descInput.addEventListener("paste", (e) => {
			const files = e.clipboardData?.files;
			if (files && files.length > 0) {
				e.preventDefault();
				void this.addFiles(files);
			}
		});

		window.setTimeout(() => titleInput.focus(), 20);
	}

	/** Replace the description with a template's body (confirming any overwrite). */
	private applyTemplate(name: string): void {
		const tpl = this.board.plugin.data.templates.find((t) => t.name === name);
		if (!tpl) return;
		const hasText = this.descInput.value.trim().length > 0;
		if (hasText && this.descInput.value !== tpl.body) {
			new ConfirmModal(
				this.app,
				"Replace the current description with this template?",
				(ok) => {
					if (ok) this.setTemplate(tpl.body, name);
				},
				"Replace"
			).open();
			return;
		}
		this.setTemplate(tpl.body, name);
	}

	private setTemplate(body: string, name: string): void {
		this.description = body;
		this.descInput.value = body;
		this.template = name;
		this.refreshPills();
		this.descInput.focus();
	}

	/** Read selected/dropped/pasted files into memory and show them. */
	private async addFiles(files: FileList): Promise<void> {
		for (let i = 0; i < files.length; i++) {
			const f = files[i];
			const data = await f.arrayBuffer();
			const name = f.name && f.name.length > 0 ? f.name : `pasted-${Date.now()}-${i}.png`;
			this.attachments.push({ name, type: f.type, data });
		}
		this.renderAttachments();
	}

	private renderAttachments(): void {
		this.attachmentsEl.empty();
		this.attachmentsEl.toggleClass("is-empty", this.attachments.length === 0);
		this.attachments.forEach((att, idx) => {
			const chip = this.attachmentsEl.createDiv("bk-attachment");
			if (att.type.startsWith("image/")) {
				const url = URL.createObjectURL(new Blob([att.data], { type: att.type }));
				const img = chip.createEl("img", { cls: "bk-attachment-thumb" });
				img.src = url;
				img.onload = () => URL.revokeObjectURL(url);
			} else {
				setIcon(chip.createSpan("bk-attachment-icon"), "file");
			}
			chip.createSpan({ cls: "bk-attachment-name", text: att.name });
			const rm = chip.createSpan("bk-attachment-remove");
			setIcon(rm, "x");
			rm.setAttr("aria-label", "Remove attachment");
			rm.onclick = () => {
				this.attachments.splice(idx, 1);
				this.renderAttachments();
			};
		});
	}

	private parentName(): string {
		return this.opts.parent ? this.opts.parent.basename : "New task";
	}

	private refreshPills(): void {
		const cfg = this.board.cfg;
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
		this.startPill.createSpan({
			text: this.startDate ? `Start ${fmtDate(this.startDate)}` : "Start date",
		});
		this.startPill.toggleClass("is-set", !!this.startDate);

		this.endPill.empty();
		setIcon(this.endPill.createSpan("bk-pill-icon"), "calendar-check");
		this.endPill.createSpan({
			text: this.endDate ? `Due ${fmtDate(this.endDate)}` : "End date",
		});
		this.endPill.toggleClass("is-set", !!this.endDate);

		this.templatePill.empty();
		setIcon(this.templatePill.createSpan("bk-pill-icon"), "file-text");
		this.templatePill.createSpan({ text: this.template ?? "Template" });
		this.templatePill.toggleClass("is-set", !!this.template);
		void cfg;
	}

	private async submit(): Promise<void> {
		if (this.title.trim().length === 0) {
			new Notice("Task needs a title");
			return;
		}
		const file = await createTask(this.board.app, this.board.cfg, {
			title: this.title.trim(),
			description: this.description,
			status: this.status,
			priority: this.priority,
			labels: this.labels,
			startDate: this.startDate,
			endDate: this.endDate,
			attachments: this.attachments,
			parent: this.opts.parent,
			folder: this.opts.folder,
		});

		if (this.createMore) {
			this.title = "";
			this.description = "";
			this.labels = [];
			this.startDate = null;
			this.endDate = null;
			this.attachments = [];
			this.template = null;
			this.renderAttachments();
			this.reopenForNext();
		} else {
			// Stay on the board rather than opening the new note; repaint and let
			// the freshly created card animate in.
			this.close();
			this.board.animateInCard(file.path);
		}
	}

	private reopenForNext(): void {
		// Reset the inputs in place without closing the modal.
		const title = this.contentEl.querySelector<HTMLInputElement>(".bk-create-title");
		const desc = this.contentEl.querySelector<HTMLTextAreaElement>(".bk-create-desc");
		if (title) {
			title.value = "";
			title.focus();
		}
		if (desc) desc.value = "";
		this.refreshPills();
		new Notice("Task created");
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
