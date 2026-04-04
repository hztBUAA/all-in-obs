# Article Importer

将微信公众号和小红书内容和其他平台的资源导入为结构化 Markdown，统一沉淀到知识库。

## 功能概览

- 支持来源自动识别：微信公众号 / 小红书
- 支持单条导入与批量导入（输入框按行粘贴）
- 自动抽取正文并转换为 Markdown
- 支持图片本地化下载，失败时自动回退远程链接
- 目录结构清晰：笔记按分类保存，媒体按文章名分文件夹保存
- 写入 frontmatter 元数据，便于后续检索和自动化处理

## 输出结构

- 笔记：`<defaultFolder>/<category>/<title>.md`
- 媒体：`<defaultFolder>/media/<title>/...`

默认 `defaultFolder` 为 `External Files`。

## 快速使用

1. 在 Obsidian 启用插件后，点击左侧 Ribbon 图标，或执行命令 `导入文章（微信 / 小红书）`
2. 粘贴链接或分享文本
3. 可按行粘贴多条，实现批量导入
4. 选择分类，按需勾选“下载图片到本地”
5. 点击导入

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

`<你的Vault>/.obsidian/plugins/wechat-article-importer/`

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
ln -s /Users/hzt/dp/wx-article "<你的Vault>/.obsidian/plugins/wechat-article-importer"
```

- 开发时保持 `npm run dev` 运行
- 代码变更后，在 Obsidian 中关闭再启用该插件，或执行 `Reload app without saving`

## 设置项说明

- `defaultFolder`：导入根目录
- `categories`：分类列表（可在设置页维护）
- `lastCategory`：记忆最近一次选择
- `downloadMedia`：默认是否下载媒体

## frontmatter 字段

微信文章示例字段：

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
