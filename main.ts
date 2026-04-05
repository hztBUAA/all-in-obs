import {
	Notice,
	Plugin,
	requestUrl,
} from "obsidian";
import { ImportSourceModal } from "./src/plugin/import-modal";
import { ImporterSettingTab } from "./src/plugin/settings-tab";
import { TextPreviewModal } from "./src/plugin/text-preview-modal";
import { CUSTOM_FOLDER_CATEGORY, ImportInput, ImporterSettings } from "./src/plugin/types";
import { runPlatformSmokeSuite, SmokeInputCase, SupportedSmokePlatform } from "./src/plugin/platform-smoke";
import { XHS_SMOKE_REPORT_PATH } from "./src/shared/paths";
import { XhsNoteData, XhsNoteService } from "./src/platforms/xhs/note-service";
import { XhsDebugLogger } from "./src/platforms/xhs/debug-logger";
import { XhsResolver } from "./src/platforms/xhs/resolver";
import { XHS_SMOKE_CASES } from "./src/platforms/xhs/smoke-cases";
import { WechatArticleService } from "./src/platforms/wechat/article-service";
import { buildWechatHeaders } from "./src/platforms/wechat/headers";
import { WECHAT_SMOKE_CASES } from "./src/platforms/wechat/smoke-cases";

type SupportedPlatform = "wechat" | "xiaohongshu";

interface ImportTarget {
	platform: SupportedPlatform;
	url: string;
}

interface BatchExtractResult {
	targets: ImportTarget[];
	invalidLines: string[];
}

const DEFAULT_SETTINGS: ImporterSettings = {
	defaultFolder: "External Files",
	categories: ["科技", "商业", "产品", "投资", "研究"],
	lastCategory: "",
	lastCustomFolder: "",
	downloadMedia: true,
	xhsDebugEnabled: true,
	xhsSmokeCaseInputs: XHS_SMOKE_CASES.map((item) => item.input),
	wechatSmokeCaseInputs: WECHAT_SMOKE_CASES.map((item) => item.input),
};

interface ImportDestination {
	categoryName: string;
	folderPath: string;
	useCustomFolder: boolean;
	customFolderPath: string;
}

export default class MultiSourceImporterPlugin extends Plugin {
	settings: ImporterSettings;
	xhsDebugLogger: XhsDebugLogger;
	xhsResolver: XhsResolver;
	xhsNoteService: XhsNoteService;
	wechatArticleService: WechatArticleService;

	async onload() {
		await this.loadSettings();
		this.initializeServices();

		this.addRibbonIcon("book", "导入文章（微信 / 小红书）", async () => {
			await this.handleImportAction();
		});

		this.addCommand({
			id: "import-article",
			name: "导入文章（微信 / 小红书）",
			callback: async () => {
				await this.handleImportAction();
			},
		});

		this.addCommand({
			id: "run-xhs-smoke-tests",
			name: "运行小红书实网 Smoke 测试",
			callback: async () => {
				await this.runXhsSmokeTests();
			},
		});

		this.addCommand({
			id: "run-platform-smoke-tests",
			name: "运行多平台实网 Smoke 测试",
			callback: async () => {
				await this.runPlatformSmokeTests();
			},
		});

		this.addSettingTab(new ImporterSettingTab(this.app, this));
	}

