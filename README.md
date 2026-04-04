# Multi-Source Content Importer

将微信公众号和小红书内容导入为结构化 Markdown，统一沉淀到 Obsidian 知识库。

这个仓库现在提供两种使用方式：

- 插件：给人手动在 Obsidian 里使用
- Skill：给 agent 直接调用同类导入能力，不依赖插件 UI

## 功能概览

- 支持来源自动识别：微信公众号 / 小红书
- 支持单条导入与批量导入（输入框按行粘贴）
- 自动抽取正文并转换为 Markdown
- 支持图片本地化下载，失败时自动回退远程链接
- 目录结构清晰：笔记按分类保存，媒体按文章名分文件夹保存
- 写入 frontmatter 元数据，便于后续检索和自动化处理

## 两种入口

- 插件入口：
  - Obsidian Ribbon 图标
  - Obsidian 命令 `导入文章（微信 / 小红书）`
  - 适合人工交互式选择分类、目录和媒体下载策略
- Skill 入口：
  - agent 直接执行 skill 自带脚本
  - 输入一个或批量链接，直接抓取、解析并保存到指定路径
  - 不要求 Obsidian 插件已安装或已启用

## 输出结构

- 插件模式：
  - 笔记：`<defaultFolder>/<category>/<title>.md`
  - 媒体：`<defaultFolder>/media/<title>/...`
- Skill 模式：
  - 笔记：`<output-dir>/<title>.md`
  - 媒体：`<output-dir>/media/<title>/...`

默认 `defaultFolder` 为 `External Files`。

## 快速使用

1. 在 Obsidian 启用插件后，点击左侧 Ribbon 图标，或执行命令 `导入文章（微信 / 小红书）`
2. 粘贴链接或分享文本
3. 可按行粘贴多条，实现批量导入
4. 选择分类，按需勾选“下载图片到本地”
5. 点击导入

## Agent Quick Start

Skill 文件：[`skills/obsidian-content-importer/SKILL.md`](skills/obsidian-content-importer/SKILL.md)

```bash
# 1. 安装 skill（复制整个 skill 目录，而不只是 SKILL.md）
# 在仓库根目录执行
mkdir -p ~/.codex/skills
cp -R skills/obsidian-content-importer ~/.codex/skills/

# 2. agent 直接使用 skill，自带脚本，不依赖插件 UI
node ~/.codex/skills/obsidian-content-importer/scripts/import-content.mjs \
  --output-dir "/absolute/output/path" \
  --category "研究" \
  --url "https://mp.weixin.qq.com/s/xxxx"

# 3. 批量导入
node ~/.codex/skills/obsidian-content-importer/scripts/import-content.mjs \
  --output-dir "/absolute/output/path" \
  --category "研究" \
  --download-media \
  --input-file "/tmp/links.txt"

# 4. 在 agent 中描述任务
# "请使用 obsidian-content-importer skill，把这些链接导入到 /path/to/notes"
```

这个 skill 的职责是复用仓库里的抓取、解析、Markdown 生成与落盘逻辑，让 agent 直接完成导入任务，而不是指导 agent 去操作插件界面。

脚本会输出 JSON 摘要，包含成功文件、失败链接和无效输入，便于 agent 继续汇报或后处理。

## 支持链接格式

- 微信公众号：
  - `https://mp.weixin.qq.com/s/...`
  - `https://mp.weixin.qq.com/s?...`
- 小红书：
  - `https://www.xiaohongshu.com/explore/...`
  - `https://www.xiaohongshu.com/discovery/item/...`
  - `https://xhslink.com/...`

## 本地安装（开发/测试）

将构建产物放到你的 Vault 插件目录（目录名必须与 `manifest.json` 的 `id` 一致）：

`<你的Vault>/.obsidian/plugins/multi-source-content-importer/`

目录内至少包含：

- `main.js`
- `manifest.json`
- `styles.css`

## 开发者指南

### 1) 安装依赖

```bash
npm install
```

### 2) 构建

```bash
npm run build
```

### 3) 热开发（watch）

```bash
npm run dev
```

`npm run dev` 会监听 `main.ts`，变更后自动重新生成 `main.js`。

### 4) 在 Obsidian 中热更新

- 推荐将当前项目目录软链到插件目录（只做一次）：

```bash
ln -s /Users/hzt/dp/wx-article "<你的Vault>/.obsidian/plugins/multi-source-content-importer"
```

- 开发时保持 `npm run dev` 运行
- 代码变更后，在 Obsidian 中关闭再启用该插件，或执行 `Reload app without saving`

## Skill 脚本参数

- `--output-dir`：必填，导出目录
- `--url`：可重复传入多个链接
- `--input-file`：批量链接文件，一行一个
- `--text`：直接传入混合文本，由脚本自动抽取链接
- `--category`：写入 frontmatter 的分类，默认 `其他`
- `--download-media`：启用后下载图片或视频到本地 `media/`

## 设置项说明

- `defaultFolder`：导入根目录
- `categories`：分类列表（可在设置页维护）
- `lastCategory`：记忆最近一次选择
- `downloadMedia`：默认是否下载媒体

## frontmatter 字段

微信公众号文章示例字段：

- `platform`
- `title`
- `source`
- `account`
- `wechat_id`
- `alias`
- `author`
- `published_at`
- `published_ts`
- `imported_at`
- `category`
- `description`
- `cover`
- `type`

小红书笔记会包含基础字段，如 `platform/title/source/category/imported_at/cover/type`。

## 已知限制

- 仅支持公开可访问内容（不处理登录、验证码、权限墙）
- 微信风控页（环境异常/去验证）会终止导入并提示
- 平台页面结构变化可能影响解析逻辑

## 发布说明

发布到社区商店时：

1. 更新 `manifest.json` 与 `versions.json` 版本
2. 执行 `npm run build`
3. 创建与版本号一致的 Git tag / GitHub Release（例如 `0.1.0`）
4. Release 上传 `main.js`、`manifest.json`、`styles.css`

## Acknowledgements

- 感谢开源项目 `xiaohongshu-importer` 提供的实现思路与交互设计参考。
