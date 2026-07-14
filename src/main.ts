import {
	Plugin,
	Notice,
	PluginSettingTab,
	Setting,
	App,
	Modal,
	TFile,
	normalizePath,
	type BasesViewRegistration,
} from "obsidian";
import {
	KANBAN_VIEW_TYPE,
	StatusDef,
	PriorityDef,
	LabelDef,
	Template,
	DEFAULT_STATUSES,
	DEFAULT_PRIORITIES,
	DEFAULT_LABELS,
	DEFAULTS,
	SEED_NOTE_PATH,
	STATUS_COLOR_PALETTE,
	buildColumnKey,
} from "./constants";
import { viewOptions, mergeStatuses } from "./config";
import { KanbanBasesView, KanbanBoard } from "./view";
import { ConfirmModal } from "./modal-confirm";

/** Persisted plugin data: columns, priorities/labels, templates, and prefs. */
interface KanbanData {
	/** Global column list (ordered). Authoritative default when a view has no override. */
	columns: StatusDef[];
	/** @deprecated Migrated into `columns` on load; kept for one-release compat. */
	customStatuses: StatusDef[];
	customPriorities: PriorityDef[];
	customLabels: LabelDef[];
	templates: Template[];
	hiddenStatuses: string[];
	pixelArt: boolean;
	/** True once the default labels have been seeded (so we don't re-seed). */
	initialized: boolean;
}

export default class KonbiniKanbanPlugin extends Plugin {
	data: KanbanData = {
		columns: [],
		customStatuses: [],
		customPriorities: [],
		customLabels: [],
		templates: [],
		hiddenStatuses: [],
		pixelArt: true,
		initialized: false,
	};

	/** Live boards, so settings changes can repaint them immediately. */
	boards = new Set<KanbanBoard>();

	async onload(): Promise<void> {
		const loaded = (await this.loadData()) as Partial<KanbanData> | null;
		this.data = {
			columns: loaded?.columns ?? [],
			customStatuses: loaded?.customStatuses ?? [],
			customPriorities: loaded?.customPriorities ?? [],
			customLabels: loaded?.customLabels ?? [],
			templates: loaded?.templates ?? [],
			hiddenStatuses: loaded?.hiddenStatuses ?? [],
			pixelArt: loaded?.pixelArt ?? true,
			initialized: loaded?.initialized ?? false,
		};

		// Migrate: seed global columns from defaults + any legacy customStatuses.
		if (!this.data.columns.length) {
			this.data.columns = mergeStatuses(DEFAULT_STATUSES, this.data.customStatuses).map(
				(s) => ({
					...s,
				})
			);
			await this.saveData(this.data);
		}

		// Seed the general default labels once (existing label names are kept).
		if (!this.data.initialized) {
			for (const def of DEFAULT_LABELS) {
				if (!this.data.customLabels.some((l) => l.name === def.name)) {
					this.data.customLabels.push({ ...def });
				}
			}
			this.data.initialized = true;
			await this.saveData(this.data);
		}

		// Refresh the typeahead seed note once the vault is ready (covers the
		// freshly-seeded default labels without creating a file during onload).
		this.app.workspace.onLayoutReady(() => void this.updateSeedNote());

		this.addSettingTab(new KonbiniSettingTab(this.app, this));

		// registerBasesView returns false when Bases is not enabled in the vault.
		// Older Obsidian versions lack the method entirely, so guard for it.
		const register = this.registerBasesView?.bind(this);
		if (typeof register !== "function") {
			new Notice("Konbini Kanban: this Obsidian version has no Bases view API.");
			return;
		}

		const ok = register(KANBAN_VIEW_TYPE, {
			name: "Kanban",
			icon: "square-kanban",
			factory: (controller, containerEl) =>
				new KanbanBasesView(controller, containerEl, this),
			// viewOptions widens each entry's `type` to `string`; the values are
			// valid text options, so re-assert the registration's option type.
			options: viewOptions as unknown as BasesViewRegistration["options"],
		});

		if (ok === false) {
			new Notice("Konbini Kanban: enable the core Bases plugin to use the Kanban view.");
		}
	}

	/** Append a global column. No-op if the key already exists. */
	async addColumn(def: StatusDef): Promise<void> {
		if (this.data.columns.some((s) => s.key === def.key)) return;
		this.data.columns.push(def);
		await this.persist();
		for (const board of this.boards) board.refresh();
	}

	/** Remove a global column and clear it from the hidden list. */
	async removeColumn(key: string): Promise<void> {
		if (this.data.columns.length <= 1) {
			new Notice("Konbini Kanban: keep at least one column.");
			return;
		}
		this.data.columns = this.data.columns.filter((s) => s.key !== key);
		this.data.hiddenStatuses = this.data.hiddenStatuses.filter((k) => k !== key);
		await this.persist();
		for (const board of this.boards) board.refresh();
	}

