# dsh-token-cost

<p align="center">
  <img src="docs/banner.png" alt="dsh-token-cost" width="100%">
</p>

<p align="center">
  <a href="README.en.md">English</a> · <strong>中文</strong>
</p>

DeepSeek Harness（DSH）Web GUI 的 Token 用量 / 缓存命中 / 费用统计插件：支持单对话视图与整体汇总，内置双计价方案并在 DeepSeek 调价后按记录时间自动切换。

## 功能

- **单对话视图**：对话页面底部官方状态行（「首 token 平均 … · … tok/s」之后）直接嵌入本会话消耗费用，点击即可打开按请求的明细弹窗（时间 / 模型 / 缓存未命中 / 缓存命中 / 输出 / 费用，最新在上）。

<p align="center">
  <img src="docs/screenshots/conversation-bottom.png" alt="对话底部状态行费用展示" width="90%">
</p>

<p align="center">
  <img src="docs/screenshots/cost-detail.png" alt="费用明细弹窗" width="80%">
</p>

- **整体汇总**（设置 > 插件配置 > Web UI 插件 > Token 费用统计）：时间筛选（今天 / 昨天 / 最近 7 天 / 最近 30 天 / 本月 / 上月 / 自定义，最多 30 天）+ 费用 / 输入 / 输出 / 缓存命中率统计卡，按模型、会话、日期分组。
- **计价状态**：高峰时段按东八区显示（09:00-12:00、14:00-18:00）。
- **自定义模型价格**：配置页可从账本发现未定价模型，按每百万 tokens 填写未命中 / 命中 / 输出单价；保存后历史记录立刻重算，无需重新扫描。第三方模型按平价计，不受 DeepSeek 峰谷影响。

## 数据来源

插件读取 DSH 的持久会话日志（`$DSH_HOME/sessions/<cwd>/<session-id>/session.jsonl.zstd`），把 provider 上报的 usage 事件折叠为按请求的计费记录（同一 turn/step 取最后一次，与官方 token-meter 投影语义一致）。紧凑账本（`$DSH_HOME/storages/dsh-token-cost/ledger.json`）缓存解析结果，只重解析变化的日志；zstd 解压使用 fzstd（纯 JS 零依赖）。

Token 字段遵循 Harness 约定：`inputTokens` = 缓存未命中部分，`cacheReadTokens` = 缓存命中部分（两者不相交，相加即计费输入）。

## 价格引擎（双方案 + 自动切换）

内置官方价格表（api-docs.deepseek.com/quick_start/pricing，2026-08-14 抓取）：

- **方案 A**（平价，2026-08-16T16:00Z 前）：deepseek-v4-flash / v4-pro 平价（CNY/USD），deepseek-chat / deepseek-reasoner 旧平价。
- **方案 B**（峰谷定价，2026-08-16T16:00Z = 北京时间 2026-08-17 00:00 起）：高峰时段东八区 09:00–12:00、14:00–18:00，闲时半价；v4 两模型适用，旧模型维持平价。判定也按东八区时钟，不按 UTC。

每条记录按时间取「生效时间最晚且不晚于记录时间」的方案计费。**将来 DeepSeek 再次调价，只需追加一条新方案，无需更新插件。** 也支持强制方案（`priceMode`）、自定义模型价格（配置页表单，底层仍存 `customPrices` JSON）与显示币种切换（CNY/USD）。

自定义价格与用量分离：账本只记 model / tokens / 时间，金额在查询时用「内置目录 + 用户覆盖」计算。可以先调用再补价，也可以先登记尚未出现的模型；补价后历史立刻回算。只填当前显示币种时，另一币种按 `1 USD = 7.25 CNY` 换算。

费用 = 未命中/1e6 × 未命中单价 + 命中/1e6 × 命中单价 + 输出/1e6 × 输出单价（每百万 tokens 单价）。

> 说明：金额为基于 provider 上报用量的估算，请以官方账单为准。按日期分组跟随浏览器时区，跨零点对话按本地日期切分；使用同一把 API Key 但在 DSH 之外发起的请求（其他工具/进程）不产生会话日志，不在统计范围内。

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
| `customPrices` | string (JSON) | `''` | 按模型覆盖/新增价格（表单编辑；也可在高级 JSON 里改） |

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