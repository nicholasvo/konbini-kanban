import {
	Plugin,
	Notice,
	PluginSettingTab,
	Setting,
	App,
	Modal,
	TFile,
	TFolder,
	normalizePath,
	setIcon,
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
	DEFAULT_KONBINI_FOLDER,
	LEGACY_SEED_NOTE_PATH,
	LEGACY_SEED_NOTE_BASENAME,
	KONBINI_ROLE_PROP,
	KONBINI_ROLE_VALUES,
	LEGACY_VALUES_NOTE_NAME,
	LEGACY_TEMPLATES_SUBFOLDER,
	STATUS_COLOR_PALETTE,
	buildColumnKey,
	VALUES_NOTE_NAME,
	TEMPLATES_SUBFOLDER,
} from "./constants";
import { viewOptions, mergeStatuses } from "./config";
import { KanbanBasesView, KanbanBoard } from "./view";
import { ConfirmModal, confirmAction } from "./modal-confirm";
import { CreateTaskModal } from "./modal-create";
import { QuickAddLinkModal } from "./modal-quick-add-link";
import { countNotesWithLabel, ensureVaultFolder, rewriteLabelsInVault } from "./data";
import { QuickAddContext } from "./quick-add-context";
import { FolderSuggest } from "./suggest";
import {
	generateTemplateId,
	isKonbiniManagedPath as pathIsKonbiniManaged,
	isUnderKonbiniFolder,
	legacyTemplatesFolderPath,
	legacyValuesNotePath,
	parseTemplateFile,
	serializeTemplate,
	stripFrontmatter,
	templateFieldsChanged,
	templateNotePath,
	templatesFolderPath,
	valuesNotePath,
} from "./templates";

/** Persisted plugin data: columns, priorities/labels, and prefs. */
interface KanbanData {
	/** Global column list (ordered). Authoritative default when a view has no override. */
	columns: StatusDef[];
	/** @deprecated Migrated into `columns` on load; kept for one-release compat. */
	customStatuses: StatusDef[];
	customPriorities: PriorityDef[];
	customLabels: LabelDef[];
	/**
	 * @deprecated Migrated to vault notes under `{konbiniFolder}/Konbini Templates/`.
	 * Kept only so we can migrate on load.
	 */
	templates: Template[];
	/** Vault-relative folder for Konbini Values.md + Konbini Templates/. */
	konbiniFolder: string;
	hiddenStatuses: string[];
	pixelArt: boolean;
	/** True once the default labels have been seeded (so we don't re-seed). */
	initialized: boolean;
	/** True once we've shown the one-time notice about locked `labels` property. */
	labelsPropLockedNotified: boolean;
}

export default class KonbiniKanbanPlugin extends Plugin {
	data: KanbanData = {
		columns: [],
		customStatuses: [],
		customPriorities: [],
		customLabels: [],
		templates: [],
		konbiniFolder: DEFAULT_KONBINI_FOLDER,
		hiddenStatuses: [],
		pixelArt: true,
		initialized: false,
		labelsPropLockedNotified: false,
	};

	/** Live boards, so settings changes can repaint them immediately. */
	boards = new Set<KanbanBoard>();

	/** In-memory templates loaded from `{konbiniFolder}/Konbini Templates/`. */
	private templateCache: Template[] = [];

	async onload(): Promise<void> {
		const loaded = (await this.loadData()) as Partial<KanbanData> | null;
		this.data = {
			columns: loaded?.columns ?? [],
			customStatuses: loaded?.customStatuses ?? [],
			customPriorities: loaded?.customPriorities ?? [],
			customLabels: loaded?.customLabels ?? [],
			templates: loaded?.templates ?? [],
			konbiniFolder: this.normalizeKonbiniFolderPath(
				loaded?.konbiniFolder?.trim() || DEFAULT_KONBINI_FOLDER
			),
			hiddenStatuses: loaded?.hiddenStatuses ?? [],
			pixelArt: loaded?.pixelArt ?? true,
			initialized: loaded?.initialized ?? false,
			labelsPropLockedNotified: loaded?.labelsPropLockedNotified ?? false,
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
				if (!this.findLabelDefCI(def.name)) {
					this.data.customLabels.push({ ...def });
				}
			}
			this.data.initialized = true;
			await this.saveData(this.data);
		}

		// Folder layout, seed note, and template migration once the vault is ready.
		this.app.workspace.onLayoutReady(() => void this.onVaultReady());

		this.addSettingTab(new KonbiniSettingTab(this.app, this));

