# Codex Deck

一个移动端优先的 Codex 远程控制台。它通过 Codex CLI 的结构化 `app-server` 协议管理真实会话，并自动只读同步 CC Switch 中的 Codex 供应商。

## 能做什么

- CC Switch 同步：自动发现 `~/.cc-switch/cc-switch.db`；WSL 下也会查找 Windows 用户目录。每 5 秒同步一次供应商变化。
- 供应商隔离：每个供应商拥有单独的 `CODEX_HOME`、配置、凭据和 app-server 进程，多个供应商可同时工作。
- 现有会话：启动时读取 Codex 已有 session，而不仅限于 Deck 创建的会话；在 WSL 下同时发现 WSL 与 Windows 用户的 Codex Home。
- 项目多会话：左侧只显示按工作目录分组的会话，同一个路径可以创建、运行和切换多个独立 Codex session；Windows `D:\...` 与 WSL `/mnt/d/...` 路径会归入同组。
- 实时管理：查看运行、空闲、待审批和异常状态；接收增量回复；发送新指令、中断 turn、批准或拒绝命令与文件修改。
- Win / WSL：Node 服务可直接跑在 Windows 或 WSL；工作目录填写运行 Codex 一侧可访问的绝对路径。
- 单网页：生产构建后由同一个 Node 服务提供前端、API 和 WebSocket，适合本机、局域网或 Cloudflare Tunnel。

> `app-server` 当前仍是 Codex CLI 的实验接口。建议使用较新的 Codex CLI，并在升级后运行一次构建和测试。

## 快速开始

需要 Node.js 22+ 和可用的 `codex` 命令。

```bash
npm install
npm run build
```

仅本机访问：

```bash
npm start
```

### 局域网与 Cloudflare Tunnel 参数

启动后会自动生成访问令牌，并将带令牌的手机入口打印到终端；也可以用 `REMOTE_TOKEN` 或 `--token` 固定令牌。

```bash
# 自动监听 0.0.0.0，并打印所有可用的局域网 IPv4 入口
npm start -- --lan

# 明确关闭访问令牌（局域网或公网中的任何人都可控制 Codex）
npm start -- --lan --no-token

# 局域网入口 + 临时 *.trycloudflare.com 入口
npm start -- --cf-tunnel

# 局域网入口 + 指定 Cloudflare Named Tunnel
npm start -- --named-tunnel codex-deck
```

三个参数也可直接用于构建后的入口：

```bash
node dist-server/index.js --lan
node dist-server/index.js --cf-tunnel
node dist-server/index.js --named-tunnel codex-deck
```

`--named-tunnel` 使用 cloudflared 已登录账号中的 Tunnel 名称或 UUID。启动器会显式把该 Tunnel 的 origin 指向当前服务的 `http://127.0.0.1:<port>`；Cloudflare DNS 仍需预先把你的固定域名路由到该 Tunnel。

如果 `cloudflared` 不在 PATH：

```bash
npm start -- --cf-tunnel --cloudflared /path/to/cloudflared
```

WSL 示例：

```bash
npm start -- --cf-tunnel --cloudflared /mnt/d/software/cloudflared/cloudflared.exe
```

可选的简写脚本：

```bash
npm run lan
npm run cf-tunnel
```

LAN 和 Cloudflare 是两个独立入口，不包含自动探测或双模式切换逻辑。每个入口都使用当前页面的同源 API 和 WebSocket。

`--no-token` 可以与 `--lan`、`--cf-tunnel` 或 `--named-tunnel` 组合，但不能与 `--token`/`REMOTE_TOKEN` 同时使用。该选项会让所有能访问入口的人直接拥有命令执行和文件修改能力，只应在可信网络或已有 Cloudflare Access 保护时使用。

也可以通过环境变量手动控制监听：

```bash
HOST=0.0.0.0 REMOTE_TOKEN='换成足够长的随机字符串' npm start
```

Windows PowerShell：

```powershell
$env:HOST='0.0.0.0'
$env:REMOTE_TOKEN='换成足够长的随机字符串'
npm start
```

打开 `http://127.0.0.1:4174`。首次远程打开时输入相同的 `REMOTE_TOKEN`。

开发模式使用 `npm run dev`，前端端口为 5173，后端端口为 4174。

长期使用 Named Tunnel 时，仍建议在 Cloudflare Access 增加一层身份验证。

## CC Switch

默认数据库路径：

- Windows：`%USERPROFILE%\.cc-switch\cc-switch.db`
- Linux：`~/.cc-switch/cc-switch.db`
- WSL：自动扫描 `/mnt/c/Users/*/.cc-switch/cc-switch.db`

自定义位置可设置 `CC_SWITCH_DB=/absolute/path/cc-switch.db`。Deck 不修改 CC Switch 数据库；供应商的新增、编辑和当前项切换应继续在 CC Switch 中完成。网页中仍保留手动供应商入口，用于没有安装 CC Switch 的环境。

CC Switch 的“本地路由”供应商如果指向 Windows 的 `127.0.0.1`，在 WSL 2 的镜像网络模式通常可直接访问；传统 NAT 模式下可能需要将配置中的地址改成 Windows 主机地址，或直接在 Windows 运行 Deck。

## 配置

| 环境变量                     | 默认值      | 用途                                        |
| ---------------------------- | ----------- | ------------------------------------------- |
| `HOST`                       | `127.0.0.1` | HTTP 监听地址                               |
| `PORT`                       | `4174`      | HTTP 端口                                   |
| `REMOTE_TOKEN`               | 空          | API/WebSocket Bearer 令牌；非本机监听时必填 |
| `CODEX_BIN`                  | `codex`     | Codex CLI 路径                              |
| `DATA_DIR`                   | `.data`     | 隔离配置和应用数据目录                      |
| `CC_SWITCH_DB`               | 自动发现    | CC Switch SQLite 数据库绝对路径             |
| `CODEX_DECK_CLOUDFLARED`     | 自动发现    | cloudflared 可执行文件路径                  |
| `CODEX_DECK_TUNNEL_PROTOCOL` | `http2`     | Quick Tunnel 传输协议                       |

## 数据与安全

- API Key、OAuth 内容和生成的供应商配置不会由 API 返回给浏览器。
- `.data/providers.json` 与 `.data/homes/` 含敏感信息，已加入 `.gitignore`，不要同步或公开。
- 网页具备执行命令和批准文件修改的能力。公网使用时，令牌与 Cloudflare Access 两层防护都值得启用。

## 验证

```bash
npm test
npm run build
```

## 常见问题

### Windows 显示 `spawn EINVAL`

请先重新执行 `npm run build` 并重启 Deck。新版本会通过 `cmd.exe` 启动 npm 安装产生的 `codex.cmd`，而原生 `codex.exe` 仍直接启动。如 Codex 不在 PATH，可显式设置：

```powershell
$env:CODEX_BIN="$env:APPDATA\npm\codex.cmd"
npm start -- --lan
```

### 现有 Session 列表为空

Deck 通过 Codex `app-server` 的 `thread/list` 读取历史。它会自动发现当前系统的 `~/.codex`，在 WSL 中还会扫描 `/mnt/c/Users/*/.codex`。修改后必须重新构建并彻底重启后端：

```bash
npm run build
npm start -- --lan
```

启动日志若显示某个 app-server 退出，请先运行 `codex --version`，或通过 `CODEX_BIN` 指向实际可用的 Codex CLI。
