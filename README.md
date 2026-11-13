# Duel Atelier · 对决工坊

A free, open-source local two-player strategy game and AI analysis sandbox.
非官方的 Splendor Duel 基础版规则实现，供学习、研究和双人同机对战参考。

![公开版牌桌](docs/images/table.jpg)

## 快速开始

需要 **Node.js 24+**。[Release](https://github.com/Akira-suka/duel-atelier/releases/latest)
提供已构建包：解压后双击 `play-built.cmd`，打开 `http://127.0.0.1:4173/`，无需安装 npm 依赖。
开发与修改则下载源码 ZIP，或：

```powershell
git clone https://github.com/Akira-suka/duel-atelier.git
cd duel-atelier
npm ci
npm run dev
```

打开终端显示的 localhost 地址。Windows 安装依赖后可双击 `start.cmd`。
无需账号、在线图片、付费 API 或模型下载。关闭终端即停止服务。

```powershell
npm run check      # 素材/类型/测试/生产构建
npm run build
npm run preview
```

推荐电脑横屏。浏览器本地自动保存对局，支持 JSON 导入/导出；删除浏览器数据会删除存档。

## 已实现

- 同机热座、私人预留牌遮挡、三种获胜条件和完整卡牌能力流程。
- 卡牌、资源与付款动画；可购买卡牌金光；单次提交防重复。
- 每个执行动作的记录与终局回放，历史牌市、资源和双方状态同步查看。
- 快速基线与战术＋MCTS 搜索复核，两种胜率独立计算与缓存。
- 渐进采样：先 8 次，再 24 次；优先当前步骤，可单步增至 64 次；关闭停止、重开续算。
- 确定性规则引擎、存档校验及可复现测试。

当前模拟胜率取决于模拟策略，并非经过真人对局校准的概率。
旧版纯局面存档可以继续游戏，但无法恢复导入前的行动历史。

v0.2 独立验收：新策略对旧策略 **54 胜 10 负**（32 个种子换边、共 64 局）；
24 个保留局面的 Brier 误差 **0.222584 → 0.222656，未改善**。
因此默认保留快速基线，搜索复核作为可选功能，不宣称预测精度已经提高。
原始结果、耗时及复现命令见 [AI_EVALUATION.md](docs/AI_EVALUATION.md)，
算法与限制见 [AI_ARCHITECTURE.md](docs/AI_ARCHITECTURE.md)。

## 许可与第三方边界

**代码与仓库自带的原创几何 SVG 主题采用 MIT License，允许商业使用。**
“免费学习项目”说明本项目的用途，不在 MIT 上追加禁止商用条款。
请保留许可证与第三方声明。

MIT 仅覆盖贡献者有权许可的内容，不授予 Splendor Duel 或其他作品的
商标、角色、美术、规则文字等第三方权利。本项目未获桌游发行方背书，
也没有宣称“开源即可获得官方商业授权”。

公开仓库不包含官方卡图、EVA 同人图像、机体徽记、生成提示词或本地私人主题。
默认卡图和牌背是项目自行编写的通用几何 SVG，可在断网环境生成。
卡牌数值来源与完整上游 MIT 声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
许可范围见 [LICENSE](LICENSE) 与 [ASSET_POLICY.md](ASSET_POLICY.md)。

## 技术结构

- `src/game/`：卡表、纯规则、合法动作、动作记录与存档。
- `src/analysis/`：本地模拟策略与分析 Worker。
- `src/ui/`：桌面棋子、动画、终局回放。
- `src/theme/`：原创公开主题和统一主题接口。
- `scripts/`：素材、发布与评测工具。
- `docs/`：架构、评测与维护说明。

界面统一调用 `applyAction`，不自行扣币或改变胜负。
规则层独立于 React，可供后续局域网服务复用；本版本没有联网同步。

## 本地主题

公开版默认使用 `atelier`。本地扩展可放在 `src/theme/local/<id>/theme.ts`，
默认导出 `Theme`，并在未跟踪的 `.env.local` 中设置 `VITE_THEME=<id>`。
模板见 `.env.example`。本地主题不会自动获得再分发许可，发布前须独立核实。

## 贡献与验证

运行 `npm run check` 后提交最小改动，附复现步骤与实际验证结果。
不提交令牌、私人存档、模型服务密钥或未授权素材。
预测算法变化应与固定旧基线做独立对比，不用测试通过或自我对战代替真人准确率。

官方规则参考：[Space Cowboys 说明书](https://cdn.svc.asmodee.net/production-spacecowboys/uploads/2025/11/SCSPL2P01EN_Rules_Planche_BD.pdf)。
本仓库未复制其规则正文。
