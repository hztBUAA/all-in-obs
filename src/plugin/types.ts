export interface ImporterSettings {
	defaultFolder: string;
	categories: string[];
	lastCategory: string;
	lastCustomFolder: string;
	downloadMedia: boolean;
	xhsDebugEnabled: boolean;
}

export interface ImportInput {
	text: string | null;
	category: string;
	downloadMedia: boolean;
	useCustomFolder: boolean;
	customFolderPath: string;
}

export const CUSTOM_FOLDER_CATEGORY = "自定义文件夹";
