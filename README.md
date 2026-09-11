# dsh-token-cost

<p align="center">
  <img src="docs/banner.png" alt="dsh-token-cost" width="100%">
</p>

<p align="center">
  <a href="README.en.md">English</a> · <strong>中文</strong>
</p>

DeepSeek Harness（DSH）Web GUI 的 Token 用量 / 缓存命中 / 费用统计插件：单对话与整体汇总，内置 DeepSeek 官方计价方案（含 V4.1 Flash 降价与 V4 Pro 路由，东八区峰谷），也可为自己调用的其他模型填写单价。

2026-08-17更新：支持为自己调用的其他模型填写单价；点「添加模型」即写入本地价格文件，刷新后仍在，历史费用立刻按新单价重算。

2026-08-25 更新：计量内核升级为 attempt-aware fold，补齐失败调用后 retry、`compaction/summary.usage` 与 fork `seedLength` 边界；账本 schema 升至 v2，旧缓存会从权威 session logs 自动重折叠。

2026-08-28 更新：retry 边界与官方 `llm/retry-started` 对齐，补充官方 session id 目录编码兼容，并刷新与 `0.1.2-alpha.1` 的差异说明。账本 schema 升至 v3，已有 v2 缓存会自动重折叠。

2026-09-05 更新：本版本使用官方 npm `0.1.2-rc.1` SDK，直接消费官方设置与插件卡片类型；同时增加 session format v2 读取，账本 schema 为 v4；并修复 Windows 路径下账本目录创建、显式 `flat: false` 自定义价格持久化，以及已有统计行费用标记的刷新。宿主 SDK 与日志协议分别验证：v2 synthetic fixture 通过不代表 `0.1.3-alpha.1` 宿主运行已验收。

2026-09-11 更新：同步官方调价——新增方案 C（V4.1 Flash，2026-09-10 12:00 起）与方案 D（V4 Pro 自 2026-09-14 12:00 起按 Flash 价计费）；旧模型名 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 自方案 C 起按 Flash 价计费，并补齐 vision-exp 在方案 B 的单价。另补入 2026-08-23 起的周末闲时历史方案，保留调价前后的各段价格。历史记录在自动模式下按生效时间切换。

## 功能

- **单对话视图**：对话页面底部官方状态行（「首 token 平均 … · … tok/s」之后）直接嵌入本会话消耗费用，点击即可打开按请求的明细弹窗（时间 / 模型 / 缓存未命中 / 缓存命中 / 输出 / 费用，最新在上）。

<p align="center">
  <img src="docs/screenshots/conversation-bottom.png" alt="对话底部状态行费用展示" width="90%">
</p>

<p align="center">
  <img src="docs/screenshots/cost-detail.png" alt="费用明细弹窗" width="80%">
</p>

- **整体汇总**（设置 > 插件 > 插件配置 > Token 费用统计）：时间筛选（今天 / 昨天 / 最近 7 天 / 最近 30 天 / 本月 / 上月 / 自定义，最多 30 天）+ 费用 / 输入 / 输出 / 缓存命中率统计卡，按模型、会话、日期分组。
- **计价状态**：高峰时段按东八区显示（09:00–12:00、14:00–18:00），判定也按东八区时钟；2026-08-23 起峰时仅限工作日，周末整天按闲时，界面会标注「仅工作日」。
- **自定义模型价格**：配置页可从账本发现未定价模型，或手动添加尚未调用的模型；按每百万 tokens 填写缓存未命中 / 缓存命中 / 输出。点「添加模型」即写入本地价格文件，刷新后仍在，历史记录立刻按新单价重算。缓存命中可不填（按 0 计）。第三方模型按平价，不受 DeepSeek 峰谷影响。

## 数据来源

插件读取 DSH 的持久会话 generation：当前 v2 为 `$DSH_HOME/sessions/<project-key>/<encoded-session-id>/session.v2.jsonl`（或 `.zstd`），并兼容 v1 的 `session.v1.jsonl(.zstd)` 与 v0 的 `session.jsonl(.zstd)`。同一会话迁移后可能保留多代不可变文件；插件只选择数字版本最高的 canonical generation 一次，不重复结算迁移副本。若最高代高于已支持的 v2，插件明确告警并跳过该会话，不回退读取旧代。

