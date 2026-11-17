# 双人联机部署与边界

保留同机模式。通过同机牌桌菜单的「网上双人联机」进入，或直接打开 `/#online`。
一方创建房间，将 8 位邀请码发给另一方；另一方在同一个服务器地址输入邀请码。
Asuka 为创建者，Sinji 为加入者。首版不提供账号、匹配、观战和自动判负。

## 本地启动与开发

需要 Node.js 24+（使用内置 `node:sqlite`，运行时可能打印 experimental 警告）。

```powershell
npm ci
npm run build
npm run server
```

打开 `http://127.0.0.1:3001/#online`。两个浏览器/独立浏览器配置可作为两位玩家。
同一浏览器同一站点共享座位凭证，多开窗口会接管同一座位，不会成为另一位玩家。
开发时额外运行 `npm run dev`；Vite 将 `/socket.io` 代理到 3001。

局域网测试：设置 `$env:HOST='0.0.0.0'` 后启动服务，双方访问服务器的局域网 IP 和 3001 端口。
是否开放 Windows 防火墙由部署者配置。同机功能无需运行联机服务器。

## 朋友小规模游玩：本机开服，无需购买域名

项目默认面向下载者自建房间，不需要云服务器、域名、账号系统或集群。
Windows 双击 `host-friends.cmd`，会安装缺失的 npm 依赖并构建，然后选择：

- **Public invite**：不同网络游玩。`npm run host:public` 启动本机服务与 Cloudflare Quick Tunnel。
- **LAN only**：同一网络游玩。`npm run host:lan` 显示本机地址和局域网地址。
- **Public invite via SSH**：`npm run host:ssh` 使用系统 OpenSSH 连接 localhost.run，适合 Cloudflare 无法连接时使用；同样不需要账号或域名。

Cloudflare 模式首次从官方 GitHub Release 获取固定版本（2026.11.0）的便携 `cloudflared`，验证发布的 SHA-256 后缓存到 `tools/`。
下载流式写入磁盘并支持断点续传，不将整个安装文件缓存在内存，不依赖匿名 GitHub API 额度。
不修改系统 PATH、不需要管理员权限或 Cloudflare 账号，也无需路由器端口映射。
自动下载支持 Windows x64 / Linux x64、ARM64；其他平台可自行安装并设置 `CLOUDFLARED` 为可执行文件路径。
若 GitHub 下载失败，也可从[官方下载页](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)取得程序后设置该变量。

