# wx-article

多平台文章导入 Obsidian 的插件项目。

## Current Status

- 已完成：微信公众号与小红书导入（抓取、解析、Markdown 转换、图片本地化、写入 Obsidian）。
- 媒体目录已按文章分层：`media/<文章名>/...`，避免平铺。

## Next Steps

- 设计并评估 arXiv 平台接入方案（待规划需求）。

## Development

```bash
npm install
npm run build
```

## Acknowledgements

- 感谢开源项目 `xiaohongshu-importer` 提供的实现思路与交互设计参考。
