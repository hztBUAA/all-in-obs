import { App, Modal } from "obsidian";

export class TextPreviewModal extends Modal {
	private readonly titleText: string;
	private readonly filePath: string;
	private readonly content: string;

	constructor(app: App, titleText: string, filePath: string, content: string) {
		super(app);
		this.titleText = titleText;
		this.filePath = filePath;
		this.content = content;
	}

	onOpen() {
		const { contentEl, titleEl } = this;
		titleEl.setText(this.titleText);
		contentEl.empty();

		contentEl.createEl("p", { text: `路径：${this.filePath}`, cls: "wca-text-preview-path" });
		const textarea = contentEl.createEl("textarea", {
			cls: "wca-text-preview-area",
			attr: {
				readonly: "true",
			},
		});
		textarea.value = this.content || "";
	}
}
