export interface ImporterSettings {
	defaultFolder: string;
	categories: string[];
	lastCategory: string;
	lastCustomFolder: string;
	downloadMedia: boolean;
	debugEnabled: boolean;
	xhsSmokeCaseInputs: string[];
	wechatSmokeCaseInputs: string[];
	// Legacy key kept for seamless migration from older versions.
	xhsDebugEnabled?: boolean;
}

export interface ImportInput {
	text: string | null;
	category: string;
	downloadMedia: boolean;
	useCustomFolder: boolean;
	customFolderPath: string;
}

export const CUSTOM_FOLDER_CATEGORY = "自定义文件夹";
