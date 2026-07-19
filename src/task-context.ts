import type { App } from "obsidian";
import type { KanbanConfig } from "./config";
import type { LabelDef, PriorityDef, StatusDef } from "./constants";
import type KonbiniKanbanPlugin from "./main";

/**
 * Slice of board behavior used by create modal + pickers.
 * Live {@link KanbanBoard} satisfies this; {@link QuickAddContext} is the
 * boardless stand-in for URI / quick-add create.
 */
export interface TaskContext {
	app: App;
	plugin: KonbiniKanbanPlugin;
	cfg: KanbanConfig;
	statusByKey: Map<string, StatusDef>;
	priorityByKey: Map<string, PriorityDef>;
	knownLabels: string[];
	labelDef(name: string): LabelDef | undefined;
	isCustomPriority(key: string): boolean;
	isCustomLabel(name: string): boolean;
	addLabel(name: string, emoji?: string, color?: string): Promise<string>;
	deleteLabel(name: string): Promise<void>;
	updateLabel(name: string, emoji: string, color: string): Promise<void>;
	deletePriority(key: string): Promise<void>;
	animateInCard(path: string): void;
}
