import { App, Modal, Notice, TFolder } from "obsidian";
import { VaultFolderPathSuggest } from "./folder-suggest";
import { CUSTOM_FOLDER_CATEGORY, ImportInput, ImporterSettings } from "./types";

export class ImportSourceModal extends Modal {
	result: ImportInput | null = null;
	onSubmit: (result: ImportInput | null) => void;
	settings: ImporterSettings;
	availableCategories: string[];
	selectedCategory: string;
	downloadMedia: boolean;
	customFolderPath: string;

	constructor(
		app: App,
		settings: ImporterSettings,
		availableCategories: string[],
		onSubmit: (result: ImportInput | null) => void
	) {
		super(app);
		this.settings = settings;
		this.availableCategories = availableCategories;
		this.onSubmit = onSubmit;
		this.selectedCategory = this.resolveInitialCategory();
		this.downloadMedia = this.settings.downloadMedia;
		this.customFolderPath = this.settings.lastCustomFolder || this.settings.defaultFolder || "";
	}

	resolveInitialCategory(): string {
		if (this.settings.lastCategory === "其他") {
			return "其他";
		}
		if (this.settings.lastCategory === CUSTOM_FOLDER_CATEGORY && this.settings.lastCustomFolder) {
			return CUSTOM_FOLDER_CATEGORY;
		}
		if (this.settings.lastCategory && this.availableCategories.includes(this.settings.lastCategory)) {
			return this.settings.lastCategory;
		}
		return this.availableCategories[0] || "其他";
	}

	normalizeCustomFolderInput(path: string): string | null {
		const trimmed = path.trim();
		if (!trimmed) {
			return null;
		}
		const normalized = trimmed.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
		if (/^\/+$/.test(normalized)) {
			return "/";
		}
		const cleaned = normalized.replace(/^\/+|\/+$/g, "");
		return cleaned || null;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("wca-modal-content");

		contentEl.createEl("h2", { text: "导入文章（微信 / 小红书）" });

		const inputRow = contentEl.createEl("div", { cls: "wca-modal-row" });
		inputRow.createEl("p", { text: "粘贴微信或小红书链接 / 分享文本（支持按行批量导入）：" });
		const input = inputRow.createEl("textarea", {
			cls: "wca-modal-textarea",
			attr: {
				placeholder: "例如：\nhttps://mp.weixin.qq.com/s/xxxxxx\nhttps://www.xiaohongshu.com/explore/xxxxxx",
			},
		});

		const categoryRow = contentEl.createEl("div", { cls: "wca-modal-row" });
		categoryRow.createEl("p", { text: "选择分类：" });
		const chipContainer = categoryRow.createEl("div", { cls: "wca-chip-container" });
		const customFolderRow = contentEl.createEl("div", { cls: ["wca-modal-row", "wca-custom-folder-row"] });
		customFolderRow.createEl("p", { text: "自定义文件夹：" });
		const customFolderInput = customFolderRow.createEl("input", {
			cls: "wca-custom-folder-input",
			attr: {
				type: "text",
				placeholder: "例如：Projects/Clippings（输入 / 表示仓库根目录）",
			},
		});
		customFolderInput.value = this.customFolderPath;
		customFolderInput.addEventListener("input", () => {
			this.customFolderPath = customFolderInput.value;
		});
		new VaultFolderPathSuggest(this.app, customFolderInput, (value) => {
			this.customFolderPath = value;
		});

		const categoryList = [...this.availableCategories, "其他", CUSTOM_FOLDER_CATEGORY];
		const updateCustomFolderRow = () => {
			customFolderRow.style.display = this.selectedCategory === CUSTOM_FOLDER_CATEGORY ? "flex" : "none";
		};
		const renderChips = () => {
			chipContainer.empty();
			categoryList.forEach((category) => {
				const chip = chipContainer.createEl("button", {
					text: category,
					cls: "wca-chip",
				});
				if (category === this.selectedCategory) {
					chip.addClass("wca-chip--selected");
				}
				chip.addEventListener("click", () => {
					this.selectedCategory = category;
					renderChips();
					updateCustomFolderRow();
				});
			});
		};
		renderChips();
		updateCustomFolderRow();

		const downloadRow = contentEl.createEl("div", { cls: ["wca-modal-row", "wca-download-row"] });
		const downloadWrap = downloadRow.createEl("div", { cls: "wca-download-wrapper" });
		const checkboxId = "wca-download-media-checkbox";
		const checkbox = downloadWrap.createEl("input", { attr: { type: "checkbox", id: checkboxId } });
		checkbox.checked = this.downloadMedia;
		checkbox.addEventListener("change", () => {
			this.downloadMedia = checkbox.checked;
		});
		downloadWrap.createEl("label", {
			text: "本次导入下载图片到本地",
			attr: { for: checkboxId },
			cls: "wca-download-label",
		});

		const buttonRow = contentEl.createEl("div", { cls: ["wca-modal-row", "wca-button-row"] });
		const importButton = buttonRow.createEl("button", {
			text: "导入",
			cls: "wca-submit-button",
		});

		const submit = () => {
			const useCustomFolder = this.selectedCategory === CUSTOM_FOLDER_CATEGORY;
			let customFolderPath = "";
			if (useCustomFolder) {
				const normalizedPath = this.normalizeCustomFolderInput(customFolderInput.value);
				if (!normalizedPath) {
					new Notice("请选择自定义文件夹路径。");
					return;
				}
				this.customFolderPath = normalizedPath;
				const vaultPath = normalizedPath === "/" ? "" : normalizedPath;
				const abstractFile = this.app.vault.getAbstractFileByPath(vaultPath);
				if (abstractFile && !(abstractFile instanceof TFolder)) {
					new Notice("该路径是文件，请改为文件夹路径。");
					return;
				}
				customFolderPath = normalizedPath;
			}

			this.result = {
				text: input.value.trim(),
				category: this.selectedCategory,
				downloadMedia: this.downloadMedia,
				useCustomFolder,
				customFolderPath,
			};
			this.close();
		};

		importButton.addEventListener("click", submit);
		input.addEventListener("keypress", (event) => {
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				submit();
			}
		});
	}

	onClose() {
		this.onSubmit(this.result);
	}
}
