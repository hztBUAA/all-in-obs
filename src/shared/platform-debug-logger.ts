import { App } from "obsidian";
import { PLATFORM_DEBUG_LOG_PATH } from "./paths";

export interface PlatformDebugLoggerOptions {
	app: App;
	isEnabled: () => boolean;
	logPath?: string;
	maxSize?: number;
	truncateTo?: number;
}

export class PlatformDebugLogger {
	private readonly app: App;
	private readonly isEnabledFn: () => boolean;
	private readonly logPath: string;
	private readonly maxSize: number;
	private readonly truncateTo: number;

	constructor(options: PlatformDebugLoggerOptions) {
		this.app = options.app;
		this.isEnabledFn = options.isEnabled;
		this.logPath = options.logPath || PLATFORM_DEBUG_LOG_PATH;
		this.maxSize = options.maxSize ?? 180000;
		this.truncateTo = options.truncateTo ?? 120000;
	}

	getLogPath(): string {
		return this.logPath;
	}

	isEnabled(): boolean {
		return this.isEnabledFn();
	}

	formatValue(value: unknown): string {
		if (typeof value === "string") {
			return value.replace(/\s+/g, " ").slice(0, 280);
		}
		if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
			return String(value);
		}
		try {
			return JSON.stringify(value).replace(/\s+/g, " ").slice(0, 280);
		} catch (_error) {
			return String(value);
		}
	}

	async reset(context: string): Promise<void> {
		if (!this.isEnabled()) {
			return;
		}
		try {
			const header = [
				"================ PLATFORM DEBUG ================",
				`time=${new Date().toISOString()}`,
				`context=${this.formatValue(context)}`,
				"",
			].join("\n");
			await this.app.vault.adapter.write(this.logPath, header);
		} catch (_error) {
			// Ignore log write failures.
		}
	}

	async append(stage: string, payload: Record<string, unknown> = {}): Promise<void> {
		if (!this.isEnabled()) {
			return;
		}

		const lineParts = Object.entries(payload).map(
			([key, value]) => `${key}=${this.formatValue(value)}`
		);
		const line = `[${new Date().toISOString()}] ${stage}${lineParts.length > 0 ? ` | ${lineParts.join(" | ")}` : ""}\n`;
		console.info(`[PLATFORM-DEBUG] ${line.trim()}`);

		try {
			let existing = "";
			if (await this.app.vault.adapter.exists(this.logPath)) {
				existing = await this.app.vault.adapter.read(this.logPath);
				if (existing.length > this.maxSize) {
					existing = existing.slice(existing.length - this.truncateTo);
				}
			}
			await this.app.vault.adapter.write(this.logPath, `${existing}${line}`);
		} catch (_error) {
			// Ignore log write failures.
		}
	}
}
