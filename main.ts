import {
	AbstractInputSuggest,
	App,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFolder,
	requestUrl,
} from "obsidian";
import { buildSmokeSuiteReport } from "./src/plugin/smoke-report";
import { XHS_SMOKE_REPORT_PATH } from "./src/shared/paths";
import { XhsNoteData, XhsNoteService } from "./src/platforms/xhs/note-service";
import { XhsDebugLogger } from "./src/platforms/xhs/debug-logger";
import { XhsResolver } from "./src/platforms/xhs/resolver";
import { XHS_SMOKE_CASES } from "./src/platforms/xhs/smoke-cases";
import { WechatArticleService } from "./src/platforms/wechat/article-service";
import { buildWechatHeaders } from "./src/platforms/wechat/headers";

interface ImporterSettings {
	defaultFolder: string;
	categories: string[];
	lastCategory: string;
	lastCustomFolder: string;
	downloadMedia: boolean;
	xhsDebugEnabled: boolean;
}

interface ImportInput {
	text: string | null;
	category: string;
	downloadMedia: boolean;
	useCustomFolder: boolean;
	customFolderPath: string;
}

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
};

const CUSTOM_FOLDER_CATEGORY = "自定义文件夹";

interface XhsSmokeCaseResult {
	name: string;
	input: string;
	extractedUrl: string;
	resolvedUrl: string;
	hasXsecToken: boolean;
	unavailablePage: boolean;
	title: string;
	isVideo: boolean;
	status: "success" | "failed";
	error: string;
}

interface ImportDestination {
	categoryName: string;
	folderPath: string;
	useCustomFolder: boolean;
	customFolderPath: string;
}

class VaultFolderPathSuggest extends AbstractInputSuggest<string> {
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
	}

	async saveSettings() {
		await this.saveData(this.settings);
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
			const resolvedUrl = await this.resolveXiaohongshuUrl(url);
			await this.xhsDebugLogger.append("import-resolved-url", { resolvedUrl });
			const html = await this.fetchXiaohongshuHtml(resolvedUrl);
			const note = this.extractXhsNoteData(resolvedUrl, html);
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

	async fetchXiaohongshuHtml(url: string): Promise<string> {
		return this.xhsNoteService.fetchHtml(url);
	}

	async resolveXiaohongshuUrl(url: string): Promise<string> {
		return this.xhsResolver.resolve(url);
	}

	getXhsDebugLogPath(): string {
		return this.xhsDebugLogger.getLogPath();
	}

	getXhsSmokeReportPath(): string {
		return XHS_SMOKE_REPORT_PATH;
	}

	async runXhsSmokeTests(): Promise<void> {
		const startedAt = new Date().toISOString();
		await this.xhsDebugLogger.reset("SMOKE_SUITE");
		await this.xhsDebugLogger.append("smoke-suite-start", { caseCount: XHS_SMOKE_CASES.length });

		const results: XhsSmokeCaseResult[] = [];
		for (const testCase of XHS_SMOKE_CASES) {
			const extracted = this.extractXiaohongshuUrl(testCase.input) || "";
			if (!extracted) {
				results.push({
					name: testCase.name,
					input: testCase.input,
					extractedUrl: "",
					resolvedUrl: "",
					hasXsecToken: false,
					unavailablePage: false,
					title: "",
					isVideo: false,
					status: "failed",
					error: "未能从输入文本识别出小红书链接",
				});
				continue;
			}

			await this.xhsDebugLogger.append("smoke-case-start", { name: testCase.name, extractedUrl: extracted });
			let resolvedUrl = "";
			let hasXsecToken = false;
			try {
				resolvedUrl = await this.resolveXiaohongshuUrl(extracted);
				hasXsecToken = /[?&]xsec_token=/i.test(resolvedUrl);
				const html = await this.fetchXiaohongshuHtml(resolvedUrl);
				const note = this.extractXhsNoteData(resolvedUrl, html);
				const unavailable = this.isXhsUnavailablePage(html);
				results.push({
					name: testCase.name,
					input: testCase.input,
					extractedUrl: extracted,
					resolvedUrl,
					hasXsecToken,
					unavailablePage: unavailable,
					title: note.title,
					isVideo: note.isVideo,
					status: "success",
					error: "",
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				results.push({
					name: testCase.name,
					input: testCase.input,
					extractedUrl: extracted,
					resolvedUrl,
					hasXsecToken,
					unavailablePage: /不可访问|unavailable/i.test(message),
					title: "",
					isVideo: false,
					status: "failed",
					error: message,
				});
			}
		}

		const successCount = results.filter((item) => item.status === "success").length;
		const failedCount = results.length - successCount;
		const report = buildSmokeSuiteReport(
			this.manifest.version,
			startedAt,
			results,
			successCount,
			failedCount
		);

		const reportPath = this.getXhsSmokeReportPath();
		await this.app.vault.adapter.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
		await this.xhsDebugLogger.append("smoke-suite-finished", {
			successCount,
			failedCount,
			reportPath,
		});
		new Notice(`XHS Smoke 测试完成：成功 ${successCount}，失败 ${failedCount}。报告：${reportPath}`);
	}

	isXhsUnavailablePage(html: string): boolean {
		return this.xhsNoteService.isUnavailablePage(html);
	}

	extractXhsNoteData(sourceUrl: string, html: string): XhsNoteData {
		return this.xhsNoteService.extractNoteData(sourceUrl, html);
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

class ImporterSettingTab extends PluginSettingTab {
	plugin: MultiSourceImporterPlugin;

	constructor(app: App, plugin: MultiSourceImporterPlugin) {
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
			text: `实网 Smoke 报告路径：${this.plugin.getXhsSmokeReportPath()}（可通过命令面板“运行小红书实网 Smoke 测试”生成）`,
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

class ImportSourceModal extends Modal {
	result: ImportInput | null = null;
	onSubmit: (result: ImportInput | null) => void;
	settings: ImporterSettings;
	selectedCategory: string;
	downloadMedia: boolean;
	customFolderPath: string;

	constructor(app: App, settings: ImporterSettings, onSubmit: (result: ImportInput | null) => void) {
		super(app);
		this.settings = settings;
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
		if (this.settings.lastCategory && this.settings.categories.includes(this.settings.lastCategory)) {
			return this.settings.lastCategory;
		}
		return this.settings.categories[0] || "其他";
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
				placeholder: "例如：\\nhttps://mp.weixin.qq.com/s/xxxxxx\\nhttps://www.xiaohongshu.com/explore/xxxxxx",
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
		new VaultFolderPathSuggest(this.app, customFolderInput);

		const categoryList = [...this.settings.categories, "其他", CUSTOM_FOLDER_CATEGORY];
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
				const normalizedPath = this.normalizeCustomFolderInput(this.customFolderPath);
				if (!normalizedPath) {
					new Notice("请选择自定义文件夹路径。");
					return;
				}
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
