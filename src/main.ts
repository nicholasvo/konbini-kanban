import { Plugin, Notice, PluginSettingTab, Setting, App, TFile, normalizePath } from "obsidian";
import {
	KANBAN_VIEW_TYPE,
	StatusDef,
	PriorityDef,
	LabelDef,
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
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const register = (this as any).registerBasesView?.bind(this);
		if (typeof register !== "function") {
			new Notice("Konbini Kanban: this Obsidian version has no Bases view API.");
			return;
		}

		const ok = register(KANBAN_VIEW_TYPE, {
			name: "Kanban",
			icon: "square-kanban",
			factory: (controller: unknown, containerEl: HTMLElement) =>
				new KanbanBasesView(controller, containerEl, this),
			options: viewOptions,
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
		hidden ? set.add(key) : set.delete(key);
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
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				fm[DEFAULTS.statusProp] = statuses;
				fm[DEFAULTS.priorityProp] = priorities;
				fm[DEFAULTS.labelsProp] = labels;
			});
		}
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