	initializeServices() {
		this.xhsDebugLogger = new XhsDebugLogger({
			app: this.app,
			isEnabled: () => this.settings.xhsDebugEnabled,
		});
		this.xhsResolver = new XhsResolver({
			logger: this.xhsDebugLogger,
			buildHeaders: () => this.buildXiaohongshuHeaders(),
		});
		this.xhsNoteService = new XhsNoteService({
			buildHeaders: () => this.buildXiaohongshuHeaders(),
		});
		this.wechatArticleService = new WechatArticleService();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.settings.defaultFolder = this.normalizeVaultPath(this.settings.defaultFolder);
		this.settings.lastCustomFolder = this.normalizeFolderDisplayPath(this.settings.lastCustomFolder);
		this.settings.xhsSmokeCaseInputs = this.normalizeSmokeCaseInputs(
			this.settings.xhsSmokeCaseInputs,
			DEFAULT_SETTINGS.xhsSmokeCaseInputs
		);
		this.settings.wechatSmokeCaseInputs = this.normalizeSmokeCaseInputs(
			this.settings.wechatSmokeCaseInputs,
			DEFAULT_SETTINGS.wechatSmokeCaseInputs
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	normalizeSmokeCaseInputs(value: unknown, fallback: string[]): string[] {
		if (!Array.isArray(value)) {
			return [...fallback];
		}
		const normalized = value
			.map((item) => (typeof item === "string" ? item.trim() : ""))
			.filter((item) => !!item);
		return normalized;
	}

	async handleImportAction() {
		const input = await this.promptForImportInput();
		if (!input?.text) {
			return;
		}

		if (input.useCustomFolder) {
			this.settings.lastCategory = CUSTOM_FOLDER_CATEGORY;
			this.settings.lastCustomFolder = this.normalizeFolderDisplayPath(input.customFolderPath) || "/";
			await this.saveSettings();
		}

		const batch = this.extractBatchImportTargets(input.text);
		if (batch.targets.length === 0) {
			new Notice("未识别到有效链接。目前支持微信公众号和小红书。");
			return;
		}

		if (batch.targets.length === 1) {
			await this.importByPlatform(batch.targets[0], input.category, input.downloadMedia, input.useCustomFolder, input.customFolderPath, false);
			return;
		}

		if (batch.invalidLines.length > 0) {
			new Notice(`检测到 ${batch.invalidLines.length} 行无效输入，已自动跳过。`);
		}

		let success = 0;
		let failed = 0;
		for (const target of batch.targets) {
			const ok = await this.importByPlatform(target, input.category, input.downloadMedia, input.useCustomFolder, input.customFolderPath, true);
			if (ok) {
				success += 1;
			} else {
				failed += 1;
			}
		}

		new Notice(`批量导入完成：成功 ${success}，失败 ${failed}。`);
	}

	async importByPlatform(
		target: ImportTarget,
		category: string,
		downloadMedia: boolean,
		useCustomFolder: boolean,
		customFolderPath: string,
		silent = false
	): Promise<boolean> {
		if (target.platform === "wechat") {
			return await this.importWechatArticle(target.url, category, downloadMedia, useCustomFolder, customFolderPath, silent);
		}
		return await this.importXiaohongshuNote(target.url, category, downloadMedia, useCustomFolder, customFolderPath, silent);
	}

	async promptForImportInput(): Promise<ImportInput | null> {
		return new Promise((resolve) => {
			const modal = new ImportSourceModal(this.app, this.settings, (result) => resolve(result));
			modal.open();
		});
	}

	normalizeVaultPath(path: string): string {
		const normalized = path.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
		if (!normalized || /^\/+$/.test(normalized)) {
			return "";
		}
		return normalized.replace(/^\/+|\/+$/g, "");
	}

	normalizeFolderDisplayPath(path: string): string {
		const trimmed = path.trim();
		if (!trimmed) {
			return "";
		}
		if (/^[/\\]+$/.test(trimmed)) {
			return "/";
		}
		const normalized = this.normalizeVaultPath(trimmed);
		return normalized || "/";
	}

	toVaultFolderPath(displayPath: string): string {
		if (displayPath === "/") {
			return "";
		}
		return this.normalizeVaultPath(displayPath);
	}

	resolveImportDestination(category: string, useCustomFolder: boolean, customFolderPath: string): ImportDestination {
		if (useCustomFolder) {
			const normalizedDisplayPath = this.normalizeFolderDisplayPath(customFolderPath) || "/";
			const folderPath = this.toVaultFolderPath(normalizedDisplayPath);
			const categoryName = folderPath ? folderPath.split("/").filter(Boolean).pop() || "其他" : "根目录";
			return {
				categoryName,
				folderPath,
				useCustomFolder: true,
				customFolderPath: normalizedDisplayPath,
			};
		}

		const baseFolder = this.normalizeVaultPath(this.settings.defaultFolder);
		const categoryName = category.trim() || "其他";
		const safeCategory = this.sanitizePathSegment(categoryName, "其他");
		const folderPath = baseFolder ? `${baseFolder}/${safeCategory}` : safeCategory;
		return {
			categoryName,
			folderPath,
			useCustomFolder: false,
			customFolderPath: "",
		};
	}

	getRelativePath(fromFolder: string, toPath: string): string {
		const fromParts = this.normalizeVaultPath(fromFolder).split("/").filter(Boolean);
		const toParts = this.normalizeVaultPath(toPath).split("/").filter(Boolean);

		let shared = 0;
		while (shared < fromParts.length && shared < toParts.length && fromParts[shared] === toParts[shared]) {
			shared += 1;
		}

		const up = Array(Math.max(fromParts.length - shared, 0)).fill("..");
		const down = toParts.slice(shared);
		const relative = [...up, ...down];
		return relative.length > 0 ? relative.join("/") : ".";
	}

	buildMediaLocation(folderPath: string, safeMediaTitle: string, useCustomFolder: boolean): { mediaFolder: string; relativeMediaPrefix: string } {
		const baseFolder = this.normalizeVaultPath(this.settings.defaultFolder);
		const mediaRootFolder = useCustomFolder ? (folderPath ? `${folderPath}/media` : "media") : baseFolder ? `${baseFolder}/media` : "media";
		const mediaFolder = `${mediaRootFolder}/${safeMediaTitle}`;
		const relativeMediaPrefix = this.getRelativePath(folderPath, mediaFolder);
		return { mediaFolder, relativeMediaPrefix };
	}

	extractImportTarget(input: string): ImportTarget | null {
		const wechatUrl = this.extractWechatUrl(input);
		if (wechatUrl) {
			return { platform: "wechat", url: wechatUrl };
		}

		const xhsUrl = this.extractXiaohongshuUrl(input);
		if (xhsUrl) {
			return { platform: "xiaohongshu", url: xhsUrl };
		}

		return null;
	}

	extractBatchImportTargets(text: string): BatchExtractResult {
		const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => !!line);
		const targets: ImportTarget[] = [];
		const invalidLines: string[] = [];
		const seen = new Set<string>();

		for (const line of lines) {
			const target = this.extractImportTarget(line);
			if (!target) {
				invalidLines.push(line);
				continue;
			}
			const key = `${target.platform}:${target.url}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			targets.push(target);
		}

		return { targets, invalidLines };
	}

	extractWechatUrl(input: string): string | null {
		const normalizedInput = input.replace(/&amp;/g, "&");
		const patterns = [
			/(https?:\/\/mp\.weixin\.qq\.com\/s\/[a-zA-Z0-9_-]+(?:\?[^\s，,]*)?)/,
			/(https?:\/\/mp\.weixin\.qq\.com\/s\?[^\s，,]+)/,
		];

		for (const pattern of patterns) {
			const match = normalizedInput.match(pattern);
			if (match?.[1]) {
				return this.normalizeArticleUrl(match[1]);
			}
		}

		return null;
	}

	extractXiaohongshuUrl(input: string): string | null {
		const normalizedInput = input.replace(/&amp;/g, "&");
		const patterns = [
			/(https?:\/\/xhslink\.com\/a?o?\/[^\s，,]+)/i,
			/(https?:\/\/www\.xiaohongshu\.com\/(?:discovery\/item|explore)\/[a-zA-Z0-9]+(?:\?[^\s，,]*)?)/i,
		];

		for (const pattern of patterns) {
			const match = normalizedInput.match(pattern);
			if (!match?.[1]) {
				continue;
			}
			const url = match[1];
			return url.replace("/explore/", "/discovery/item/");
		}

		return null;
	}

	normalizeArticleUrl(url: string): string {
		let normalized = url.trim().replace(/&amp;/g, "&");
		normalized = normalized.replace(/[。！!）)\]】>,，,]+$/, "");
		normalized = normalized.replace(/#wechat_redirect$/, "");
		return normalized;
	}

	async importWechatArticle(
		url: string,
		category: string,
		downloadMedia: boolean,
		useCustomFolder: boolean,
		customFolderPath: string,
		silent = false
	): Promise<boolean> {
		try {
			const normalizedUrl = this.normalizeArticleUrl(url);
			const html = await this.wechatArticleService.fetchHtml(normalizedUrl);
			const article = this.wechatArticleService.extractArticle(normalizedUrl, html);

			if (!article.contentHtml.trim()) {
				throw new Error("未提取到正文内容");
			}

			const destination = this.resolveImportDestination(category, useCustomFolder, customFolderPath);
			const categoryName = destination.categoryName;
			const folderPath = destination.folderPath;

			await this.ensureFolder(folderPath);

			let imageMap = new Map<string, string>();
			const safeTitle = this.sanitizeFileName(article.title, "Untitled WeChat Article");
			const safeMediaTitle = this.sanitizeMediaBaseName(article.title, "Untitled-WeChat-Article");
			const { mediaFolder, relativeMediaPrefix } = this.buildMediaLocation(folderPath, safeMediaTitle, destination.useCustomFolder);

			if (article.images.length > 0) {
				if (downloadMedia) {
					await this.ensureFolder(mediaFolder);
				}

				imageMap = await this.buildImageMap(article.images, {
					downloadMedia,
					mediaFolder,
					safeMediaTitle,
					relativeMediaPrefix,
					headers: buildWechatHeaders(normalizedUrl),
				});
			}

			article.contentMarkdown = this.wechatArticleService.convertHtmlToMarkdown(article.contentHtml, imageMap);

			const normalizedCover = this.normalizeMediaUrl(article.cover);
			const finalCover = normalizedCover ? (imageMap.get(normalizedCover) ?? normalizedCover) : "";

			const frontmatter = this.wechatArticleService.buildFrontmatter(article, categoryName, finalCover);
			const markdown = `${frontmatter}\n# ${article.title}\n\n${article.contentMarkdown}\n`;

			const filePath = await this.getUniqueNotePath(folderPath, safeTitle);
			const file = await this.app.vault.create(filePath, markdown);
			await this.app.workspace.getLeaf(true).openFile(file);

			this.settings.lastCategory = category;
			if (destination.useCustomFolder) {
				this.settings.lastCustomFolder = destination.customFolderPath;
			}
			await this.saveSettings();

			if (!silent) {
				new Notice(`已导入公众号文章：${filePath}`);
			}
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error("Failed to import WeChat article:", error);
			if (!silent) {
				new Notice(`导入失败：${message}`);
			}
			return false;
		}
	}

	buildXiaohongshuHeaders(): Record<string, string> {
		return {
			"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
			"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
			Referer: "https://www.xiaohongshu.com/",
		};
	}

	async importXiaohongshuNote(
		url: string,
		category: string,
		downloadMedia: boolean,
		useCustomFolder: boolean,
		customFolderPath: string,
		silent = false
	): Promise<boolean> {
		try {
			await this.xhsDebugLogger.reset(url);
			await this.xhsDebugLogger.append("import-start", { inputUrl: url });
			const resolvedUrl = await this.xhsResolver.resolve(url);
			await this.xhsDebugLogger.append("import-resolved-url", { resolvedUrl });
			const html = await this.xhsNoteService.fetchHtml(resolvedUrl);
			const note = this.xhsNoteService.extractNoteData(resolvedUrl, html);
			const cleanContent = note.content.trim();

			const destination = this.resolveImportDestination(category, useCustomFolder, customFolderPath);
			const categoryName = destination.categoryName;
			const folderPath = destination.folderPath;

			await this.ensureFolder(folderPath);

			const safeTitle = this.sanitizeFileName(note.title, "Untitled Xiaohongshu Note");
			const safeMediaTitle = this.sanitizeMediaBaseName(note.title, "Untitled-XHS-Note");
			const { mediaFolder, relativeMediaPrefix } = this.buildMediaLocation(folderPath, safeMediaTitle, destination.useCustomFolder);
			const headers = this.buildXiaohongshuHeaders();

			if (downloadMedia && (note.images.length > 0 || note.videoUrl)) {
				await this.ensureFolder(mediaFolder);
			}

			const imageMap = await this.buildImageMap(note.images, {
				downloadMedia,
				mediaFolder,
				safeMediaTitle,
				relativeMediaPrefix,
				headers,
			});

			const finalImages = note.images.map((img) => imageMap.get(img) ?? img);
			const normalizedCover = this.normalizeMediaUrl(note.cover);
			const finalCover = normalizedCover ? (imageMap.get(normalizedCover) ?? normalizedCover) : "";

			let videoMarkdown = "";
			if (note.isVideo && note.videoUrl) {
				let finalVideoUrl = note.videoUrl;
				if (downloadMedia) {
					const videoFilename = await this.downloadMediaFile(
						note.videoUrl,
						mediaFolder,
						`${safeMediaTitle}-video`,
						".mp4",
						headers
					);
					if (!videoFilename.startsWith("http")) {
						finalVideoUrl = `${relativeMediaPrefix}/${videoFilename}`;
					}
				}
				videoMarkdown = `<video controls src="${finalVideoUrl}" width="100%"></video>\n\n`;
			}

			let markdownBody = "";
			if (videoMarkdown) {
				markdownBody += videoMarkdown;
			} else if (finalImages.length > 0) {
				markdownBody += `![Cover Image](${this.toMarkdownDestination(finalImages[0])})\n\n`;
			}

			if (cleanContent) {
				markdownBody += `${cleanContent}\n\n`;
			}

			if (note.tags.length > 0) {
				markdownBody += note.tags.map((tag) => `#${tag}`).join(" ") + "\n\n";
			}

			if (!note.isVideo && finalImages.length > 1) {
				const restImages = finalImages
					.slice(1)
					.map((img) => `![Image](${this.toMarkdownDestination(img)})`)
					.join("\n");
				markdownBody += `${restImages}\n`;
			}

			const frontmatter = this.buildXhsFrontmatter(note, categoryName, finalCover);
			const markdown = `${frontmatter}\n# ${note.title}\n\n${this.normalizeMarkdownSpacing(markdownBody)}\n`;

			const filePath = await this.getUniqueNotePath(folderPath, safeTitle);
			const file = await this.app.vault.create(filePath, markdown);
			await this.app.workspace.getLeaf(true).openFile(file);

			this.settings.lastCategory = category;
			if (destination.useCustomFolder) {
				this.settings.lastCustomFolder = destination.customFolderPath;
			}
			await this.saveSettings();
			if (!silent) {
				new Notice(`已导入小红书内容：${filePath}`);
			}
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.xhsDebugLogger.append("import-error", { message });
			console.error("Failed to import Xiaohongshu note:", error);
			if (!silent) {
				new Notice(`导入失败：${message}`);
			}
			return false;
		}
	}

	getXhsDebugLogPath(): string {
		return this.xhsDebugLogger.getLogPath();
	}

	getXhsSmokeReportPath(): string {
		return XHS_SMOKE_REPORT_PATH;
	}

	getSmokeCasesText(platform: SupportedSmokePlatform): string {
		const inputs = platform === "xiaohongshu" ? this.settings.xhsSmokeCaseInputs : this.settings.wechatSmokeCaseInputs;
		return inputs.join("\n");
	}

	async setSmokeCasesText(platform: SupportedSmokePlatform, rawText: string): Promise<void> {
		const parsed = this.normalizeSmokeCaseInputs(rawText.split(/\r?\n/), []);
		if (platform === "xiaohongshu") {
			this.settings.xhsSmokeCaseInputs = parsed;
		} else {
			this.settings.wechatSmokeCaseInputs = parsed;
		}
		await this.saveSettings();
	}

	async openSmokeReportFile(): Promise<void> {
		await this.showTextPreviewModal(
			"Smoke 报告",
			this.getXhsSmokeReportPath(),
			`${JSON.stringify({ message: "Smoke report has not been generated yet." }, null, 2)}\n`
		);
	}

	async openXhsDebugLogFile(): Promise<void> {
		await this.showTextPreviewModal("XHS 调试日志", this.getXhsDebugLogPath(), "");
	}

	async readSmokeReportSummary(): Promise<string> {
		const reportPath = this.getXhsSmokeReportPath();
		if (!(await this.app.vault.adapter.exists(reportPath))) {
			return `报告不存在：${reportPath}`;
		}

		try {
			const text = await this.app.vault.adapter.read(reportPath);
			const report = JSON.parse(text) as {
				finishedAt?: string;
				caseCount?: number;
				successCount?: number;
				failedCount?: number;
				platformSummary?: {
					wechat?: { caseCount?: number; successCount?: number };
					xiaohongshu?: { caseCount?: number; successCount?: number };
				};
				results?: Array<{
					platform?: string;
					name?: string;
					status?: string;
					error?: string;
				}>;
			};

			const lines: string[] = [];
			lines.push(`报告路径: ${reportPath}`);
			lines.push(`完成时间: ${report.finishedAt || "unknown"}`);
			lines.push(`总计: ${report.successCount ?? 0}/${report.caseCount ?? 0} 成功, 失败 ${report.failedCount ?? 0}`);
			lines.push(
				`XHS: ${report.platformSummary?.xiaohongshu?.successCount ?? 0}/${report.platformSummary?.xiaohongshu?.caseCount ?? 0}`
			);
			lines.push(
				`Wechat: ${report.platformSummary?.wechat?.successCount ?? 0}/${report.platformSummary?.wechat?.caseCount ?? 0}`
			);

			const failed = (report.results || []).filter((item) => item.status !== "success");
			if (failed.length > 0) {
				lines.push("");
				lines.push("失败用例:");
				for (const item of failed.slice(0, 8)) {
					lines.push(`[${item.platform || "unknown"}] ${item.name || "unnamed"} -> ${item.error || "unknown error"}`);
				}
			}

			return lines.join("\n");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return `读取报告失败: ${message}`;
		}
	}

	async showTextPreviewModal(title: string, path: string, defaultContent: string): Promise<void> {
		const normalizedPath = path.trim().replace(/^\/+/, "");
		if (!normalizedPath) {
			new Notice("文件路径无效。");
			return;
		}

		const folderPath = normalizedPath.includes("/") ? normalizedPath.slice(0, normalizedPath.lastIndexOf("/")) : "";
		if (folderPath) {
			await this.ensureFolder(folderPath);
		}

		if (!(await this.app.vault.adapter.exists(normalizedPath))) {
			await this.app.vault.adapter.write(normalizedPath, defaultContent);
		}

		const content = await this.app.vault.adapter.read(normalizedPath);
		new TextPreviewModal(this.app, title, normalizedPath, content).open();
	}

	buildSmokeInputCases(platform: SupportedSmokePlatform): SmokeInputCase[] {
		const inputs = platform === "xiaohongshu" ? this.settings.xhsSmokeCaseInputs : this.settings.wechatSmokeCaseInputs;
		const prefix = platform === "xiaohongshu" ? "XHS" : "Wechat";
		return inputs.map((input, index) => {
			const compact = input.replace(/\s+/g, " ").trim();
			const shortName = compact.slice(0, 20) || `${prefix}-${index + 1}`;
			return {
				name: `${prefix}-${index + 1}: ${shortName}`,
				input,
			};
		});
	}

	async runXhsSmokeTests(): Promise<void> {
		await this.runPlatformSmokeTests(["xiaohongshu"]);
	}

	async runPlatformSmokeTests(platforms: SupportedSmokePlatform[] = ["wechat", "xiaohongshu"]): Promise<void> {
		const result = await runPlatformSmokeSuite({
			app: this.app,
			pluginVersion: this.manifest.version,
			reportPath: this.getXhsSmokeReportPath(),
			platforms,
			xhsDebugLogger: this.xhsDebugLogger,
			xhsResolver: this.xhsResolver,
			xhsNoteService: this.xhsNoteService,
			wechatArticleService: this.wechatArticleService,
			extractXhsUrl: (input) => this.extractXiaohongshuUrl(input),
			extractWechatUrl: (input) => this.extractWechatUrl(input),
			xhsCases: this.buildSmokeInputCases("xiaohongshu"),
			wechatCases: this.buildSmokeInputCases("wechat"),
		});
		new Notice(`平台 Smoke 测试完成：成功 ${result.successCount}，失败 ${result.failedCount}。报告：${result.reportPath}`);
	}

	buildXhsFrontmatter(note: XhsNoteData, category: string, cover: string): string {
		const importedAt = this.formatDateTime(new Date());
		const rows = [
			"---",
			`platform: ${this.toYamlString("xiaohongshu")}`,
			`title: ${this.toYamlString(note.title)}`,
			`source: ${this.toYamlString(note.source)}`,
			`category: ${this.toYamlString(category)}`,
			`imported_at: ${this.toYamlString(importedAt)}`,
			`cover: ${this.toYamlString(cover)}`,
			`type: ${this.toYamlString(note.isVideo ? "video" : "note")}`,
			"---",
		];
		return rows.join("\n");
	}

	async buildImageMap(
		imageUrls: string[],
		options: {
			downloadMedia: boolean;
			mediaFolder: string;
			safeMediaTitle: string;
			relativeMediaPrefix: string;
			headers?: Record<string, string>;
		}
	): Promise<Map<string, string>> {
		const map = new Map<string, string>();
		let index = 1;

		for (const rawUrl of imageUrls) {
			const normalized = this.normalizeMediaUrl(rawUrl);
			if (!normalized || map.has(normalized)) {
				continue;
			}

			if (!options.downloadMedia) {
				map.set(normalized, normalized);
				continue;
			}

			const extension = this.guessImageExtension(normalized);
			const baseName = `${options.safeMediaTitle}-${index}`;
			const downloaded = await this.downloadMediaFile(normalized, options.mediaFolder, baseName, extension, options.headers);
			const finalRef = downloaded.startsWith("http") ? downloaded : `${options.relativeMediaPrefix}/${downloaded}`;
			map.set(normalized, finalRef);
			index += 1;
		}

		return map;
	}

	async downloadMediaFile(
		url: string,
		folderPath: string,
		baseName: string,
		extension: string,
		headers?: Record<string, string>
	): Promise<string> {
		try {
			const filename = await this.getUniqueMediaFilename(folderPath, baseName, extension);
			const filePath = `${folderPath}/${filename}`;

			const response = await requestUrl({
				url,
				method: "GET",
				headers: headers || {},
				throw: false,
			});

			if (response.status >= 400) {
				throw new Error(`HTTP ${response.status}`);
			}

			await this.app.vault.adapter.writeBinary(filePath, response.arrayBuffer);
			return filename;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`Failed to download media: ${url}`, error);
			new Notice(`部分图片下载失败，已回退远程链接：${message}`);
			return url;
		}
	}