v0/v1 的顶层 `assistant/chunk` / `assistant/message` 与 v2 的 `assistant/message.data.usage`（缺失时取 `data.stream` 最后一个 usage）/ `assistant/attempt.data.stream` 都折叠为按 attempt 的计费记录。v2 stream 支持官方 packed text、reasoning、tool-call run 语法；usage 仍来自其中的 raw `chunk` record。同一次 attempt 内后值替换前值，只有 `llm/retry-started` 打开同一 turn/step 的下一计费槽；`compaction/summary.usage` 独立计入。fork 的 v0/v1 使用 `seedLength`，v2 使用最后一个 `session/end-seed { inherited: true }` 的 cut，聚合时排除继承前缀。紧凑账本（`$DSH_HOME/storages/dsh-token-cost/ledger.json`）只重解析变化的权威 generation；ledger v4 会使旧口径缓存失效。自定义单价存在同目录的 `custom-prices.json`；显式 `flat: false` 会原样持久化。zstd 解压使用 fzstd（纯 JS 零依赖）。

Token 字段遵循 Harness 约定：`inputTokens` = 缓存未命中部分，`cacheReadTokens` = 缓存命中部分（两者不相交，相加即计费输入）。

统计边界仍由上游日志决定：标题生成、Web Search、被中断调用、失败摘要或其他客户端若没有写出 usage，插件不会虚构 token 或费用。可公开复核的 synthetic fixture 与手算结果位于 `tests/fixtures/usage-accounting/`。

### 支持版本与日志协议边界

声明的宿主与浏览器 SDK 版本为官方 npm `0.1.2-rc.1`，编译依赖固定到该版本。设置 namespace 使用 `@deepseek-ai/dsh-settings` 的原生 `register` / `watch`，浏览器 scope 和卡片 slot 分别来自官方 `dsh-client-ui-settings/client` 与 `dsh-client-ui-settings-plugins/client`。构建不需要 DSH 源码 checkout、旧 `dsh-client-runtime` 或本地伪造声明。

