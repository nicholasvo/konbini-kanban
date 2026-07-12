export const KANBAN_VIEW_TYPE = "kanban";

/** Plugin-maintained note that seeds Obsidian's property typeahead. */
export const SEED_NOTE_PATH = "Konbini Kanban values.md";

export interface StatusDef {
	key: string;
	label: string;
	/** CSS color for the icon. */
	color: string;
	/** Icon renderer key. */
	icon: StatusIconKind;
	/** Optional emoji glyph shown instead of the drawn icon (custom statuses). */
	emoji?: string;
}

export type StatusIconKind =
	| "backlog"
	| "unstarted"
	| "started"
	| "done"
	| "canceled";

export interface PriorityDef {
	key: string;
	label: string;
	/** Linear's numeric ranking; lower sorts first (after no-priority). */
	rank: number;
	icon: PriorityIconKind;
	/** Optional emoji glyph shown instead of the drawn icon (custom priorities). */
	emoji?: string;
	/** Optional tint for the drawn icon (custom priorities). */
	color?: string;
}

export type PriorityIconKind = "none" | "urgent" | "high" | "medium" | "low";

/** A named label with a color and optional emoji (user-defined). */
export interface LabelDef {
	name: string;
	color: string;
	emoji?: string;
}

/** A named description-body template (user-defined), applied on task create. */
export interface Template {
	name: string;
	body: string;
	/** Optional prefill values applied when the template is selected in the create modal. */
	status?: string;
	priority?: string;
	labels?: string[];
}

/**
 * Default status set, mirroring Linear's workflow states. Frontmatter stores
 * the `key` string. The order here is the left-to-right column order.
 */
export const DEFAULT_STATUSES: StatusDef[] = [
	{ key: "backlog", label: "Backlog", color: "#95a2b3", icon: "backlog" },
	{ key: "todo", label: "Todo", color: "#9aa1ad", icon: "unstarted" },
	{ key: "in progress", label: "In progress", color: "#f2c94c", icon: "started" },
	{ key: "done", label: "Done", color: "#5e6ad2", icon: "done" },
	{ key: "canceled", label: "Canceled", color: "#95a2b3", icon: "canceled" },
];

/**
 * Default priority set, mirroring Linear. `no priority` is the absence of a
 * value (stored as nothing / "no priority"); the rest store their `key`.
 */
export const DEFAULT_PRIORITIES: PriorityDef[] = [
	{ key: "no priority", label: "No priority", rank: 99, icon: "none" },
	{ key: "urgent", label: "Urgent", rank: 1, icon: "urgent" },
	{ key: "high", label: "High", rank: 2, icon: "high" },
	{ key: "medium", label: "Medium", rank: 3, icon: "medium" },
	{ key: "low", label: "Low", rank: 4, icon: "low" },
];

/**
 * General work/study labels seeded on first run (not coding-specific). They're
 * stored like any user label, so they can be recolored or removed.
 */
export const DEFAULT_LABELS: LabelDef[] = [
	{ name: "important", color: "#e15b64" },
	{ name: "follow-up", color: "#f2994a" },
	{ name: "idea", color: "#d4b106" },
	{ name: "reading", color: "#16a3a3" },
	{ name: "meeting", color: "#6e79d6" },
	{ name: "research", color: "#9b59b6" },
	{ name: "errand", color: "#3fb950" },
	{ name: "waiting", color: "#95a2b3" },
];

/** Colors cycled through when a user creates a new status. */
export const STATUS_COLOR_PALETTE = [
	"#95a2b3",
	"#6e79d6",
	"#3fb950",
	"#f2994a",
	"#e15b64",
	"#9b59b6",
	"#16a3a3",
	"#d4b106",
];

/** Default frontmatter property names. All are remappable via view options. */
export const DEFAULTS = {
	statusProp: "status",
	priorityProp: "priority",
	labelsProp: "labels",
	parentProp: "parent",
	titleProp: "title",
	startDateProp: "startDate",
	endDateProp: "endDate",
	defaultStatus: "todo",
} as const;
