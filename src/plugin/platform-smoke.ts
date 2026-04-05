import { App } from "obsidian";
import { buildSmokeSuiteReport } from "./smoke-report";
import { PlatformDebugLogger } from "../shared/platform-debug-logger";
import { XhsResolver } from "../platforms/xhs/resolver";
import { XhsNoteService } from "../platforms/xhs/note-service";
import { WechatArticleService } from "../platforms/wechat/article-service";

export type SupportedSmokePlatform = "wechat" | "xiaohongshu";

export interface SmokeInputCase {
	name: string;
	input: string;
}

export interface XhsSmokeCaseResult {
	name: string;
	input: string;
	platform: "xiaohongshu";
	extractedUrl: string;
	resolvedUrl: string;
	hasXsecToken: boolean;
	unavailablePage: boolean;
	title: string;
	isVideo: boolean;
	status: "success" | "failed";
	error: string;
}

export interface WechatSmokeCaseResult {
	name: string;
	input: string;
	platform: "wechat";
	extractedUrl: string;
	title: string;
	status: "success" | "failed";
	error: string;
}

export type PlatformSmokeCaseResult = XhsSmokeCaseResult | WechatSmokeCaseResult;

export interface RunPlatformSmokeOptions {
	app: App;
	pluginVersion: string;
	reportPath: string;
	platforms: SupportedSmokePlatform[];
	debugLogger: PlatformDebugLogger;
	xhsResolver: XhsResolver;
	xhsNoteService: XhsNoteService;
	wechatArticleService: WechatArticleService;
	extractXhsUrl: (input: string) => string | null;
	extractWechatUrl: (input: string) => string | null;
	xhsCases: SmokeInputCase[];
	wechatCases: SmokeInputCase[];
}

export interface RunPlatformSmokeResult {
	successCount: number;
	failedCount: number;
	reportPath: string;
}

export async function runPlatformSmokeSuite(options: RunPlatformSmokeOptions): Promise<RunPlatformSmokeResult> {
	const startedAt = new Date().toISOString();
	const runWechat = options.platforms.includes("wechat");
	const runXhs = options.platforms.includes("xiaohongshu");
	const results: PlatformSmokeCaseResult[] = [];
	await options.debugLogger.reset(`SMOKE_SUITE:${options.platforms.join(",")}`);
	await options.debugLogger.append("smoke-suite-start", {
		platforms: options.platforms.join(","),
		xhsCaseCount: options.xhsCases.length,
		wechatCaseCount: options.wechatCases.length,
	});

	if (runWechat) {
		results.push(...await runWechatSmokeSuite(options));
	}
	if (runXhs) {
		results.push(...await runXhsSmokeSuite(options));
	}

	const successCount = results.filter((item) => item.status === "success").length;
	const failedCount = results.length - successCount;
	const platformSummary = {
		wechat: {
			caseCount: results.filter((item) => item.platform === "wechat").length,
			successCount: results.filter((item) => item.platform === "wechat" && item.status === "success").length,
		},
		xiaohongshu: {
			caseCount: results.filter((item) => item.platform === "xiaohongshu").length,
			successCount: results.filter((item) => item.platform === "xiaohongshu" && item.status === "success").length,
		},
	};

	const report = buildSmokeSuiteReport(
		options.pluginVersion,
		startedAt,
		results,
		successCount,
		failedCount
	);

	await options.app.vault.adapter.write(options.reportPath, `${JSON.stringify({ ...report, platformSummary }, null, 2)}\n`);
	await options.debugLogger.append("smoke-suite-finished", {
		successCount,
		failedCount,
		reportPath: options.reportPath,
	});

	return {
		successCount,
		failedCount,
		reportPath: options.reportPath,
	};
}