v2 日志读取依据 DSH `0.1.3-alpha.1` 的固定源码快照 [`d347e70390`](https://github.com/deepseek-ai/deepseek-harness/commit/d347e703908d0406b7a7ef80e3a0e594d86b2215)：session format v2 将每次 Assistant settlement 写为携带嵌入 stream 的 `assistant/message` 或 `assistant/attempt`，当前 generation 使用 `session.v2.jsonl(.zstd)`；迁移留下的 v0/v1 文件不是额外调用。`0.1.3-alpha.1` 宿主的完整安装与运行尚未验收；其版本不在本包声明的 peer 支持范围中。

本插件继续单独结算官方已经写入日志的 `compaction/summary.usage`，并在跨 session 汇总中排除 fork 继承前缀。这不代表插件能替代官方账单，也不扩大上游没有记录 usage 的遥测边界。`compaction/end` 等没有官方 usage schema 的字段仍不换算为费用；仓库测试只使用 synthetic fixture，不发布真实 session log。

## 安装

```sh
dsh plugin --profile web add github:le-soleil-se-couche/dsh-token-cost
```

使用官方 `@deepseek-ai/dsh@0.1.2-rc.1` 宿主。安装与重启会修改指定 profile；重启其 `dsh web` 后，在设置 > 插件 > 插件配置中打开「Token 费用统计」。历史会话日志在首次查询时自动回填。已在 macOS 的独立官方宿主中验证插件设置入口、合成日志费用汇总、自定义单价保存及币种设置重启保留；真实模型回合和其他平台仍需单独验证。

### 插件中心提示安装超时

`Request timed out: GitHub may be unreachable or the network is unstable` 是插件中心的请求超时提示，仅凭这段提示无法判断插件是否构建失败。GitHub 安装还会下载构建依赖并执行 `prepare`；请在终端中检查完整输出。

先记录 `dsh --version`、`node --version` 和 `pnpm --version`，再执行 `git ls-remote https://github.com/le-soleil-se-couche/dsh-token-cost.git HEAD` 检查 GitHub 可达性。随后在自己的测试 profile 中运行上面的安装命令，并保留从首次错误到进程退出的完整输出及退出码。

若 GitHub 无法连接，先处理网络连通性；若出现 `prepare`、TypeScript 或 peer dependency 错误，请将对应错误和宿主版本附到 Issue 中。分享日志前移除 Token、认证链接、代理凭证和个人路径。安装失败时保留现有可用 profile，通过测试 profile 验证修复后再更新。

## 内置计价方案

| 方案 | 生效时间（北京时间） | 说明 |
|---|---|---|
| A `flat-2026-08` | 2026-08-17 00:00 之前 | 平价：V4 Flash 未命中/命中/输出 = 1 / 0.02 / 2 元；V4 Pro = 3 / 0.025 / 6 元 |
| B `peak-offpeak-2026-08-17` | 2026-08-17 00:00 起 | 峰谷定价（每日）：V4 Flash 高峰 3 / 0.1 / 9 元；V4 Pro 高峰 9 / 0.3 / 27 元 |
| B2 `peak-offpeak-weekdays-2026-08-23` | 2026-08-23 00:00 起 | 沿用 B 的单价，峰时仅工作日；周末整天按闲时 |
| C `v4.1-flash-2026-09-10` | 2026-09-10 12:00 起 | V4.1 Flash 降价：高峰 2 / 0.04 / 8 元；峰时仅工作日；旧名 `deepseek-v4-flash` 系列按 Flash 价计费 |
| D `v4-pro-to-flash-2026-09-14` | 2026-09-14 12:00 起 | `deepseek-v4-pro` 路由到 V4.1 Flash，按 Flash 价计费（至 V4.1 Pro 上线） |

价格为「缓存未命中 / 缓存命中 / 输出」，单位元/百万 tokens；闲时为高峰的一半。方案 B2 起高峰时段仅周一至周五（东八区 09:00–12:00、14:00–18:00）。B2 是自动模式使用的历史过渡方案，现有手动 A/B/C/D 选择保持原义。

周末规则的历史生效日依据当时提交的 [PR #2](https://github.com/le-soleil-se-couche/dsh-token-cost/pull/2)；[当前官方价格页](https://api-docs.deepseek.com/quick_start/pricing/)确认周一至周五的峰时规则，但未保留该历史生效日期。

## 配置项

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关（状态行费用显示 + 汇总卡片） |
| `currency` | `'cny'` \| `'usd'` | `'cny'` | 显示币种 |
| `priceMode` | `'auto'` \| `'scheme-a'` \| `'scheme-b'` \| `'scheme-c'` \| `'scheme-d'` | `'auto'` | 自动按记录时间切换，也可强制某一方案 |
| `customPrices` | string (JSON) | `''` | 兼容旧设置项；现用配置页表单，落盘到 `storages/dsh-token-cost/custom-prices.json` |

以上均可在卡片的「配置」页编辑；「重新扫描会话日志」按钮强制全量重解析。

## 开发

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm pack
```

开发基线为 Node.js `22.22.1` 和 pnpm `9.15.9`。Git 安装的 `prepare` 会同时生成 JavaScript 与声明文件。源码 checkout 保留 `src/`、`build/`、测试和锁文件；安装包只携带 `lib/`、bundle patch 与双语说明。宿主入口为 `lib/index.js`，浏览器入口为 `lib/client.js`（`window.__ModuleLoader__.load` factory），声明入口为 `lib/types/index.d.ts` 与 `lib/types/client/index.d.ts`。打包前可通过 `npm pack --dry-run --ignore-scripts` 检查清单。

本地构建后可用 `dsh plugin --profile web add link:/absolute/path/to/dsh-token-cost` 安装到指定 profile。安装和重启会修改该 profile，请选择自己的开发 profile。

架构说明见 DESIGN.md。

---

*[English version](README.en.md)*
