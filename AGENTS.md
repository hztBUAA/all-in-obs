# AGENTS Workflow

This repository uses a reproducible fix loop for Xiaohongshu and WeChat import issues.

## Standard Debug Loop

1. Reproduce with real plugin entry:
- In Obsidian command palette, run `运行小红书实网 Smoke 测试`.
- This calls the same service path used by normal import flow (`main.ts -> XhsResolver/XhsNoteService`).

2. Inspect artifacts:
- Debug log: `.obsidian/plugins/multi-source-content-importer/xhs-debug.log`
- Smoke report: `.obsidian/plugins/multi-source-content-importer/xhs-smoke-report.json`

3. Locate failure stage from logs:
- `resolve-get-response` / `resolve-head-response`: shortlink redirect behavior.
- `resolve-html-extracted`: HTML fallback extraction behavior.
- `import-error`: final user-facing failure reason.

4. Implement minimal fix:
- Prefer fixing `src/platforms/xhs/*` service modules.
- Keep plugin shell orchestration in `main.ts`.

5. Regression run:
- Re-run smoke command.
- Ensure no case regresses compared with baseline.

## Baseline XHS Smoke Cases

- `http://xhslink.com/o/AOCPqBZcRZ8`
- `http://xhslink.com/o/9mieTWxY9ce`
- `http://xhslink.com/o/vwCTLUg3W5`
- `http://xhslink.com/o/9WJrnkkjpx5`
- `http://xhslink.com/o/8glUzkSMrIo`

## Architecture Boundaries

- `main.ts`
- Plugin shell: commands, settings, orchestration.

- `src/platforms/xhs`
- `resolver.ts`: shortlink resolution (GET Location -> HEAD Location -> HTML extraction -> token rebuild).
- `note-service.ts`: note HTML fetch, unavailable-page detection, structured extraction.
- `debug-logger.ts`: opt-in/out debug logging with rolling truncation.
- `smoke-cases.ts`: shared real-world smoke case set.

- `src/platforms/wechat`
- Platform-specific HTTP headers and verification page detection.

- `src/shared`
- Shared constants and cross-platform helper values.

## Skills Alignment Rule

`skills/obsidian-content-importer/scripts/import-content.mjs` must preserve the same XHS shortlink decision chain as plugin services.
When plugin XHS resolver behavior changes, update skills script in the same PR.

## Pre-Release Checklist

1. `npm run build` passes.
2. Run Obsidian command `运行小红书实网 Smoke 测试`.
3. Confirm `xhs-smoke-report.json` success/failure count is acceptable and no known fixed case regresses.
4. Spot-check at least one direct long link and one xhs shortlink import in UI.
5. Keep `xhsDebugEnabled` default `true`; only disable for privacy-sensitive users.
