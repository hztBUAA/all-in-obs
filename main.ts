import {
	App,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	requestUrl,
} from "obsidian";
import TurndownService from "turndown";

interface WechatImporterSettings {
	defaultFolder: string;
	categories: string[];
	lastCategory: string;
	downloadMedia: boolean;
	feishuSessionCookie: string;
}

interface ImportInput {
	text: string | null;
	category: string;
	downloadMedia: boolean;
}

type SupportedPlatform = "wechat" | "xiaohongshu" | "feishu";

interface ImportTarget {
	platform: SupportedPlatform;
	url: string;
}

interface BatchExtractResult {
	targets: ImportTarget[];
	invalidLines: string[];
}

interface WechatArticleData {
	title: string;
	description: string;
	source: string;
	account: string;
	wechatId: string;
	alias: string;
	author: string;
	publishedAt: string;
	publishedTs: number;
	cover: string;
	type: string;
	contentHtml: string;
	contentMarkdown: string;
	images: string[];
}

interface XhsNoteData {
	title: string;
	source: string;
	content: string;
	images: string[];
	videoUrl: string | null;
	isVideo: boolean;
	tags: string[];
	cover: string;
}

interface FeishuDocData {
	title: string;
	source: string;
	docToken: string;
	docType: "docs" | "docx";
	description: string;
	contentHtml: string;
	contentMarkdown: string;
	images: string[];
}

const DEFAULT_SETTINGS: WechatImporterSettings = {
	defaultFolder: "External Files",
	categories: ["科技", "商业", "产品", "投资", "研究"],
	lastCategory: "",
	downloadMedia: true,
	feishuSessionCookie: "",
};

const WECHAT_REFERER = "https://mp.weixin.qq.com/";

export default class WechatArticleImporterPlugin extends Plugin {
	settings: WechatImporterSettings;

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon("book", "导入内容（微信 / 小红书 / 飞书）", async () => {
			await this.handleImportAction();
		});

		this.addCommand({
			id: "import-article",
			name: "导入内容（微信 / 小红书 / 飞书）",
			callback: async () => {
				await this.handleImportAction();
			},
		});

