import { App, Modal, Setting } from "obsidian";

/**
 * A small yes/no confirmation dialog. Replaces native window.confirm(), which
 * Obsidian discourages and which behaves poorly in the mobile app. Reports the
 * choice via the callback; dismissing counts as a cancel.
 */
export class ConfirmModal extends Modal {
	private message: string;
	private confirmText: string;
	private onResult: (ok: boolean) => void;
	private answered = false;

	constructor(app: App, message: string, onResult: (ok: boolean) => void, confirmText = "Confirm") {
		super(app);
		this.message = message;
		this.onResult = onResult;
		this.confirmText = confirmText;
	}

	onOpen(): void {
		this.contentEl.createEl("p", { text: this.message });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(false)))
			.addButton((b) => b.setButtonText(this.confirmText).setCta().onClick(() => this.finish(true)));
	}

	private finish(ok: boolean): void {
		this.answered = true;
		this.onResult(ok);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		// Dismissing without choosing (Esc / click-out) is a cancel.
		if (!this.answered) this.onResult(false);
	}
}