	async getUniqueMediaFilename(folderPath: string, baseName: string, extension: string): Promise<string> {
		let index = 0;
		for (;;) {
			const suffix = index === 0 ? "" : `-${index}`;
			const filename = `${baseName}${suffix}${extension}`;
			const filePath = `${folderPath}/${filename}`;
			if (!(await this.app.vault.adapter.exists(filePath))) {
				return filename;
			}
			index += 1;
		}
	}

	guessImageExtension(url: string): string {
		const wxFmtMatch = url.match(/[?&]wx_fmt=([a-zA-Z0-9]+)/i);
		if (wxFmtMatch?.[1]) {
			const format = wxFmtMatch[1].toLowerCase();
			if (format === "jpeg" || format === "jpg") {
				return ".jpg";
			}
			if (format === "png") {
				return ".png";
			}
			if (format === "gif") {
				return ".gif";
			}
			if (format === "webp") {
				return ".webp";
			}
		}

		try {
			const pathname = new URL(url).pathname;
			const extMatch = pathname.match(/\.([a-zA-Z0-9]+)$/);
			if (extMatch?.[1]) {
				const ext = extMatch[1].toLowerCase();
				if (["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(ext)) {
					return ext === "jpeg" ? ".jpg" : `.${ext}`;
				}
			}
		} catch (_error) {
			// Ignore URL parsing error and fall back to default extension.
		}

		return ".jpg";
	}

	toYamlString(value: string): string {
		const safe = (value || "")
			.replace(/\\/g, "\\\\")
			.replace(/"/g, "\\\"")
			.replace(/\r?\n/g, "\\n");
		return `"${safe}"`;
	}

	formatDateTime(date: Date): string {
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, "0");
		const day = String(date.getDate()).padStart(2, "0");
		const hour = String(date.getHours()).padStart(2, "0");
		const minute = String(date.getMinutes()).padStart(2, "0");
		const second = String(date.getSeconds()).padStart(2, "0");
		return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
	}

