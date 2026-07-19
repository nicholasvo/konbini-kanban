import { normalizePath, parseYaml, type TFile } from "obsidian";
import {
	DEFAULTS,
	KONBINI_ROLE_PROP,
	KONBINI_ROLE_TEMPLATE,
	KONBINI_TEMPLATE_ID_PROP,
	LEGACY_TEMPLATES_SUBFOLDER,
	LEGACY_VALUES_NOTE_NAME,
	TEMPLATES_SUBFOLDER,
	VALUES_NOTE_NAME,
	type Template,
} from "./constants";

/** Opaque id for a template note (`tpl-` + random hex). */
export function generateTemplateId(): string {
	const bytes = new Uint8Array(4);
	crypto.getRandomValues(bytes);
	return `tpl-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** True when editable template fields differ (ignores id/path). */
export function templateFieldsChanged(a: Template, b: Template): boolean {
	const labelsA = [...(a.labels ?? [])].sort().join("\0");
	const labelsB = [...(b.labels ?? [])].sort().join("\0");
	return (
		a.name !== b.name ||
		a.body !== b.body ||
		(a.status ?? "") !== (b.status ?? "") ||
		(a.priority ?? "") !== (b.priority ?? "") ||
		labelsA !== labelsB
	);
}

/** `{konbiniFolder}/Konbini Values.md` */
export function valuesNotePath(konbiniFolder: string): string {
	return normalizePath(`${konbiniFolder}/${VALUES_NOTE_NAME}`);
}

/** `{konbiniFolder}/Values.md` (pre-prefix layout). */
export function legacyValuesNotePath(konbiniFolder: string): string {
	return normalizePath(`${konbiniFolder}/${LEGACY_VALUES_NOTE_NAME}`);
}

/** `{konbiniFolder}/Konbini Templates` */
export function templatesFolderPath(konbiniFolder: string): string {
	return normalizePath(`${konbiniFolder}/${TEMPLATES_SUBFOLDER}`);
}

/** `{konbiniFolder}/Templates` (pre-prefix layout). */
export function legacyTemplatesFolderPath(konbiniFolder: string): string {
	return normalizePath(`${konbiniFolder}/${LEGACY_TEMPLATES_SUBFOLDER}`);
}

/** `{konbiniFolder}/Konbini Templates/{name}.md` */
export function templateNotePath(konbiniFolder: string, name: string): string {
	return normalizePath(`${templatesFolderPath(konbiniFolder)}/${name}.md`);
}

/** True if `path` is the Konbini folder or anything inside it. */
export function isUnderKonbiniFolder(konbiniFolder: string, path: string): boolean {
	const root = normalizePath(konbiniFolder);
	const p = normalizePath(path);
	if (!root || root === ".") return false;
	return p === root || p.startsWith(`${root}/`);
}

/**
 * True if `path` is plugin-owned and must not appear as a board task:
 * Konbini Values.md or anything under Konbini Templates/ (plus pre-prefix
 * Values.md / Templates/ until migrated). Other notes in the Konbini folder
 * stay visible on boards.
 */
export function isKonbiniManagedPath(konbiniFolder: string, path: string): boolean {
	const p = normalizePath(path);
	if (p === valuesNotePath(konbiniFolder) || p === legacyValuesNotePath(konbiniFolder)) {
		return true;
	}
	const templates = templatesFolderPath(konbiniFolder);
	if (p === templates || p.startsWith(`${templates}/`)) return true;
	const legacyTemplates = legacyTemplatesFolderPath(konbiniFolder);
	return p === legacyTemplates || p.startsWith(`${legacyTemplates}/`);
}

/**
 * Parse a markdown file's YAML frontmatter block directly from its raw
 * contents. Used instead of `metadataCache` so freshly written template notes
 * reflect their prefill values immediately, before the cache catches up.
 */
export function parseFrontmatter(content: string): Record<string, unknown> | undefined {
	if (!content.startsWith("---")) return undefined;
	const end = content.indexOf("\n---", 3);
	if (end < 0) return undefined;
	try {
		const parsed = parseYaml(content.slice(3, end));
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Strip YAML frontmatter from a markdown file's raw contents. */
export function stripFrontmatter(content: string): string {
	if (!content.startsWith("---")) return content;
	const end = content.indexOf("\n---", 3);
	if (end < 0) return content;
	let body = content.slice(end + 4);
	if (body.startsWith("\r\n")) body = body.slice(2);
	else if (body.startsWith("\n")) body = body.slice(1);
	return body;
}

function yamlScalar(value: string): string {
	if (/[:#{}[\],&*?|>!%@`]/.test(value) || value !== value.trim()) {
		return JSON.stringify(value);
	}
	return value;
}

/** Serialize a template to a markdown note with Konbini frontmatter. */
export function serializeTemplate(tpl: Template): string {
	const id = tpl.id || generateTemplateId();
	const lines = [
		"---",
		`${KONBINI_ROLE_PROP}: ${KONBINI_ROLE_TEMPLATE}`,
		`${KONBINI_TEMPLATE_ID_PROP}: ${yamlScalar(id)}`,
	];
	if (tpl.status) lines.push(`${DEFAULTS.statusProp}: ${yamlScalar(tpl.status)}`);
	if (tpl.priority) lines.push(`${DEFAULTS.priorityProp}: ${yamlScalar(tpl.priority)}`);
	if (tpl.labels && tpl.labels.length > 0) {
		lines.push(`${DEFAULTS.labelsProp}:`);
		for (const label of tpl.labels) lines.push(`  - ${yamlScalar(label)}`);
	}
	lines.push("---", "");
	return lines.join("\n") + tpl.body;
}

function asStringArray(v: unknown): string[] {
	if (Array.isArray(v)) return v.map((x) => String(x)).filter((s) => s.length > 0);
	if (typeof v === "string" && v.trim().length > 0) {
		return v
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
	}
	return [];
}

/**
 * Build a Template from a vault file + raw contents. Frontmatter is parsed from
 * the contents by default; pass `frontmatter` to override (e.g. from a cache).
 */
export function parseTemplateFile(
	file: TFile,
	content: string,
	frontmatter?: Record<string, unknown>
): Template {
	const fm = frontmatter ?? parseFrontmatter(content) ?? {};
	const idRaw = fm[KONBINI_TEMPLATE_ID_PROP];
	const id = typeof idRaw === "string" ? idRaw.trim() : "";
	const status = typeof fm[DEFAULTS.statusProp] === "string" ? String(fm[DEFAULTS.statusProp]).trim() : "";
	const priority =
		typeof fm[DEFAULTS.priorityProp] === "string" ? String(fm[DEFAULTS.priorityProp]).trim() : "";
	const labels = asStringArray(fm[DEFAULTS.labelsProp]);
	return {
		name: file.basename,
		body: stripFrontmatter(content),
		id: id || undefined,
		status: status || undefined,
		priority: priority || undefined,
		labels: labels.length > 0 ? labels : undefined,
		path: file.path,
	};
}
