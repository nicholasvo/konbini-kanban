import { App, TFile, Keymap, Menu, setIcon, BasesView } from "obsidian";
import type { QueryController } from "obsidian";
import {
	KANBAN_VIEW_TYPE,
	StatusDef,
	PriorityDef,
	LabelDef,
	STATUS_COLOR_PALETTE,
	SEED_NOTE_PATH,
} from "./constants";
import { KanbanConfig, resolveConfig } from "./config";
import type KonbiniKanbanPlugin from "./main";
import {
	Task,
	readTask,
	setStatus,
	collectLabels,
} from "./data";
import { renderCard } from "./card";
import { CreateTaskModal } from "./modal-create";
import { renderEmptyKonbini } from "./konbini";
import { statusGlyph } from "./icons";

export interface ChildRollup {
	done: number;
	total: number;
}

/**
 * Holds everything a card needs and owns the column DOM. One board per view
 * instance; rebuilt on every onDataUpdated, but it reuses the root element.
 */
export class KanbanBoard {
	app: App;
	plugin: KonbiniKanbanPlugin;
	cfg!: KanbanConfig;
	statusByKey = new Map<string, StatusDef>();
	priorityByKey = new Map<string, PriorityDef>();

	/** Re-runs the Bases data pipeline + repaint; wired up by the view. */
	refresh: () => void = () => {};

	private rootEl: HTMLElement;
	private columnsEl!: HTMLElement;
	private columnBodyEls = new Map<string, HTMLElement>();

	tasks: Task[] = [];
	taskByPath = new Map<string, Task>();
	knownLabels: string[] = [];
	labelDefByName = new Map<string, LabelDef>();
	childRollup = new Map<string, ChildRollup>();
	childrenByParent = new Map<string, Task[]>();
	private collapsed = new Set<string>();
	private targetFolder = "";

	// FLIP state: card rects captured before a move, replayed on the next render
	// so cards spring from their old position into the new layout.
	private flipFrom: Map<string, DOMRect> | null = null;
	private flipFocus: string | null = null;

	constructor(app: App, rootEl: HTMLElement, plugin: KonbiniKanbanPlugin) {
		this.app = app;
		this.plugin = plugin;
		this.rootEl = rootEl;
		this.rootEl.addClass("bk-root");
	}

	private paletteColor(n: number): string {
		return STATUS_COLOR_PALETTE[n % STATUS_COLOR_PALETTE.length];
	}

	/** Persist a new status and repaint so it becomes a column. Returns its key. */
	async addStatus(name: string, emoji?: string, color?: string): Promise<string> {
		const key = name.trim().toLowerCase();
		if (key.length === 0) return this.cfg.defaultStatus;
		if (this.statusByKey.has(key)) return key;
		await this.plugin.addCustomStatus({
			key,
			label: name.trim(),
			color: color ?? this.paletteColor(this.plugin.data.customStatuses.length),
			icon: "unstarted",
			emoji: emoji || undefined,
		});
		this.refresh();
		return key;
	}

	/** Persist a new priority (ranked after existing ones). Returns its key. */
	async addPriority(name: string, emoji?: string, color?: string): Promise<string> {
		const key = name.trim().toLowerCase();
		if (key.length === 0) return "no priority";
		if (this.priorityByKey.has(key)) return key;
		const ranks = this.cfg.priorities.map((p) => p.rank).filter((r) => r < 99);
		const rank = (ranks.length > 0 ? Math.max(...ranks) : 4) + 1;
		await this.plugin.addCustomPriority({
			key,
			label: name.trim(),
			rank,
			icon: "medium",
			emoji: emoji || undefined,
			color: color ?? this.paletteColor(this.plugin.data.customPriorities.length),
		});
		this.refresh();
		return key;
	}

	/** Persist a new (or updated) label definition. Returns the label name. */
	async addLabel(name: string, emoji?: string, color?: string): Promise<string> {
		const n = name.trim();
		if (n.length === 0) return "";
		await this.plugin.addCustomLabel({
			name: n,
			color: color ?? this.paletteColor(this.plugin.data.customLabels.length),
			emoji: emoji || undefined,
		});
		this.refresh();
		return n;
	}