	sanitizePathSegment(value: string, fallback: string): string {
		const sanitized = value.replace(/[\\/:*?"<>|]/g, "-").trim();
		return sanitized || fallback;
	}

	sanitizeFileName(value: string, fallback: string): string {
		const sanitized = this.sanitizePathSegment(value, fallback).replace(/\s+/g, " ").substring(0, 120);
		return sanitized || fallback;
	}

	sanitizeMediaBaseName(value: string, fallback: string): string {
		const sanitized = value
			.replace(/[^a-zA-Z0-9\u4e00-\u9fa5\s-_]/g, "")
			.trim()
			.replace(/\s+/g, "-")
			.substring(0, 96);
		return sanitized || fallback;
	}

	toMarkdownDestination(value: string): string {
		if (!value) {
			return value;
		}
		if (/[\s()<>]/.test(value)) {
			return `<${value}>`;
		}
		return value;
	}

	normalizeMarkdownSpacing(markdown: string): string {
		if (!markdown) {
			return "";
		}

		const normalized = markdown
			.replace(/\r\n/g, "\n")
			.replace(/\u00a0/g, " ")
			.replace(/\u200b/g, "");

		const lines = normalized.split("\n");
		const output: string[] = [];
		let previousWasBlank = false;

		for (const rawLine of lines) {
			const cleanedLine = rawLine.replace(/[ \t\u3000]+$/g, "");
			const isBlank = cleanedLine.replace(/[ \t\u3000]/g, "") === "";

			if (isBlank) {
				if (!previousWasBlank) {
					output.push("");
				}
				previousWasBlank = true;
				continue;
			}

			output.push(cleanedLine);
			previousWasBlank = false;
		}

		return output.join("\n").replace(/^\n+|\n+$/g, "");
	}

	async ensureFolder(folderPath: string): Promise<void> {
		if (!folderPath) {
			return;
		}

		const parts = folderPath.split("/").filter(Boolean);
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!(await this.app.vault.adapter.exists(current))) {
				await this.app.vault.createFolder(current);
			}
		}
	}