		this.addCommand({
			id: "insert-quick-add-link",
			name: "Insert quick-add link",
			editorCallback: (editor) => {
				new QuickAddLinkModal(this, (md) => editor.replaceSelection(md)).open();
			},
		});

		this.registerObsidianProtocolHandler("konbini", (params) => {
			this.handleKonbiniUri(params);
		});

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

	/** True if a path is Konbini Values.md or under Konbini Templates/. */
	isKonbiniManagedPath(path: string): boolean {
		return pathIsKonbiniManaged(this.data.konbiniFolder, path);
	}

	listTemplates(): Template[] {
		return this.templateCache;
	}

	getTemplate(name: string): Template | undefined {
		return this.templateCache.find((t) => t.name === name);
	}

	getTemplateById(id: string): Template | undefined {
		return this.templateCache.find((t) => t.id === id);
	}

	/**
	 * Point Konbini at an existing vault folder and move Konbini Values.md +
	 * Konbini Templates/ there from the previous path. Does not create a new
	 * top-level folder.
	 */
	async setKonbiniFolder(folder: string): Promise<void> {
		const next = this.normalizeKonbiniFolderPath(folder);
		if (next === this.data.konbiniFolder) return;

		const target = this.app.vault.getAbstractFileByPath(next);
		if (!(target instanceof TFolder)) {
			new Notice("Konbini Kanban: pick an existing folder in the vault.");
			return;
		}

		const previous = this.data.konbiniFolder;
		// Ensure previous uses prefixed names before we move them.
		await this.migratePrefixedLayoutNames();

		this.data.konbiniFolder = next;
		await this.saveData(this.data);

		// Don't run repairKonbiniFolderPath here — it would see the old Values
		// note still under `previous` and snap the setting back before we move.
		// Don't pre-create Konbini Templates/ either — an empty dest blocks rename.

		const prevValues = this.app.vault.getAbstractFileByPath(valuesNotePath(previous));
		const nextValuesPath = valuesNotePath(next);
		if (
			prevValues instanceof TFile &&
			!(this.app.vault.getAbstractFileByPath(nextValuesPath) instanceof TFile)
		) {
			await this.app.fileManager.renameFile(prevValues, nextValuesPath);
		}

		await this.moveTemplatesFolder(previous, next);
		await this.migratePrefixedLayoutNames();

		await this.migrateLegacySeedNote();
		await this.ensureValuesNote();
		await this.migrateDataTemplatesToNotes();
		await this.updateSeedNote();
		await this.refreshTemplates();
		for (const board of this.boards) board.refresh();
	}

	/**
	 * Rename `{previous}/Konbini Templates` → `{next}/Konbini Templates`
	 * (notes move with the folder). Does not create a new folder. If an empty
	 * leftover blocks the rename, trash it first so back-and-forth moves leave
	 * no empty folders.
	 */
	private async moveTemplatesFolder(previous: string, next: string): Promise<void> {
		const prevPath = templatesFolderPath(previous);
		const nextPath = templatesFolderPath(next);
		const prevTemplates = this.app.vault.getAbstractFileByPath(prevPath);
		if (!(prevTemplates instanceof TFolder)) return;

		const nextTemplates = this.app.vault.getAbstractFileByPath(nextPath);
		if (nextTemplates instanceof TFolder && nextTemplates.children.length === 0) {
			await this.app.fileManager.trashFile(nextTemplates);
		} else if (nextTemplates) {
			// Destination already has files — move only missing children, then
			// drop the empty source so we don't leave a second templates folder.
			if (nextTemplates instanceof TFolder) {
				for (const child of [...prevTemplates.children]) {
					const destPath = normalizePath(`${nextPath}/${child.name}`);
					if (this.app.vault.getAbstractFileByPath(destPath)) continue;
					await this.app.fileManager.renameFile(child, destPath);
				}
				if (prevTemplates.children.length === 0) {
					await this.app.fileManager.trashFile(prevTemplates);
				}
			}
			return;
		}

		await this.app.fileManager.renameFile(prevTemplates, nextPath);
	}

