import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { ImporterSettings } from "./types";

export interface ImporterSettingsTabHost {
	settings: ImporterSettings;
	saveSettings(): Promise<void>;
	normalizeVaultPath(path: string): string;
	getDebugLogPath(): string;
	getSmokeReportPath(): string;
	getSmokeCasesText(platform: "wechat" | "xiaohongshu"): string;
	setSmokeCasesText(platform: "wechat" | "xiaohongshu", rawText: string): Promise<void>;
	runPlatformSmokeTests(platforms?: Array<"wechat" | "xiaohongshu">): Promise<void>;
	openSmokeReportFile(): Promise<void>;
	openDebugLogFile(): Promise<void>;
	readSmokeReportSummary(): Promise<string>;
}

export class ImporterSettingTab extends PluginSettingTab {
	plugin: ImporterSettingsTabHost;

	constructor(app: App, plugin: Plugin & ImporterSettingsTabHost) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("wca-settings-root");

		const basicSection = containerEl.createDiv({ cls: "wca-settings-section" });
		new Setting(basicSection).setName("基础设置").setHeading();

		new Setting(basicSection)
			.setName("默认文件夹")
			.setDesc("笔记保存根目录，分类会在此目录下创建子目录。")
			.addText((text) =>
				text
					.setPlaceholder("External Files")
					.setValue(this.plugin.settings.defaultFolder)
					.onChange(async (value) => {
						this.plugin.settings.defaultFolder = this.plugin.normalizeVaultPath(value);
						await this.plugin.saveSettings();
					})
			);

