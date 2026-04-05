import { requestUrl } from "obsidian";

export interface XhsNoteData {
	title: string;
	source: string;
	content: string;
	images: string[];
	videoUrl: string | null;
	isVideo: boolean;
	tags: string[];
	cover: string;
}

export interface XhsNoteServiceOptions {
	buildHeaders: () => Record<string, string>;
}

interface XhsVideoStreamItem {
	masterUrl?: string;
}

interface XhsImageItem {
	urlDefault?: string;
}

interface XhsNoteObject {
	type?: string;
	desc?: string | string[];
	imageList?: XhsImageItem[];
	video?: {
		media?: {
			stream?: {
				h264?: XhsVideoStreamItem[];
				h265?: XhsVideoStreamItem[];
			};
		};
	};
}

interface XhsState {
	note?: {
		noteDetailMap?: Record<string, { note?: XhsNoteObject }>;
	};
}

export class XhsNoteService {
	private readonly buildHeaders: () => Record<string, string>;

	constructor(options: XhsNoteServiceOptions) {
		this.buildHeaders = options.buildHeaders;
	}

	async fetchHtml(url: string): Promise<string> {
		const response = await requestUrl({
			url,
			method: "GET",
			headers: this.buildHeaders(),
			throw: false,
		});

		if (response.status >= 400) {
			throw new Error(`请求失败（HTTP ${response.status}）`);
		}

		if (this.isUnavailablePage(response.text)) {
			throw new Error("小红书笔记不可访问，可能已删除、无权限访问，或需要保留分享链接中的 xsec_token 参数。");
		}

		return response.text;
	}

	isUnavailablePage(html: string): boolean {
		return /<title>\s*小红书\s*-\s*你访问的页面不见了\s*<\/title>/i.test(html);
	}

	extractNoteData(sourceUrl: string, html: string): XhsNoteData {
		const titleMatch = html.match(/<title>(.*?)<\/title>/);
		const title = titleMatch?.[1]?.replace(" - 小红书", "").trim() || "Untitled Xiaohongshu Note";
		const state = this.parseState(html);
		const note = state ? this.getNoteObject(state) : null;

		const images = this.extractImages(note);
		const videoUrl = this.extractVideoUrl(note);
		const isVideo = note?.type === "video";

		const contentFromHtml = html.match(/<div id="detail-desc" class="desc">([\s\S]*?)<\/div>/)?.[1] || "";
		const content = this.extractContent(note, contentFromHtml);
		const tags = this.extractTags(content);
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

	private parseState(html: string): XhsState | null {
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
			const parsed: unknown = JSON.parse(cleanedJson);
			if (!parsed || typeof parsed !== "object") {
				return null;
			}
			return parsed as XhsState;
		} catch (_error) {
			return null;
		}
	}

	private getNoteObject(state: XhsState): XhsNoteObject | null {
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

	private extractImages(note: XhsNoteObject | null): string[] {
		const list = Array.isArray(note?.imageList) ? note.imageList : [];
		return list
			.map((img) => this.normalizeMediaUrl(img?.urlDefault || ""))
			.filter((url: string) => !!url);
	}

	private extractVideoUrl(note: XhsNoteObject | null): string | null {
		const stream = note?.video?.media?.stream;
		const h264 = Array.isArray(stream?.h264) ? stream.h264 : [];
		const h265 = Array.isArray(stream?.h265) ? stream.h265 : [];
		const picked = h264[0]?.masterUrl || h265[0]?.masterUrl || "";
		const normalized = this.normalizeMediaUrl(picked);
		return normalized || null;
	}

	private extractContent(note: XhsNoteObject | null, contentFromHtml: string): string {
		const htmlText = contentFromHtml
			.replace(/<[^>]+>/g, "")
			.replace(/\[话题\]/g, "")
			.replace(/\[[^\]]+\]/g, "")
			.trim();

		const desc = Array.isArray(note?.desc) ? note.desc.join("\n") : note?.desc || "";
		const decodedDesc = this.decodeJsEscapedString(String(desc)).replace(/\r/g, "").trim();
		return decodedDesc || htmlText;
	}

	private extractTags(content: string): string[] {
		const matches = content.match(/#([^#\s]+)/g) || [];
		const unique = new Set(matches.map((tag) => tag.replace(/^#/, "").trim()).filter((tag) => !!tag));
		return Array.from(unique);
	}

	private normalizeMediaUrl(url: string): string {
		if (!url) {
			return "";
		}

		let normalized = this.decodeHtmlEntities(this.decodeJsEscapedString(url.trim()));
		normalized = normalized.replace(/\\\//g, "/").replace(/\\/g, "");
		if (normalized.startsWith("//")) {
			normalized = `https:${normalized}`;
		}
		if (/^https?:\/\//i.test(normalized)) {
			return normalized;
		}
		return "";
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
}