	labelDef(name: string): LabelDef | undefined {
		return this.labelDefByName.get(name);
	}

	isCustomStatus(key: string): boolean {
		return this.plugin.data.customStatuses.some((s) => s.key === key);
	}
	isCustomPriority(key: string): boolean {
		return this.plugin.data.customPriorities.some((p) => p.key === key);
	}
	isCustomLabel(name: string): boolean {
		return this.plugin.data.customLabels.some((l) => l.name === name);
	}

	async deleteStatus(key: string): Promise<void> {
		await this.plugin.removeCustomStatus(key);
		this.refresh();
	}
	async deletePriority(key: string): Promise<void> {
		await this.plugin.removeCustomPriority(key);
		this.refresh();
	}
	async deleteLabel(name: string): Promise<void> {
		await this.plugin.removeCustomLabel(name);
		this.refresh();
	}

	updateStatus(key: string, emoji: string, color: string): Promise<void> {
		return this.plugin.updateCustomStatus(key, emoji, color);
	}
	updatePriority(key: string, emoji: string, color: string): Promise<void> {
		return this.plugin.updateCustomPriority(key, emoji, color);
	}
	updateLabel(name: string, emoji: string, color: string): Promise<void> {
		return this.plugin.updateCustomLabel(name, emoji, color);
	}

	/** Re-read config + entries and repaint. */
	update(cfg: KanbanConfig, files: TFile[], targetFolder: string): void {
		this.cfg = cfg;
		this.targetFolder = targetFolder;
		this.statusByKey = new Map(cfg.statuses.map((s) => [s.key, s]));
		this.priorityByKey = new Map(cfg.priorities.map((p) => [p.key, p]));
		this.labelDefByName = new Map(cfg.labelDefs.map((d) => [d.name, d]));

		this.tasks = files.map((f) => readTask(this.app, f, cfg));
		this.taskByPath = new Map(this.tasks.map((i) => [i.file.path, i]));
		// Known labels = those used on notes plus any user-defined label names.
		this.knownLabels = Array.from(
			new Set([...collectLabels(this.tasks), ...cfg.labelDefs.map((d) => d.name)])
		).sort((a, b) => a.localeCompare(b));
		this.computeRollups();
		this.computeChildren();
		this.render();
	}

	/** Group in-scope sub-tasks under their parent path, sorted like columns. */
	private computeChildren(): void {
		this.childrenByParent.clear();
		for (const task of this.tasks) {
			if (!task.parentPath || !this.taskByPath.has(task.parentPath)) continue;
			const arr = this.childrenByParent.get(task.parentPath) ?? [];
			arr.push(task);
			this.childrenByParent.set(task.parentPath, arr);
		}
		for (const arr of this.childrenByParent.values()) arr.sort((a, b) => this.compareTasks(a, b));
	}

	private compareTasks(a: Task, b: Task): number {
		const ra = this.priorityByKey.get(a.priority)?.rank ?? 99;
		const rb = this.priorityByKey.get(b.priority)?.rank ?? 99;
		return ra - rb || a.title.localeCompare(b.title);
	}

	childrenOf(task: Task): Task[] {
		return this.childrenByParent.get(task.file.path) ?? [];
	}

	isCollapsed(path: string): boolean {
		return this.collapsed.has(path);
	}

	toggleCollapsed(path: string): void {
		if (this.collapsed.has(path)) this.collapsed.delete(path);
		else this.collapsed.add(path);
		this.render();
	}

	private computeRollups(): void {
		this.childRollup.clear();
		const doneKeys = new Set(["done", "canceled"]);
		for (const task of this.tasks) {
			if (!task.parentPath) continue;
			const roll = this.childRollup.get(task.parentPath) ?? { done: 0, total: 0 };
			roll.total++;
			if (doneKeys.has(task.status)) roll.done++;
			this.childRollup.set(task.parentPath, roll);
		}
	}