	/** Show or hide a status column across all open boards. */
	async setColumnHidden(key: string, hidden: boolean): Promise<void> {
		const set = new Set(this.data.hiddenStatuses);
		if (hidden) set.add(key);
		else set.delete(key);
		this.data.hiddenStatuses = Array.from(set);
		await this.saveData(this.data);
		for (const board of this.boards) board.refresh();
	}

	/** Move a column up (delta -1) or down (delta +1) in the global list. */
	async moveColumn(key: string, delta: -1 | 1): Promise<void> {
		const i = this.data.columns.findIndex((c) => c.key === key);
		const j = i + delta;
		if (i < 0 || j < 0 || j >= this.data.columns.length) return;
		const next = [...this.data.columns];
		const [item] = next.splice(i, 1);
		next.splice(j, 0, item);
		this.data.columns = next;
		await this.saveData(this.data);
		for (const board of this.boards) board.refresh();
	}

	/** @deprecated Prefer addColumn — kept so older board helpers keep compiling. */
	async addCustomStatus(def: StatusDef): Promise<void> {
		await this.addColumn(def);
	}

	async addCustomPriority(def: PriorityDef): Promise<void> {
		if (this.data.customPriorities.some((p) => p.key === def.key)) return;
		this.data.customPriorities.push(def);
		await this.persist();
	}

	async addCustomLabel(def: LabelDef): Promise<void> {
		const existing = this.data.customLabels.find((l) => l.name === def.name);
		if (existing) {
			existing.color = def.color;
			existing.emoji = def.emoji;
		} else {
			this.data.customLabels.push(def);
		}
		await this.persist();
	}

	/** @deprecated Prefer removeColumn. */
	async removeCustomStatus(key: string): Promise<void> {
		await this.removeColumn(key);
	}

	async removeCustomPriority(key: string): Promise<void> {
		this.data.customPriorities = this.data.customPriorities.filter((p) => p.key !== key);
		await this.persist();
	}

	async removeCustomLabel(name: string): Promise<void> {
		this.data.customLabels = this.data.customLabels.filter((l) => l.name !== name);
		await this.persist();
	}

	/**
	 * Add or overwrite a description-body template by name. Templates only feed
	 * the create modal, so they skip the seed-note rewrite and board repaint.
	 */
	async saveTemplate(template: Template, originalName?: string): Promise<void> {
		const key = originalName ?? template.name;
		const existing = this.data.templates.find((t) => t.name === key);
		if (existing) {
			existing.name = template.name;
			existing.body = template.body;
		} else {
			this.data.templates.push(template);
		}
		await this.saveData(this.data);
	}

	async removeTemplate(name: string): Promise<void> {
		this.data.templates = this.data.templates.filter((t) => t.name !== name);
		await this.saveData(this.data);
	}

	// Updates only change emoji/color (not the stored value), so they skip the
	// seed-note rewrite but still save and repaint open boards.
	async updateCustomStatus(key: string, emoji: string, color: string): Promise<void> {
		const def = this.data.columns.find((s) => s.key === key);
		if (!def) return;
		def.emoji = emoji || undefined;
		def.color = color;
		await this.saveData(this.data);
		for (const board of this.boards) board.refresh();
	}

	async updateCustomPriority(key: string, emoji: string, color: string): Promise<void> {
		const def = this.data.customPriorities.find((p) => p.key === key);
		if (!def) return;
		def.emoji = emoji || undefined;
		def.color = color;
		await this.saveData(this.data);
		for (const board of this.boards) board.refresh();
	}

	async updateCustomLabel(name: string, emoji: string, color: string): Promise<void> {
		const def = this.data.customLabels.find((l) => l.name === name);
		if (!def) return;
		def.emoji = emoji || undefined;
		def.color = color;
		await this.saveData(this.data);
		for (const board of this.boards) board.refresh();
	}

	/** @deprecated Prefer setColumnHidden. */
	async setStatusHidden(key: string, hidden: boolean): Promise<void> {
		await this.setColumnHidden(key, hidden);
	}

	async setPixelArt(on: boolean): Promise<void> {
		this.data.pixelArt = on;
		await this.saveData(this.data);
		for (const board of this.boards) board.refresh();
	}

	/** Save data and refresh the typeahead seed note. */
	private async persist(): Promise<void> {
		await this.saveData(this.data);
		await this.updateSeedNote();
	}

