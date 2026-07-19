import { Modal, Notice, Setting, normalizePath } from "obsidian";
import type KonbiniKanbanPlugin from "./main";
import { DEFAULT_PRIORITIES, type Template } from "./constants";
import { FolderSuggest } from "./suggest";

/**
 * Configures and inserts a markdown quick-add link at the editor cursor:
 * `[text](obsidian://konbini?folder=…&template=…)`.
 */
export class QuickAddLinkModal extends Modal {
	private plugin: KonbiniKanbanPlugin;
	private onInsert: (markdown: string) => void;
	private folder = "";
	private linkText = "Quick add task";
	private templateName = "";
	private templatePreviewEl!: HTMLElement;

	constructor(plugin: KonbiniKanbanPlugin, onInsert: (markdown: string) => void) {
		super(plugin.app);
		this.plugin = plugin;
		this.onInsert = onInsert;
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText("Insert quick-add link");

		new Setting(contentEl)
			.setName("Destination folder")
			.setDesc("Vault folder where new tasks from this link will be created.")
			.addText((text) => {
				text.setPlaceholder("Search folders…").setValue(this.folder);
				new FolderSuggest(this.app, text.inputEl, (folder) => {
					this.folder = folder.path;
					text.setValue(folder.path);
				});
			});

		new Setting(contentEl).setName("Link text").addText((text) => {
			text.setPlaceholder("Quick add task").setValue(this.linkText);
			text.onChange((v) => (this.linkText = v));
		});

		new Setting(contentEl)
			.setName("Template")
			.setDesc("Optional — applied when the link opens the create modal.")
			.addDropdown((dd) => {
				dd.addOption("", "No template");
				for (const t of this.plugin.listTemplates()) {
					dd.addOption(t.name, t.name);
				}
				dd.setValue(this.templateName);
				dd.onChange((v) => {
					this.templateName = v;
					this.renderTemplatePreview();
				});
			});

		this.templatePreviewEl = contentEl.createDiv("bk-quick-add-template-preview");
		this.renderTemplatePreview();

		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText("Insert")
				.setCta()
				.onClick(() => this.submit())
		);
	}

	/** Bullet list of prefill fields the selected template will apply. */
	private renderTemplatePreview(): void {
		const host = this.templatePreviewEl;
		host.empty();
		const name = this.templateName.trim();
		if (!name) {
			host.hide();
			return;
		}
		const tpl = this.plugin.getTemplate(name);
		if (!tpl) {
			host.hide();
			return;
		}
		const items = this.templatePreviewItems(tpl);
		if (items.length === 0) {
			host.hide();
			return;
		}
		host.show();
		const list = host.createEl("ul");
		for (const item of items) list.createEl("li", { text: item });
	}

	private templatePreviewItems(tpl: Template): string[] {
		const items: string[] = [];
		const body = tpl.body.trim();
		if (body) {
			const oneLine = body.replace(/\s+/g, " ");
			const snippet = oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine;
			items.push(`Description: ${snippet}`);
		}
		if (tpl.status) {
			const label =
				this.plugin.data.columns.find((s) => s.key === tpl.status)?.label ?? tpl.status;
			items.push(`Status: ${label}`);
		}
		if (tpl.priority) {
			const priorities = [
				...DEFAULT_PRIORITIES,
				...this.plugin.data.customPriorities,
			];
			const label =
				priorities.find((p) => p.key === tpl.priority)?.label ?? tpl.priority;
			items.push(`Priority: ${label}`);
		}
		if (tpl.labels?.length) {
			items.push(`Labels: ${tpl.labels.join(", ")}`);
		}
		return items;
	}

	private submit(): void {
		const folder = normalizePath(this.folder.trim());
		const text = this.linkText.trim();
		if (!folder || folder === ".") {
			new Notice("Pick a destination folder");
			return;
		}
		if (text.length === 0) {
			new Notice("Link text is required");
			return;
		}

		// Use encodeURIComponent (spaces → %20). URLSearchParams uses +, which
		// Obsidian's protocol handler can treat as a literal "+" in the folder path.
		const parts = [`folder=${encodeURIComponent(folder)}`];
		const template = this.templateName.trim();
		if (template) parts.push(`template=${encodeURIComponent(template)}`);

		const uri = `obsidian://konbini?${parts.join("&")}`;
		this.onInsert(`[${text}](${uri})`);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
