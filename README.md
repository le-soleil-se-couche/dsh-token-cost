# dsh-token-cost

<p align="center">
  <img src="docs/banner.png" alt="dsh-token-cost" width="100%">
</p>

<p align="center">
  <a href="README.en.md">English</a> · <strong>中文</strong>
</p>

DeepSeek Harness（DSH）Web GUI 的 Token 用量 / 缓存命中 / 费用统计插件：单对话与整体汇总，内置 DeepSeek 双计价方案（东八区峰谷），也可为自己调用的其他模型填写单价。

2026-08-17更新：支持为自己调用的其他模型填写单价；点「添加模型」即写入本地价格文件，刷新后仍在，历史费用立刻按新单价重算。

2026-08-25 更新：计量内核升级为 attempt-aware fold，补齐失败调用后 retry、`compaction/summary.usage` 与 fork `seedLength` 边界；账本 schema 升至 v2，旧缓存会从权威 session logs 自动重折叠。

2026-08-28 更新：retry 边界与官方 `llm/retry-started` 对齐，补充官方 session id 目录编码兼容，并刷新与 `0.1.2-alpha.1` 的差异说明。账本 schema 升至 v3，已有 v2 缓存会自动重折叠。

2026-09-05 源码预览：本分支增加 session format v2 读取与新版设置接口适配，账本 schema 为 v4。目标 `0.1.3-alpha.1` 宿主的完整安装和运行尚未通过验收，部分精确版本依赖尚不可安装；旧 SDK 下的测试不能替代该验收。日常安装请使用 `main`，本分支仅供适配审阅。

## 功能

- **单对话视图**：对话页面底部官方状态行（「首 token 平均 … · … tok/s」之后）直接嵌入本会话消耗费用，点击即可打开按请求的明细弹窗（时间 / 模型 / 缓存未命中 / 缓存命中 / 输出 / 费用，最新在上）。

<p align="center">
  <img src="docs/screenshots/conversation-bottom.png" alt="对话底部状态行费用展示" width="90%">
</p>

<p align="center">
  <img src="docs/screenshots/cost-detail.png" alt="费用明细弹窗" width="80%">
</p>

- **整体汇总**（设置 > 插件 > 插件配置 > Token 费用统计）：时间筛选（今天 / 昨天 / 最近 7 天 / 最近 30 天 / 本月 / 上月 / 自定义，最多 30 天）+ 费用 / 输入 / 输出 / 缓存命中率统计卡，按模型、会话、日期分组。
- **计价状态**：高峰时段按东八区显示（09:00–12:00、14:00–18:00），判定也按东八区时钟。
- **自定义模型价格**：配置页可从账本发现未定价模型，或手动添加尚未调用的模型；按每百万 tokens 填写缓存未命中 / 缓存命中 / 输出。点「添加模型」即写入本地价格文件，刷新后仍在，历史记录立刻按新单价重算。缓存命中可不填（按 0 计）。第三方模型按平价，不受 DeepSeek 峰谷影响。

## 数据来源

插件读取 DSH 的持久会话 generation：当前 v2 为 `$DSH_HOME/sessions/<project-key>/<encoded-session-id>/session.v2.jsonl`（或 `.zstd`），并兼容 v1 的 `session.v1.jsonl(.zstd)` 与 v0 的 `session.jsonl(.zstd)`。同一会话迁移后可能保留多代不可变文件；插件只选择数字版本最高的 canonical generation 一次，不重复结算迁移副本。若最高代高于已支持的 v2，插件明确告警并跳过该会话，不回退读取旧代。

v0/v1 的顶层 `assistant/chunk` / `assistant/message` 与 v2 的 `assistant/message.data.usage`（缺失时取 `data.stream` 最后一个 usage）/ `assistant/attempt.data.stream` 都折叠为按 attempt 的计费记录。v2 stream 支持官方 packed text、reasoning、tool-call run 语法；usage 仍来自其中的 raw `chunk` record。同一次 attempt 内后值替换前值，只有 `llm/retry-started` 打开同一 turn/step 的下一计费槽；`compaction/summary.usage` 独立计入。fork 的 v0/v1 使用 `seedLength`，v2 使用最后一个 `session/end-seed { inherited: true }` 的 cut，聚合时排除继承前缀。紧凑账本（`$DSH_HOME/storages/dsh-token-cost/ledger.json`）只重解析变化的权威 generation；ledger v4 会使旧口径缓存失效。自定义单价存在同目录的 `custom-prices.json`；显式 `flat: false` 会原样持久化。zstd 解压使用 fzstd（纯 JS 零依赖）。

Token 字段遵循 Harness 约定：`inputTokens` = 缓存未命中部分，`cacheReadTokens` = 缓存命中部分（两者不相交，相加即计费输入）。

统计边界仍由上游日志决定：标题生成、Web Search、被中断调用、失败摘要或其他客户端若没有写出 usage，插件不会虚构 token 或费用。可公开复核的 synthetic fixture 与手算结果位于 `tests/fixtures/usage-accounting/`。

### 与 DSH 0.1.3-alpha.1 的兼容边界

本次兼容依据 DSH `0.1.3-alpha.1` 的固定源码快照 [`d347e70390`](https://github.com/deepseek-ai/deepseek-harness/commit/d347e703908d0406b7a7ef80e3a0e594d86b2215)：session format v2 将每次 Assistant settlement 写为携带嵌入 stream 的 `assistant/message` 或 `assistant/attempt`，当前 generation 使用 `session.v2.jsonl(.zstd)`；迁移留下的 v0/v1 文件不是额外调用。设置卡注册到该版本仍在使用的官方 `settings.plugin.item` keyed slot，位置保持在 Plugins 的 Plugin configuration tab。

本插件继续单独结算官方已经写入日志的 `compaction/summary.usage`，并在跨 session 汇总中排除 fork 继承前缀。这不代表插件能替代官方账单，也不扩大上游没有记录 usage 的遥测边界。`compaction/end` 等没有官方 usage schema 的字段仍不换算为费用；仓库测试只使用 synthetic fixture，不发布真实 session log。

## 安装

```sh
dsh plugin --profile web add github:le-soleil-se-couche/dsh-token-cost
```

重启 `dsh web` 后，在设置页展开「Web UI 插件」即可看到。历史会话日志在首次查询时自动回填。

## 配置项

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关（状态行费用显示 + 汇总卡片） |
| `currency` | 'cny' | 'usd' | `'cny'` | 显示币种 |
| `priceMode` | 'auto' | 'scheme-a' | 'scheme-b' | `'auto'` | 自动按记录时间切换 |
| `customPrices` | string (JSON) | `''` | 兼容旧设置项；现用配置页表单，落盘到 `storages/dsh-token-cost/custom-prices.json` |

以上均可在卡片的「配置」页编辑；「重新扫描会话日志」按钮强制全量重解析。

## 开发

```sh
pnpm install && pnpm -r build
pnpm --filter @deepseek-ai/dsh-token-cost test
pnpm --filter @deepseek-ai/dsh-token-cost typecheck
```

架构说明见 DESIGN.md。

---

*[English version](README.en.md)*
