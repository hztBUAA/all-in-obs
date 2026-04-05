const PLUGIN_SUBDIR = "plugins/multi-source-content-importer";

function normalizeConfigDir(configDir: string): string {
	return configDir.trim().replace(/^\/+|\/+$/g, "");
}

function getPluginDataDir(configDir: string): string {
	const baseDir = normalizeConfigDir(configDir);
	return baseDir ? `${baseDir}/${PLUGIN_SUBDIR}` : PLUGIN_SUBDIR;
}

export function getPlatformDebugLogPath(configDir: string): string {
	return `${getPluginDataDir(configDir)}/debug.log`;
}

export function getPlatformSmokeReportPath(configDir: string): string {
	return `${getPluginDataDir(configDir)}/smoke-report.json`;
}
