import { normalizePath, type TFile } from "obsidian";
import {
	DEFAULTS,
	KONBINI_ROLE_PROP,
	KONBINI_ROLE_TEMPLATE,
	TEMPLATES_SUBFOLDER,
	type Template,
} from "./constants";


/** `{konbiniFolder}/Templates` */
export function templatesFolderPath(konbiniFolder: string): string {
	return normalizePath(`${konbiniFolder}/${TEMPLATES_SUBFOLDER}`);
}

/** `{konbiniFolder}/Templates/{name}.md` */
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
	const lines = ["---", `${KONBINI_ROLE_PROP}: ${KONBINI_ROLE_TEMPLATE}`];
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

/** Build a Template from a vault file + raw contents + optional frontmatter. */
export function parseTemplateFile(
	file: TFile,
	content: string,
	frontmatter: Record<string, unknown> | undefined
): Template {
	const fm = frontmatter ?? {};
	const status = typeof fm[DEFAULTS.statusProp] === "string" ? String(fm[DEFAULTS.statusProp]).trim() : "";
	const priority =
		typeof fm[DEFAULTS.priorityProp] === "string" ? String(fm[DEFAULTS.priorityProp]).trim() : "";
	const labels = asStringArray(fm[DEFAULTS.labelsProp]);
	return {
		name: file.basename,
		body: stripFrontmatter(content),
		status: status || undefined,
		priority: priority || undefined,
		labels: labels.length > 0 ? labels : undefined,
		path: file.path,
	};
}
