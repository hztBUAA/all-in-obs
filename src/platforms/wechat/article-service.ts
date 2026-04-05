import { requestUrl } from "obsidian";
import TurndownService from "turndown";
import { buildWechatHeaders, isWechatVerificationPage } from "./headers";

export interface WechatArticleData {
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

export class WechatArticleService {
	async fetchHtml(url: string): Promise<string> {
		const response = await requestUrl({
			url,
			method: "GET",
			headers: buildWechatHeaders(url),
			throw: false,
		});

		if (response.status >= 400) {
			throw new Error(`请求失败（HTTP ${response.status}）`);
		}

		if (isWechatVerificationPage(response.text)) {
			throw new Error("微信返回了验证页面（环境异常/去验证），请稍后重试或更换网络环境。");
		}

		return response.text;
	}

	extractArticle(sourceUrl: string, html: string): WechatArticleData {
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
			replacement: (_content: string, node: Node) => {
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
			filter: (node: HTMLElement) => node.nodeName.toLowerCase() === "svg",
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

	buildFrontmatter(article: WechatArticleData, category: string, cover: string): string {
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

	private extractCgiDataSegment(html: string): string {
		const marker = "window.cgiDataNew";
		const startIndex = html.indexOf(marker);
		if (startIndex < 0) {
			return html;
		}

		const maxLength = 650000;
		return html.slice(startIndex, startIndex + maxLength);
	}

	private extractJsDecodeProp(text: string, prop: string): string {
		const escaped = prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`${escaped}\\s*:\\s*JsDecode\\('([\\s\\S]*?)'\\)`);
		return regex.exec(text)?.[1] ?? "";
	}

	private extractVarDoubleQuoted(text: string, variableName: string): string {
		const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`var\\s+${escaped}\\s*=\\s*"([\\s\\S]*?)"`);
		return regex.exec(text)?.[1] ?? "";
	}

	private extractWindowDoubleQuoted(text: string, variableName: string): string {
		const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`window\\.${escaped}\\s*=\\s*"([\\s\\S]*?)"`);
		return regex.exec(text)?.[1] ?? "";
	}

	private extractVarSingleQuoted(text: string, variableName: string, suffixPattern = ""): string {
		const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`var\\s+${escaped}\\s*=\\s*'([\\s\\S]*?)'${suffixPattern}`);
		return regex.exec(text)?.[1] ?? "";
	}

