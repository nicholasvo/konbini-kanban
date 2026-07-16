import { App, TFile, normalizePath, parseLinktext } from "obsidian";
import { KanbanConfig } from "./config";
import { DEFAULTS } from "./constants";

/** Normalized in-memory view of one task note. */
export interface Task {
	file: TFile;
	title: string;
	status: string;
	priority: string;
	labels: string[];
	parentPath: string | null;
	startDate: string | null;
	endDate: string | null;
}

function frontmatter(app: App, file: TFile): Record<string, unknown> {
	return app.metadataCache.getFileCache(file)?.frontmatter ?? {};
}

function asStringArray(v: unknown): string[] {
	if (Array.isArray(v)) return v.map((x) => String(x)).filter((s) => s.length > 0);
	if (typeof v === "string" && v.trim().length > 0) {
		// Allow comma-separated single-line lists.
		return v
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
	}
	return [];
}

/** Resolve a wikilink/path stored in a `parent` property to a vault path. */
function resolveParent(app: App, raw: unknown, sourcePath: string): string | null {
	if (typeof raw !== "string" || raw.trim().length === 0) return null;
	let text = raw.trim();
	const m = text.match(/^\[\[(.*?)\]\]$/);
	if (m) text = m[1];
	const { path } = parseLinktext(text);
	const dest = app.metadataCache.getFirstLinkpathDest(path, sourcePath);
	return dest ? dest.path : null;
}

export function readTask(app: App, file: TFile, cfg: KanbanConfig): Task {
	const fm = frontmatter(app, file);
	const rawTitle = fm[cfg.titleProp];
	const title =
		typeof rawTitle === "string" && rawTitle.trim().length > 0
			? rawTitle.trim()
			: file.basename;
	const status =
		typeof fm[cfg.statusProp] === "string"
			? String(fm[cfg.statusProp]).trim().toLowerCase()
			: "";
	const priority =
		typeof fm[cfg.priorityProp] === "string"
			? String(fm[cfg.priorityProp]).trim().toLowerCase()
			: "no priority";
	return {
		file,
		title,
		status,
		priority,
		labels: asStringArray(fm[cfg.labelsProp]),
		parentPath: resolveParent(app, fm[cfg.parentProp], file.path),
		startDate: asDate(fm[cfg.startDateProp]),
		endDate: asDate(fm[cfg.endDateProp]),
	};
}

/** Normalize a frontmatter date value to an ISO `yyyy-mm-dd` string, or null. */
function asDate(v: unknown): string | null {
	if (typeof v !== "string" && typeof v !== "number") return null;
	const s = String(v).trim();
	if (s.length === 0) return null;
	const m = s.match(/^\d{4}-\d{2}-\d{2}/);
	return m ? m[0] : s;
}

export async function setStatus(
	app: App,
	file: TFile,
	cfg: KanbanConfig,
	status: string
): Promise<void> {
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		fm[cfg.statusProp] = status;
	});
}

export async function setPriority(
	app: App,
	file: TFile,
	cfg: KanbanConfig,
	priority: string
): Promise<void> {
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		if (priority === "no priority") delete fm[cfg.priorityProp];
		else fm[cfg.priorityProp] = priority;
	});
}

export async function setLabels(
	app: App,
	file: TFile,
	cfg: KanbanConfig,
	labels: string[]
): Promise<void> {
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		if (labels.length === 0) delete fm[cfg.labelsProp];
		else fm[cfg.labelsProp] = labels;
	});
}

export async function setTitle(
	app: App,
	file: TFile,
	cfg: KanbanConfig,
	title: string
): Promise<void> {
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		fm[cfg.titleProp] = title;
	});
}

export async function setDate(
	app: App,
	file: TFile,
	cfg: KanbanConfig,
	which: "start" | "end",
	value: string | null
): Promise<void> {
	const prop = which === "start" ? cfg.startDateProp : cfg.endDateProp;
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		if (value) fm[prop] = value;
		else delete fm[prop];
	});
}

/**
 * Read a note's body — everything after the frontmatter block — with leading
 * blank lines trimmed. This is what the editor surfaces as the "description".
 */
export async function readBody(app: App, file: TFile): Promise<string> {
	const content = await app.vault.cachedRead(file);
	const end = app.metadataCache.getFileCache(file)?.frontmatterPosition?.end?.offset;
	const body = end != null ? content.slice(end) : content;
	return body.replace(/^\s+/, "");
}

/**
 * Replace a note's body while leaving its frontmatter untouched. Uses an atomic
 * read-modify-write so a concurrent frontmatter edit can't clobber it.
 */
export async function setBody(app: App, file: TFile, body: string): Promise<void> {
	await app.vault.process(file, (content) => {
		const end = app.metadataCache.getFileCache(file)?.frontmatterPosition?.end?.offset;
		const fmPart = end != null ? content.slice(0, end) : "";
		const trimmed = body.trim();
		return `${fmPart}${trimmed.length > 0 ? `\n\n${trimmed}\n` : "\n"}`;
	});
}

