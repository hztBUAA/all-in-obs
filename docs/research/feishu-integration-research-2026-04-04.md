# Feishu Integration Research (2026-04-04)

## Goal

Research mature open-source implementations for Feishu integration, then extract practical patterns for our Obsidian importer (focus: private/public doc import reliability, auth lifecycle, and automation friendliness).

## Projects Reviewed

1. `Wsine/feishu2md` (MIT, active, 2k+ stars)
2. `longbridge/feishu-pages` (MIT, active)
3. `LazyZane/feishushare` (MIT, Obsidian plugin with OAuth flow)
4. `dicarne/feishu-backup` (MIT, personal backup tool)
5. Official SDK: `larksuite/node-sdk`

## High-Value Findings

### 1) The robust route is OpenAPI, not HTML scraping

- `feishu2md` directly calls docx/wiki/drive OpenAPI and paginates block lists.
- `feishu-pages` uses app credentials + documented wiki/docx scopes and exports at scale.
- Both avoid page-structure scraping and rely on stable API contracts.

What this means for us:
- Cookie-based HTML scraping can be a short-term compatibility path.
- Long-term stable private-doc support should move to OpenAPI token flows.

### 2) Token lifecycle management is the key reliability differentiator

- `feishushare` implements:
  - OAuth code exchange
  - refresh token renewal
  - concurrent refresh guard (single refresh promise)
  - token-expired error code handling + automatic reauth fallback

What this means for us:
- If we support private docs seriously, we should treat token lifecycle as first-class.
- A single `feishuSessionCookie` text field is useful for experiments, but insufficient for durable production reliability.

### 3) Wiki -> docx indirection and block pagination are required

- `feishu2md` resolves wiki node token to underlying object token/type, then fetches docx content.
- It paginates block reads and media downloads.

What this means for us:
- Our parser/importer needs explicit wiki-token resolution.
- We should avoid assuming one request can fetch full content.

### 4) Rate limiting + retries are non-optional

- `feishu2md` adds API middleware rate limiting.
- `feishushare` has throttling, retry with backoff, and 429 handling.
- `feishu-pages` README also highlights frequency limits.

What this means for us:
- We should add request pacing and retry policy for Feishu API paths.

### 5) Security trade-offs are explicit in the ecosystem

- `dicarne/feishu-backup` warns that exposing app secret in URL is risky.

What this means for us:
- Never embed secret in share links or callback URLs.
- Keep secrets in local settings storage only.

## Recommended Architecture For Our Plugin

## Phase A (near-term, experimental private access)

- Keep current URL import UX.
- Support two Feishu fetch modes:
  1. `public` mode (no cookie/token)
  2. `session-cookie` mode (manual cookie)
- Improve diagnostic errors:
  - distinguish login page / permission denied / rate limit / parsing failure.

Why:
- Fastest path to verify private-doc feasibility on real user environments.

## Phase B (recommended stable path)

- Introduce `openapi` mode:
  - App ID / App Secret settings
  - user OAuth authorization code flow (preferred for user-visible docs)
  - refresh token lifecycle
  - wiki/docx/drive API data fetch
- Keep `session-cookie` as fallback/debug path, not primary path.

Why:
- Better long-term maintainability and lower page-structure fragility.

## User-Friendly Automation Strategy (Token/Cookie Acquisition)

## Option 1: "Paste cURL" assistant (recommended first)

- Ask user to copy one Feishu page request as cURL from browser devtools.
- Parse the cURL text and extract:
  - `Cookie`
  - `User-Agent`
  - optional extra headers
- One-click import into plugin settings.

Pros:
- No browser extension needed.
- Very user-friendly for technical users.
- Works cross-browser.

Cons:
- Token/cookie expires; user may need periodic refresh.

## Option 2: Browser cookie auto-read helper (advanced)

- Use local helper script (for example via Chrome cookie DB + keychain access).

Pros:
- More automated.

Cons:
- OS permission friction, browser schema changes, security concerns.
- Harder to make robust in pure Obsidian plugin context.

Recommendation:
- Start with Option 1, then evaluate Option 2 only if user demand is high.

## What To Reuse From Open Source

1. From `feishu2md`
- wiki/docx token normalization and resolution logic
- block pagination and image media download flow
- explicit docx-only handling and clear erroring for unsupported types

2. From `feishushare`
- OAuth/refresh patterns
- token validity probing before business calls
- retry + backoff + 429 handling model

3. From `feishu-pages`
- permission checklist and operational docs style
- environment-driven deployment and CI-friendly credential setup

## What Not To Reuse As-Is

- App secret embedded in URL or callback paths.
- Any flow that assumes admin-level enterprise permissions for personal plugin users.
- Overly broad scopes by default.

## Proposed Validation Matrix For Feishu v2

1. Public docx URL import (no auth)
2. Public wiki URL import (no auth, wiki->docx resolution)
3. Private docx import with session cookie
4. Private wiki import with session cookie
5. Expired cookie/token handling and user prompt quality
6. 429 behavior under batch import
7. Same-doc reimport update behavior (`feishu_doc_token` idempotency)

## Source Links

- https://github.com/Wsine/feishu2md
- https://github.com/longbridge/feishu-pages
- https://github.com/LazyZane/feishushare
- https://github.com/dicarne/feishu-backup
- https://github.com/larksuite/node-sdk
- https://open.feishu.cn/document/