		this.addSettingTab(new WechatImporterSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async handleImportAction() {
		const input = await this.promptForImportInput();
		if (!input?.text) {
			return;
		}

		const batch = this.extractBatchImportTargets(input.text);
		if (batch.targets.length === 0) {
			new Notice("未识别到有效链接。目前支持微信公众号、小红书和飞书文档。");
			return;
		}

		if (batch.targets.length === 1) {
			await this.importByPlatform(batch.targets[0], input.category, input.downloadMedia, false);
			return;
		}

		if (batch.invalidLines.length > 0) {
			new Notice(`检测到 ${batch.invalidLines.length} 行无效输入，已自动跳过。`);
		}

		let success = 0;
		let failed = 0;
		for (const target of batch.targets) {
			const ok = await this.importByPlatform(target, input.category, input.downloadMedia, true);
			if (ok) {
				success += 1;
			} else {
				failed += 1;
			}
		}

		new Notice(`批量导入完成：成功 ${success}，失败 ${failed}。`);
	}

	async importByPlatform(target: ImportTarget, category: string, downloadMedia: boolean, silent = false): Promise<boolean> {
		if (target.platform === "wechat") {
			return await this.importWechatArticle(target.url, category, downloadMedia, silent);
		}
		if (target.platform === "feishu") {
			return await this.importFeishuDoc(target.url, category, downloadMedia, silent);
		}
		return await this.importXiaohongshuNote(target.url, category, downloadMedia, silent);
	}

	async promptForImportInput(): Promise<ImportInput | null> {
		return new Promise((resolve) => {
			const modal = new WechatInputModal(this.app, this.settings, (result) => resolve(result));
			modal.open();
		});
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

		const feishuUrl = this.extractFeishuUrl(input);
		if (feishuUrl) {
			return { platform: "feishu", url: feishuUrl };
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

	extractFeishuUrl(input: string): string | null {
		const normalizedInput = input.replace(/&amp;/g, "&");
		const pattern =
			/(https?:\/\/[\w.-]+\.(?:feishu\.cn|larksuite\.com|larkoffice\.com)\/(?:docs|docx)\/[a-zA-Z0-9]+(?:\?[^\s，,]*)?)/i;
		const match = normalizedInput.match(pattern);
		return match?.[1] ? this.normalizeFeishuUrl(match[1]) : null;
	}

	normalizeFeishuUrl(url: string): string {
		const normalized = this.normalizeArticleUrl(url);
		try {
			const parsed = new URL(normalized);
			const token = this.extractFeishuDocToken(normalized);
			if (!token) {
				return normalized;
			}

			const docType = parsed.pathname.includes("/docx/") ? "docx" : "docs";
			return `${parsed.origin}/${docType}/${token}`;
		} catch (_error) {
			return normalized;
		}
	}

	extractFeishuDocToken(url: string): string {
		try {
			const parsed = new URL(url);
			const match = parsed.pathname.match(/\/(?:docs|docx)\/([a-zA-Z0-9]+)/i);
			return match?.[1] ?? "";
		} catch (_error) {
			return "";
		}
	}

	normalizeXiaohongshuUrl(url: string): string {
		const normalized = this.normalizeArticleUrl(url);
		try {
			const parsed = new URL(normalized);
			if (!/xiaohongshu\.com$/i.test(parsed.hostname)) {
				return normalized;
			}

			const match = parsed.pathname.match(/\/(?:explore|discovery\/item)\/([a-zA-Z0-9]+)/i);
			if (!match?.[1]) {
				return normalized.replace("/explore/", "/discovery/item/");
			}

			return `https://www.xiaohongshu.com/discovery/item/${match[1]}`;
		} catch (_error) {
			return normalized.replace("/explore/", "/discovery/item/");
		}
	}

	normalizeArticleUrl(url: string): string {
		let normalized = url.trim().replace(/&amp;/g, "&");
		normalized = normalized.replace(/[。！!）)\]】>,，,]+$/, "");
		normalized = normalized.replace(/#wechat_redirect$/, "");
		return normalized;
	}

	buildWechatHeaders(articleUrl: string): Record<string, string> {
		return {
			"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
			"Referer": WECHAT_REFERER,
			"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
			"Cache-Control": "no-cache",
			"Sec-Fetch-Site": "none",
			"Sec-Fetch-Mode": "navigate",
			"Sec-Fetch-Dest": "document",
			"X-Requested-With": "XMLHttpRequest",
			"X-Source-URL": articleUrl,
		};
	}

	isVerificationPage(html: string): boolean {
		return /环境异常|去验证|secitptpage\/template\/verify|TCaptcha|wappoc_appmsgcaptcha/i.test(html);
	}

	async importWechatArticle(url: string, category: string, downloadMedia: boolean, silent = false): Promise<boolean> {
		try {
			const normalizedUrl = this.normalizeArticleUrl(url);
			const html = await this.fetchWechatHtml(normalizedUrl);
			const article = this.extractWechatArticle(normalizedUrl, html);

			if (!article.contentHtml.trim()) {
				throw new Error("未提取到正文内容");
			}

			const baseFolder = this.settings.defaultFolder.trim();
			const categoryName = category.trim() || "其他";
			const folderPath = baseFolder
				? `${baseFolder}/${this.sanitizePathSegment(categoryName, "其他")}`
				: this.sanitizePathSegment(categoryName, "其他");

			await this.ensureFolder(folderPath);

			let imageMap = new Map<string, string>();
			const safeTitle = this.sanitizeFileName(article.title, "Untitled WeChat Article");
			const safeMediaTitle = this.sanitizeMediaBaseName(article.title, "Untitled-WeChat-Article");
			const mediaRootFolder = baseFolder ? `${baseFolder}/media` : "media";
			const mediaFolder = `${mediaRootFolder}/${safeMediaTitle}`;
			const relativeMediaPrefix = `../media/${safeMediaTitle}`;

			if (article.images.length > 0) {
				if (downloadMedia) {
					await this.ensureFolder(mediaFolder);
				}

				imageMap = await this.buildImageMap(article.images, {
					downloadMedia,
					mediaFolder,
					safeMediaTitle,
					relativeMediaPrefix,
					headers: this.buildWechatHeaders(normalizedUrl),
				});
			}

			article.contentMarkdown = this.convertHtmlToMarkdown(article.contentHtml, imageMap);

			const normalizedCover = this.normalizeMediaUrl(article.cover);
			const finalCover = normalizedCover ? (imageMap.get(normalizedCover) ?? normalizedCover) : "";

			const frontmatter = this.buildWechatFrontmatter(article, categoryName, finalCover);
			const markdown = `${frontmatter}\n# ${article.title}\n\n${article.contentMarkdown}\n`;

			const filePath = await this.getUniqueNotePath(folderPath, safeTitle);
			const file = await this.app.vault.create(filePath, markdown);
			await this.app.workspace.getLeaf(true).openFile(file);

			this.settings.lastCategory = categoryName;
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

	async fetchWechatHtml(url: string): Promise<string> {
		const response = await requestUrl({
			url,
			method: "GET",
			headers: this.buildWechatHeaders(url),
			throw: false,
		});

		if (response.status >= 400) {
			throw new Error(`请求失败（HTTP ${response.status}）`);
		}

		if (this.isVerificationPage(response.text)) {
			throw new Error("微信返回了验证页面（环境异常/去验证），请稍后重试或更换网络环境。");
		}

		return response.text;
	}

	buildFeishuHeaders(url: string): Record<string, string> {
		const headers: Record<string, string> = {
			"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
			"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
			Referer: url,
		};
		const sessionCookie = this.settings.feishuSessionCookie.trim();
		if (sessionCookie) {
			headers.Cookie = sessionCookie;
		}
		return headers;
	}

	async importFeishuDoc(url: string, category: string, downloadMedia: boolean, silent = false): Promise<boolean> {
		try {
			const normalizedUrl = this.normalizeFeishuUrl(url);
			const html = await this.fetchFeishuHtml(normalizedUrl);
			const doc = this.extractFeishuDocData(normalizedUrl, html);
			if (!doc.contentHtml.trim()) {
				throw new Error("未提取到飞书文档正文");
			}

			const existingFile = await this.findMarkdownFileByFrontmatter("feishu_doc_token", doc.docToken);
			const baseFolder = this.settings.defaultFolder.trim();
			const categoryName = existingFile?.parent?.name || category.trim() || "其他";
			const folderPath = baseFolder
				? `${baseFolder}/${this.sanitizePathSegment(categoryName, "其他")}`
				: this.sanitizePathSegment(categoryName, "其他");

			if (!existingFile) {
				await this.ensureFolder(folderPath);
			}

			let imageMap = new Map<string, string>();
			const safeTitle = this.sanitizeFileName(doc.title, "Untitled Feishu Doc");
			const safeMediaTitle = this.sanitizeMediaBaseName(doc.title, "Untitled-Feishu-Doc");
			const mediaRootFolder = baseFolder ? `${baseFolder}/media` : "media";
			const mediaFolder = `${mediaRootFolder}/${safeMediaTitle}`;
			const relativeMediaPrefix = `../media/${safeMediaTitle}`;

			if (doc.images.length > 0) {
				if (downloadMedia) {
					await this.ensureFolder(mediaFolder);
				}
				imageMap = await this.buildImageMap(doc.images, {
					downloadMedia,
					mediaFolder,
					safeMediaTitle,
					relativeMediaPrefix,
					headers: this.buildFeishuHeaders(normalizedUrl),
				});
			}

			doc.contentMarkdown = this.convertHtmlToMarkdown(doc.contentHtml, imageMap);
			const frontmatter = this.buildFeishuFrontmatter(doc, categoryName);
			const markdown = `${frontmatter}\n# ${doc.title}\n\n${doc.contentMarkdown}\n`;

			let filePath = "";
			let fileToOpen = existingFile;
			if (existingFile) {
				await this.app.vault.modify(existingFile, markdown);
				filePath = existingFile.path;
			} else {
				filePath = await this.getUniqueNotePath(folderPath, safeTitle);
				fileToOpen = await this.app.vault.create(filePath, markdown);
			}

			if (fileToOpen) {
				await this.app.workspace.getLeaf(true).openFile(fileToOpen);
			}

			this.settings.lastCategory = categoryName;
			await this.saveSettings();
			if (!silent) {
				const verb = existingFile ? "已更新飞书文档" : "已导入飞书文档";
				new Notice(`${verb}：${filePath}`);
			}
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error("Failed to import Feishu doc:", error);
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

	async importXiaohongshuNote(url: string, category: string, downloadMedia: boolean, silent = false): Promise<boolean> {
		try {
			const resolvedUrl = await this.resolveXiaohongshuUrl(url);
			const html = await this.fetchXiaohongshuHtml(resolvedUrl);
			const note = this.extractXhsNoteData(resolvedUrl, html);
			const cleanContent = note.content.trim();

			const baseFolder = this.settings.defaultFolder.trim();
			const categoryName = category.trim() || "其他";
			const folderPath = baseFolder
				? `${baseFolder}/${this.sanitizePathSegment(categoryName, "其他")}`
				: this.sanitizePathSegment(categoryName, "其他");

			await this.ensureFolder(folderPath);

			const safeTitle = this.sanitizeFileName(note.title, "Untitled Xiaohongshu Note");
			const safeMediaTitle = this.sanitizeMediaBaseName(note.title, "Untitled-XHS-Note");
			const mediaRootFolder = baseFolder ? `${baseFolder}/media` : "media";
			const mediaFolder = `${mediaRootFolder}/${safeMediaTitle}`;
			const relativeMediaPrefix = `../media/${safeMediaTitle}`;
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

			this.settings.lastCategory = categoryName;
			await this.saveSettings();
			if (!silent) {
				new Notice(`已导入小红书内容：${filePath}`);
			}
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error("Failed to import Xiaohongshu note:", error);
			if (!silent) {
				new Notice(`导入失败：${message}`);
			}
			return false;
		}
	}

	async fetchXiaohongshuHtml(url: string): Promise<string> {
		const response = await requestUrl({
			url,
			method: "GET",
			headers: this.buildXiaohongshuHeaders(),
			throw: false,
		});

		if (response.status >= 400) {
			throw new Error(`请求失败（HTTP ${response.status}）`);
		}

		return response.text;
	}

	async resolveXiaohongshuUrl(url: string): Promise<string> {
		const normalized = this.normalizeArticleUrl(url);
		if (!/xhslink\.com/i.test(normalized)) {
			return this.normalizeXiaohongshuUrl(normalized);
		}

		const response = await requestUrl({
			url: normalized,
			method: "GET",
			headers: this.buildXiaohongshuHeaders(),
			throw: false,
		});

		const match = response.text.match(
			/https?:\/\/www\.xiaohongshu\.com\/(?:discovery\/item|explore)\/[a-zA-Z0-9]+(?:\?[^"'<>\\s]*)?/i
		);
		if (match?.[0]) {
			return this.normalizeXiaohongshuUrl(this.decodeHtmlEntities(match[0]));
		}

		throw new Error("小红书短链解析失败，请改用帖子详情页链接重试。");
	}

	async fetchFeishuHtml(url: string): Promise<string> {
		const response = await requestUrl({
			url,
			method: "GET",
			headers: this.buildFeishuHeaders(url),
			throw: false,
		});

		if (response.status >= 400) {
			throw new Error(`请求失败（HTTP ${response.status}）`);
		}

		if (this.isFeishuPermissionPage(response.text)) {
			throw new Error("飞书文档不可公开访问，当前仅支持公网可获取文档。");
		}

		return response.text;
	}

	isFeishuPermissionPage(html: string): boolean {
		return /无权限访问|申请权限|权限不足|文档不存在|页面不存在|登录后查看|继续访问飞书/i.test(html);
	}

	extractFeishuDocData(sourceUrl: string, html: string): FeishuDocData {
		const docToken = this.extractFeishuDocToken(sourceUrl);
		const docType = sourceUrl.includes("/docx/") ? "docx" : "docs";
		const title = this.pickFirst([
			this.extractMetaContent(html, "property", "og:title"),
			this.extractMetaContent(html, "name", "twitter:title"),
			this.extractFeishuTitleTag(html),
		]) || `Untitled Feishu Doc ${docToken}`;
		const description = this.pickFirst([
			this.extractMetaContent(html, "name", "description"),
			this.extractMetaContent(html, "property", "og:description"),
		]);
		const contentHtml = this.extractFeishuContentHtml(html);
		const images = this.extractImageUrlsFromContent(contentHtml, "");

		return {
			title: this.cleanText(title),
			source: sourceUrl,
			docToken,
			docType,
			description: this.cleanText(description),
			contentHtml,
			contentMarkdown: "",
			images,
		};
	}

	extractFeishuTitleTag(html: string): string {
		const match = html.match(/<title>([\s\S]*?)<\/title>/i);
		if (!match?.[1]) {
			return "";
		}
		return this.decodeHtmlEntities(match[1])
			.replace(/\s*-\s*飞书云文档\s*$/, "")
			.replace(/\s*-\s*飞书\s*$/, "")
			.trim();
	}

	extractFeishuContentHtml(html: string): string {
		try {
			const doc = new DOMParser().parseFromString(html, "text/html");
			const selectors = [
				"main",
				"[role='main']",
				"article",
				".docx-container",
				".docx-viewer-container",
				".lark-doc-content",
				".lark-editor",
				".op-wiki-page-content",
				".docs-container",
				".doc-content",
			];

			let bestHtml = "";
			let bestScore = 0;
			for (const selector of selectors) {
				doc.querySelectorAll(selector).forEach((node) => {
					const cleaned = node.cloneNode(true) as HTMLElement;
					cleaned.querySelectorAll("script, style, noscript, iframe, svg, nav, header, footer, aside, button").forEach((el) => el.remove());
					const textLength = (cleaned.textContent || "").replace(/\s+/g, " ").trim().length;
					const imageCount = cleaned.querySelectorAll("img").length;
					const score = textLength + imageCount * 80;
					if (score > bestScore) {
						bestScore = score;
						bestHtml = cleaned.innerHTML || cleaned.outerHTML;
					}
				});
			}

			return bestScore >= 80 ? bestHtml : "";
		} catch (_error) {
			return "";
		}
	}

	extractXhsNoteData(sourceUrl: string, html: string): XhsNoteData {
		const titleMatch = html.match(/<title>(.*?)<\/title>/);
		const title = titleMatch?.[1]?.replace(" - 小红书", "").trim() || "Untitled Xiaohongshu Note";
		const state = this.parseXhsState(html);
		const note = state ? this.getXhsNoteObject(state) : null;

		const images = this.extractXhsImages(note);
		const videoUrl = this.extractXhsVideoUrl(note);
		const isVideo = note?.type === "video";

		const contentFromHtml = html.match(/<div id="detail-desc" class="desc">([\s\S]*?)<\/div>/)?.[1] || "";
		const content = this.extractXhsContent(note, contentFromHtml);
		const tags = this.extractXhsTags(content);
		const normalizedContent = content
			.replace(/#[^#\s]*(?:\s+#[^#\s]*)*\s*/g, "")
			.trim();

		return {
			title,
			source: sourceUrl,
			content: normalizedContent,
			images,
			videoUrl,
			isVideo,
			tags,
			cover: images[0] || "",
		};
	}

	parseXhsState(html: string): any | null {
		const stateMatch = html.match(/window\.__INITIAL_STATE__=(.*?)<\/script>/s);
		if (!stateMatch?.[1]) {
			return null;
		}

		try {
			const jsonStr = stateMatch[1].trim();
			const cleanedJson = jsonStr.replace(/undefined/g, "null");
			return JSON.parse(cleanedJson);
		} catch (_error) {
			return null;
		}
	}

	getXhsNoteObject(state: any): any | null {
		try {
			const map = state?.note?.noteDetailMap;
			if (!map || typeof map !== "object") {
				return null;
			}
			const noteId = Object.keys(map)[0];
			return map[noteId]?.note ?? null;
		} catch (_error) {
			return null;
		}
	}

	extractXhsImages(note: any): string[] {
		const list = Array.isArray(note?.imageList) ? note.imageList : [];
		return list
			.map((img: any) => this.normalizeMediaUrl(img?.urlDefault || ""))
			.filter((url: string) => !!url);
	}

	extractXhsVideoUrl(note: any): string | null {
		const stream = note?.video?.media?.stream;
		const h264 = Array.isArray(stream?.h264) ? stream.h264 : [];
		const h265 = Array.isArray(stream?.h265) ? stream.h265 : [];
		const picked = h264[0]?.masterUrl || h265[0]?.masterUrl || "";
		const normalized = this.normalizeMediaUrl(picked);
		return normalized || null;
	}

	extractXhsContent(note: any, contentFromHtml: string): string {
		const htmlText = contentFromHtml
			.replace(/<[^>]+>/g, "")
			.replace(/\[话题\]/g, "")
			.replace(/\[[^\]]+\]/g, "")
			.trim();
		if (htmlText) {
			return htmlText;
		}

		const desc = (note?.desc || "")
			.replace(/\[话题\]/g, "")
			.replace(/\[[^\]]+\]/g, "")
			.trim();
		return desc;
	}

	extractXhsTags(content: string): string[] {
		const matches = content.match(/#\S+/g) || [];
		return matches.map((tag) => tag.replace(/^#/, "").trim()).filter((tag) => !!tag);
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

	buildFeishuFrontmatter(doc: FeishuDocData, category: string): string {
		const importedAt = this.formatDateTime(new Date());
		const rows = [
			"---",
			`platform: ${this.toYamlString("feishu")}`,
			`title: ${this.toYamlString(doc.title)}`,
			`source: ${this.toYamlString(doc.source)}`,
			`feishu_doc_token: ${this.toYamlString(doc.docToken)}`,
			`feishu_doc_type: ${this.toYamlString(doc.docType)}`,
			`access_mode: ${this.toYamlString("public")}`,
			`imported_at: ${this.toYamlString(importedAt)}`,
			`category: ${this.toYamlString(category)}`,
			`description: ${this.toYamlString(doc.description)}`,
			"type: \"doc\"",
			"---",
		];
		return rows.join("\n");
	}

	extractWechatArticle(sourceUrl: string, html: string): WechatArticleData {
		const cgiSegment = this.extractCgiDataSegment(html);

		const title = this.pickFirst([
			this.decodeJsDecodeValue(this.extractJsDecodeProp(cgiSegment, "title")),
			this.decodeJsEscapedString(this.extractVarSingleQuoted(html, "msg_title", "\\.html\\(false\\)")),
			this.extractMetaContent(html, "property", "og:title"),
			this.extractTitleTag(html),
		]) || "Untitled WeChat Article";

		const description = this.pickFirst([
			this.decodeJsDecodeValue(this.extractJsDecodeProp(cgiSegment, "desc")),
			this.decodeJsEscapedString(this.extractVarHtmlDecodeDoubleQuoted(html, "msg_desc")),
			this.extractMetaContent(html, "name", "description"),
		]) || "";

		const account = this.pickFirst([
			this.decodeJsDecodeValue(this.extractJsDecodeProp(cgiSegment, "nick_name")),
			this.decodeJsEscapedString(this.extractVarHtmlDecodeDoubleQuoted(html, "nickname")),
		]) || "";

		const wechatId = this.pickFirst([
			this.decodeJsDecodeValue(this.extractJsDecodeProp(cgiSegment, "user_name")),
			this.decodeJsEscapedString(this.extractVarDoubleQuoted(html, "user_name")),
		]) || "";

		const alias = this.pickFirst([
			this.decodeJsDecodeValue(this.extractJsDecodeProp(cgiSegment, "alias")),
			this.decodeJsEscapedString(this.extractWindowDoubleQuoted(html, "alias")),
		]) || "";

		const author = this.pickFirst([
			this.decodeJsDecodeValue(this.extractJsDecodeProp(cgiSegment, "author")),
			this.decodeJsEscapedString(this.extractVarDoubleQuoted(html, "author")),
		]) || "";

		const publishedAtRaw = this.pickFirst([
			this.decodeJsDecodeValue(this.extractJsDecodeProp(cgiSegment, "create_time")),
			this.decodeJsDecodeValue(this.extractJsDecodeProp(cgiSegment, "ori_create_time")),
		]) || "";

		const publishedTs = this.pickNumber([
			this.extractNumericProp(cgiSegment, "ori_create_time"),
			this.extractNumericVar(html, "ct"),
			this.extractNumericVar(html, "create_time"),
		]);

		const publishedAt = publishedAtRaw || (publishedTs > 0 ? this.formatUnixTime(publishedTs) : "");

		const cover = this.pickFirst([
			this.decodeJsDecodeValue(this.extractJsDecodeProp(cgiSegment, "cdn_url")),
			this.decodeJsEscapedString(this.extractVarDoubleQuoted(html, "msg_cdn_url")),
			this.extractMetaContent(html, "property", "og:image"),
		]) || "";

		const type = this.pickFirst([
			this.extractNumericType(cgiSegment),
			this.decodeJsEscapedString(this.extractVarDoubleQuoted(html, "appmsg_type")),
		]) || "article";

		let contentHtml = this.extractJsContentHtml(html);
		if (!contentHtml) {
			contentHtml = this.decodeJsDecodeValue(this.extractContentNoEncode(cgiSegment));
		}
		contentHtml = this.cleanContentHtml(contentHtml);

		const images = this.extractImageUrlsFromContent(contentHtml, cover);

		return {
			title: this.cleanText(title),
			description: this.cleanText(description),
			source: sourceUrl,
			account: this.cleanText(account),
			wechatId: this.cleanText(wechatId),
			alias: this.cleanText(alias),
			author: this.cleanText(author),
			publishedAt: this.cleanText(publishedAt),
			publishedTs,
			cover: this.normalizeMediaUrl(cover),
			type: this.cleanText(type),
			contentHtml,
			contentMarkdown: "",
			images,
		};
	}

	extractCgiDataSegment(html: string): string {
		const marker = "window.cgiDataNew";
		const startIndex = html.indexOf(marker);
		if (startIndex < 0) {
			return html;
		}

		const maxLength = 650000;
		return html.slice(startIndex, startIndex + maxLength);
	}

	extractJsDecodeProp(text: string, prop: string): string {
		const escaped = prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`${escaped}\\s*:\\s*JsDecode\\('([\\s\\S]*?)'\\)`);
		return regex.exec(text)?.[1] ?? "";
	}

	extractVarDoubleQuoted(text: string, variableName: string): string {
		const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`var\\s+${escaped}\\s*=\\s*"([\\s\\S]*?)"`);
		return regex.exec(text)?.[1] ?? "";
	}

	extractWindowDoubleQuoted(text: string, variableName: string): string {
		const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`window\\.${escaped}\\s*=\\s*"([\\s\\S]*?)"`);
		return regex.exec(text)?.[1] ?? "";
	}

	extractVarSingleQuoted(text: string, variableName: string, suffixPattern = ""): string {
		const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`var\\s+${escaped}\\s*=\\s*'([\\s\\S]*?)'${suffixPattern}`);
		return regex.exec(text)?.[1] ?? "";
	}

	extractVarHtmlDecodeDoubleQuoted(text: string, variableName: string): string {
		const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`var\\s+${escaped}\\s*=\\s*htmlDecode\\("([\\s\\S]*?)"\\)`);
		return regex.exec(text)?.[1] ?? "";
	}

	extractNumericVar(text: string, variableName: string): number {
		const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`var\\s+${escaped}\\s*=\\s*"?(\\d{8,13})"?`);
		const value = regex.exec(text)?.[1] ?? "";
		return this.toNumber(value);
	}

	extractNumericProp(text: string, propName: string): number {
		const escaped = propName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`${escaped}\\s*:\\s*'?(\\d{8,13})'?\\s*\\*?\\s*1?`);
		const value = regex.exec(text)?.[1] ?? "";
		return this.toNumber(value);
	}

	extractNumericType(text: string): string {
		const regex = /type\s*:\s*'?(\d+)'?\s*\*\s*1/;
		return regex.exec(text)?.[1] ?? "";
	}

	extractMetaContent(html: string, attrName: string, attrValue: string): string {
		const escaped = attrValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`<meta\\s+${attrName}=["']${escaped}["']\\s+content=["']([^"']*)["']`, "i");
		return this.decodeHtmlEntities(regex.exec(html)?.[1] ?? "");
	}

	extractTitleTag(html: string): string {
		const match = html.match(/<title>([\s\S]*?)<\/title>/i);
		if (!match?.[1]) {
			return "";
		}
		return this.decodeHtmlEntities(match[1]).replace(/\s*-\s*微信公众平台\s*$/, "").trim();
	}

	extractContentNoEncode(segment: string): string {
		const match = segment.match(/content_noencode\s*:\s*JsDecode\('([\s\S]*?)'\),\s*create_time\s*:/);
		return match?.[1] ?? "";
	}

	extractJsContentHtml(html: string): string {
		try {
			const doc = new DOMParser().parseFromString(html, "text/html");
			const contentEl = doc.querySelector("#js_content");
			return contentEl?.innerHTML ?? "";
		} catch (_error) {
			return "";
		}
	}

	cleanContentHtml(contentHtml: string): string {
		if (!contentHtml) {
			return "";
		}

		try {
			const doc = new DOMParser().parseFromString(`<div id=\"wechat-root\">${contentHtml}</div>`, "text/html");
			const root = doc.querySelector("#wechat-root");
			if (!root) {
				return contentHtml;
			}

			root.querySelectorAll("script, style, noscript, iframe").forEach((node) => node.remove());
			root.querySelectorAll("mp-style-type").forEach((node) => node.remove());
			root.querySelectorAll("img").forEach((img) => {
				const dataSrc = this.normalizeMediaUrl(img.getAttribute("data-src") || "");
				const src = this.normalizeMediaUrl(img.getAttribute("src") || "");
				if (!img.getAttribute("src") && dataSrc) {
					img.setAttribute("src", dataSrc);
				}
				if (src && src !== img.getAttribute("src")) {
					img.setAttribute("src", src);
				}
			});

			return root.innerHTML;
		} catch (_error) {
			return contentHtml;
		}
	}

	extractImageUrlsFromContent(contentHtml: string, coverUrl: string): string[] {
		const urls = new Set<string>();
		const cover = this.normalizeMediaUrl(coverUrl);
		if (cover) {
			urls.add(cover);
		}

		if (!contentHtml) {
			return Array.from(urls);
		}

		try {
			const doc = new DOMParser().parseFromString(`<div id=\"wechat-root\">${contentHtml}</div>`, "text/html");
			doc.querySelectorAll("img").forEach((img) => {
				const rawUrl = img.getAttribute("data-src") || img.getAttribute("src") || "";
				const normalized = this.normalizeMediaUrl(rawUrl);
				if (normalized) {
					urls.add(normalized);
				}
			});
		} catch (_error) {
			const pattern = /<img\b[^>]*?(?:data-src|src)=['"]([^'"]+)['"][^>]*>/gi;
			let match: RegExpExecArray | null = pattern.exec(contentHtml);
			while (match) {
				const normalized = this.normalizeMediaUrl(match[1]);
				if (normalized) {
					urls.add(normalized);
				}
				match = pattern.exec(contentHtml);
			}
		}

		return Array.from(urls);
	}

	convertHtmlToMarkdown(contentHtml: string, imageMap: Map<string, string>): string {
		const turndown = new TurndownService({
			headingStyle: "atx",
			codeBlockStyle: "fenced",
			emDelimiter: "_",
			bulletListMarker: "-",
		});

		const resolveImage = (raw: string): string => {
			const normalized = this.normalizeMediaUrl(raw);
			if (!normalized) {
				return "";
			}
			return imageMap.get(normalized) ?? normalized;
		};

		turndown.addRule("wechatImage", {
			filter: "img",
			replacement: (_content, node) => {
				const el = node as HTMLElement;
				const rawUrl = el.getAttribute("data-src") || el.getAttribute("src") || "";
				const finalUrl = resolveImage(rawUrl);
				if (!finalUrl) {
					return "";
				}
				const alt = (el.getAttribute("alt") || "Image").replace(/\s+/g, " ").trim() || "Image";
				const destination = this.toMarkdownDestination(finalUrl);
				return `![${alt}](${destination})`;
			},
		});

		turndown.addRule("removeSvg", {
			filter: "svg",
			replacement: () => "",
		});

		turndown.addRule("removeStyleTags", {
			filter: ["style", "script", "noscript"],
			replacement: () => "",
		});

		let markdown = turndown.turndown(contentHtml || "");
		markdown = this.normalizeMarkdownSpacing(markdown);

		return markdown;
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
		while (true) {
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

	buildWechatFrontmatter(article: WechatArticleData, category: string, cover: string): string {
		const importedAt = this.formatDateTime(new Date());
		const publishedTs = article.publishedTs > 0 ? String(article.publishedTs) : "0";

		const rows = [
			"---",
			`platform: ${this.toYamlString("wechat")}`,
			`title: ${this.toYamlString(article.title)}`,
			`source: ${this.toYamlString(article.source)}`,
			`account: ${this.toYamlString(article.account)}`,
			`wechat_id: ${this.toYamlString(article.wechatId)}`,
			`alias: ${this.toYamlString(article.alias)}`,
			`author: ${this.toYamlString(article.author)}`,
			`published_at: ${this.toYamlString(article.publishedAt)}`,
			`published_ts: ${publishedTs}`,
			`imported_at: ${this.toYamlString(importedAt)}`,
			`category: ${this.toYamlString(category)}`,
			`description: ${this.toYamlString(article.description)}`,
			`cover: ${this.toYamlString(cover)}`,
			`type: ${this.toYamlString(article.type)}`,
			"---",
		];

		return rows.join("\n");
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

	formatUnixTime(unixSeconds: number): string {
		if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) {
			return "";
		}
		return this.formatDateTime(new Date(unixSeconds * 1000));
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
		while (true) {
			const suffix = index === 0 ? "" : `-${index}`;
			const filePath = `${folderPath}/${baseName}${suffix}.md`;
			if (!(await this.app.vault.adapter.exists(filePath))) {
				return filePath;
			}
			index += 1;
		}
	}

	async findMarkdownFileByFrontmatter(field: string, value: string) {
		const files = this.app.vault.getMarkdownFiles();
		const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const pattern = new RegExp(`^${field}:\\s*"?${escapedValue}"?$`, "m");
		for (const file of files) {
			const content = await this.app.vault.cachedRead(file);
			const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
			if (frontmatter?.[1] && pattern.test(frontmatter[1])) {
				return file;
			}
		}
		return null;
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

	decodeJsDecodeValue(value: string): string {
		if (!value) {
			return "";
		}

		const decoded = value
			.replace(/\\x([0-9A-Fa-f]{2})/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)))
			.replace(/\\u([0-9A-Fa-f]{4})/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)))
			.replace(/\\r/g, "\r")
			.replace(/\\n/g, "\n")
			.replace(/\\t/g, "\t")
			.replace(/\\'/g, "'")
			.replace(/\\"/g, '"')
			.replace(/\\\\/g, "\\");

		return this.decodeHtmlEntities(decoded);
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

	cleanText(value: string): string {
		return value.replace(/\s+/g, " ").trim();
	}

	pickFirst(values: Array<string | null | undefined>): string {
		for (const item of values) {
			if (item && item.trim()) {
				return item.trim();
			}
		}
		return "";
	}

	pickNumber(values: number[]): number {
		for (const value of values) {
			if (Number.isFinite(value) && value > 0) {
				return value;
			}
		}
		return 0;
	}

	toNumber(value: string): number {
		const parsed = Number(value);
		if (!Number.isFinite(parsed)) {
			return 0;
		}
		return parsed;
	}
}

class WechatImporterSettingTab extends PluginSettingTab {
	plugin: WechatArticleImporterPlugin;

	constructor(app: App, plugin: WechatArticleImporterPlugin) {
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
						this.plugin.settings.defaultFolder = value.trim();
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
			.setName("飞书 Session Cookie（预留）")
			.setDesc("v1 仅支持公网可访问飞书文档；此字段暂为后续更高权限抓取预留。")
			.addTextArea((text) =>
				text.setPlaceholder("留空即可").setValue(this.plugin.settings.feishuSessionCookie).onChange(async (value) => {
					this.plugin.settings.feishuSessionCookie = value.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl).setName("分类管理").setHeading();
		containerEl.createEl("p", { text: "可编辑分类名称、调整顺序或删除分类；导入弹窗中固定包含“其他”。" });

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

class WechatInputModal extends Modal {
	result: ImportInput | null = null;
	onSubmit: (result: ImportInput | null) => void;
	settings: WechatImporterSettings;
	selectedCategory: string;
	downloadMedia: boolean;

	constructor(app: App, settings: WechatImporterSettings, onSubmit: (result: ImportInput | null) => void) {
		super(app);
		this.settings = settings;
		this.onSubmit = onSubmit;
		this.selectedCategory = this.resolveInitialCategory();
		this.downloadMedia = this.settings.downloadMedia;
	}

	resolveInitialCategory(): string {
		if (this.settings.lastCategory === "其他") {
			return "其他";
		}
		if (this.settings.lastCategory && this.settings.categories.includes(this.settings.lastCategory)) {
			return this.settings.lastCategory;
		}
		return this.settings.categories[0] || "其他";
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("wca-modal-content");

		contentEl.createEl("h2", { text: "导入内容（微信 / 小红书 / 飞书）" });

		const inputRow = contentEl.createEl("div", { cls: "wca-modal-row" });
		inputRow.createEl("p", { text: "粘贴微信、小红书或飞书链接 / 分享文本（支持按行批量导入）：" });
		const input = inputRow.createEl("textarea", {
			cls: "wca-modal-textarea",
			attr: {
				placeholder:
					"例如：\\nhttps://mp.weixin.qq.com/s/xxxxxx\\nhttps://www.xiaohongshu.com/explore/xxxxxx\\nhttps://xxx.feishu.cn/docx/xxxxxxxx",
			},
		});

		const categoryRow = contentEl.createEl("div", { cls: "wca-modal-row" });
		categoryRow.createEl("p", { text: "选择分类：" });
		const chipContainer = categoryRow.createEl("div", { cls: "wca-chip-container" });

		const categoryList = [...this.settings.categories, "其他"];
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
				});
			});
		};
		renderChips();

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
			this.result = {
				text: input.value.trim(),
				category: this.selectedCategory,
				downloadMedia: this.downloadMedia,
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
