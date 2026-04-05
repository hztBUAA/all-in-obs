import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import { ImporterSettings } from "./types";

export interface ImporterSettingsTabHost {
	settings: ImporterSettings;
	saveSettings(): Promise<void>;
	normalizeVaultPath(path: string): string;
	getXhsDebugLogPath(): string;
	getXhsSmokeReportPath(): string;
	getSmokeCasesText(platform: "wechat" | "xiaohongshu"): string;
	setSmokeCasesText(platform: "wechat" | "xiaohongshu", rawText: string): Promise<void>;
	runXhsSmokeTests(): Promise<void>;
	runPlatformSmokeTests(platforms?: Array<"wechat" | "xiaohongshu">): Promise<void>;
	openSmokeReportFile(): Promise<void>;
	openXhsDebugLogFile(): Promise<void>;
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

		new Setting(containerEl)
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

		new Setting(containerEl)
			.setName("默认下载图片")
			.setDesc("开启后导入时默认下载正文图片到本地 media 目录。")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.downloadMedia).onChange(async (value) => {
					this.plugin.settings.downloadMedia = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("小红书调试日志")
			.setDesc(`默认开启。日志路径：${this.plugin.getXhsDebugLogPath()}`)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.xhsDebugEnabled).onChange(async (value) => {
					this.plugin.settings.xhsDebugEnabled = value;
					await this.plugin.saveSettings();
				})
			);

		containerEl.createEl("p", {
			text: `实网 Smoke 报告路径：${this.plugin.getXhsSmokeReportPath()}（可通过命令面板“运行多平台实网 Smoke 测试”生成）`,
		});

		new Setting(containerEl).setName("Smoke 测试").setHeading();
		containerEl.createEl("p", { text: "可直接在设置页运行测试、查看报告，并自定义各平台测试用例（每行一条）。" });

		new Setting(containerEl)
			.setName("运行与查看")
			.addButton((button) =>
				button
					.setButtonText("运行多平台 Smoke")
					.onClick(async () => {
						await this.plugin.runPlatformSmokeTests();
					})
			)
			.addButton((button) =>
				button
					.setButtonText("仅运行小红书")
					.onClick(async () => {
						await this.plugin.runXhsSmokeTests();
					})
			)
			.addButton((button) =>
				button
					.setButtonText("打开报告")
					.onClick(async () => {
						await this.plugin.openSmokeReportFile();
					})
			)
			.addButton((button) =>
				button
					.setButtonText("打开调试日志")
					.onClick(async () => {
						await this.plugin.openXhsDebugLogFile();
					})
			);

		const smokeSummaryEl = containerEl.createEl("pre");
		smokeSummaryEl.setText("点击“刷新报告摘要”查看最近一次 Smoke 结果。");

		new Setting(containerEl)
			.setName("报告摘要")
			.addButton((button) =>
				button
					.setButtonText("刷新报告摘要")
					.onClick(async () => {
						smokeSummaryEl.setText(await this.plugin.readSmokeReportSummary());
					})
			);

		new Setting(containerEl)
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

		new Setting(containerEl)
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

		new Setting(containerEl).setName("分类管理").setHeading();
		containerEl.createEl("p", { text: "可编辑分类名称、调整顺序或删除分类；导入弹窗中固定包含“其他”和“自定义文件夹”。" });

		this.plugin.settings.categories.forEach((category, index) => {
			const setting = new Setting(containerEl)
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

		new Setting(containerEl).addButton((button) =>
			button.setButtonText("新增分类").onClick(async () => {
				this.plugin.settings.categories.push("新分类");
				await this.plugin.saveSettings();
				this.display();
			})
		);
	}
}
