export interface WechatSmokeCase {
	name: string;
	input: string;
}

// WeChat public pages may be rate-limited or return verification pages under some networks.
// Keep this list configurable in-repo for team-maintained real-world baseline links.
export const WECHAT_SMOKE_CASES: WechatSmokeCase[] = [];
