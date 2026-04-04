---
name: obsidian-content-importer
description: Use when a user gives one or many WeChat or Xiaohongshu links and wants the parsed notes saved to a specific local path without relying on the Obsidian plugin UI. This skill wraps the repository's import capability as a direct agent tool through the bundled script, including batch import, frontmatter generation, media download, and JSON result reporting.
---

# Obsidian Content Importer

This skill is for direct execution, not for extending the plugin.

- Humans can keep using the Obsidian plugin UI.
- Agents should use this skill's script to import links directly.
- The target path can be any local folder. If it is inside an Obsidian vault, the notes become available there automatically.

## What this skill does

Given one link or a batch of links, the script will:

1. Detect supported platforms: WeChat or Xiaohongshu
2. Fetch and parse the page
3. Convert content into Markdown
4. Write note files into the requested output directory
5. Optionally download media into `media/<title>/`
6. Return a JSON summary with created files and failures

## Use this script

Bundled executable: [`scripts/import-content.mjs`](scripts/import-content.mjs)

Run it with:

```bash
node scripts/import-content.mjs --output-dir "/absolute/output/path" --category "研究" --url "https://mp.weixin.qq.com/s/xxxx"
```

Batch import:

```bash
node scripts/import-content.mjs --output-dir "/absolute/output/path" --category "研究" --download-media --input-file "/tmp/links.txt"
```

Multiple URLs directly:

```bash
node scripts/import-content.mjs \
  --output-dir "/absolute/output/path" \
  --url "https://mp.weixin.qq.com/s/xxxx" \
  --url "https://www.xiaohongshu.com/discovery/item/xxxx"
```

## Agent workflow

1. Decide the output directory with the user or infer it from context.
2. Prefer repeated `--url` for a small batch; use `--input-file` for larger batches.
3. Add `--download-media` only when local media is actually needed.
4. Parse the JSON result and report:
   - created note paths
   - failed links and reasons
   - skipped invalid lines

## Output contract

- Notes: `<output-dir>/<title>.md`
- Media: `<output-dir>/media/<title>/...`
- Common frontmatter: `platform`, `title`, `source`, `category`, `imported_at`, `cover`, `type`
- WeChat also writes: `account`, `wechat_id`, `alias`, `author`, `published_at`, `published_ts`, `description`