	/** Bucket tasks by status. Unknown/empty statuses fall into defaultStatus. */
	private bucketed(): Map<string, Task[]> {
		const map = new Map<string, Task[]>();
		for (const s of this.cfg.statuses) map.set(s.key, []);
		for (const task of this.tasks) {
			// In-scope sub-tasks render nested under their parent, not as columns.
			if (task.parentPath && this.taskByPath.has(task.parentPath)) continue;
			let key = task.status;
			if (!this.statusByKey.has(key)) key = this.cfg.defaultStatus;
			if (!map.has(key)) map.set(key, []);
			map.get(key)!.push(task);
		}
		// Sort each column by priority rank then title.
		for (const list of map.values()) list.sort((a, b) => this.compareTasks(a, b));
		return map;
	}

	private render(): void {
		// Preserve horizontal scroll across the rebuild; otherwise the new
		// .bk-columns starts at scrollLeft 0 and the FLIP animates every card
		// sliding in from the side.
		const prevScroll = this.columnsEl?.scrollLeft ?? 0;
		this.rootEl.empty();
		this.columnBodyEls.clear();
		this.columnsEl = this.rootEl.createDiv("bk-columns");
		const buckets = this.bucketed();
		const hidden = new Set(this.plugin.data.hiddenStatuses);

		for (const status of this.cfg.statuses) {
			if (hidden.has(status.key)) continue;
			const list = buckets.get(status.key) ?? [];
			const colEl = this.columnsEl.createDiv("bk-column");
			colEl.dataset.status = status.key;

			const headerEl = colEl.createDiv("bk-column-header");
			headerEl.appendChild(statusGlyph(status));
			headerEl.createSpan({ cls: "bk-column-title", text: status.label });
			headerEl.createSpan({ cls: "bk-column-count", text: String(list.length) });
			const menuBtn = headerEl.createSpan({ cls: "bk-column-menu" });
			menuBtn.setAttr("aria-label", "Column options");
			setIcon(menuBtn, "more-horizontal");
			menuBtn.onclick = (e) => this.openColumnMenu(e, status.key);
			const addBtn = headerEl.createSpan({ cls: "bk-column-add", text: "+" });
			addBtn.setAttr("aria-label", "New task");
			addBtn.onclick = () => this.openCreateModal(status.key);

			const bodyEl = colEl.createDiv("bk-column-body");
			this.columnBodyEls.set(status.key, bodyEl);

			for (const task of list) {
				bodyEl.appendChild(renderCard(this, task));
			}
			if (list.length === 0) {
				if (this.plugin.data.pixelArt) bodyEl.appendChild(renderEmptyKonbini(status.key));
				else bodyEl.createDiv({ cls: "bk-column-empty", text: "No tasks" });
			}
		}

		// Hidden-columns panel: re-show any columns the user has hidden.
		const hiddenStatuses = this.cfg.statuses.filter((s) => hidden.has(s.key));
		if (hiddenStatuses.length > 0) {
			const panel = this.columnsEl.createDiv("bk-hidden-panel");
			panel.createDiv({ cls: "bk-hidden-title", text: "Hidden columns" });
			for (const status of hiddenStatuses) {
				const row = panel.createDiv("bk-hidden-row");
				row.appendChild(statusGlyph(status));
				row.createSpan({ cls: "bk-hidden-label", text: status.label });
				row.createSpan({ cls: "bk-hidden-count", text: String((buckets.get(status.key) ?? []).length) });
				row.setAttr("aria-label", `Show ${status.label}`);
				row.onclick = () => void this.plugin.setStatusHidden(status.key, false);
			}
		}

		// Restore scroll before the FLIP measures final positions.
		this.columnsEl.scrollLeft = prevScroll;

		if (this.flipFrom) {
			this.playFlip(this.flipFrom, this.flipFocus);
			this.flipFrom = null;
			this.flipFocus = null;
		}
	}

