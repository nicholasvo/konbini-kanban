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
	/**
	 * Vault-relative folder for new tasks from this board.
	 * Empty → infer from where most board tasks already live.
	 */
	newTaskFolder: string;
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

/** Trimmed string option; empty when unset (no fallback). */
function optionalStr(reader: RawConfigReader, key: string): string {
	const v = reader.get(key);
	return typeof v === "string" ? v.trim() : "";
}

/**
 * Parse a comma-separated "key:Label" override string into a status set,
 * preserving order. Caller must pass a non-empty string.
 */
function parseStatuses(raw: string): StatusDef[] {
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

/** Plugin data pieces that feed resolveConfig. */
export interface CustomDefs {
	/** Global column list from Settings. Used when the view has no statuses override. */
	columns?: StatusDef[];
	priorities?: PriorityDef[];
	labels?: LabelDef[];
}

export function mergeStatuses(base: StatusDef[], custom: StatusDef[]): StatusDef[] {
	const seen = new Set(base.map((s) => s.key));
	return [...base, ...custom.filter((s) => !seen.has(s.key))];
}

function mergePriorities(base: PriorityDef[], custom: PriorityDef[]): PriorityDef[] {
	const seen = new Set(base.map((p) => p.key));
	return [...base, ...custom.filter((p) => !seen.has(p.key))];
}

/**
 * Resolve view options + plugin data into a KanbanConfig.
 *
 * Column set:
 * 1. Per-board `statuses` override (non-empty) — wins, same as before
 * 2. Else global Settings `columns`
 * 3. Else Linear DEFAULT_STATUSES
 *
 * Default status for new tasks / unknown statuses:
 * 1. Per-board `defaultStatus` when it matches a column in that set
 * 2. Else first column of the resolved set (override → global → defaults)
 */
export function resolveConfig(reader: RawConfigReader, custom: CustomDefs = {}): KanbanConfig {
	const rawStatuses = reader.get("statuses");
	const hasOverride = typeof rawStatuses === "string" && rawStatuses.trim().length > 0;
	const globalColumns = custom.columns ?? [];
	const statuses = hasOverride
		? parseStatuses(rawStatuses)
		: globalColumns.length > 0
			? globalColumns
			: DEFAULT_STATUSES;

	const configuredDefault = optionalStr(reader, "defaultStatus");
	const defaultStatus =
		configuredDefault && statuses.some((s) => s.key === configuredDefault)
			? configuredDefault
			: (statuses[0]?.key ?? "backlog");

	return {
		statusProp: str(reader, "statusProp", DEFAULTS.statusProp),
		priorityProp: str(reader, "priorityProp", DEFAULTS.priorityProp),
		// Labels property is permanently locked to `labels` (no per-view remap).
		labelsProp: DEFAULTS.labelsProp,
		parentProp: str(reader, "parentProp", DEFAULTS.parentProp),
		titleProp: str(reader, "titleProp", DEFAULTS.titleProp),
		startDateProp: str(reader, "startDateProp", DEFAULTS.startDateProp),
		endDateProp: str(reader, "endDateProp", DEFAULTS.endDateProp),
		defaultStatus,
		newTaskFolder: optionalStr(reader, "newTaskFolder"),
		statuses,
		priorities: mergePriorities(DEFAULT_PRIORITIES, custom.priorities ?? []),
		labelDefs: custom.labels ?? [],
	};
}

/** Options array passed to registerBasesView. */
export function viewOptions() {
	return [
		{
			type: "text",
			displayName: "Status property",
			key: "statusProp",
			default: DEFAULTS.statusProp,
		},
		{
			type: "text",
			displayName: "Priority property",
			key: "priorityProp",
			default: DEFAULTS.priorityProp,
		},
		{
			type: "text",
			displayName: "Parent property",
			key: "parentProp",
			default: DEFAULTS.parentProp,
		},
		{
			type: "text",
			displayName: "Title property",
			key: "titleProp",
			default: DEFAULTS.titleProp,
		},
		{
			type: "text",
			displayName: "Start date property",
			key: "startDateProp",
			default: DEFAULTS.startDateProp,
		},
		{
			type: "text",
			displayName: "End date property",
			key: "endDateProp",
			default: DEFAULTS.endDateProp,
		},
		{
			type: "text",
			displayName: "Default status (new tasks)",
			key: "defaultStatus",
			default: "",
			placeholder: "Leave empty for first column",
		},
		{
			type: "folder",
			displayName: "New task folder",
			key: "newTaskFolder",
			default: "",
			placeholder: "Leave empty to auto-detect",
		},
		{
			type: "text",
			displayName: "Columns override (optional — overrides global Settings when set)",
			key: "statuses",
			default: "",
		},
	];
}
