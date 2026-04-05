import { AbstractInputSuggest, App } from "obsidian";

export class VaultFolderPathSuggest extends AbstractInputSuggest<string> {
	constructor(app: App, textInputEl: HTMLInputElement) {
		super(app, textInputEl);
		this.limit = 200;
	}

	getSuggestions(query: string): string[] {
		const keyword = query.trim().toLowerCase();
		const folders = this.app.vault.getAllFolders(true).map((folder) => (folder.path ? folder.path : "/"));
		if (!keyword) {
			return folders;
		}
		return folders.filter((folder) => folder.toLowerCase().includes(keyword));
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value === "/" ? "/ (仓库根目录)" : value);
	}

	selectSuggestion(value: string, _evt: MouseEvent | KeyboardEvent): void {
		this.setValue(value);
		this.close();
	}
}
