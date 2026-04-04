# Multi-Source Content Importer

将微信公众号和小红书内容导入为结构化 Markdown，统一沉淀到 Obsidian 知识库。

这个仓库主要服务两类使用方式：

- 插件：给人手动在 Obsidian 里使用
- Skill：给 agent 直接调用导入能力

如果你只是想在 Obsidian 里正常安装和使用插件，请先看下面的“人类用户快速开始”。

## 人类用户快速开始

### 1. 安装插件文件

把构建产物放到当前 Vault 的插件目录里，目录名必须与 [`manifest.json`](manifest.json) 里的 `id` 完全一致：

`<你的Vault>/.obsidian/plugins/multi-source-content-importer/`

目录内至少包含这 3 个文件：

- `main.js`
- `manifest.json`
- `styles.css`

最简单的安装方式是直接从 GitHub Release 下载构建产物：

1. 打开 [GitHub Releases](https://github.com/hztBUAA/all-in-obs/releases)
2. 下载当前版本的 `main.js`、`manifest.json`、`styles.css`
3. 放到 `<你的Vault>/.obsidian/plugins/multi-source-content-importer/` 目录下

如果你是从源码本地安装，再执行下面这组命令：

```bash
npm install
npm run build
mkdir -p "<你的Vault>/.obsidian/plugins/multi-source-content-importer"
cp main.js manifest.json styles.css "<你的Vault>/.obsidian/plugins/multi-source-content-importer/"
```

如果你是开发时本地联调，推荐软链：

```bash
npm install
npm run build
ln -s "$(pwd)" "<你的Vault>/.obsidian/plugins/multi-source-content-importer"
```

### 2. 在 Obsidian 中启用插件

1. 打开当前 Vault
2. 进入 `Settings -> Community plugins`
3. 如果社区插件总开关未开启，先开启
4. 在已安装插件列表里启用 `Multi-Source Content Importer`

### 3. 确认是否安装成功

满足下面任意一项，通常就说明插件已经正常加载：

- 左侧 Ribbon 出现书本图标
- 命令面板中能搜到 `导入文章（微信 / 小红书）`
- `Settings -> Community plugins` 里能看到并打开该插件设置页

### 4. 开始导入

1. 点击左侧 Ribbon 图标，或打开命令面板执行 `导入文章（微信 / 小红书）`
2. 粘贴一个或多个链接或分享文本
3. 选择分类
4. 按需勾选“下载图片到本地”
5. 点击导入

## 如果装了但不显示

这是本地安装时最常见的问题，建议按顺序检查：

### 1. 目录名是否正确

插件目录必须叫：

`multi-source-content-importer`

不能是这些名字：

- `wechat-article-importer`
- `all-in-obs`
- `wx-article`
- 任何别的自定义目录名

### 2. 文件是否放在目录根部

下面这种结构才是正确的：

```text
<你的Vault>/.obsidian/plugins/multi-source-content-importer/
  main.js
  manifest.json
  styles.css
```

下面这种多套了一层目录的结构是错误的：

```text
<你的Vault>/.obsidian/plugins/multi-source-content-importer/
  wx-article/
    main.js
    manifest.json
    styles.css
```

### 3. 是否放到了当前打开的 Vault

很多“安装了但不显示”的原因，其实是文件放进了另一个 Vault 的 `.obsidian/plugins/` 目录。

### 4. 是否已经构建

如果你是从源码安装，必须先运行：

```bash
npm install
npm run build
```

如果你是从 GitHub Release 下载的现成构建产物，则不需要执行 `npm install` 或 `npm run build`。

没有 `main.js`，Obsidian 不会正常识别插件。

### 5. 是否重新加载了 Obsidian

复制或软链完成后，如果插件列表没有更新，可以尝试：

- 关闭再打开当前 Vault
- 在 Obsidian 中执行 `Reload app without saving`
- 关闭后重新启用该插件

### 6. 如何快速自检

可以直接检查目标目录：

```bash
ls "<你的Vault>/.obsidian/plugins/multi-source-content-importer"
```

至少应该看到：

- `main.js`
- `manifest.json`
- `styles.css`

## 功能概览

- 支持来源自动识别：微信公众号 / 小红书
- 支持单条导入与批量导入
- 自动抽取正文并转换为 Markdown
- 支持图片本地化下载，失败时自动回退远程链接
- 自动写入 frontmatter 元数据
- 支持分类目录与自定义文件夹

## 支持链接格式

微信公众号：

- `https://mp.weixin.qq.com/s/...`
- `https://mp.weixin.qq.com/s?...`

小红书：

- `https://www.xiaohongshu.com/explore/...`
- `https://www.xiaohongshu.com/discovery/item/...`
- `https://xhslink.com/...`

## 输出结构

默认 `defaultFolder` 为 `External Files`。

插件模式下，默认输出为：

- 笔记：`<defaultFolder>/<category>/<title>.md`
- 媒体：`<defaultFolder>/media/<title>/...`

如果选择“自定义文件夹”：

- 笔记：`<customFolder>/<title>.md`
- 媒体：`<customFolder>/media/<title>/...`

## 设置项说明

- `defaultFolder`：导入根目录
- `categories`：分类列表，可在设置页维护
- `lastCategory`：记忆最近一次选择
- `downloadMedia`：默认是否下载媒体

## frontmatter 字段

微信公众号文章会写入这些字段：

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

小红书笔记会写入这些基础字段：

- `platform`
- `title`
- `source`
- `category`
- `imported_at`
- `cover`
- `type`

## 开发者指南

### 1. 安装依赖

```bash
npm install
```

### 2. 构建

```bash
npm run build
```

### 3. 热开发

```bash
npm run dev
```

`npm run dev` 会监听 [`main.ts`](main.ts)，变更后自动重新生成 `main.js`。

### 4. 在 Obsidian 中热更新

- 保持 `npm run dev` 运行
- 在 Obsidian 中关闭再启用该插件
- 或执行 `Reload app without saving`

## Agent Skill

如果你是给 agent 用，而不是给人手动点插件 UI，用这个 skill：

- [skills/obsidian-content-importer/SKILL.md](skills/obsidian-content-importer/SKILL.md)

推荐安装到：

- `~/.codex/skills/obsidian-content-importer/`
- `~/.claude/skills/obsidian-content-importer/`

安装时必须复制整个目录，而不是只复制 `SKILL.md`，因为脚本也在里面：

- `SKILL.md`
- `scripts/import-content.mjs`

示例：

```bash
mkdir -p ~/.codex/skills ~/.claude/skills
cp -R skills/obsidian-content-importer ~/.codex/skills/
cp -R skills/obsidian-content-importer ~/.claude/skills/
```

安装完成后可以这样自检：

```bash
node ~/.codex/skills/obsidian-content-importer/scripts/import-content.mjs --help
node ~/.claude/skills/obsidian-content-importer/scripts/import-content.mjs --help
```

## 已知限制

- 仅支持公开可访问内容
- 不处理登录、验证码、权限墙
- 微信风控页会终止导入并提示
- 平台页面结构变化可能影响解析逻辑

## Changelog

### 0.1.5

- 修复小红书 `xhslink` 短链解析不稳定的问题，优先保留跳转后的分享参数，避免丢失 `xsec_token`
- 增强小红书短链解析 fallback，补充 Node `http/https` 请求链路，降低 Obsidian 运行时网络差异带来的失败率
- 遇到“小红书 - 你访问的页面不见了”时直接报错并停止导入，不再生成空白笔记
- 修复部分视频笔记因分享参数被裁剪而无法提取正文、封面和视频链接的问题
- 同步更新 agent skill 脚本的小红书短链与失效页处理逻辑

### 0.1.4

- 新增给 agent 直接调用的 `obsidian-content-importer` skill
- 完善本地安装、软链联调与热更新说明

## 发布说明

发布到社区商店时：

1. 更新 `manifest.json` 与 `versions.json` 版本
2. 执行 `npm run build`
3. 创建与版本号一致的 Git tag 或 GitHub Release，例如 `0.1.4`
4. Release 上传 `main.js`、`manifest.json`、`styles.css`

## Acknowledgements

- 感谢开源项目 `xiaohongshu-importer` 提供的实现思路与交互设计参考。
