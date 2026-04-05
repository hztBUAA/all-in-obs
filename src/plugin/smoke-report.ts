export interface SmokeSuiteReport<TCaseResult> {
	startedAt: string;
	finishedAt: string;
	pluginVersion: string;
	caseCount: number;
	successCount: number;
	failedCount: number;
	results: TCaseResult[];
}

export function buildSmokeSuiteReport<TCaseResult>(
	pluginVersion: string,
	startedAt: string,
	results: TCaseResult[],
	successCount: number,
	failedCount: number
): SmokeSuiteReport<TCaseResult> {
	return {
		startedAt,
		finishedAt: new Date().toISOString(),
		pluginVersion,
		caseCount: results.length,
		successCount,
		failedCount,
		results,
	};
}
