# 贡献指南

感谢你愿意给 Codex Deck 提问题或补丁。

## 开发环境

```bash
npm install
npm run dev
```

- 前端：[http://127.0.0.1:5173](http://127.0.0.1:5173)
- 后端：[http://127.0.0.1:4174](http://127.0.0.1:4174)

## 提交前请跑

```bash
npm test
npm run build
```

## 约定

- 一次改动只做一件事，不要把重构和功能混在同一个 PR 里
- 不要提交密钥、本机环境文件或机器相关路径
- 本地覆盖项请复制 [`.env.example`](.env.example) 为 `.env`，真实 token 和域名不要进仓库
- 优先复用现有组件和样式
- 改协议解析、CLI、路径归一化或供应商隔离时，请补测试

参与本仓库即表示你同意遵守 [行为准则](CODE_OF_CONDUCT.md)。

## 报告问题

请附上 Codex CLI 版本（`codex --version`）、操作系统（Windows / WSL / Linux / macOS）以及启动 Deck 的命令。不要附带 `.env`、`.data/`、`~/.codex/auth.json` 或 API Key。
