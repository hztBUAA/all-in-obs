# Design: feat/xhs-favor (Based on `main@b728396`)

## Context

Current main branch supports Xiaohongshu single-link import (including short-link resolve and media download), but does not support "my favorites" synchronization.

This document proposes a reviewable design before implementation.

## Objective

Allow users to sync favorite Xiaohongshu notes into Obsidian with deduplication and incremental updates.

## Scope (v1 of `feat/xhs-favor`)

In scope:

- Pull favorite note list (incremental)
- Import note content using existing single-note pipeline
- Deduplicate by note ID
- Preserve update history metadata

Out of scope:

- Full account mirror (all boards/likes/comments)
- Guaranteed bypass of platform anti-bot/protected content
- Background daemon sync outside user-triggered command

## Architecture

## 1) Auth layer

New settings:

- `xhsSessionCookie: string` (full cookie text, already present in feature branch experiments)
- `xhsCookieUpdatedAt: string` (ISO timestamp)
- `xhsFavorEnabled: boolean`
- `xhsFavorPageSize: number` (default 20)
- `xhsFavorMaxNotesPerRun: number` (default 100)

Validation:

- Reject obviously invalid cookie strings early.
- Detect expired/invalid session and return actionable notices.

## 2) Favor source adapter

Add adapter abstraction:

- `XhsFavorSource.fetchPage(cursor) -> { items, nextCursor, hasMore }`

Implementation detail:

- First version can call web endpoints using cookie-authenticated requests.
- If endpoint is blocked or changed, fallback to "seed links" mode:
  - user pastes multiple favorite note URLs; same downstream pipeline still works.

## 3) Normalization and identity

Canonical identity:

- `xhs_note_id` extracted from canonical URL (`/discovery/item/<id>`)

Frontmatter additions:

- `xhs_note_id`
- `xhs_source_type: "favorite_sync" | "manual_import"`
- `xhs_synced_at`
- `xhs_sync_cursor` (optional for audit)

## 4) Import execution

Reuse existing path:

- resolve URL
- fetch html
- parse note
- download media
- write markdown

Behavior change for sync mode:

- if note with same `xhs_note_id` exists -> update existing file
- else create new file

## 5) Sync state

Persist state in plugin data:

- `xhsFavorCursor`
- `xhsLastSyncAt`
- `xhsLastSyncCount`
- `xhsLastSyncError`

Guarantees:

- resume from cursor between runs
- safe stop at `xhsFavorMaxNotesPerRun`
- clear summary notice after each run

## UX

Commands:

- `xhs-favor-sync-now`
- `xhs-favor-sync-reset-cursor`
- `xhs-favor-validate-session`

Settings panel:

- cookie field (textarea)
- "paste cURL and auto-extract cookie" helper (recommended)
- sync knobs (`pageSize`, `maxPerRun`)
- status area (last sync time/result)

## Error Handling

Classification:

- `AUTH_INVALID`
- `RATE_LIMITED`
- `ENDPOINT_CHANGED`
- `PARSER_FAILED`
- `NETWORK_ERROR`

User-facing strategy:

- concise Chinese notice + suggested action
- logs include endpoint, status code, and note id when available

## Testing Plan

Unit tests:

- note id extraction
- frontmatter merge/update
- cursor progression
- dedupe behavior

Integration tests (manual):

1. Valid cookie + small favorite list
2. Expired cookie
3. Duplicate notes across pages
4. Re-sync after note already exists
5. Import with media download on/off

## Rollout Plan

Phase 1:

- manual sync command + cursor state + dedupe

Phase 2:

- better diagnostics + retry/backoff + 429 handling

Phase 3:

- optional scheduled sync trigger (if needed)

## Risk Notes

- Xiaohongshu web endpoints are unstable and anti-bot sensitive.
- Cookie mode is operationally fragile; needs clear UX for refresh.
- Keep feature behind explicit user action and clear warnings.

## Acceptance Criteria

1. User can run one command to sync favorites into markdown notes.
2. Re-run does not create duplicates for the same `xhs_note_id`.
3. Existing note can be updated idempotently.
4. Failure messages clearly indicate auth vs parsing vs network issues.
