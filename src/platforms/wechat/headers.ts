const WECHAT_REFERER = "https://mp.weixin.qq.com/";

export function buildWechatHeaders(articleUrl: string): Record<string, string> {
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

export function isWechatVerificationPage(html: string): boolean {
	return /环境异常|去验证|secitptpage\/template\/verify|TCaptcha|wappoc_appmsgcaptcha/i.test(html);
}