	private extractVarHtmlDecodeDoubleQuoted(text: string, variableName: string): string {
		const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`var\\s+${escaped}\\s*=\\s*htmlDecode\\("([\\s\\S]*?)"\\)`);
		return regex.exec(text)?.[1] ?? "";
	}

	private extractNumericVar(text: string, variableName: string): number {
		const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`var\\s+${escaped}\\s*=\\s*"?(\\d{8,13})"?`);
		const value = regex.exec(text)?.[1] ?? "";
		return this.toNumber(value);
	}

	private extractNumericProp(text: string, propName: string): number {
		const escaped = propName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`${escaped}\\s*:\\s*'?(\\d{8,13})'?\\s*\\*?\\s*1?`);
		const value = regex.exec(text)?.[1] ?? "";
		return this.toNumber(value);
	}

	private extractNumericType(text: string): string {
		const regex = /type\s*:\s*'?(\d+)'?\s*\*\s*1/;
		return regex.exec(text)?.[1] ?? "";
	}

	private extractMetaContent(html: string, attrName: string, attrValue: string): string {
		const escaped = attrValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`<meta\\s+${attrName}=["']${escaped}["']\\s+content=["']([^"']*)["']`, "i");
		return this.decodeHtmlEntities(regex.exec(html)?.[1] ?? "");
	}

	private extractTitleTag(html: string): string {
		const match = html.match(/<title>([\s\S]*?)<\/title>/i);
		if (!match?.[1]) {
			return "";
		}
		return this.decodeHtmlEntities(match[1]).replace(/\s*-\s*微信公众平台\s*$/, "").trim();
	}

	private extractContentNoEncode(segment: string): string {
		const match = segment.match(/content_noencode\s*:\s*JsDecode\('([\s\S]*?)'\),\s*create_time\s*:/);
		return match?.[1] ?? "";
	}

	private extractJsContentHtml(html: string): string {
		try {
			const doc = new DOMParser().parseFromString(html, "text/html");
			const contentEl = doc.querySelector("#js_content");
			return contentEl?.innerHTML ?? "";
		} catch {
			return "";
		}
	}

	private cleanContentHtml(contentHtml: string): string {
		if (!contentHtml) {
			return "";
		}

		try {
			const doc = new DOMParser().parseFromString(`<div id="wechat-root">${contentHtml}</div>`, "text/html");
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
		} catch {
			return contentHtml;
		}
	}

	private extractImageUrlsFromContent(contentHtml: string, coverUrl: string): string[] {
		const urls = new Set<string>();
		const cover = this.normalizeMediaUrl(coverUrl);
		if (cover) {
			urls.add(cover);
		}

		if (!contentHtml) {
			return Array.from(urls);
		}

		try {
			const doc = new DOMParser().parseFromString(`<div id="wechat-root">${contentHtml}</div>`, "text/html");
			doc.querySelectorAll("img").forEach((img) => {
				const rawUrl = img.getAttribute("data-src") || img.getAttribute("src") || "";
				const normalized = this.normalizeMediaUrl(rawUrl);
				if (normalized) {
					urls.add(normalized);
				}
			});
		} catch {
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

	private toYamlString(value: string): string {
		const safe = (value || "")
			.replace(/\\/g, "\\\\")
			.replace(/"/g, "\\\"")
			.replace(/\r?\n/g, "\\n");
		return `"${safe}"`;
	}

	private formatDateTime(date: Date): string {
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, "0");
		const day = String(date.getDate()).padStart(2, "0");
		const hour = String(date.getHours()).padStart(2, "0");
		const minute = String(date.getMinutes()).padStart(2, "0");
		const second = String(date.getSeconds()).padStart(2, "0");
		return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
	}

	private formatUnixTime(unixSeconds: number): string {
		if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) {
			return "";
		}
		return this.formatDateTime(new Date(unixSeconds * 1000));
	}

	private toMarkdownDestination(value: string): string {
		if (!value) {
			return value;
		}
		if (/[\s()<>]/.test(value)) {
			return `<${value}>`;
		}
		return value;
	}

	private normalizeMarkdownSpacing(markdown: string): string {
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

	private normalizeMediaUrl(url: string): string {
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

	private decodeJsDecodeValue(value: string): string {
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

	private decodeJsEscapedString(value: string): string {
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

	private decodeHtmlEntities(value: string): string {
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

		return value.replace(/&(#x?[0-9A-Fa-f]+|[a-zA-Z]+);/g, (all, token: string) => {
			if (token.startsWith("#x") || token.startsWith("#X")) {
				const codePoint = parseInt(token.slice(2), 16);
				return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : all;
			}
			if (token.startsWith("#")) {
				const codePoint = parseInt(token.slice(1), 10);
				return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : all;
			}
			return named[token] ?? all;
		});
	}

	private cleanText(value: string): string {
		return value.replace(/\s+/g, " ").trim();
	}

	private pickFirst(values: Array<string | null | undefined>): string {
		for (const item of values) {
			if (item && item.trim()) {
				return item.trim();
			}
		}
		return "";
	}

	private pickNumber(values: number[]): number {
		for (const value of values) {
			if (Number.isFinite(value) && value > 0) {
				return value;
			}
		}
		return 0;
	}

	private toNumber(value: string): number {
		const parsed = Number(value);
		if (!Number.isFinite(parsed)) {
			return 0;
		}
		return parsed;
	}
}
