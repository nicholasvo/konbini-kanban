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
} from "./constants";
import { viewOptions } from "./config";
import { KanbanBasesView, KanbanBoard } from "./view";

/** Persisted plugin data: user-created statuses/priorities/labels and prefs. */
interface KanbanData {
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
			customStatuses: loaded?.customStatuses ?? [],
			customPriorities: loaded?.customPriorities ?? [],
			customLabels: loaded?.customLabels ?? [],
			templates: loaded?.templates ?? [],
			hiddenStatuses: loaded?.hiddenStatuses ?? [],
			pixelArt: loaded?.pixelArt ?? true,
			initialized: loaded?.initialized ?? false,
		};

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
			factory: (controller, containerEl) => new KanbanBasesView(controller, containerEl, this),
			// viewOptions widens each entry's `type` to `string`; the values are
			// valid text options, so re-assert the registration's option type.
			options: viewOptions as unknown as BasesViewRegistration["options"],
		});

		if (ok === false) {
			new Notice("Konbini Kanban: enable the core Bases plugin to use the Kanban view.");
		}
	}

	async addCustomStatus(def: StatusDef): Promise<void> {
		if (this.data.customStatuses.some((s) => s.key === def.key)) return;
		this.data.customStatuses.push(def);
		await this.persist();
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

	async removeCustomStatus(key: string): Promise<void> {
		this.data.customStatuses = this.data.customStatuses.filter((s) => s.key !== key);
		await this.persist();
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
		const def = this.data.customStatuses.find((s) => s.key === key);
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

	/** Show or hide a status column across all open boards. */
	async setStatusHidden(key: string, hidden: boolean): Promise<void> {
		const set = new Set(this.data.hiddenStatuses);
		if (hidden) set.add(key);
		else set.delete(key);
		this.data.hiddenStatuses = Array.from(set);
		await this.saveData(this.data);
		for (const board of this.boards) board.refresh();
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
		const statuses = [
			...DEFAULT_STATUSES.map((s) => s.key),
			...this.data.customStatuses.map((s) => s.key),
		];
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

/** Modal for creating or editing a description-body template. */
class TemplateEditModal extends Modal {
	private plugin: KonbiniKanbanPlugin;
	private original: Template | null;
	private existingNames: string[];
	private onSubmit: (template: Template) => void | Promise<void>;
	private name: string;
	private body: string;
	private tplStatus: string;
	private tplPriority: string;
	private tplLabels: string[];

	constructor(
		app: App,
		plugin: KonbiniKanbanPlugin,
		original: Template | null,
		existingNames: string[],
		onSubmit: (template: Template) => void | Promise<void>
	) {
		super(app);
		this.plugin = plugin;
		this.original = original;
		this.existingNames = existingNames;
		this.onSubmit = onSubmit;
		this.name = original?.name ?? "";
		this.body = original?.body ?? "";
		this.tplStatus = original?.status ?? "";
		this.tplPriority = original?.priority ?? "";
		this.tplLabels = original?.labels ? [...original.labels] : [];
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
				area.setPlaceholder("## Steps to reproduce\n\n## Expected\n\n## Actual").setValue(this.body);
				area.onChange((v) => (this.body = v));
				area.inputEl.rows = 8;
			});

		new Setting(contentEl).setName("Prefill values").setHeading();

		const allStatuses = [...DEFAULT_STATUSES, ...this.plugin.data.customStatuses];
		new Setting(contentEl)
			.setName("Status")
			.setDesc("Pre-select a status when this template is applied.")
			.addDropdown((dd) => {
				dd.addOption("", "— none —");
				for (const s of allStatuses) dd.addOption(s.key, s.label);
				dd.setValue(this.tplStatus);
				dd.onChange((v) => (this.tplStatus = v));
			});

		const allPriorities = [
			...DEFAULT_PRIORITIES.filter((p) => p.key !== "no priority"),
			...this.plugin.data.customPriorities,
		];
		new Setting(contentEl)
			.setName("Priority")
			.setDesc("Pre-select a priority when this template is applied.")
			.addDropdown((dd) => {
				dd.addOption("", "— none —");
				for (const p of allPriorities) dd.addOption(p.key, p.label);
				dd.setValue(this.tplPriority);
				dd.onChange((v) => (this.tplPriority = v));
			});

		const knownLabels = this.plugin.data.customLabels.map((l) => l.name).join(", ");
		new Setting(contentEl)
			.setName("Labels")
			.setDesc(
				knownLabels
					? `Comma-separated. Available: ${knownLabels}`
					: "Comma-separated label names."
			)
			.addText((text) => {
				text.setPlaceholder("bug, backend")
					.setValue(this.tplLabels.join(", "));
				text.onChange((v) => {
					this.tplLabels = v
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean);
				});
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
		await this.onSubmit({
			name,
			body: this.body,
			status: this.tplStatus || undefined,
			priority: this.tplPriority || undefined,
			labels: this.tplLabels.length > 0 ? [...this.tplLabels] : undefined,
		});
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
				toggle.setValue(this.plugin.data.pixelArt).onChange((value) => void this.plugin.setPixelArt(value))
			);

		// Description-body templates, picked from the create modal's Template pill.
		new Setting(containerEl)
			.setName("Task templates")
			.setDesc("Reusable description text you can drop into a new task from the Template pill.")
			.setHeading()
			.addButton((btn) =>
				btn
					.setButtonText("Add template")
					.setCta()
					.onClick(() =>
					new TemplateEditModal(
						this.app,
						this.plugin,
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
							this.plugin,
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

		// Only labels are user-definable; statuses and priorities are fixed.
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
						.onChange((value) => void this.plugin.updateCustomLabel(label.name, "", value))
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
}
