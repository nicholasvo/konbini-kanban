import type { App } from "obsidian";
import { resolveConfig, type KanbanConfig } from "./config";
import { STATUS_COLOR_PALETTE, type LabelDef, type PriorityDef, type StatusDef } from "./constants";
import type KonbiniKanbanPlugin from "./main";
import { confirmAction } from "./modal-confirm";
import type { TaskContext } from "./task-context";

/**
 * Boardless TaskContext for `obsidian://konbini` quick-add links.
 * Destination comes from the URI; config from plugin Settings (not an open board).
 */
export class QuickAddContext implements TaskContext {
	app: App;
	plugin: KonbiniKanbanPlugin;
	cfg!: KanbanConfig;
	statusByKey = new Map<string, StatusDef>();
	priorityByKey = new Map<string, PriorityDef>();
	knownLabels: string[] = [];
	private labelDefByName = new Map<string, LabelDef>();

	constructor(plugin: KonbiniKanbanPlugin) {
		this.app = plugin.app;
		this.plugin = plugin;
		this.rebuildMaps();
	}

	private rebuildMaps(): void {
		this.cfg = resolveConfig(
			{ get: () => undefined },
			{
				columns: this.plugin.data.columns,
				priorities: this.plugin.data.customPriorities,
				labels: this.plugin.data.customLabels,
			}
		);
		this.statusByKey = new Map(this.cfg.statuses.map((s) => [s.key, s]));
		this.priorityByKey = new Map(this.cfg.priorities.map((p) => [p.key, p]));
		this.labelDefByName = new Map(this.cfg.labelDefs.map((d) => [d.name, d]));
		this.knownLabels = this.cfg.labelDefs.map((d) => d.name).sort((a, b) => a.localeCompare(b));
	}

	private paletteColor(n: number): string {
		return STATUS_COLOR_PALETTE[n % STATUS_COLOR_PALETTE.length];
	}

	labelDef(name: string): LabelDef | undefined {
		return this.labelDefByName.get(name);
	}

	isCustomPriority(key: string): boolean {
		return this.plugin.data.customPriorities.some((p) => p.key === key);
	}

	isCustomLabel(name: string): boolean {
		return this.plugin.data.customLabels.some((l) => l.name === name);
	}

	async addLabel(name: string, emoji?: string, color?: string): Promise<string> {
		const n = name.trim();
		if (n.length === 0) return "";
		const ok = await this.plugin.addCustomLabel({
			name: n,
			color: color ?? this.paletteColor(this.plugin.data.customLabels.length),
			emoji: emoji || undefined,
		});
		if (!ok) return "";
		this.rebuildMaps();
		return n;
	}

	async deleteLabel(name: string): Promise<void> {
		const n = this.plugin.countNotesWithLabel(name);
		const ok = await confirmAction(
			this.app,
			n > 0
				? `Remove label “${name}” from Settings and from ${n} note${n === 1 ? "" : "s"}?`
				: `Delete label “${name}”?`,
			"Delete"
		);
		if (!ok) return;
		await this.plugin.removeCustomLabel(name);
		this.rebuildMaps();
	}

	async updateLabel(name: string, emoji: string, color: string): Promise<void> {
		await this.plugin.updateCustomLabel(name, emoji, color);
		this.rebuildMaps();
	}

	async deletePriority(key: string): Promise<void> {
		await this.plugin.removeCustomPriority(key);
		this.rebuildMaps();
	}

	animateInCard(_path: string): void {
		/* no board to animate */
	}
}