		new Setting(basicSection)
			.setName("默认下载图片")
			.setDesc("开启后导入时默认下载正文图片到本地 media 目录。")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.downloadMedia).onChange(async (value) => {
					this.plugin.settings.downloadMedia = value;
					await this.plugin.saveSettings();
				})
			);

		const debugSection = containerEl.createDiv({ cls: "wca-settings-section" });
		new Setting(debugSection).setName("调试与 Smoke（多平台）").setHeading();
		debugSection.createEl("p", {
			cls: "wca-settings-intro",
			text: "统一管理微信与小红书的实网 smoke 测试、报告与调试日志。",
		});

		new Setting(debugSection)
			.setName("统一调试日志")
			.setDesc(`默认开启。日志路径：${this.plugin.getDebugLogPath()}`)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.debugEnabled).onChange(async (value) => {
					this.plugin.settings.debugEnabled = value;
					await this.plugin.saveSettings();
				})
			);

		debugSection.createEl("p", {
			cls: "wca-settings-path",
			text: `Smoke 报告路径：${this.plugin.getSmokeReportPath()}`,
		});
		debugSection.createEl("p", {
			cls: "wca-settings-path",
			text: `调试日志路径：${this.plugin.getDebugLogPath()}`,
		});

		new Setting(debugSection)
			.setName("运行测试")
			.addButton((button) =>
				button
					.setButtonText("运行 Smoke（按当前用例）")
					.onClick(async () => {
						await this.runSafe(async () => this.plugin.runPlatformSmokeTests());
					})
			);

		new Setting(debugSection)
			.setName("查看结果")
			.addButton((button) =>
				button
					.setButtonText("查看报告")
					.onClick(async () => {
						await this.runSafe(async () => this.plugin.openSmokeReportFile());
					})
			)
			.addButton((button) =>
				button
					.setButtonText("查看调试日志")
					.onClick(async () => {
						await this.runSafe(async () => this.plugin.openDebugLogFile());
					})
			);

		const smokeSummaryEl = debugSection.createEl("pre", { cls: "wca-settings-summary" });
		smokeSummaryEl.setText("点击“刷新报告摘要”查看最近一次 Smoke 结果。");

		new Setting(debugSection)
			.setName("报告摘要")
			.addButton((button) =>
				button
					.setButtonText("刷新报告摘要")
					.onClick(async () => {
						await this.runSafe(async () => {
							smokeSummaryEl.setText(await this.plugin.readSmokeReportSummary());
						});
					})
			);

		debugSection.createEl("h4", { text: "Smoke 用例配置", cls: "wca-settings-subheading" });
		debugSection.createEl("p", {
			cls: "wca-settings-intro",
			text: "每行一条输入，可填分享文案或直链；保存后下次运行立即生效。",
		});

		new Setting(debugSection)
			.setName("小红书 Smoke 用例")
			.setDesc("每行一条分享文本或链接。")
			.addTextArea((text) => {
				text.setPlaceholder("http://xhslink.com/o/xxxx ...");
				text.setValue(this.plugin.getSmokeCasesText("xiaohongshu"));
				text.inputEl.rows = 6;
				text.onChange(async (value) => {
					await this.plugin.setSmokeCasesText("xiaohongshu", value);
				});
			});

		new Setting(debugSection)
			.setName("微信 Smoke 用例")
			.setDesc("每行一条公众号链接或分享文本。")
			.addTextArea((text) => {
				text.setPlaceholder("https://mp.weixin.qq.com/s/xxxx");
				text.setValue(this.plugin.getSmokeCasesText("wechat"));
				text.inputEl.rows = 4;
				text.onChange(async (value) => {
					await this.plugin.setSmokeCasesText("wechat", value);
				});
			});

		const categorySection = containerEl.createDiv({ cls: "wca-settings-section" });
		new Setting(categorySection).setName("分类管理").setHeading();
		categorySection.createEl("p", {
			cls: "wca-settings-intro",
			text: "可编辑分类名称、调整顺序或删除分类；导入弹窗会自动合并默认目录下一级子目录，并固定包含“其他”和“自定义文件夹”。",
		});

		this.plugin.settings.categories.forEach((category, index) => {
			const setting = new Setting(categorySection)
				.setName(`分类 ${index + 1}`)
				.addText((text) =>
					text.setValue(category).onChange(async (value) => {
						this.plugin.settings.categories[index] = value.trim() || "未命名分类";
						await this.plugin.saveSettings();
					})
				);

			setting.addButton((button) =>
				button
					.setIcon("arrow-up")
					.setTooltip("上移")
					.setDisabled(index === 0)
					.onClick(async () => {
						if (index > 0) {
							[this.plugin.settings.categories[index - 1], this.plugin.settings.categories[index]] = [
								this.plugin.settings.categories[index],
								this.plugin.settings.categories[index - 1],
							];
							await this.plugin.saveSettings();
							this.display();
						}
					})
			);

			setting.addButton((button) =>
				button
					.setIcon("arrow-down")
					.setTooltip("下移")
					.setDisabled(index === this.plugin.settings.categories.length - 1)
					.onClick(async () => {
						if (index < this.plugin.settings.categories.length - 1) {
							[this.plugin.settings.categories[index], this.plugin.settings.categories[index + 1]] = [
								this.plugin.settings.categories[index + 1],
								this.plugin.settings.categories[index],
							];
							await this.plugin.saveSettings();
							this.display();
						}
					})
			);

			setting.addButton((button) =>
				button
					.setButtonText("删除")
					.onClick(async () => {
						const removed = this.plugin.settings.categories[index];
						this.plugin.settings.categories.splice(index, 1);
						if (this.plugin.settings.lastCategory === removed) {
							this.plugin.settings.lastCategory = "";
						}
						await this.plugin.saveSettings();
						this.display();
					})
			);
		});

		new Setting(categorySection).addButton((button) =>
			button.setButtonText("新增分类").onClick(async () => {
				this.plugin.settings.categories.push("新分类");
				await this.plugin.saveSettings();
				this.display();
			})
		);
	}

	async runSafe(task: () => Promise<void>): Promise<void> {
		try {
			await task();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`操作失败：${message}`);
		}
	}
}
