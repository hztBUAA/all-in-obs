#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";
import process from "process";

const WECHAT_REFERER = "https://mp.weixin.qq.com/";

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printHelp();
		return;
	}

	if (!options.outputDir) {
		throw new Error("Missing required argument: --output-dir");
	}

	const rawInputs = await collectRawInputs(options);
	const batch = extractBatchImportTargets(rawInputs);
	if (batch.targets.length === 0) {
		throw new Error("No valid links found. Supported platforms: WeChat / Xiaohongshu.");
	}

	const outputDir = path.resolve(options.outputDir);
	await ensureFolder(outputDir);

	const results = [];
	for (const target of batch.targets) {
		try {
			const filePath =
				target.platform === "wechat"
					? await importWechatArticle(target.url, outputDir, options.category, options.downloadMedia)
					: await importXiaohongshuNote(target.url, outputDir, options.category, options.downloadMedia);
			results.push({
				status: "success",
				platform: target.platform,
				url: target.url,
				filePath,
			});
		} catch (error) {
			results.push({
				status: "failed",
				platform: target.platform,
				url: target.url,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	const summary = {
		outputDir,
		category: options.category,
		downloadMedia: options.downloadMedia,
		successCount: results.filter((item) => item.status === "success").length,
		failedCount: results.filter((item) => item.status === "failed").length,
		invalidLines: batch.invalidLines,
		results,
	};

	process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
	if (summary.failedCount > 0) {
		process.exitCode = 1;
	}
}

function parseArgs(args) {
	const options = {
		urls: [],
		inputFile: "",
		text: "",
		outputDir: "",
		category: "其他",
		downloadMedia: false,
		help: false,
	};

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		switch (arg) {
			case "--url":
				options.urls.push(readValue(args, ++index, "--url"));
				break;
			case "--input-file":
				options.inputFile = readValue(args, ++index, "--input-file");
				break;
			case "--text":
				options.text = readValue(args, ++index, "--text");
				break;
			case "--output-dir":
				options.outputDir = readValue(args, ++index, "--output-dir");
				break;
			case "--category":
				options.category = readValue(args, ++index, "--category") || "其他";
				break;
			case "--download-media":
				options.downloadMedia = true;
				break;
			case "--help":
			case "-h":
				options.help = true;
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return options;
}

function readValue(args, index, flag) {
	const value = args[index];
	if (!value || value.startsWith("--")) {
		throw new Error(`Missing value for ${flag}`);
	}
	return value;
}

function printHelp() {
	const text = `
Usage:
  node scripts/import-content.mjs --output-dir <dir> [--category <name>] [--download-media] --url <url>...
  node scripts/import-content.mjs --output-dir <dir> [--category <name>] [--download-media] --input-file <file>

Examples:
  node scripts/import-content.mjs --output-dir ./out --category 研究 --url "https://mp.weixin.qq.com/s/xxxx"
  node scripts/import-content.mjs --output-dir ./out --download-media --input-file ./links.txt
`;
	process.stdout.write(text.trimStart());
}

async function collectRawInputs(options) {
	const parts = [];
	if (options.urls.length > 0) {
		parts.push(...options.urls);
	}
	if (options.text) {
		parts.push(options.text);
	}
	if (options.inputFile) {
		const fileText = await fs.readFile(path.resolve(options.inputFile), "utf8");
		parts.push(fileText);
	}
	return parts.join("\n");
}

function extractBatchImportTargets(text) {
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const targets = [];
	const invalidLines = [];
	const seen = new Set();

	for (const line of lines) {
		const target = extractImportTarget(line);
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

function extractImportTarget(input) {
	const wechatUrl = extractWechatUrl(input);
	if (wechatUrl) {
		return { platform: "wechat", url: wechatUrl };
	}

	const xhsUrl = extractXiaohongshuUrl(input);
	if (xhsUrl) {
		return { platform: "xiaohongshu", url: xhsUrl };
	}

	return null;
}

function extractWechatUrl(input) {
	const normalizedInput = input.replace(/&amp;/g, "&");
	const patterns = [
		/(https?:\/\/mp\.weixin\.qq\.com\/s\/[a-zA-Z0-9_-]+(?:\?[^\s，,]*)?)/,
		/(https?:\/\/mp\.weixin\.qq\.com\/s\?[^\s，,]+)/,
	];

	for (const pattern of patterns) {
		const match = normalizedInput.match(pattern);
		if (match?.[1]) {
			return normalizeArticleUrl(match[1]);
		}
	}

	return null;
}

function extractXiaohongshuUrl(input) {
	const normalizedInput = input.replace(/&amp;/g, "&");
	const patterns = [
		/(https?:\/\/xhslink\.com\/a?o?\/[^\s，,]+)/i,
		/(https?:\/\/www\.xiaohongshu\.com\/(?:discovery\/item|explore)\/[a-zA-Z0-9]+(?:\?[^\s，,]*)?)/i,
	];

	for (const pattern of patterns) {
		const match = normalizedInput.match(pattern);
		if (match?.[1]) {
			return match[1].replace("/explore/", "/discovery/item/");
		}
	}

	return null;
}

async function importWechatArticle(url, outputDir, category, downloadMedia) {
	const normalizedUrl = normalizeArticleUrl(url);
	const html = await fetchText(normalizedUrl, buildWechatHeaders(normalizedUrl));
	if (isVerificationPage(html)) {
		throw new Error("WeChat returned a verification page. Retry later or switch network.");
	}

	const article = extractWechatArticle(normalizedUrl, html);
	if (!article.contentHtml.trim()) {
		throw new Error("Failed to extract WeChat article body.");
	}

	const safeTitle = sanitizeFileName(article.title, "Untitled WeChat Article");
	const safeMediaTitle = sanitizeMediaBaseName(article.title, "Untitled-WeChat-Article");
	const mediaFolder = path.join(outputDir, "media", safeMediaTitle);
	const relativeMediaPrefix = toPosix(path.relative(outputDir, mediaFolder)) || ".";

	let imageMap = new Map();
	if (article.images.length > 0) {
		if (downloadMedia) {
			await ensureFolder(mediaFolder);
		}
		imageMap = await buildImageMap(article.images, {
			downloadMedia,
			mediaFolder,
			safeMediaTitle,
			relativeMediaPrefix,
			headers: buildWechatHeaders(normalizedUrl),
		});
	}

	const contentMarkdown = convertHtmlToMarkdown(article.contentHtml, imageMap);
	const normalizedCover = normalizeMediaUrl(article.cover);
	const finalCover = normalizedCover ? imageMap.get(normalizedCover) ?? normalizedCover : "";
	const frontmatter = buildWechatFrontmatter(article, category, finalCover);
	const markdown = `${frontmatter}\n# ${article.title}\n\n${contentMarkdown}\n`;

	const filePath = await getUniqueNotePath(outputDir, safeTitle);
	await fs.writeFile(filePath, markdown, "utf8");
	return filePath;
}

async function importXiaohongshuNote(url, outputDir, category, downloadMedia) {
	const resolvedUrl = await resolveXiaohongshuUrl(url);
	const html = await fetchText(resolvedUrl, buildXiaohongshuHeaders());
	if (isXhsUnavailablePage(html)) {
		throw new Error("Xiaohongshu note is unavailable. It may be deleted, access-restricted, or require the xsec_token from the share link.");
	}
	const note = extractXhsNoteData(resolvedUrl, html);

	const safeTitle = sanitizeFileName(note.title, "Untitled Xiaohongshu Note");
	const safeMediaTitle = sanitizeMediaBaseName(note.title, "Untitled-XHS-Note");
	const mediaFolder = path.join(outputDir, "media", safeMediaTitle);
	const relativeMediaPrefix = toPosix(path.relative(outputDir, mediaFolder)) || ".";
	const headers = buildXiaohongshuHeaders();

	if (downloadMedia && (note.images.length > 0 || note.videoUrl)) {
		await ensureFolder(mediaFolder);
	}

	const imageMap = await buildImageMap(note.images, {
		downloadMedia,
		mediaFolder,
		safeMediaTitle,
		relativeMediaPrefix,
		headers,
	});

	const finalImages = note.images.map((img) => imageMap.get(img) ?? img);
	const normalizedCover = normalizeMediaUrl(note.cover);
	const finalCover = normalizedCover ? imageMap.get(normalizedCover) ?? normalizedCover : "";

	let videoMarkdown = "";
	if (note.isVideo && note.videoUrl) {
		let finalVideoUrl = note.videoUrl;
		if (downloadMedia) {
			const videoFilename = await downloadMediaFile(note.videoUrl, mediaFolder, `${safeMediaTitle}-video`, ".mp4", headers);
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
		markdownBody += `![Cover Image](${toMarkdownDestination(finalImages[0])})\n\n`;
	}

	const cleanContent = note.content.trim();
	if (cleanContent) {
		markdownBody += `${cleanContent}\n\n`;
	}

	if (note.tags.length > 0) {
		markdownBody += `${note.tags.map((tag) => `#${tag}`).join(" ")}\n\n`;
	}

	if (!note.isVideo && finalImages.length > 1) {
		markdownBody += `${finalImages.slice(1).map((img) => `![Image](${toMarkdownDestination(img)})`).join("\n")}\n`;
	}

	const frontmatter = buildXhsFrontmatter(note, category, finalCover);
	const markdown = `${frontmatter}\n# ${note.title}\n\n${normalizeMarkdownSpacing(markdownBody)}\n`;

	const filePath = await getUniqueNotePath(outputDir, safeTitle);
	await fs.writeFile(filePath, markdown, "utf8");
	return filePath;
}

async function fetchText(url, headers = {}) {
	const response = await fetch(url, {
		method: "GET",
		headers,
		redirect: "follow",
	});

	if (!response.ok) {
		throw new Error(`Request failed: HTTP ${response.status}`);
	}

	return await response.text();
}

async function fetchBinary(url, headers = {}) {
	const response = await fetch(url, {
		method: "GET",
		headers,
		redirect: "follow",
	});

	if (!response.ok) {
		throw new Error(`Request failed: HTTP ${response.status}`);
	}

	return Buffer.from(await response.arrayBuffer());
}

function buildWechatHeaders(articleUrl) {
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

function buildXiaohongshuHeaders() {
	return {
		"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
		"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
		"Referer": "https://www.xiaohongshu.com/",
	};
}

function isVerificationPage(html) {
	return /环境异常|去验证|secitptpage\/template\/verify|TCaptcha|wappoc_appmsgcaptcha/i.test(html);
}

async function resolveXiaohongshuUrl(url) {
	const normalized = normalizeArticleUrl(url);
	if (!/xhslink\.com/i.test(normalized)) {
		return normalizeXiaohongshuUrl(normalized);
	}

	const response = await fetch(normalized, {
		method: "GET",
		headers: buildXiaohongshuHeaders(),
		redirect: "manual",
	});
	const location = response.headers.get("location");
	if (location) {
		return normalizeXiaohongshuUrl(decodeHtmlEntities(location));
	}

	const html = await response.text();
	const match = html.match(/https?:\/\/www\.xiaohongshu\.com\/(?:discovery\/item|explore)\/[a-zA-Z0-9]+(?:\?[^"'<>\\s]*)?/i);
	if (!match?.[0]) {
		throw new Error("Failed to resolve Xiaohongshu short link.");
	}

	return normalizeXiaohongshuUrl(decodeHtmlEntities(match[0]));
}

function extractWechatArticle(sourceUrl, html) {
	const cgiSegment = extractCgiDataSegment(html);

	const title =
		pickFirst([
			decodeJsDecodeValue(extractJsDecodeProp(cgiSegment, "title")),
			decodeJsEscapedString(extractVarSingleQuoted(html, "msg_title", "\\.html\\(false\\)")),
			extractMetaContent(html, "property", "og:title"),
			extractTitleTag(html),
		]) || "Untitled WeChat Article";

	const description =
		pickFirst([
			decodeJsDecodeValue(extractJsDecodeProp(cgiSegment, "desc")),
			decodeJsEscapedString(extractVarHtmlDecodeDoubleQuoted(html, "msg_desc")),
			extractMetaContent(html, "name", "description"),
		]) || "";

	const account =
		pickFirst([
			decodeJsDecodeValue(extractJsDecodeProp(cgiSegment, "nick_name")),
			decodeJsEscapedString(extractVarHtmlDecodeDoubleQuoted(html, "nickname")),
		]) || "";

	const wechatId =
		pickFirst([
			decodeJsDecodeValue(extractJsDecodeProp(cgiSegment, "user_name")),
			decodeJsEscapedString(extractVarDoubleQuoted(html, "user_name")),
		]) || "";

	const alias =
		pickFirst([
			decodeJsDecodeValue(extractJsDecodeProp(cgiSegment, "alias")),
			decodeJsEscapedString(extractWindowDoubleQuoted(html, "alias")),
		]) || "";

	const author =
		pickFirst([
			decodeJsDecodeValue(extractJsDecodeProp(cgiSegment, "author")),
			decodeJsEscapedString(extractVarDoubleQuoted(html, "author")),
		]) || "";

	const publishedAtRaw =
		pickFirst([
			decodeJsDecodeValue(extractJsDecodeProp(cgiSegment, "create_time")),
			decodeJsDecodeValue(extractJsDecodeProp(cgiSegment, "ori_create_time")),
		]) || "";

	const publishedTs = pickNumber([
		extractNumericProp(cgiSegment, "ori_create_time"),
		extractNumericVar(html, "ct"),
		extractNumericVar(html, "create_time"),
	]);

	const publishedAt = publishedAtRaw || (publishedTs > 0 ? formatUnixTime(publishedTs) : "");

	const cover =
		pickFirst([
			decodeJsDecodeValue(extractJsDecodeProp(cgiSegment, "cdn_url")),
			decodeJsEscapedString(extractVarDoubleQuoted(html, "msg_cdn_url")),
			extractMetaContent(html, "property", "og:image"),
		]) || "";

	const type =
		pickFirst([
			extractNumericType(cgiSegment),
			decodeJsEscapedString(extractVarDoubleQuoted(html, "appmsg_type")),
		]) || "article";

	let contentHtml = decodeJsDecodeValue(extractContentNoEncode(cgiSegment));
	if (!contentHtml) {
		contentHtml = extractWechatContentFallback(html);
	}
	contentHtml = cleanContentHtml(contentHtml);

	return {
		title: cleanText(title),
		description: cleanText(description),
		source: sourceUrl,
		account: cleanText(account),
		wechatId: cleanText(wechatId),
		alias: cleanText(alias),
		author: cleanText(author),
		publishedAt: cleanText(publishedAt),
		publishedTs,
		cover: normalizeMediaUrl(cover),
		type: cleanText(type),
		contentHtml,
		images: extractImageUrlsFromContent(contentHtml, cover),
	};
}

function extractXhsNoteData(sourceUrl, html) {
	const titleMatch = html.match(/<title>(.*?)<\/title>/i);
	const title = titleMatch?.[1]?.replace(" - 小红书", "").trim() || "Untitled Xiaohongshu Note";
	const state = parseXhsState(html);
	const note = getXhsNoteObject(state);

	const images = extractXhsImages(note);
	const videoUrl = extractXhsVideoUrl(note);
	const isVideo = note?.type === "video";

	const contentFromHtml = html.match(/<div id="detail-desc" class="desc">([\s\S]*?)<\/div>/)?.[1] || "";
	const content = extractXhsContent(note, contentFromHtml);
	const tags = extractXhsTags(content);
	const normalizedContent = content.replace(/#[^#\s]*(?:\s+#[^#\s]*)*\s*/g, "").trim();

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

function parseXhsState(html) {
	const stateMatch = html.match(/window\.__INITIAL_STATE__=(.*?)<\/script>/s);
	if (!stateMatch?.[1]) {
		return null;
	}

	try {
		return JSON.parse(stateMatch[1].trim().replace(/undefined/g, "null"));
	} catch (_error) {
		return null;
	}
}

function getXhsNoteObject(state) {
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

function extractXhsImages(note) {
	const list = Array.isArray(note?.imageList) ? note.imageList : [];
	return list.map((img) => normalizeMediaUrl(img?.urlDefault || "")).filter(Boolean);
}

function extractXhsVideoUrl(note) {
	const stream = note?.video?.media?.stream;
	const h264 = Array.isArray(stream?.h264) ? stream.h264 : [];
	const h265 = Array.isArray(stream?.h265) ? stream.h265 : [];
	return normalizeMediaUrl(h264[0]?.masterUrl || h265[0]?.masterUrl || "") || null;
}

function extractXhsContent(note, contentFromHtml) {
	const htmlText = stripHtml(contentFromHtml).replace(/\[话题\]/g, "").replace(/\[[^\]]+\]/g, "").trim();
	if (htmlText) {
		return htmlText;
	}

	return (note?.desc || "").replace(/\[话题\]/g, "").replace(/\[[^\]]+\]/g, "").trim();
}

function extractXhsTags(content) {
	const matches = content.match(/#\S+/g) || [];
	return matches.map((tag) => tag.replace(/^#/, "").trim()).filter(Boolean);
}

async function buildImageMap(imageUrls, options) {
	const map = new Map();
	let index = 1;

	for (const rawUrl of imageUrls) {
		const normalized = normalizeMediaUrl(rawUrl);
		if (!normalized || map.has(normalized)) {
			continue;
		}

		if (!options.downloadMedia) {
			map.set(normalized, normalized);
			continue;
		}

		const extension = guessImageExtension(normalized);
		const baseName = `${options.safeMediaTitle}-${index}`;
		const downloaded = await downloadMediaFile(normalized, options.mediaFolder, baseName, extension, options.headers);
		map.set(normalized, downloaded.startsWith("http") ? downloaded : `${options.relativeMediaPrefix}/${downloaded}`);
		index += 1;
	}

	return map;
}

async function downloadMediaFile(url, folderPath, baseName, extension, headers = {}) {
	try {
		await ensureFolder(folderPath);
		const filename = await getUniqueMediaFilename(folderPath, baseName, extension);
		const filePath = path.join(folderPath, filename);
		const data = await fetchBinary(url, headers);
		await fs.writeFile(filePath, data);
		return filename;
	} catch (_error) {
		return url;
	}
}

async function getUniqueMediaFilename(folderPath, baseName, extension) {
	let index = 0;
	while (true) {
		const suffix = index === 0 ? "" : `-${index}`;
		const filename = `${baseName}${suffix}${extension}`;
		if (!(await exists(path.join(folderPath, filename)))) {
			return filename;
		}
		index += 1;
	}
}

async function getUniqueNotePath(folderPath, baseName) {
	let index = 0;
	while (true) {
		const suffix = index === 0 ? "" : `-${index}`;
		const filePath = path.join(folderPath, `${baseName}${suffix}.md`);
		if (!(await exists(filePath))) {
			return filePath;
		}
		index += 1;
	}
}

function convertHtmlToMarkdown(contentHtml, imageMap) {
	let html = cleanContentHtml(contentHtml || "");

	html = html.replace(/<img\b[^>]*?>/gi, (tag) => {
		const rawUrl = extractAttribute(tag, "data-src") || extractAttribute(tag, "src") || "";
		const finalUrl = imageMap.get(normalizeMediaUrl(rawUrl)) ?? normalizeMediaUrl(rawUrl);
		if (!finalUrl) {
			return "";
		}
		const alt = cleanText(decodeHtmlEntities(extractAttribute(tag, "alt") || "Image")) || "Image";
		return `\n\n![${alt}](${toMarkdownDestination(finalUrl)})\n\n`;
	});

	html = html.replace(/<br\s*\/?>/gi, "\n");
	html = html.replace(/<\/(p|div|section|article|blockquote|h1|h2|h3|h4|h5|h6|ul|ol|li|table|tr)>/gi, "\n");
	html = html.replace(/<(ul|ol)\b[^>]*>/gi, "\n");
	html = html.replace(/<li\b[^>]*>/gi, "- ");
	html = html.replace(/<h1\b[^>]*>/gi, "\n# ");
	html = html.replace(/<h2\b[^>]*>/gi, "\n## ");
	html = html.replace(/<h3\b[^>]*>/gi, "\n### ");
	html = html.replace(/<h4\b[^>]*>/gi, "\n#### ");
	html = html.replace(/<h5\b[^>]*>/gi, "\n##### ");
	html = html.replace(/<h6\b[^>]*>/gi, "\n###### ");
	html = html.replace(/<blockquote\b[^>]*>/gi, "\n> ");

	html = html.replace(/<[^>]+>/g, "");
	html = decodeHtmlEntities(html);
	return normalizeMarkdownSpacing(html);
}

function extractAttribute(tag, name) {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const regex = new RegExp(`${escaped}\\s*=\\s*["']([^"']*)["']`, "i");
	return regex.exec(tag)?.[1] ?? "";
}

function cleanContentHtml(contentHtml) {
	return (contentHtml || "")
		.replace(/<(script|style|noscript|iframe)\b[\s\S]*?<\/\1>/gi, "")
		.replace(/<mp-style-type\b[^>]*>[\s\S]*?<\/mp-style-type>/gi, "");
}

function extractImageUrlsFromContent(contentHtml, coverUrl) {
	const urls = new Set();
	const cover = normalizeMediaUrl(coverUrl);
	if (cover) {
		urls.add(cover);
	}

	const pattern = /<img\b[^>]*?(?:data-src|src)=['"]([^'"]+)['"][^>]*>/gi;
	let match = pattern.exec(contentHtml);
	while (match) {
		const normalized = normalizeMediaUrl(match[1]);
		if (normalized) {
			urls.add(normalized);
		}
		match = pattern.exec(contentHtml);
	}

	return Array.from(urls);
}

function buildWechatFrontmatter(article, category, cover) {
	const importedAt = formatDateTime(new Date());
	const publishedTs = article.publishedTs > 0 ? String(article.publishedTs) : "0";
	return [
		"---",
		`platform: ${toYamlString("wechat")}`,
		`title: ${toYamlString(article.title)}`,
		`source: ${toYamlString(article.source)}`,
		`account: ${toYamlString(article.account)}`,
		`wechat_id: ${toYamlString(article.wechatId)}`,
		`alias: ${toYamlString(article.alias)}`,
		`author: ${toYamlString(article.author)}`,
		`published_at: ${toYamlString(article.publishedAt)}`,
		`published_ts: ${publishedTs}`,
		`imported_at: ${toYamlString(importedAt)}`,
		`category: ${toYamlString(category)}`,
		`description: ${toYamlString(article.description)}`,
		`cover: ${toYamlString(cover)}`,
		`type: ${toYamlString(article.type)}`,
		"---",
	].join("\n");
}

function buildXhsFrontmatter(note, category, cover) {
	const importedAt = formatDateTime(new Date());
	return [
		"---",
		`platform: ${toYamlString("xiaohongshu")}`,
		`title: ${toYamlString(note.title)}`,
		`source: ${toYamlString(note.source)}`,
		`category: ${toYamlString(category)}`,
		`imported_at: ${toYamlString(importedAt)}`,
		`cover: ${toYamlString(cover)}`,
		`type: ${toYamlString(note.isVideo ? "video" : "note")}`,
		"---",
	].join("\n");
}

function normalizeArticleUrl(url) {
	return url.trim().replace(/&amp;/g, "&").replace(/[。！!）)\]】>,，,]+$/, "").replace(/#wechat_redirect$/, "");
}

function normalizeXiaohongshuUrl(url) {
	const normalized = normalizeArticleUrl(url);
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

function isXhsUnavailablePage(html) {
	return /<title>\s*小红书\s*-\s*你访问的页面不见了\s*<\/title>/i.test(html);
}

function normalizeMediaUrl(url) {
	if (!url) {
		return "";
	}

	let normalized = decodeHtmlEntities(decodeJsEscapedString(url.trim()));
	normalized = normalized.replace(/\\x26amp;/gi, "&").replace(/&amp;/gi, "&").replace(/\u0026/gi, "&");
	normalized = normalized.replace(/^\/\//, "https://");
	if (/^http:\/\//i.test(normalized)) {
		normalized = normalized.replace(/^http:\/\//i, "https://");
	}
	if (!/^https?:\/\//i.test(normalized)) {
		return "";
	}
	return normalized.trim();
}

function guessImageExtension(url) {
	const wxFmtMatch = url.match(/[?&]wx_fmt=([a-zA-Z0-9]+)/i);
	if (wxFmtMatch?.[1]) {
		const format = wxFmtMatch[1].toLowerCase();
		if (["jpeg", "jpg"].includes(format)) {
			return ".jpg";
		}
		if (["png", "gif", "webp"].includes(format)) {
			return `.${format}`;
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
		// ignore
	}

	return ".jpg";
}

function sanitizeFileName(value, fallback) {
	const sanitized = sanitizePathSegment(value, fallback).replace(/\s+/g, " ").substring(0, 120);
	return sanitized || fallback;
}

function sanitizeMediaBaseName(value, fallback) {
	const sanitized = value.replace(/[^a-zA-Z0-9\u4e00-\u9fa5\s-_]/g, "").trim().replace(/\s+/g, "-").substring(0, 96);
	return sanitized || fallback;
}

function sanitizePathSegment(value, fallback) {
	const sanitized = (value || "").replace(/[\\/:*?"<>|]/g, "-").trim();
	return sanitized || fallback;
}

function normalizeMarkdownSpacing(markdown) {
	const normalized = (markdown || "").replace(/\r\n/g, "\n").replace(/\u00a0/g, " ").replace(/\u200b/g, "");
	const lines = normalized.split("\n");
	const output = [];
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

function toYamlString(value) {
	return `"${(value || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\r?\n/g, "\\n")}"`;
}

function toMarkdownDestination(value) {
	if (!value) {
		return value;
	}
	return /[\s()<>]/.test(value) ? `<${value}>` : value;
}

function formatDateTime(date) {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hour = String(date.getHours()).padStart(2, "0");
	const minute = String(date.getMinutes()).padStart(2, "0");
	const second = String(date.getSeconds()).padStart(2, "0");
	return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function formatUnixTime(unixSeconds) {
	return Number.isFinite(unixSeconds) && unixSeconds > 0 ? formatDateTime(new Date(unixSeconds * 1000)) : "";
}

function extractCgiDataSegment(html) {
	const marker = "window.cgiDataNew";
	const startIndex = html.indexOf(marker);
	return startIndex < 0 ? html : html.slice(startIndex, startIndex + 650000);
}

function extractJsDecodeProp(text, prop) {
	const escaped = prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`${escaped}\\s*:\\s*JsDecode\\('([\\s\\S]*?)'\\)`).exec(text)?.[1] ?? "";
}

function extractVarDoubleQuoted(text, variableName) {
	const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`var\\s+${escaped}\\s*=\\s*"([\\s\\S]*?)"`).exec(text)?.[1] ?? "";
}

function extractWindowDoubleQuoted(text, variableName) {
	const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`window\\.${escaped}\\s*=\\s*"([\\s\\S]*?)"`).exec(text)?.[1] ?? "";
}

function extractVarSingleQuoted(text, variableName, suffixPattern = "") {
	const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`var\\s+${escaped}\\s*=\\s*'([\\s\\S]*?)'${suffixPattern}`).exec(text)?.[1] ?? "";
}

function extractVarHtmlDecodeDoubleQuoted(text, variableName) {
	const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`var\\s+${escaped}\\s*=\\s*htmlDecode\\("([\\s\\S]*?)"\\)`).exec(text)?.[1] ?? "";
}

function extractNumericVar(text, variableName) {
	const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return toNumber(new RegExp(`var\\s+${escaped}\\s*=\\s*"?(\\d{8,13})"?`).exec(text)?.[1] ?? "");
}

function extractNumericProp(text, propName) {
	const escaped = propName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return toNumber(new RegExp(`${escaped}\\s*:\\s*'?(\\d{8,13})'?\\s*\\*?\\s*1?`).exec(text)?.[1] ?? "");
}

function extractNumericType(text) {
	return /type\s*:\s*'?(\d+)'?\s*\*\s*1/.exec(text)?.[1] ?? "";
}

function extractMetaContent(html, attrName, attrValue) {
	const escaped = attrValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return decodeHtmlEntities(new RegExp(`<meta\\s+${attrName}=["']${escaped}["']\\s+content=["']([^"']*)["']`, "i").exec(html)?.[1] ?? "");
}

function extractTitleTag(html) {
	const value = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "";
	return decodeHtmlEntities(value).replace(/\s*-\s*微信公众平台\s*$/, "").trim();
}

function extractContentNoEncode(segment) {
	return segment.match(/content_noencode\s*:\s*JsDecode\('([\s\S]*?)'\),\s*create_time\s*:/)?.[1] ?? "";
}

function extractWechatContentFallback(html) {
	const startMatch = /<div[^>]+id=["']js_content["'][^>]*>/i.exec(html);
	if (!startMatch || startMatch.index === undefined) {
		return "";
	}

	let index = startMatch.index + startMatch[0].length;
	let depth = 1;
	while (index < html.length) {
		const nextTag = html.slice(index).match(/<\/?div\b[^>]*>/i);
		if (!nextTag || nextTag.index === undefined) {
			break;
		}
		index += nextTag.index;
		const tag = nextTag[0];
		if (/^<div\b/i.test(tag)) {
			depth += 1;
		} else {
			depth -= 1;
			if (depth === 0) {
				return html.slice(startMatch.index + startMatch[0].length, index);
			}
		}
		index += tag.length;
	}

	return "";
}

function decodeJsDecodeValue(value) {
	if (!value) {
		return "";
	}

	return decodeHtmlEntities(
		value
			.replace(/\\x([0-9A-Fa-f]{2})/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)))
			.replace(/\\u([0-9A-Fa-f]{4})/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)))
			.replace(/\\r/g, "\r")
			.replace(/\\n/g, "\n")
			.replace(/\\t/g, "\t")
			.replace(/\\'/g, "'")
			.replace(/\\"/g, '"')
			.replace(/\\\\/g, "\\")
	);
}

function decodeJsEscapedString(value) {
	if (!value) {
		return "";
	}

	return decodeHtmlEntities(
		value
			.replace(/\\'/g, "'")
			.replace(/\\"/g, '"')
			.replace(/\\n/g, "\n")
			.replace(/\\r/g, "\r")
			.replace(/\\t/g, "\t")
			.replace(/\\\\/g, "\\")
	);
}

function decodeHtmlEntities(value) {
	if (!value) {
		return "";
	}

	const named = {
		amp: "&",
		lt: "<",
		gt: ">",
		quot: '"',
		apos: "'",
		nbsp: " ",
	};

	return value.replace(/&(#x?[0-9A-Fa-f]+|[a-zA-Z]+);/g, (all, token) => {
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

function stripHtml(value) {
	return decodeHtmlEntities((value || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""));
}

function cleanText(value) {
	return (value || "").replace(/\s+/g, " ").trim();
}

function pickFirst(values) {
	for (const item of values) {
		if (item && item.trim()) {
			return item.trim();
		}
	}
	return "";
}

function pickNumber(values) {
	for (const value of values) {
		if (Number.isFinite(value) && value > 0) {
			return value;
		}
	}
	return 0;
}

function toNumber(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

async function ensureFolder(folderPath) {
	await fs.mkdir(folderPath, { recursive: true });
}

async function exists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch (_error) {
		return false;
	}
}

function toPosix(value) {
	return value.split(path.sep).join("/");
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