async function runXhsSmokeSuite(options: RunPlatformSmokeOptions): Promise<XhsSmokeCaseResult[]> {
	const results: XhsSmokeCaseResult[] = [];
	for (const testCase of options.xhsCases) {
		const extracted = options.extractXhsUrl(testCase.input) || "";
		await options.debugLogger.append("smoke-case-start", {
			platform: "xiaohongshu",
			name: testCase.name,
			extractedUrl: extracted,
		});
		if (!extracted) {
			results.push({
				name: testCase.name,
				input: testCase.input,
				platform: "xiaohongshu",
				extractedUrl: "",
				resolvedUrl: "",
				hasXsecToken: false,
				unavailablePage: false,
				title: "",
				isVideo: false,
				status: "failed",
				error: "未能从输入文本识别出小红书链接",
			});
			await options.debugLogger.append("smoke-case-failed", {
				platform: "xiaohongshu",
				name: testCase.name,
				error: "未能从输入文本识别出小红书链接",
			});
			continue;
		}

		let resolvedUrl = "";
		let hasXsecToken = false;
		try {
			resolvedUrl = await options.xhsResolver.resolve(extracted);
			hasXsecToken = /[?&]xsec_token=/i.test(resolvedUrl);
			const html = await options.xhsNoteService.fetchHtml(resolvedUrl);
			const note = options.xhsNoteService.extractNoteData(resolvedUrl, html);
			const unavailable = options.xhsNoteService.isUnavailablePage(html);
			results.push({
				name: testCase.name,
				input: testCase.input,
				platform: "xiaohongshu",
				extractedUrl: extracted,
				resolvedUrl,
				hasXsecToken,
				unavailablePage: unavailable,
				title: note.title,
				isVideo: note.isVideo,
				status: "success",
				error: "",
			});
			await options.debugLogger.append("smoke-case-success", {
				platform: "xiaohongshu",
				name: testCase.name,
				resolvedUrl,
				title: note.title,
				hasXsecToken,
				isVideo: note.isVideo,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			results.push({
				name: testCase.name,
				input: testCase.input,
				platform: "xiaohongshu",
				extractedUrl: extracted,
				resolvedUrl,
				hasXsecToken,
				unavailablePage: /不可访问|unavailable/i.test(message),
				title: "",
				isVideo: false,
				status: "failed",
				error: message,
			});
			await options.debugLogger.append("smoke-case-failed", {
				platform: "xiaohongshu",
				name: testCase.name,
				resolvedUrl,
				error: message,
			});
		}
	}
	return results;
}

async function runWechatSmokeSuite(options: RunPlatformSmokeOptions): Promise<WechatSmokeCaseResult[]> {
	const results: WechatSmokeCaseResult[] = [];
	for (const testCase of options.wechatCases) {
		const extracted = options.extractWechatUrl(testCase.input) || "";
		await options.debugLogger.append("smoke-case-start", {
			platform: "wechat",
			name: testCase.name,
			extractedUrl: extracted,
		});
		if (!extracted) {
			results.push({
				name: testCase.name,
				input: testCase.input,
				platform: "wechat",
				extractedUrl: "",
				title: "",
				status: "failed",
				error: "未能从输入文本识别出微信链接",
			});
			await options.debugLogger.append("smoke-case-failed", {
				platform: "wechat",
				name: testCase.name,
				error: "未能从输入文本识别出微信链接",
			});
			continue;
		}

		try {
			const html = await options.wechatArticleService.fetchHtml(extracted);
			const article = options.wechatArticleService.extractArticle(extracted, html);
			results.push({
				name: testCase.name,
				input: testCase.input,
				platform: "wechat",
				extractedUrl: extracted,
				title: article.title,
				status: "success",
				error: "",
			});
			await options.debugLogger.append("smoke-case-success", {
				platform: "wechat",
				name: testCase.name,
				title: article.title,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			results.push({
				name: testCase.name,
				input: testCase.input,
				platform: "wechat",
				extractedUrl: extracted,
				title: "",
				status: "failed",
				error: message,
			});
			await options.debugLogger.append("smoke-case-failed", {
				platform: "wechat",
				name: testCase.name,
				error: message,
			});
		}
	}
	return results;
}