	/**
	 * Maintain a seed note whose frontmatter lists every status/priority/label
	 * value. Obsidian only suggests property values that already exist in some
	 * note's frontmatter, so this makes custom values appear in the native
	 * property typeahead even before any task uses them.
	 */
	private async updateSeedNote(): Promise<void> {
		const statuses = this.data.columns.map((s) => s.key);
		const priorities = [
			...DEFAULT_PRIORITIES.filter((p) => p.key !== "no priority").map((p) => p.key),
			...this.data.customPriorities.map((p) => p.key),
		];
		const labels = this.data.customLabels.map((l) => l.name);

		const path = normalizePath(SEED_NOTE_PATH);
		let file = this.app.vault.getAbstractFileByPath(path);
		if (!file) {
			file = await this.app.vault.create(
				path,
				"Maintained by Konbini Kanban to seed property suggestions. Safe to keep or move.\n"
			);
		}
		if (file instanceof TFile) {
			await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				fm[DEFAULTS.statusProp] = statuses;
				fm[DEFAULTS.priorityProp] = priorities;
				fm[DEFAULTS.labelsProp] = labels;
			});
		}
	}
}

/** One-line preview of a template body for the settings list. */
function templatePreview(body: string): string {
	const flat = body.replace(/\s+/g, " ").trim();
	if (flat.length === 0) return "Empty template";
	return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

/** Modal for creating a global column (name only; icon/color auto-assigned). */
class ColumnEditModal extends Modal {
	private existingKeys: string[];
	private onSubmit: (def: StatusDef) => void | Promise<void>;
	private name = "";
	private paletteIndex: number;

	constructor(
		app: App,
		existingKeys: string[],
		paletteIndex: number,
		onSubmit: (def: StatusDef) => void | Promise<void>
	) {
		super(app);
		this.existingKeys = existingKeys;
		this.paletteIndex = paletteIndex;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText("New column");

		new Setting(contentEl).setName("Name").addText((text) => {
			text.setPlaceholder("Review").setValue(this.name);
			text.onChange((v) => (this.name = v));
			window.setTimeout(() => text.inputEl.focus(), 20);
		});

		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText("Create")
				.setCta()
				.onClick(() => void this.submit())
		);
	}

	private async submit(): Promise<void> {
		const label = this.name.trim();
		if (label.length === 0) {
			new Notice("Column needs a name");
			return;
		}
		const key = buildColumnKey(label);
		if (this.existingKeys.includes(key)) {
			new Notice("A column with that name already exists");
			return;
		}
		await this.onSubmit({
			key,
			label,
			color: STATUS_COLOR_PALETTE[this.paletteIndex % STATUS_COLOR_PALETTE.length],
			icon: "unstarted",
		});
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Modal for creating or editing a description-body template. */
class TemplateEditModal extends Modal {
	private original: Template | null;
	private existingNames: string[];
	private onSubmit: (template: Template) => void | Promise<void>;
	private name: string;
	private body: string;

	constructor(
		app: App,
		original: Template | null,
		existingNames: string[],
		onSubmit: (template: Template) => void | Promise<void>
	) {
		super(app);
		this.original = original;
		this.existingNames = existingNames;
		this.onSubmit = onSubmit;
		this.name = original?.name ?? "";
		this.body = original?.body ?? "";
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText(this.original ? "Edit template" : "New template");

		new Setting(contentEl).setName("Name").addText((text) => {
			text.setPlaceholder("Bug report").setValue(this.name);
			text.onChange((v) => (this.name = v));
			window.setTimeout(() => text.inputEl.focus(), 20);
		});

		new Setting(contentEl)
			.setName("Description")
			.setDesc("Text inserted into the new task's body.")
			.setClass("bk-template-body-setting")
			.addTextArea((area) => {
				area.setPlaceholder("## Steps to reproduce\n\n## Expected\n\n## Actual").setValue(
					this.body
				);
				area.onChange((v) => (this.body = v));
				area.inputEl.rows = 8;
			});

		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText(this.original ? "Save" : "Create")
				.setCta()
				.onClick(() => void this.submit())
		);
	}

	private async submit(): Promise<void> {
		const name = this.name.trim();
		if (name.length === 0) {
			new Notice("Template needs a name");
			return;
		}
		const clash = this.existingNames.some((n) => n === name && n !== this.original?.name);
		if (clash) {
			new Notice("A template with that name already exists");
			return;
		}
		await this.onSubmit({ name, body: this.body });
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class KonbiniSettingTab extends PluginSettingTab {
	private plugin: KonbiniKanbanPlugin;

	constructor(app: App, plugin: KonbiniKanbanPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Konbini empty-column art")
			.setDesc("Show a cute animated ASCII konbini cat in columns that have no tasks.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.data.pixelArt)
					.onChange((value) => void this.plugin.setPixelArt(value))
			);

		// Global columns — default for views without a per-board statuses override.
		new Setting(containerEl)
			.setName("Columns")
			.setDesc(
				"These columns apply to all Kanban views that don't define their own column set in view options. Order here is left-to-right on the board. Views with a custom Columns override are unaffected."
			)
			.setHeading()
			.addButton((btn) =>
				btn
					.setButtonText("Add column")
					.setCta()
					.onClick(() =>
						new ColumnEditModal(
							this.app,
							this.plugin.data.columns.map((c) => c.key),
							this.plugin.data.columns.length,
							async (def) => {
								await this.plugin.addColumn(def);
								this.display();
							}
						).open()
					)
			);

		const columns = this.plugin.data.columns;
		const hidden = new Set(this.plugin.data.hiddenStatuses);
		if (columns.length === 0) {
			containerEl.createDiv({
				cls: "setting-item-description",
				text: "No columns yet — add one to get started.",
			});
		}
		columns.forEach((col, index) => {
			const row = new Setting(containerEl).setName(col.label).addToggle((toggle) =>
				toggle.setValue(!hidden.has(col.key)).onChange((visible) => {
					void this.plugin.setColumnHidden(col.key, !visible);
				})
			);
			row.addExtraButton((btn) => {
				btn.setIcon("chevron-up").setTooltip("Move up");
				if (index === 0) btn.setDisabled(true);
				else
					btn.onClick(
						() => void this.plugin.moveColumn(col.key, -1).then(() => this.display())
					);
			});
			row.addExtraButton((btn) => {
				btn.setIcon("chevron-down").setTooltip("Move down");
				if (index === columns.length - 1) btn.setDisabled(true);
				else
					btn.onClick(
						() => void this.plugin.moveColumn(col.key, 1).then(() => this.display())
					);
			});
			row.addExtraButton((btn) =>
				btn
					.setIcon("trash-2")
					.setTooltip("Delete")
					.onClick(() => this.confirmDeleteColumn(col))
			);
		});

		// Description-body templates, picked from the create modal's Template pill.
		new Setting(containerEl)
			.setName("Task templates")
			.setDesc(
				"Reusable description text you can drop into a new task from the Template pill."
			)
			.setHeading()
			.addButton((btn) =>
				btn
					.setButtonText("Add template")
					.setCta()
					.onClick(() =>
						new TemplateEditModal(
							this.app,
							null,
							this.plugin.data.templates.map((t) => t.name),
							async (template) => {
								await this.plugin.saveTemplate(template);
								this.display();
							}
						).open()
					)
			);

		const templates = this.plugin.data.templates;
		if (templates.length === 0) {
			containerEl.createDiv({
				cls: "setting-item-description",
				text: "No templates yet — add one to reuse a description across tasks.",
			});
		}
		for (const template of templates) {
			new Setting(containerEl)
				.setName(template.name)
				.setDesc(templatePreview(template.body))
				.addExtraButton((b) =>
					b
						.setIcon("pencil")
						.setTooltip("Edit")
						.onClick(() =>
							new TemplateEditModal(
								this.app,
								template,
								this.plugin.data.templates.map((t) => t.name),
								async (edited) => {
									await this.plugin.saveTemplate(edited, template.name);
									this.display();
								}
							).open()
						)
				)
				.addExtraButton((b) =>
					b
						.setIcon("trash-2")
						.setTooltip("Delete")
						.onClick(async () => {
							await this.plugin.removeTemplate(template.name);
							this.display();
						})
				);
		}

		new Setting(containerEl).setName("Custom labels").setHeading();
		const labels = this.plugin.data.customLabels;
		if (labels.length === 0) {
			containerEl.createDiv({
				cls: "setting-item-description",
				text: "No custom labels yet — create them from a card's label picker.",
			});
			return;
		}
		for (const label of labels) {
			new Setting(containerEl)
				.setName(label.name)
				.addColorPicker((picker) =>
					picker
						.setValue(label.color ?? "#888888")
						.onChange(
							(value) => void this.plugin.updateCustomLabel(label.name, "", value)
						)
				)
				.addExtraButton((btn) =>
					btn
						.setIcon("trash-2")
						.setTooltip("Delete")
						.onClick(async () => {
							await this.plugin.removeCustomLabel(label.name);
							this.display();
						})
				);
		}
	}

	private confirmDeleteColumn(col: StatusDef): void {
		const count = this.countTasksWithStatus(col.key);
		const msg =
			count > 0
				? `${count} task${count === 1 ? "" : "s"} use status “${col.label}”. They will fall back to the default status column on the board. Delete this column?`
				: `Delete column “${col.label}”?`;
		new ConfirmModal(
			this.app,
			msg,
			(ok) => {
				if (!ok) return;
				void this.plugin.removeColumn(col.key).then(() => this.display());
			},
			"Delete"
		).open();
	}

	/** Count notes whose default status property matches the column key. */
	private countTasksWithStatus(key: string): number {
		let n = 0;
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			const raw = fm?.[DEFAULTS.statusProp];
			if (typeof raw === "string" && raw.trim().toLowerCase() === key) n++;
		}
		return n;
	}
}