	async getUniqueNotePath(folderPath: string, baseName: string): Promise<string> {
		let index = 0;
		for (;;) {
			const suffix = index === 0 ? "" : `-${index}`;
			const filePath = folderPath ? `${folderPath}/${baseName}${suffix}.md` : `${baseName}${suffix}.md`;
			if (!(await this.app.vault.adapter.exists(filePath))) {
				return filePath;
			}
			index += 1;
		}
	}

	normalizeMediaUrl(url: string): string {
		if (!url) {
			return "";
		}

		let normalized = this.decodeHtmlEntities(this.decodeJsEscapedString(url.trim()));
		normalized = normalized.replace(/\\x26amp;/gi, "&").replace(/&amp;/gi, "&");
		normalized = normalized.replace(/\u0026/gi, "&");
		normalized = normalized.replace(/^\/\//, "https://");
		if (/^http:\/\//i.test(normalized)) {
			normalized = normalized.replace(/^http:\/\//i, "https://");
		}

		if (!/^https?:\/\//i.test(normalized)) {
			return "";
		}

		return normalized.trim();
	}

	decodeJsEscapedString(value: string): string {
		if (!value) {
			return "";
		}
		return this.decodeHtmlEntities(
			value
				.replace(/\\'/g, "'")
				.replace(/\\"/g, '"')
				.replace(/\\n/g, "\n")
				.replace(/\\r/g, "\r")
				.replace(/\\t/g, "\t")
				.replace(/\\\\/g, "\\")
		);
	}

	decodeHtmlEntities(value: string): string {
		if (!value) {
			return "";
		}

		const named: Record<string, string> = {
			amp: "&",
			lt: "<",
			gt: ">",
			quot: '"',
			apos: "'",
			nbsp: " ",
		};

		return value.replace(/&(#x?[0-9A-Fa-f]+|[a-zA-Z]+);/g, (_all, token: string) => {
			if (token.startsWith("#x") || token.startsWith("#X")) {
				const codePoint = parseInt(token.slice(2), 16);
				return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _all;
			}
			if (token.startsWith("#")) {
				const codePoint = parseInt(token.slice(1), 10);
				return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _all;
			}
			return named[token] ?? _all;
		});
	}
}