/** Collect the distinct label values across a set of tasks, for the picker. */
export function collectLabels(tasks: Task[]): string[] {
	const set = new Set<string>();
	for (const i of tasks) for (const l of i.labels) set.add(l);
	return Array.from(set).sort((a, b) => a.localeCompare(b));
}

export interface RewriteLabelsResult {
	filesTouched: number;
	filesFailed: number;
}

/** Count markdown notes whose `labels` frontmatter includes `label` (case-insensitive). */
export function countNotesWithLabel(
	app: App,
	label: string,
	shouldSkip?: (path: string) => boolean
): number {
	const needle = label.toLowerCase();
	let n = 0;
	for (const file of app.vault.getMarkdownFiles()) {
		if (shouldSkip?.(file.path)) continue;
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm || !(DEFAULTS.labelsProp in fm)) continue;
		if (asStringArray(fm[DEFAULTS.labelsProp]).some((l) => l.toLowerCase() === needle)) n++;
	}
	return n;
}

/**
 * Rename (`to` string) or remove (`to` null) a label across vault notes.
 * Matches case-insensitively; writes canonical `to` (or drops) and dedupes.
 */
export async function rewriteLabelsInVault(
	app: App,
	from: string,
	to: string | null,
	shouldSkip?: (path: string) => boolean
): Promise<RewriteLabelsResult> {
	const fromLower = from.toLowerCase();
	let filesTouched = 0;
	let filesFailed = 0;

	for (const file of app.vault.getMarkdownFiles()) {
		if (shouldSkip?.(file.path)) continue;
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm || !(DEFAULTS.labelsProp in fm)) continue;
		const labels = asStringArray(fm[DEFAULTS.labelsProp]);
		if (!labels.some((l) => l.toLowerCase() === fromLower)) continue;

		try {
			await app.fileManager.processFrontMatter(file, (front: Record<string, unknown>) => {
				const current = asStringArray(front[DEFAULTS.labelsProp]);
				const next: string[] = [];
				const seen = new Set<string>();
				for (const l of current) {
					let value = l;
					if (l.toLowerCase() === fromLower) {
						if (to === null) continue;
						value = to;
					}
					const key = value.toLowerCase();
					if (seen.has(key)) continue;
					seen.add(key);
					next.push(value);
				}
				if (next.length === 0) delete front[DEFAULTS.labelsProp];
				else front[DEFAULTS.labelsProp] = next;
			});
			filesTouched++;
		} catch {
			filesFailed++;
		}
	}

	return { filesTouched, filesFailed };
}

export interface NewTaskSpec {
	title: string;
	description: string;
	status: string;
	priority: string;
	labels: string[];
	parent?: TFile | null;
	startDate?: string | null;
	endDate?: string | null;
	attachments?: PendingAttachment[];
	folder: string;
}

/** A file selected/pasted in the create modal, awaiting import into the vault. */
export interface PendingAttachment {
	name: string;
	type: string;
	data: ArrayBuffer;
}

function slugify(title: string): string {
	const base = title
		.trim()
		.replace(/[\\/:*?"<>|#^[\]]/g, "")
		.replace(/\s+/g, " ")
		.slice(0, 80);
	return base.length > 0 ? base : "Untitled task";
}

async function uniquePath(app: App, folder: string, name: string): Promise<string> {
	const dir = folder && folder !== "/" ? folder.replace(/\/$/, "") + "/" : "";
	let candidate = normalizePath(`${dir}${name}.md`);
	let n = 1;
	while (app.vault.getAbstractFileByPath(candidate)) {
		candidate = normalizePath(`${dir}${name} ${++n}.md`);
	}
	return candidate;
}

/**
 * Create a new task note: frontmatter holds the structured fields, the body
 * holds the description. Returns the created file.
 */
export async function createTask(app: App, cfg: KanbanConfig, spec: NewTaskSpec): Promise<TFile> {
	const path = await uniquePath(app, spec.folder, slugify(spec.title));
	const file = await app.vault.create(path, spec.description ? `\n${spec.description}\n` : "");
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		fm[cfg.titleProp] = spec.title;
		fm[cfg.statusProp] = spec.status;
		if (spec.priority && spec.priority !== "no priority") fm[cfg.priorityProp] = spec.priority;
		if (spec.labels.length > 0) fm[cfg.labelsProp] = spec.labels;
		if (spec.startDate) fm[cfg.startDateProp] = spec.startDate;
		if (spec.endDate) fm[cfg.endDateProp] = spec.endDate;
		if (spec.parent) {
			fm[cfg.parentProp] = app.fileManager.generateMarkdownLink(spec.parent, file.path);
		}
	});

	// Import any attachments into the vault and embed them in the note body.
	if (spec.attachments && spec.attachments.length > 0) {
		const embeds: string[] = [];
		for (const att of spec.attachments) {
			const dest = await app.fileManager.getAvailablePathForAttachment(att.name, file.path);
			const created = await app.vault.createBinary(dest, att.data);
			embeds.push(app.fileManager.generateMarkdownLink(created, file.path));
		}
		await app.vault.append(file, `\n${embeds.join("\n")}\n`);
	}

	return file;
}
