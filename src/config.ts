import {
	DEFAULTS,
	DEFAULT_STATUSES,
	DEFAULT_PRIORITIES,
	StatusDef,
	PriorityDef,
	LabelDef,
} from "./constants";

/**
 * Resolved, normalized configuration for one kanban view instance. Property
 * names and the status/priority sets are remappable through Bases view options;
 * everything defaults to the Linear-flavored values so the board looks right
 * with zero configuration.
 */
export interface KanbanConfig {
	statusProp: string;
	priorityProp: string;
	labelsProp: string;
	parentProp: string;
	titleProp: string;
	startDateProp: string;
	endDateProp: string;
	defaultStatus: string;
	statuses: StatusDef[];
	priorities: PriorityDef[];
	labelDefs: LabelDef[];
}

/** A minimal shape of the Bases view config object (config.get). */
export interface RawConfigReader {
	get(key: string): unknown;
}

function str(reader: RawConfigReader, key: string, fallback: string): string {
	const v = reader.get(key);
	return typeof v === "string" && v.trim().length > 0 ? v.trim() : fallback;
}

/**
 * Parse an optional comma-separated "key:Label" override string into a status
 * set, preserving order. Falls back to the defaults when absent or unparseable.
 */
function parseStatuses(raw: unknown): StatusDef[] {
	if (typeof raw !== "string" || raw.trim().length === 0) return DEFAULT_STATUSES;
	const byKey = new Map(DEFAULT_STATUSES.map((s) => [s.key, s]));
	const out: StatusDef[] = [];
	for (const part of raw.split(",")) {
		const [keyRaw, labelRaw] = part.split(":");
		const key = keyRaw?.trim().toLowerCase();
		if (!key) continue;
		const base = byKey.get(key);
		out.push({
			key,
			label: labelRaw?.trim() || base?.label || titleCase(key),
			color: base?.color ?? "#95a2b3",
			icon: base?.icon ?? "unstarted",
		});
	}
	return out.length > 0 ? out : DEFAULT_STATUSES;
}

function titleCase(s: string): string {
	return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** User-created statuses/priorities/labels, persisted in plugin data. */
export interface CustomDefs {
	statuses?: StatusDef[];
	priorities?: PriorityDef[];
	labels?: LabelDef[];
}

function mergeStatuses(base: StatusDef[], custom: StatusDef[]): StatusDef[] {
	const seen = new Set(base.map((s) => s.key));
	return [...base, ...custom.filter((s) => !seen.has(s.key))];
}

function mergePriorities(base: PriorityDef[], custom: PriorityDef[]): PriorityDef[] {
	const seen = new Set(base.map((p) => p.key));
	return [...base, ...custom.filter((p) => !seen.has(p.key))];
}

export function resolveConfig(reader: RawConfigReader, custom: CustomDefs = {}): KanbanConfig {
	return {
		statusProp: str(reader, "statusProp", DEFAULTS.statusProp),
		priorityProp: str(reader, "priorityProp", DEFAULTS.priorityProp),
		labelsProp: str(reader, "labelsProp", DEFAULTS.labelsProp),
		parentProp: str(reader, "parentProp", DEFAULTS.parentProp),
		titleProp: str(reader, "titleProp", DEFAULTS.titleProp),
		startDateProp: str(reader, "startDateProp", DEFAULTS.startDateProp),
		endDateProp: str(reader, "endDateProp", DEFAULTS.endDateProp),
		defaultStatus: str(reader, "defaultStatus", DEFAULTS.defaultStatus),
		statuses: mergeStatuses(parseStatuses(reader.get("statuses")), custom.statuses ?? []),
		priorities: mergePriorities(DEFAULT_PRIORITIES, custom.priorities ?? []),
		labelDefs: custom.labels ?? [],
	};
}

/** Options array passed to registerBasesView. */
export function viewOptions() {
	return [
		{ type: "text", displayName: "Status property", key: "statusProp", default: DEFAULTS.statusProp },
		{ type: "text", displayName: "Priority property", key: "priorityProp", default: DEFAULTS.priorityProp },
		{ type: "text", displayName: "Labels property", key: "labelsProp", default: DEFAULTS.labelsProp },
		{ type: "text", displayName: "Parent property", key: "parentProp", default: DEFAULTS.parentProp },
		{ type: "text", displayName: "Title property", key: "titleProp", default: DEFAULTS.titleProp },
		{ type: "text", displayName: "Start date property", key: "startDateProp", default: DEFAULTS.startDateProp },
		{ type: "text", displayName: "End date property", key: "endDateProp", default: DEFAULTS.endDateProp },
		{ type: "text", displayName: "Default status (new tasks)", key: "defaultStatus", default: DEFAULTS.defaultStatus },
		{
			type: "text",
			displayName: "Columns (key:Label, comma-separated)",
			key: "statuses",
			default: "",
		},
	];
}
