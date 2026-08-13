# Codex Deck

一个移动端优先的 Codex 远程控制台。它通过 Codex CLI 的结构化 `app-server` 协议管理真实会话，并自动只读同步 CC Switch 中的 Codex 供应商。

## 能做什么

- CC Switch 同步：自动发现 `~/.cc-switch/cc-switch.db`；WSL 下也会只读查找 Windows 的 CC Switch 数据库。每 5 秒同步连接信息，但不会修改 CCS 当前项。
- Session 级供应商：一个共享 Codex runtime 在启动时加载 CCS 中的 Official、中转、Responses/Chat 等连接定义；每个新 Session 独立选择 `modelProvider + model`，密钥只进入 runtime 进程环境。
- 真实会话库：Deck 使用当前系统真实的 `~/.codex`，启动时读取已有 session，不再为供应商复制 `CODEX_HOME` 或制造历史孤岛。
- 终端共同值守：Deck runtime 仅在本机环回地址开放 control WebSocket；普通终端通过供应商设置里复制的 `codex --remote ws://127.0.0.1:<port>` 接入，与网页同时查看和控制同一批 Session。
- 项目多会话：左侧只显示按工作目录分组的会话，同一个路径可以创建、运行和切换多个独立 Codex session；Windows `D:\...` 与 WSL `/mnt/d/...` 路径会归入同组。
- 实时管理：查看运行、空闲、待审批和异常状态；接收增量回复；发送新指令、中断 turn、批准或拒绝命令与文件修改。
- Win / WSL：Node 服务可直接跑在 Windows 或 WSL；工作目录填写运行 Codex 一侧可访问的绝对路径。
- 单网页：生产构建后由同一个 Node 服务提供前端、API 和 WebSocket，适合本机、局域网或 Cloudflare Tunnel。

> `app-server` 当前仍是 Codex CLI 的实验接口。建议使用较新的 Codex CLI，并在升级后运行一次构建和测试。

## 推荐日常工作流

先启动 Deck，然后在“供应商设置”中复制终端接入命令。通用命令是：

```bash
codex --remote ws://127.0.0.1:<runtime-port>
```

页面可按当前项目生成带 `-C` 的命令。你可以在多个终端中分别运行这些命令；TUI 和网页连接同一个 runtime，所以网页能看到实时运行、审批和错误状态，并能继续发送指令。

直接运行普通 `codex` 创建的旧 Session 仍会出现在历史列表，但 Deck 无法安全附着到那个已经拥有 stdin/审批通道的外部进程，因此不会伪装成实时受管状态。以后用 `--remote` 方式启动即可完全值守。

当前 Codex 版本的 provider 是 thread 创建属性，不能对同一个 thread 热切换。Deck 的“切换供应商”会调用 `thread/fork`：完整复制历史到一个新分支并使用目标供应商，原分支保留以便回退；这不是空白新会话。

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
| `DATA_DIR`                   | `.data`     | Deck 偏好与自定义供应商元数据               |
| `CODEX_DECK_RUNTIME_PORT`    | 自动分配    | 仅监听本机的 Codex control WebSocket 端口；不设则每次启动选空闲端口 |
| `CC_SWITCH_DB`               | 自动发现    | CC Switch SQLite 数据库绝对路径             |
| `CODEX_DECK_CLOUDFLARED`     | 自动发现    | cloudflared 可执行文件路径                  |
| `CODEX_DECK_TUNNEL_PROTOCOL` | `http2`     | Quick Tunnel 传输协议                       |

## 数据与安全

- API Key、OAuth 内容和生成的供应商配置不会由 API 返回给浏览器。
- `.data/providers.json` 可能含自定义供应商密钥，已加入 `.gitignore`，不要同步或公开。CCS 密钥不会返回网页，也不会出现在复制的终端命令中。
- runtime control WebSocket 只监听 `127.0.0.1`，不会随 `--lan` 或 Cloudflare Tunnel 暴露；公网只开放带 Deck 鉴权的网页/API。
- 网页具备执行命令和批准文件修改的能力。公网使用时，令牌与 Cloudflare Access 两层防护都值得启用。

## 验证

```bash
npm test
npm run build
```

## 常见问题

### Windows 显示 `spawn EINVAL` 或 `connect ECONNREFUSED`

请先重新执行 `npm run build` 并彻底退出旧进程后重启 Deck。npm 全局安装的 Codex 在 Windows 上同时带有无扩展名脚本和 `codex.cmd`；Deck 会优先通过 `node` 启动官方 `codex.js`（或直接启动 `codex.exe`），避免把供应商 `-c` 参数拼进 `cmd.exe` 后再被二次加引号，导致 `--listen` 失效、runtime 端口无人监听。

如 Codex 不在 PATH，可显式设置原生可执行文件：

```powershell
$env:CODEX_BIN="$env:APPDATA\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe"
npm start -- --lan
```

### 现有 Session 列表为空

Deck 通过 Codex `app-server` 的 `thread/list` 读取当前系统 `~/.codex` 中的历史。修改后必须重新构建并彻底重启后端：

```bash
npm run build
npm start -- --lan
```

启动日志若显示某个 app-server 退出，请先运行 `codex --version`，或通过 `CODEX_BIN` 指向实际可用的 Codex CLI。

### Windows 与 WSL

Windows 和 WSL 是两个独立运行环境，各自拥有原生 `~/.codex` 与 SQLite runtime。不要让 WSL 直接打开 Windows 的 `.codex`（反向亦然）。需要同时值守两边时，分别启动两个 Deck 实例并使用不同 HTTP 端口；runtime 端口默认自动分配，也可显式设置 `PORT=4184 CODEX_DECK_RUNTIME_PORT=4185`。

### 自定义供应商与 OpenAI Official 如何隔离

带 Base URL 的中转供应商只使用该 CCS 记录自己的 API Key。OpenAI Official 只使用 CCS 保存在 `codex_oauth_auth.json` 里的 ChatGPT 登录，**不会**读取 `~/.codex/auth.json` 里当前 CCS 项写进去的中转 Key。

CCS 切换供应商时会改写本机 `auth.json`：当前项若是 Niko / Spacetime，文件里往往是那家的 Key。Deck 启动 runtime 时会另写一份只含 Official ChatGPT 登录的 `auth.json`（不写空的 access_token），并把会话目录接到原来的 `~/.codex`。Official Session 使用 `requires_openai_auth`，由 Codex 自己刷新 ChatGPT 登录，不会把 CCS 当前项的 Key 发到 `api.openai.com`。

旧的 Niko CCS 记录没有独立 Key，会误走 Official 登录。新的 Niko API 已有自己的 Key，用它新建 Session 即可。若 Official 仍报 401，请先在 CCS 里把 OpenAI Official 设为当前项并重新登录，再回 Deck 点“应用”后新建 Official Session。

如果某个中转供应商标了“无独立 Key”，在 CCS 里补上 API Key，再在 Deck 供应商设置中点击“应用”后开新 Session。已有旧 Session 不会自动改鉴权。

### CCS 更新为什么显示“待应用”

CCS 连接定义只在 app-server 启动时加载。Deck 检测到变化后不会自动杀掉正在工作的 Session，而是在供应商设置中显示“待应用”。等任务空闲后点击“应用”会安全重启共享 runtime；历史 Session 不受影响，已连接的终端需要重新连接。