房主使用 `http://127.0.0.1:3001/#online` 创建房间，把**临时 HTTPS 网址 + 8 位邀请码**一起发给朋友。
朋友不需要安装 Node、游戏或隧道程序。仅分享邀请码无法跨网络找到房主电脑。
应用只接受本次生成的确切公网 Origin，不放开所有 `trycloudflare.com` 来源。
启动器只有确认隧道注册连接成功后才提示分享，90 秒未连接就退出，不把取得网址当作连接成功。
Cloudflare 默认使用 TCP 7844（HTTP/2）；可用 `TUNNEL_PROTOCOL` 选择 `http2`、`quic` 或 `auto`。
SSH 备用方式使用 TCP 22，核对[官方公布的 Ed25519 主机指纹](https://localhost.run/docs/security)，
不读取个人 SSH 密钥、不修改全局 SSH 配置。Windows 若缺少 `ssh` / `ssh-keyscan`，需安装系统的 OpenSSH 客户端。
免费 SSH 域名可能在运行中轮换；终端会显示新网址，朋友需要在新网址上传已保存的重连凭证。

房主需保持开服窗口和电脑运行，Ctrl+C 结束。Quick Tunnel 停止后地址失效，重新开服通常会生成新网址。
**浏览器存储按域名隔离**：朋友换了临时网址后，要上传之前下载的「重连凭证」才能接回旧座位；
只有邀请码不能接管已占用座位。房主的 localhost 地址不变，服务器 `data/` 不删除即可保留存档。
临时地址无法连接时可重启隧道，或同网使用局域网模式；不宣称所有地区网络都能稳定访问。

这两种隧道都是免费第三方服务，没有可用性保证，不适合作为长期公开运营平台。
依据：[Cloudflare Quick Tunnels 官方说明](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)，
[WebSocket 支持](https://developers.cloudflare.com/network/websockets/)。
备用方式依据：[localhost.run 官方说明](https://localhost.run/docs/)、[无密钥连接说明](https://localhost.run/docs/faq)。
隧道工具为 Cloudflare 独立软件，适用其自身许可证；不会随源码提交其二进制。

好友开服入口上限为 20 个持久房间、16 个连接，服务端不运行 AI。默认 SQLite 文件 `data/duel.sqlite`。
`PORT` 可更换端口，`DUEL_DATABASE` 可更换存档位置。也可直接运行 `npm run host:ssh -- --port 3005 --database data/friends.sqlite`。
端口被占用时请停止旧的开服窗口，或设定其他端口。
局域网模式监听 0.0.0.0，Windows 防火墙需允许朋友连接；公网隧道模式只监听 127.0.0.1。

## 可选：已有主机的长期部署

仓库保留 `npm run server` 和 Dockerfile，供已经有主机的使用者选用，并非游玩前提。
普通服务默认监听 127.0.0.1:3001；用 `HOST`、`PORT`、`DUEL_DATABASE` 配置。
通过自己的 HTTPS 反向代理时，设置 `ALLOWED_ORIGINS` 为实际 Origin（多个用逗号分隔）。
SQLite 目录必须持久化，只运行单实例，不配置共享数据库的多副本。健康检查为 `GET /health`。
Docker 默认只包含公开几何主题，不打包本机 EVA 素材或 `.env.local`。

## 恢复、存档与隐私

- 浏览器先保存随机座位凭证，再申请房间。服务端只保存凭证的 SHA-256 摘要。
- 刷新、断网、服务器重启后通过凭证恢复座位，并取回完整的**可见局面快照**。
- 每个行动包含唯一 ID 和期望局面版本。事务中同时保存新局面和行动，再确认；丢失确认后重发不会执行两次。
- 尚未确认的行动在浏览器持久化；断线期间不允许继续走棋。客户端最多一个待确认行动。
- 「保存重连凭证」用于清理浏览器或换设备后的恢复。它相当于座位钥匙，**只分享邀请码，不分享凭证文件**。
- 「离开房间」清除当前浏览器的凭证，不删除服务器对局；未备份凭证则无法认领原座位。
- 邀请码仅允许占据空闲的第二座位，不能读取已满房间。每座位只保留一个在线连接，新连接替换旧连接。
- 对局中只发送 `getPlayerView` 投影和当前玩家可用动作。隐藏牌库、随机种子/状态、对手预留牌不进入网络消息。
- 从公开市场预留的牌在公开日志中仍可追溯，这是双方原本就能知道的信息；盲预留身份不写入公共日志。
- 线上初始牌库另外使用系统安全随机源打乱，避免从规则引擎的 32 位初始化随机状态推测隐藏牌库。
- 完整行动回放只在终局后向持有座位凭证的玩家开放；可导出 JSON，或进入现有回放界面进行本地分析。
- 联机过程中不运行 AI 分析、不发送完整存档给对方；服务器不运行 MCTS。回放分析不会覆盖同机当前存档。

同机存档、联机凭证使用不同存储键。服务端对局只存在服务器磁盘，普通客户端无法导入任意状态覆盖它。
服务端是受信任的裁判；该方案不防服务器运营者查看数据库，也不检测玩家使用外部 AI。

## 资源上限与备份

普通服务器入口上限为 200 个持久房间、128 个连接；好友开服入口进一步限制为 20 房间、16 连接。每局最多 5000 次行动。SQLite 页缓存约 4 MiB；
没有每房间 Worker、后台模拟、全历史快照缓存或断线消息缓存。每个请求按需读写当前局面。
静态素材通过 HTTP 流式传输，WebSocket 只发送状态数据；客户端只加载一种主题。
不超过 1 MiB 的 HTML/JS/CSS/SVG 支持 gzip，响应声明实际长度。`npm run build` 会逐张生成 WebP 图片副本，
浏览器支持 WebP 时自动使用；卡面宽 480 px、桌面宽不超过 1920 px，quality 86，保留原始 PNG。
转换只在构建时执行，单任务处理；服务器不运行图片编码器。2026-11-17 本机 75 张主题图从 138.4 MiB 降至 2.7 MiB。
Sharp 的编码参数见[官方文档](https://sharp.pixelplumbing.com/api-output/#webp)。
入站消息上限 8 KiB，每连接每 10 秒最多 40 次业务请求；IP 建连/入房另有限流，限流表最多 2048 项。
慢连接的发送队列超过 32 项时断开传输，让客户端重连并重新同步，避免持续积压快照。
反向代理后的 IP 默认是代理地址，因此这些 IP 限额可能由所有用户共享；首版按好友小规模使用设计。

空房超过 24 小时、已加入双方的对局距最后成功行动超过 30 天会过期，启动及每小时清理一次。
无在线时长扣分和断线判负。数据库本身有房间数/行动数边界，但没有固定字节配额，部署者应监控磁盘。
备份时停止服务后复制 `data` 目录（包括 SQLite WAL 文件），恢复后再启动。
不要将数据库、凭证或 `.env` 提交到 GitHub；仓库已忽略这些路径。

## 验证

`npm run check` 覆盖规则、AI、类型、生产构建，以及真实 Socket.IO 双客户端的：
入房、满房拒绝、回合鉴权、旧版本拒绝、非法请求、重复行动、隐藏信息、服务器重启恢复、
座位接管、终局回放复现、房间上限和过期、浏览器来源拒绝、客户端刷新后待确认行动恢复。
2026-11-17 已使用两个隔离 Edge 浏览器环境，经真实 localhost.run HTTPS/WSS 隧道完成默认主题整局验收：
95 步、10 类行动，包含断网恢复、刷新、凭证迁移与终局回放，页面脚本错误为 0。详见 [验收记录](ONLINE_ACCEPTANCE.md)。
两个浏览器仍在同一台电脑运行；未代替两台物理设备、不同运营商网络的现场测试。
Cloudflare 在本次网络中无法建立隧道；EVA 图片经备用免费线路仍出现超时/截断，未判定 EVA 公网完整体验通过。
Docker 守护进程未运行，容器构建尚未实测。

2026-11-17 本机资源冒烟测试（`npm run benchmark:online`）：12 房间、24 连接、144 次成功行动，
确认延迟 P50 55.4 ms / P95 84.0 ms。服务器和全部负载客户端在同一进程中，合计峰值 RSS
111.5 MiB，相比初始化增长 16.1 MiB；最大快照 9582 字节，SQLite 含 WAL 共 2916776 字节。
随机局面、硬件、磁盘同步与网络会改变结果；这些数据不是生产服务器容量承诺。

协议依据：[Socket.IO 交付语义](https://socket.io/docs/v4/delivery-guarantees/)。
实现采用应用层持久化、确认和去重，不依赖 Socket.IO 的断线数据缓存。

### 重跑浏览器验收

先运行 `npm run build`，再在独立终端运行 `npm run host:lan -- --port 3003 --database data/e2e.sqlite`。
Windows 默认使用已安装的 Microsoft Edge；其他平台需先执行 `npx playwright install chromium`。
运行 `npm run test:e2e`，单个 Worker 创建两份隔离浏览器环境，通过真实页面点击走到终局。
公网验收将 `E2E_HOST_URL` 设为房主本机地址，`E2E_GUEST_URL` 设为终端给出的 HTTPS 地址；
也可在已忽略的 `.qa/e2e-env.json` 写入 `{"host":"http://127.0.0.1:3003","guest":"https://你的临时域名"}`。
图片、失败快照保存在 `.qa/browser/`，凭证仅保留在测试浏览器内存/临时下载中，不写入测试报告。
测试驱动只读取客户端收到的可见状态选择合法动作，不直接修改服务器或浏览器对局状态。
公网测试主动断开朋友端网络，再自动重连、刷新、导出凭证并在全新浏览器中导入；
同时核验对手盲预留隐藏、两端版本一致、资源数字布局、终局回放以及实际 WebSocket 主机名。