	/** Snapshot the on-screen rect of every top-level card, keyed by note path. */
	private captureRects(): Map<string, DOMRect> {
		const rects = new Map<string, DOMRect>();
		this.rootEl.querySelectorAll<HTMLElement>(".bk-card[data-path]").forEach((el) => {
			if (el.dataset.path) rects.set(el.dataset.path, el.getBoundingClientRect());
		});
		return rects;
	}

	/**
	 * FLIP: each card that moved is animated from its old position into its new
	 * slot. Follows the Codex motion guide — a quiet ease-out, small scale, no
	 * overshoot. Uses the Web Animations API exclusively (no inline transform),
	 * so the card's CSS `transition: transform` is never triggered; that fight
	 * between the transition and the FLIP was the source of the flicker.
	 */
	private playFlip(first: Map<string, DOMRect>, focus: string | null): void {
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		// --motion-ease-enter from the style guide.
		const EASE = "cubic-bezier(0.19, 1, 0.22, 1)";
		this.rootEl.querySelectorAll<HTMLElement>(".bk-card[data-path]").forEach((el) => {
			const path = el.dataset.path;
			const prev = path ? first.get(path) : undefined;
			if (!prev) return;
			const now = el.getBoundingClientRect();
			const dx = prev.left - now.left;
			const dy = prev.top - now.top;
			if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;

			const isFocus = path === focus;
			// Moved card settles from a subtle 0.98 scale; reflowed cards just slide.
			const from = isFocus
				? `translate(${dx}px, ${dy}px) scale(0.98)`
				: `translate(${dx}px, ${dy}px)`;
			const to = isFocus ? "translate(0px, 0px) scale(1)" : "translate(0px, 0px)";
			el.animate([{ transform: from }, { transform: to }], {
				duration: isFocus ? 300 : 250,
				easing: EASE,
			});
		});
	}

	// --- Card interactions -------------------------------------------------

	openFile(file: TFile, evt: MouseEvent): void {
		void this.app.workspace.openLinkText(file.path, "", Keymap.isModEvent(evt));
	}

	rollupFor(task: Task): ChildRollup | null {
		return this.childRollup.get(task.file.path) ?? null;
	}

	parentTitleFor(task: Task): string | null {
		if (!task.parentPath) return null;
		const parent = this.taskByPath.get(task.parentPath);
		if (parent) return parent.title;
		// Parent not in the current query scope; fall back to its filename.
		const f = this.app.vault.getAbstractFileByPath(task.parentPath);
		return f ? f.name.replace(/\.md$/, "") : null;
	}

	private openColumnMenu(e: MouseEvent, statusKey: string): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Hide column")
				.setIcon("eye-off")
				.onClick(() => void this.plugin.setStatusHidden(statusKey, true))
		);
		menu.showAtMouseEvent(e);
	}

	openCreateModal(status?: string, parent?: TFile): void {
		new CreateTaskModal(this, {
			status: status ?? this.cfg.defaultStatus,
			parent: parent ?? null,
			folder: this.targetFolder,
		}).open();
	}

	// --- Drag and drop (pointer-based; see dnd.ts) -------------------------

	/** The column body under a viewport point (anywhere in the column width). */
	columnBodyAt(x: number, y: number): HTMLElement | null {
		for (const body of this.columnBodyEls.values()) {
			const col = body.closest<HTMLElement>(".bk-column");
			if (!col) continue;
			const r = col.getBoundingClientRect();
			if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return body;
		}
		return null;
	}

	/** Snapshot every card's rect by element (for in-drag reflow FLIP). */
	captureCardRects(): Map<HTMLElement, DOMRect> {
		const rects = new Map<HTMLElement, DOMRect>();
		this.rootEl.querySelectorAll<HTMLElement>(".bk-card").forEach((el) => rects.set(el, el.getBoundingClientRect()));
		return rects;
	}

	/** Animate cards from their captured positions to current — the live gap. */
	playCardReflow(first: Map<HTMLElement, DOMRect>): void {
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		this.rootEl.querySelectorAll<HTMLElement>(".bk-card").forEach((el) => {
			const prev = first.get(el);
			if (!prev) return;
			const now = el.getBoundingClientRect();
			const dx = prev.left - now.left;
			const dy = prev.top - now.top;
			if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
			el.animate(
				[{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0px, 0px)" }],
				{ duration: 180, easing: "cubic-bezier(0.19, 1, 0.22, 1)" }
			);
		});
	}

	highlightColumn(body: HTMLElement | null): void {
		for (const b of this.columnBodyEls.values()) b.removeClass("bk-column-dragover");
		body?.addClass("bk-column-dragover");
	}

	/** Commit a drop: write the new status if the column changed, else re-sort. */
	async commitDrop(task: Task, targetStatus: string): Promise<void> {
		if (targetStatus && targetStatus !== task.status) {
			this.flipFrom = this.captureRects();
			this.flipFocus = task.file.path;
			await setStatus(this.app, task.file, this.cfg, targetStatus);
		} else {
			// Same column: we sort by priority, so snap back to sorted order.
			this.flipFrom = this.captureRects();
			this.flipFocus = task.file.path;
			this.render();
		}
	}
}