	/**
	 * Normalize a settings path to the Konbini folder itself (vault-relative).
	 * Accepts accidental Values / Templates suffixes (current + pre-prefix) and
	 * trailing slashes.
	 */
	private normalizeKonbiniFolderPath(folder: string): string {
		let next = normalizePath(folder.trim() || DEFAULT_KONBINI_FOLDER);
		const suffixes = [
			VALUES_NOTE_NAME,
			LEGACY_VALUES_NOTE_NAME,
			TEMPLATES_SUBFOLDER,
			LEGACY_TEMPLATES_SUBFOLDER,
		];
		for (const suffix of suffixes) {
			if (next.endsWith(`/${suffix}`)) {
				next = next.slice(0, -`/${suffix}`.length);
				break;
			}
			if (next === suffix) {
				next = DEFAULT_KONBINI_FOLDER;
				break;
			}
		}
		next = normalizePath(next.replace(/\/+$/, ""));
		return next || DEFAULT_KONBINI_FOLDER;
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

	async addCustomLabel(def: LabelDef): Promise<boolean> {
		const name = def.name.trim();
		if (name.length === 0) return false;
		const clash = this.findLabelDefCI(name);
		if (clash) {
			new Notice(`A label named “${clash.name}” already exists`);
			return false;
		}
		this.data.customLabels.push({
			name,
			color: def.color,
			emoji: def.emoji,
		});
		await this.persist();
		return true;
	}

	/** Case-insensitive lookup of a custom label definition. */
	findLabelDefCI(name: string): LabelDef | undefined {
		const needle = name.trim().toLowerCase();
		if (!needle) return undefined;
		return this.data.customLabels.find((l) => l.name.toLowerCase() === needle);
	}

	/** @deprecated Prefer removeColumn. */
	async removeCustomStatus(key: string): Promise<void> {
		await this.removeColumn(key);
	}

	async removeCustomPriority(key: string): Promise<void> {
		this.data.customPriorities = this.data.customPriorities.filter((p) => p.key !== key);
		await this.persist();
	}

	/**
	 * Remove a label def and strip it from all notes / templates (case-insensitive).
	 * Caller should confirm first.
	 */
	async removeCustomLabel(name: string): Promise<void> {
		const def = this.findLabelDefCI(name);
		const canonical = def?.name ?? name.trim();
		if (!canonical) return;

		const result = await rewriteLabelsInVault(this.app, canonical, null, (path) =>
			this.shouldSkipLabelSweep(path)
		);
		this.data.customLabels = this.data.customLabels.filter(
			(l) => l.name.toLowerCase() !== canonical.toLowerCase()
		);
		await this.persist();
		await this.refreshTemplates();
		for (const board of this.boards) board.refresh();
		if (result.filesFailed > 0) {
			new Notice(
				`Konbini Kanban: removed label “${canonical}” from ${result.filesTouched} note(s); ${result.filesFailed} failed.`
			);
		}
	}

	/**
	 * Rename a label def and rewrite it on all notes / templates.
	 * Caller should confirm first. Returns false if the new name clashes.
	 */
	async renameCustomLabel(oldName: string, newName: string): Promise<boolean> {
		const def = this.findLabelDefCI(oldName);
		if (!def) return false;
		const next = newName.trim();
		if (next.length === 0) {
			new Notice("Label needs a name");
			return false;
		}
		const clash = this.findLabelDefCI(next);
		if (clash && clash.name !== def.name) {
			new Notice(`A label named “${clash.name}” already exists`);
			return false;
		}
		if (def.name === next) return true;

		const result = await rewriteLabelsInVault(this.app, def.name, next, (path) =>
			this.shouldSkipLabelSweep(path)
		);
		def.name = next;
		await this.persist();
		await this.refreshTemplates();
		for (const board of this.boards) board.refresh();
		if (result.filesFailed > 0) {
			new Notice(
				`Konbini Kanban: renamed label on ${result.filesTouched} note(s); ${result.filesFailed} failed.`
			);
		}
		return true;
	}

	/** Skip Konbini-managed files except Konbini Templates/ (Values note etc.). */
	shouldSkipLabelSweep(path: string): boolean {
		if (!isUnderKonbiniFolder(this.data.konbiniFolder, path)) return false;
		return !isUnderKonbiniFolder(templatesFolderPath(this.data.konbiniFolder), path);
	}

	/** Count notes that reference a label (for confirm copy). */
	countNotesWithLabel(name: string): number {
		return countNotesWithLabel(this.app, name, (path) => this.shouldSkipLabelSweep(path));
	}

	/**
	 * Add or overwrite a template note under `{konbiniFolder}/Konbini Templates/`.
	 * Templates only feed the create modal, so they skip the seed-note rewrite.
	 */
	async saveTemplate(template: Template, originalName?: string): Promise<void> {
		await this.ensureFolder(templatesFolderPath(this.data.konbiniFolder));
		const withId: Template = {
			...template,
			id: template.id || generateTemplateId(),
		};
		const oldName = originalName ?? withId.name;
		const oldPath = templateNotePath(this.data.konbiniFolder, oldName);
		const newPath = templateNotePath(this.data.konbiniFolder, withId.name);
		const content = serializeTemplate(withId);

		let file = this.app.vault.getAbstractFileByPath(oldPath);
		if (file instanceof TFile) {
			if (oldName !== withId.name) {
				const clash = this.app.vault.getAbstractFileByPath(newPath);
				if (clash) {
					new Notice("A template with that name already exists");
					return;
				}
				await this.app.fileManager.renameFile(file, newPath);
				file = this.app.vault.getAbstractFileByPath(newPath);
			}
			if (file instanceof TFile) {
				await this.app.vault.process(file, () => content);
			}
		} else {
			const clash = this.app.vault.getAbstractFileByPath(newPath);
			if (clash) {
				new Notice("A template with that name already exists");
				return;
			}
			await this.app.vault.create(newPath, content);
		}
		await this.refreshTemplates();
	}

	async removeTemplate(name: string): Promise<void> {
		const path = templateNotePath(this.data.konbiniFolder, name);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await this.app.fileManager.trashFile(file);
		await this.refreshTemplates();
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

	private async onVaultReady(): Promise<void> {
		await this.ensureKonbiniLayout();
		await this.updateSeedNote();
		await this.refreshTemplates();
		await this.maybeNotifyLabelsPropLocked();
	}

	/** One-time notice if any .base still remaps labelsProp away from `labels`. */
	private async maybeNotifyLabelsPropLocked(): Promise<void> {
		if (this.data.labelsPropLockedNotified) return;
		const remapped = await this.vaultHasRemappedLabelsProp();
		this.data.labelsPropLockedNotified = true;
		await this.saveData(this.data);
		if (!remapped) return;
		new Notice(
			"Konbini Kanban now always uses the frontmatter property “labels”. A board in this vault had Labels property remapped — move those values into “labels” if cards look unlabeled.",
			12000
		);
	}

	private async vaultHasRemappedLabelsProp(): Promise<boolean> {
		for (const file of this.app.vault.getFiles()) {
			if (file.extension !== "base") continue;
			const text = await this.app.vault.cachedRead(file);
			const re = /labelsProp:\s*["']?([^\s"'\n]+)/g;
			let m: RegExpExecArray | null;
			while ((m = re.exec(text)) !== null) {
				const v = m[1].replace(/^["']|["']$/g, "").trim();
				if (v.length > 0 && v !== DEFAULTS.labelsProp) return true;
			}
		}
		return false;
	}

	/** Create/migrate Konbini folder, Values seed, and Templates; repair moved folders. */
	private async ensureKonbiniLayout(): Promise<void> {
		await this.repairKonbiniFolderPath();
		await this.ensureFolder(this.data.konbiniFolder);
		await this.migratePrefixedLayoutNames();
		await this.ensureFolder(templatesFolderPath(this.data.konbiniFolder));
		await this.migrateLegacySeedNote();
		await this.ensureValuesNote();
		await this.migrateDataTemplatesToNotes();
	}

	/**
	 * Rename pre-prefix layout (`Values.md`, `Templates/`) to
	 * `Konbini Values.md` / `Konbini Templates/` so they don't clash with
	 * common vault names when the Konbini folder moves.
	 */
	private async migratePrefixedLayoutNames(): Promise<void> {
		const folder = this.data.konbiniFolder;
		const oldValues = this.app.vault.getAbstractFileByPath(legacyValuesNotePath(folder));
		const newValuesPath = valuesNotePath(folder);
		const newValues = this.app.vault.getAbstractFileByPath(newValuesPath);
		if (oldValues instanceof TFile) {
			if (!(newValues instanceof TFile)) {
				await this.app.fileManager.renameFile(oldValues, newValuesPath);
			} else {
				// Prefixed note already exists (e.g. created while Values.md was
				// still present) — drop the short-name leftover.
				await this.app.fileManager.trashFile(oldValues);
			}
		}

		const oldTemplates = this.app.vault.getAbstractFileByPath(
			legacyTemplatesFolderPath(folder)
		);
		const newTemplatesPath = templatesFolderPath(folder);
		const newTemplates = this.app.vault.getAbstractFileByPath(newTemplatesPath);
		if (!(oldTemplates instanceof TFolder)) return;

		if (!newTemplates) {
			await this.app.fileManager.renameFile(oldTemplates, newTemplatesPath);
			return;
		}

		if (!(newTemplates instanceof TFolder)) return;

		for (const child of [...oldTemplates.children]) {
			const destPath = normalizePath(`${newTemplatesPath}/${child.name}`);
			if (this.app.vault.getAbstractFileByPath(destPath)) continue;
			await this.app.fileManager.renameFile(child, destPath);
		}
		if (oldTemplates.children.length === 0) {
			await this.app.fileManager.trashFile(oldTemplates);
		}
	}

	/**
	 * If the Values note is missing at the configured path but a marked
	 * `konbini-role: values` note exists elsewhere (folder renamed/moved in the
	 * file explorer, or Values+Templates dragged out), adopt its parent as
	 * konbiniFolder so we don't recreate duplicates at the old path.
	 */
	private async repairKonbiniFolderPath(): Promise<void> {
		const valuesPath = valuesNotePath(this.data.konbiniFolder);
		if (this.app.vault.getAbstractFileByPath(valuesPath) instanceof TFile) return;

		const found = this.findValuesNote();
		if (!found?.parent) return;

		const repaired = found.parent.path === "/" ? "" : found.parent.path;
		const next = normalizePath(repaired || DEFAULT_KONBINI_FOLDER);
		if (next !== this.data.konbiniFolder) {
			this.data.konbiniFolder = next;
			await this.saveData(this.data);
		}
	}

	private findValuesNote(): TFile | null {
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (fm?.[KONBINI_ROLE_PROP] === KONBINI_ROLE_VALUES) return file;
		}
		return null;
	}

	/**
	 * Move the pre-folder seed note (`Konbini Kanban values.md`, at vault root or
	 * relocated by the user) into `{konbiniFolder}/Konbini Values.md`. If both
	 * exist, merge any user-added body or extra frontmatter into the Values note,
	 * then trash the leftover.
	 */
	private async migrateLegacySeedNote(): Promise<void> {
		const legacy = this.findLegacySeedNote();
		if (!legacy) return;

		const destPath = valuesNotePath(this.data.konbiniFolder);
		// Already the live Values note (e.g. user renamed it in place).
		if (legacy.path === destPath) return;

		await this.ensureFolder(this.data.konbiniFolder);
		const dest = this.app.vault.getAbstractFileByPath(destPath);

		if (!(dest instanceof TFile)) {
			await this.app.fileManager.renameFile(legacy, destPath);
			return;
		}

		const customized = await this.mergeLegacySeedIntoValues(legacy, dest);
		await this.app.fileManager.trashFile(legacy);
		if (customized) {
			new Notice(
				"Konbini Kanban: merged your old seed note into the Konbini folder (original is in the trash)."
			);
		}
	}

	/** Find the legacy seed by exact root path, else by basename anywhere in the vault. */
	private findLegacySeedNote(): TFile | null {
		const atRoot = this.app.vault.getAbstractFileByPath(normalizePath(LEGACY_SEED_NOTE_PATH));
		if (atRoot instanceof TFile) return atRoot;

		const destPath = valuesNotePath(this.data.konbiniFolder);
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (file.basename === LEGACY_SEED_NOTE_BASENAME && file.path !== destPath) {
				return file;
			}
		}
		return null;
	}

	/**
	 * Copy user-authored content from the legacy root seed into Konbini Values.md.
	 * Returns true if anything beyond the stock plugin body / managed props was merged.
	 */
	private async mergeLegacySeedIntoValues(legacy: TFile, dest: TFile): Promise<boolean> {
		const legacyContent = await this.app.vault.read(legacy);
		const destContent = await this.app.vault.read(dest);
		const legacyBody = stripFrontmatter(legacyContent).trim();

		const stockBodies = new Set([
			"Maintained by Konbini Kanban to seed property suggestions. Safe to keep or move.",
			"Maintained by Konbini Kanban to seed property suggestions.",
			"",
		]);

		const legacyCustomBody = legacyBody.length > 0 && !stockBodies.has(legacyBody);
		let customized = false;

		if (legacyCustomBody && !destContent.includes(legacyBody)) {
			customized = true;
			await this.app.vault.process(dest, (data) => {
				const fmMatch = data.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
				const fmBlock = fmMatch ? fmMatch[0] : "";
				const currentBody = stripFrontmatter(data).trimEnd();
				const nextBody =
					!currentBody || stockBodies.has(currentBody.trim())
						? legacyBody
						: `${currentBody}\n\n${legacyBody}`;
				return `${fmBlock}${nextBody}\n`;
			});
		}

		const legacyFm = this.app.metadataCache.getFileCache(legacy)?.frontmatter ?? {};
		const managedKeys = new Set<string>([
			DEFAULTS.statusProp,
			DEFAULTS.priorityProp,
			DEFAULTS.labelsProp,
			KONBINI_ROLE_PROP,
			"position",
		]);
		const extraEntries = Object.entries(legacyFm).filter(([key]) => !managedKeys.has(key));
		if (extraEntries.length > 0) {
			let wroteExtra = false;
			await this.app.fileManager.processFrontMatter(dest, (fm: Record<string, unknown>) => {
				for (const [key, value] of extraEntries) {
					if (fm[key] === undefined) {
						fm[key] = value;
						wroteExtra = true;
					}
				}
			});
			if (wroteExtra) customized = true;
		}

		return customized;
	}

	private async ensureValuesNote(): Promise<void> {
		const path = valuesNotePath(this.data.konbiniFolder);
		if (this.app.vault.getAbstractFileByPath(path) instanceof TFile) return;
		// Prefer adopting an existing marked note over creating a duplicate.
		if (this.findValuesNote()) return;
		await this.app.vault.create(
			path,
			"Maintained by Konbini Kanban to seed property suggestions.\n"
		);
	}

	private async migrateDataTemplatesToNotes(): Promise<void> {
		if (!this.data.templates.length) return;
		await this.ensureFolder(templatesFolderPath(this.data.konbiniFolder));
		for (const tpl of this.data.templates) {
			const path = templateNotePath(this.data.konbiniFolder, tpl.name);
			if (this.app.vault.getAbstractFileByPath(path)) continue;
			await this.app.vault.create(path, serializeTemplate(tpl));
		}
		this.data.templates = [];
		await this.saveData(this.data);
	}

	async refreshTemplates(): Promise<void> {
		const folderPath = templatesFolderPath(this.data.konbiniFolder);
		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		const out: Template[] = [];
		if (folder instanceof TFolder) {
			for (const child of folder.children) {
				if (!(child instanceof TFile) || child.extension !== "md") continue;
				const content = await this.app.vault.read(child);
				let tpl = parseTemplateFile(child, content);
				if (!tpl.id) {
					const id = generateTemplateId();
					tpl = { ...tpl, id };
					await this.app.vault.process(child, () => serializeTemplate(tpl));
				}
				out.push(tpl);
			}
		}
		out.sort((a, b) => a.name.localeCompare(b.name));
		this.templateCache = out;
	}

	private async ensureFolder(path: string): Promise<void> {
		await ensureVaultFolder(this.app, path);
	}

	/**
	 * Normalize URI folder param. Older quick-add links used URLSearchParams,
	 * which encodes spaces as "+" — if that path doesn't exist but the
	 * space-separated path does, prefer the real folder.
	 */
	private resolveUriFolder(raw: string): string {
		const folder = normalizePath(raw);
		if (!folder || folder === ".") return folder;
		if (this.app.vault.getAbstractFileByPath(folder) instanceof TFolder) {
			return folder;
		}
		if (folder.includes("+")) {
			const spaced = normalizePath(folder.replace(/\+/g, " "));
			if (this.app.vault.getAbstractFileByPath(spaced) instanceof TFolder) {
				return spaced;
			}
		}
		return folder;
	}

	private handleKonbiniUri(params: Record<string, string>): void {
		const folder = this.resolveUriFolder((params.folder ?? "").trim());
		if (!folder || folder === ".") {
			new Notice("Konbini Kanban: URI requires a folder parameter.");
			return;
		}
		// Always boardless: destination is the link's folder; config from plugin
		// Settings. Avoids depending on which Kanban leaf is open in a split.
		const ctx = new QuickAddContext(this);
		const modal = new CreateTaskModal(ctx, {
			status: ctx.cfg.defaultStatus,
			parent: null,
			folder,
		});
		const templateName = (params.template ?? "").trim();
		if (templateName) modal.applyTemplateByName(templateName);
		const statusOverride = (params.status ?? "").trim();
		if (statusOverride) modal.setStatusPrefill(statusOverride);
		const priority = (params.priority ?? "").trim();
		if (priority) modal.setPriorityPrefill(priority);
		modal.open();
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

		const path = valuesNotePath(this.data.konbiniFolder);
		let file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			// Don't create a second seed note if the marked one was moved.
			file = this.findValuesNote();
		}
		if (!(file instanceof TFile)) {
			await this.ensureFolder(this.data.konbiniFolder);
			file = await this.app.vault.create(
				path,
				"Maintained by Konbini Kanban to seed property suggestions.\n"
			);
		}
		if (file instanceof TFile) {
			await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				fm[KONBINI_ROLE_PROP] = KONBINI_ROLE_VALUES;
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

/** Modal for creating or renaming a custom label (name only; color auto-assigned on create). */
class LabelEditModal extends Modal {
	private plugin: KonbiniKanbanPlugin;
	private original: LabelDef | null;
	private onSubmit: (name: string) => void | Promise<void>;
	private name: string;

	constructor(
		app: App,
		plugin: KonbiniKanbanPlugin,
		original: LabelDef | null,
		onSubmit: (name: string) => void | Promise<void>
	) {
		super(app);
		this.plugin = plugin;
		this.original = original;
		this.onSubmit = onSubmit;
		this.name = original?.name ?? "";
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText(this.original ? "Rename label" : "New label");

		new Setting(contentEl).setName("Name").addText((text) => {
			text.setPlaceholder("important").setValue(this.name);
			text.onChange((v) => (this.name = v));
			window.setTimeout(() => text.inputEl.focus(), 20);
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
			new Notice("Label needs a name");
			return;
		}
		const clash = this.plugin.findLabelDefCI(name);
		if (clash && clash.name !== this.original?.name) {
			new Notice(`A label named “${clash.name}” already exists`);
			return;
		}
		await this.onSubmit(name);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
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
			.setDesc("Copied into the new task's body when this template is applied.")
			.setClass("bk-template-body-setting")
			.addTextArea((area) => {
				area.setPlaceholder("## Steps to reproduce\n\n## Expected\n\n## Actual").setValue(
					this.body
				);
				area.onChange((v) => (this.body = v));
				area.inputEl.rows = 8;
			});

		new Setting(contentEl)
			.setName("Prefill values")
			.setDesc(
				"Copied into a new task when this template is applied. Saving changes only affects notes created after you save."
			)
			.setHeading();

		const allStatuses = this.plugin.data.columns;
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

		new Setting(contentEl)
			.setName("Labels")
			.setDesc("Pre-select labels when this template is applied.")
			.setClass("bk-template-labels-setting");

		const labelPicker = contentEl.createDiv("bk-template-label-picker");
		this.renderLabelPicker(labelPicker);

		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText(this.original ? "Save" : "Create")
				.setCta()
				.onClick(() => void this.submit())
		);
	}

	private renderLabelPicker(host: HTMLElement): void {
		host.empty();
		const selected = new Set(this.tplLabels);
		const known = Array.from(
			new Set([...this.plugin.data.customLabels.map((l) => l.name), ...this.tplLabels])
		).sort((a, b) => a.localeCompare(b));

		if (known.length === 0) {
			host.createDiv({
				cls: "bk-template-label-empty",
				text: "No labels yet — create them from a card's label picker.",
			});
			return;
		}

		for (const label of known) {
			const def = this.plugin.data.customLabels.find((l) => l.name === label);
			const row = host.createDiv("bk-template-label-row");
			const box = row.createSpan("bk-check");
			if (selected.has(label)) {
				box.addClass("is-checked");
				setIcon(box, "check");
			}
			const dot = row.createSpan("bk-label-dot");
			if (def?.color) dot.style.background = def.color;
			row.createSpan({ cls: "bk-template-label-name", text: label });
			row.onclick = () => {
				if (selected.has(label)) {
					this.tplLabels = this.tplLabels.filter((l) => l !== label);
				} else {
					this.tplLabels = [...this.tplLabels, label];
				}
				this.renderLabelPicker(host);
			};
		}
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
		const next: Template = {
			name,
			body: this.body,
			id: this.original?.id || generateTemplateId(),
			status: this.tplStatus || undefined,
			priority: this.tplPriority || undefined,
			labels: this.tplLabels.length > 0 ? [...this.tplLabels] : undefined,
		};
		if (this.original && templateFieldsChanged(this.original, next)) {
			const ok = await confirmAction(
				this.app,
				"These template changes only affect new notes created from this template. Existing notes are not updated.",
				"Save"
			);
			if (!ok) return;
		}
		await this.onSubmit(next);
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

	private async onKonbiniFolderPicked(
		folder: TFolder,
		text: { setValue: (v: string) => void }
	): Promise<void> {
		const current = this.plugin.data.konbiniFolder;
		const next = normalizePath(folder.path);
		if (next === normalizePath(current)) {
			text.setValue(current);
			return;
		}

		const ok = await confirmAction(
			this.app,
			`Move Konbini data (Konbini Values.md and Konbini Templates/) into “${next}”? The folder path setting will update to that location.`,
			"Move"
		);
		if (!ok) {
			text.setValue(current);
			return;
		}

		await this.plugin.setKonbiniFolder(next);
		this.display();
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

		new Setting(containerEl)
			.setName("Konbini folder path")
			.setDesc(
				"Search and pick an existing vault folder. Konbini moves Konbini Values.md and Konbini Templates/ into that folder. Other notes there (including tasks) stay on the board."
			)
			.addText((text) => {
				text.setPlaceholder("Search folders…").setValue(this.plugin.data.konbiniFolder);
				const current = this.plugin.data.konbiniFolder;
				new FolderSuggest(
					this.app,
					text.inputEl,
					(folder) => void this.onKonbiniFolderPicked(folder, text),
					current
				);
				// Typing alone does not change the path — only a suggestion pick does.
				text.inputEl.addEventListener("blur", () => {
					text.setValue(this.plugin.data.konbiniFolder);
				});
			});

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
				`Reusable notes in ${this.plugin.data.konbiniFolder}/Konbini Templates — applied from the Template pill when creating a task.`
			)
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
							this.plugin.listTemplates().map((t) => t.name),
							async (template) => {
								await this.plugin.saveTemplate(template);
								this.display();
							}
						).open()
					)
			);

		const templates = this.plugin.listTemplates();
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
								this.plugin.listTemplates().map((t) => t.name),
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

		new Setting(containerEl)
			.setName("Custom labels")
			.setDesc("Labels you can apply to tasks. Rename or delete updates notes that use them.")
			.setHeading()
			.addButton((btn) =>
				btn
					.setButtonText("Add label")
					.setCta()
					.onClick(() =>
						new LabelEditModal(this.app, this.plugin, null, async (name) => {
							const ok = await this.plugin.addCustomLabel({
								name,
								color: STATUS_COLOR_PALETTE[
									this.plugin.data.customLabels.length %
										STATUS_COLOR_PALETTE.length
								],
							});
							if (ok) this.display();
						}).open()
					)
			);

		const labels = this.plugin.data.customLabels;
		if (labels.length === 0) {
			containerEl.createDiv({
				cls: "setting-item-description",
				text: "No custom labels yet — add one here or from a card's label picker.",
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
						.setIcon("pencil")
						.setTooltip("Rename")
						.onClick(() =>
							new LabelEditModal(this.app, this.plugin, label, async (name) => {
								await this.confirmRenameLabel(label, name);
							}).open()
						)
				)
				.addExtraButton((btn) =>
					btn
						.setIcon("trash-2")
						.setTooltip("Delete")
						.onClick(() => void this.confirmDeleteLabel(label))
				);
		}
	}

	private async confirmRenameLabel(label: LabelDef, newName: string): Promise<void> {
		if (newName === label.name) {
			this.display();
			return;
		}
		const n = this.plugin.countNotesWithLabel(label.name);
		const ok = await confirmAction(
			this.app,
			n > 0
				? `Rename label “${label.name}” to “${newName}” on ${n} note${n === 1 ? "" : "s"}?`
				: `Rename label “${label.name}” to “${newName}”?`,
			"Rename"
		);
		if (!ok) return;
		const renamed = await this.plugin.renameCustomLabel(label.name, newName);
		if (renamed) this.display();
	}

	private async confirmDeleteLabel(label: LabelDef): Promise<void> {
		const n = this.plugin.countNotesWithLabel(label.name);
		const ok = await confirmAction(
			this.app,
			n > 0
				? `Remove label “${label.name}” from Settings and from ${n} note${n === 1 ? "" : "s"}?`
				: `Delete label “${label.name}”?`,
			"Delete"
		);
		if (!ok) return;
		await this.plugin.removeCustomLabel(label.name);
		this.display();
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
			if (this.plugin.isKonbiniManagedPath(file.path)) continue;
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			const raw: unknown = fm?.[DEFAULTS.statusProp];
			if (typeof raw === "string" && raw.trim().toLowerCase() === key) n++;
		}
		return n;
	}
}
