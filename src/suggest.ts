import { AbstractInputSuggest, App, TFolder, normalizePath } from "obsidian";

/** Inline folder search (existing vault folders only). */
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
	private onChoose: (folder: TFolder) => void;
	private excludePath: string;

	constructor(
		app: App,
		inputEl: HTMLInputElement,
		onChoose: (folder: TFolder) => void,
		excludePath = ""
	) {
		super(app, inputEl);
		this.onChoose = onChoose;
		this.excludePath = normalizePath(excludePath);
	}

	protected getSuggestions(query: string): TFolder[] {
		const q = query.toLowerCase().trim();
		const folders = this.app.vault
			.getAllFolders(/* includeRoot */ false)
			.filter((f) => normalizePath(f.path) !== this.excludePath);
		if (!q) return folders;
		return folders.filter((f) => f.path.toLowerCase().includes(q));
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path);
	}

	selectSuggestion(folder: TFolder): void {
		this.close();
		this.onChoose(folder);
	}
}
