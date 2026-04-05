import { requestUrl } from "obsidian";
import { XhsDebugLogger } from "./debug-logger";

export interface XhsResolverOptions {
	logger: XhsDebugLogger;
	buildHeaders: () => Record<string, string>;
}

export class XhsResolver {
	private readonly logger: XhsDebugLogger;
	private readonly buildHeaders: () => Record<string, string>;

	constructor(options: XhsResolverOptions) {
		this.logger = options.logger;
		this.buildHeaders = options.buildHeaders;
	}

	async resolve(url: string): Promise<string> {
		const normalized = this.normalizeArticleUrl(url);
		if (!/xhslink\.com/i.test(normalized)) {
			return this.normalizeXiaohongshuUrl(normalized);
		}

		const shortLinkUrl = this.normalizeXhsShortLinkUrl(normalized);
		await this.logger.append("resolve-shortlink-start", { normalized, shortLinkUrl });
		const resolvedUrl = await this.resolveShortLink(shortLinkUrl);
		if (resolvedUrl) {
			return resolvedUrl;
		}

		await this.logger.append("resolve-shortlink-failed", { shortLinkUrl });
		throw new Error("小红书短链解析失败，请改用帖子详情页链接重试。");
	}

	async resolveShortLink(url: string, redirects = 0): Promise<string | null> {
		if (redirects > 5) {
			await this.logger.append("resolve-max-redirect", { url, redirects });
			return null;
		}

		const attemptUrls = this.buildXhsShortLinkAttemptUrls(url);
		for (const attemptUrl of attemptUrls) {
			await this.logger.append("resolve-attempt", { attemptUrl, redirects });
			try {
				const response = await requestUrl({
					url: attemptUrl,
					method: "GET",
					headers: this.buildHeaders(),
					throw: false,
				});

				const location = this.getHeaderIgnoreCase(response.headers as Record<string, unknown>, "location");
				await this.logger.append("resolve-get-response", {
					attemptUrl,
					status: response.status,
					hasLocation: !!location,
					textLength: response.text?.length ?? 0,
				});
				if (location) {
					const nextUrl = new URL(this.decodeHtmlEntities(location), attemptUrl).toString();
					await this.logger.append("resolve-get-location", { attemptUrl, nextUrl });
					if (/xhslink\.com/i.test(nextUrl)) {
						return this.resolveShortLink(nextUrl, redirects + 1);
					}
					return this.normalizeXiaohongshuUrl(nextUrl);
				}

				const headLocation = await this.resolveLocationWithHead(attemptUrl);
				if (headLocation) {
					const nextUrl = new URL(this.decodeHtmlEntities(headLocation), attemptUrl).toString();
					await this.logger.append("resolve-head-location", { attemptUrl, nextUrl });
					if (/xhslink\.com/i.test(nextUrl)) {
						return this.resolveShortLink(nextUrl, redirects + 1);
					}
					return this.normalizeXiaohongshuUrl(nextUrl);
				}

				const extracted = this.extractFromHtml(response.text);
				await this.logger.append("resolve-html-extracted", {
					attemptUrl,
					extracted: extracted || "",
				});
				if (extracted) {
					return extracted;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await this.logger.append("resolve-get-error", { attemptUrl, message });

				const headLocation = await this.resolveLocationWithHead(attemptUrl);
				if (headLocation) {
					const nextUrl = new URL(this.decodeHtmlEntities(headLocation), attemptUrl).toString();
					await this.logger.append("resolve-head-location-after-error", { attemptUrl, nextUrl });
					if (/xhslink\.com/i.test(nextUrl)) {
						return this.resolveShortLink(nextUrl, redirects + 1);
					}
					return this.normalizeXiaohongshuUrl(nextUrl);
				}
			}
		}

		return null;
	}

	async resolveLocationWithHead(url: string): Promise<string> {
		try {
			const response = await requestUrl({
				url,
				method: "HEAD",
				headers: this.buildHeaders(),
				throw: false,
			});
			const location = this.getHeaderIgnoreCase(response.headers as Record<string, unknown>, "location");
			await this.logger.append("resolve-head-response", {
				url,
				status: response.status,
				hasLocation: !!location,
			});
			return location;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.logger.append("resolve-head-error", { url, message });
			return "";
		}
	}

	extractFromHtml(html: string): string | null {
		const candidates: string[] = [];
		const addCandidate = (raw: string) => {
			if (!raw) {
				return;
			}
			const normalized = this.normalizeXiaohongshuUrl(this.decodeHtmlEntities(raw));
			if (!normalized || candidates.includes(normalized)) {
				return;
			}
			candidates.push(normalized);
		};

		const metaPatterns = [
			/<meta\b[^>]*\b(?:property|name)=["']og:url["'][^>]*\bcontent=["']([^"']+)["'][^>]*>/gi,
			/<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*\b(?:property|name)=["']og:url["'][^>]*>/gi,
		];
		for (const pattern of metaPatterns) {
			for (const match of html.matchAll(pattern)) {
				addCandidate(match[1] || "");
			}
		}

		const canonicalPatterns = [
			/<link\b[^>]*\brel=["']canonical["'][^>]*\bhref=["']([^"']+)["'][^>]*>/gi,
			/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']canonical["'][^>]*>/gi,
		];
		for (const pattern of canonicalPatterns) {
			for (const match of html.matchAll(pattern)) {
				addCandidate(match[1] || "");
			}
		}

		const directMatches = html.matchAll(
			/https?:\/\/www\.xiaohongshu\.com\/(?:discovery\/item|explore)\/[a-zA-Z0-9]+(?:\?[^"'<>\\s]*)?/gi
		);
		for (const match of directMatches) {
			addCandidate(match[0]);
		}

		const withToken = candidates.find((candidate) => /[?&]xsec_token=/i.test(candidate));
		if (withToken) {
			return withToken;
		}

		const fallbackNoteId = this.extractXhsNoteIdFromUrl(candidates[0] || "");
		const tokenizedFromState = this.buildTokenizedUrlFromState(html, fallbackNoteId);
		if (tokenizedFromState) {
			return tokenizedFromState;
		}

		return candidates[0] || null;
	}

	normalizeXhsShortLinkUrl(url: string): string {
		if (!/xhslink\.com/i.test(url)) {
			return url;
		}
		return url.replace(/^http:\/\//i, "https://");
	}

	buildXhsShortLinkAttemptUrls(url: string): string[] {
		const normalized = this.normalizeXhsShortLinkUrl(url);
		const attempts = [normalized];
		if (/^https:\/\//i.test(normalized)) {
			attempts.push(normalized.replace(/^https:\/\//i, "http://"));
		}
		return Array.from(new Set(attempts));
	}

	getHeaderIgnoreCase(headers: Record<string, unknown>, headerName: string): string {
		const target = headerName.toLowerCase();
		for (const [key, value] of Object.entries(headers)) {
			if (key.toLowerCase() !== target) {
				continue;
			}
			if (typeof value === "string") {
				return value;
			}
			if (Array.isArray(value) && typeof value[0] === "string") {
				return value[0];
			}
		}
		return "";
	}

	buildTokenizedUrlFromState(html: string, noteIdHint = ""): string | null {
		const state = this.parseXhsState(html);
		if (state) {
			try {
				const map = state?.note?.noteDetailMap;
				if (map && typeof map === "object") {
					const noteIdFromMap = Object.keys(map)[0] || "";
					const note = map[noteIdFromMap]?.note;
					const noteId = (typeof note?.noteId === "string" && note.noteId) || noteIdFromMap;
					if (noteId) {
						const xsecToken = typeof note?.xsecToken === "string" ? note.xsecToken.trim() : "";
						if (xsecToken) {
							const query = new URLSearchParams({
								xsec_token: xsecToken,
								xsec_source: "pc_feed",
								source: "web_explore_feed",
							});
							return this.normalizeXiaohongshuUrl(
								`https://www.xiaohongshu.com/discovery/item/${noteId}?${query.toString()}`
							);
						}
						return this.normalizeXiaohongshuUrl(`https://www.xiaohongshu.com/discovery/item/${noteId}`);
					}
				}
			} catch (_error) {
				// Continue to regex fallback.
			}
		}

		const noteId = noteIdHint || this.extractXhsNoteIdFromUrl(html);
		if (!noteId) {
			return null;
		}

		const xsecToken = this.extractXhsTokenFromHtmlByNoteId(html, noteId);
		if (!xsecToken) {
			return null;
		}

		const query = new URLSearchParams({
			xsec_token: xsecToken,
			xsec_source: "pc_feed",
			source: "web_explore_feed",
		});
		return this.normalizeXiaohongshuUrl(
			`https://www.xiaohongshu.com/discovery/item/${noteId}?${query.toString()}`
		);
	}

	extractXhsNoteIdFromUrl(input: string): string {
		if (!input) {
			return "";
		}
		const match = input.match(/\/(?:discovery\/item|explore)\/([a-zA-Z0-9]+)/i);
		return match?.[1] || "";
	}

	extractXhsTokenFromHtmlByNoteId(html: string, noteId: string): string {
		if (!html || !noteId) {
			return "";
		}

		const escapedNoteId = noteId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const mapPattern = new RegExp(
			`"noteDetailMap"\\s*:\\s*\\{\\s*"${escapedNoteId}"\\s*:\\s*\\{[\\s\\S]*?"xsecToken"\\s*:\\s*"([^"]+)"`,
			"i"
		);
		const mapMatch = html.match(mapPattern);
		if (mapMatch?.[1]) {
			return this.decodeJsEscapedString(this.decodeHtmlEntities(mapMatch[1])).trim();
		}

		const anyTokenMatch = html.match(/"xsecToken"\s*:\s*"([^"]+)"/i);
		if (anyTokenMatch?.[1]) {
			return this.decodeJsEscapedString(this.decodeHtmlEntities(anyTokenMatch[1])).trim();
		}

		return "";
	}

	parseXhsState(html: string): any | null {
		const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script>/i);
		if (!stateMatch?.[1]) {
			return null;
		}

		try {
			let jsonStr = stateMatch[1].trim();
			jsonStr = jsonStr.replace(/;\s*$/, "");
			const lastBrace = jsonStr.lastIndexOf("}");
			if (lastBrace >= 0) {
				jsonStr = jsonStr.slice(0, lastBrace + 1);
			}
			const cleanedJson = jsonStr.replace(/undefined/g, "null").replace(/\bNaN\b/g, "null");
			return JSON.parse(cleanedJson);
		} catch (_error) {
			return null;
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
				const normalizedPath = parsed.pathname.replace("/explore/", "/discovery/item/");
				return `${parsed.origin}${normalizedPath}${parsed.search}`;
			}

			return `https://www.xiaohongshu.com/discovery/item/${match[1]}${parsed.search}`;
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