/**
 * Minimal shape of the runtime Bases query result we read from. The published
 * typings expose `data`/`groupedData`, but the runtime also surfaces
 * `ungroupedData` on some versions, so we model just the fields we touch.
 */
interface BasesEntryLike {
	file?: TFile;
}
interface BasesGroupLike {
	entries?: BasesEntryLike[];
}
interface BasesDataLike {
	groupedData?: BasesGroupLike[];
	ungroupedData?: BasesEntryLike[];
}

/**
 * The registered Bases view. Bridges Obsidian's data lifecycle to KanbanBoard.
 */
export class KanbanBasesView extends BasesView {
	readonly type = KANBAN_VIEW_TYPE;
	private board: KanbanBoard;
	private plugin: KonbiniKanbanPlugin;

	constructor(controller: unknown, parentEl: HTMLElement, plugin: KonbiniKanbanPlugin) {
		super(controller as QueryController);
		this.plugin = plugin;
		const container = parentEl.createDiv("bk-view-container");
		this.board = new KanbanBoard(this.app, container, plugin);
		this.board.refresh = () => this.onDataUpdated();
		// Track this board so settings changes can repaint it; drop it on unload.
		plugin.boards.add(this.board);
		this.register(() => plugin.boards.delete(this.board));
	}

	onDataUpdated(): void {
		const cfg = resolveConfig(
			{ get: (k: string) => this.config.get(k) },
			{
				statuses: this.plugin.data.customStatuses,
				priorities: this.plugin.data.customPriorities,
				labels: this.plugin.data.customLabels,
			}
		);
		const files = this.collectFiles();
		this.board.update(cfg, files, this.inferTargetFolder(files));
	}

	/** Pull the deduped TFile set from the query result. */
	private collectFiles(): TFile[] {
		const out: TFile[] = [];
		const seen = new Set<string>();
		const data = this.data as unknown as BasesDataLike;
		const groups = data?.groupedData ?? [];
		const pushEntry = (entry: BasesEntryLike): void => {
			const file = entry?.file;
			// Never show the plugin's typeahead seed note as a task.
			if (file && file.path !== SEED_NOTE_PATH && !seen.has(file.path)) {
				seen.add(file.path);
				out.push(file);
			}
		};
		if (Array.isArray(data?.ungroupedData)) data.ungroupedData.forEach(pushEntry);
		for (const g of groups) (g?.entries ?? []).forEach(pushEntry);
		return out;
	}

	/** New tasks go in the folder most tasks already live in, else vault root. */
	private inferTargetFolder(files: TFile[]): string {
		const counts = new Map<string, number>();
		for (const f of files) {
			const dir = f.parent?.path ?? "";
			counts.set(dir, (counts.get(dir) ?? 0) + 1);
		}
		let best = "";
		let bestN = -1;
		for (const [dir, n] of counts) {
			if (n > bestN) {
				best = dir;
				bestN = n;
			}
		}
		return best === "/" ? "" : best;
	}
}
