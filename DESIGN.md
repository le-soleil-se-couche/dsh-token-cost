# dsh-token-cost 设计文档

Token 用量 / 缓存命中 / 费用统计插件（DeepSeek Harness Web GUI）

## 1. 需求映射

| 需求 | 实现 |
|---|---|
| 单对话视图 | composer dock 费用芯片（底部状态行旁，显示 ≈¥金额 + 缓存命中率），点击打开单会话明细弹窗（按 step 的 usage 记录表） |
| 整体汇总视图 | 设置页 > 插件配置 > Web UI 插件 > 「Token 费用统计」卡片，含汇总 Tab（时间筛选 + 统计卡片 + 按模型/会话/API Key 分组表） |
| 底部缺少价格信息 | composer dock 的「≈¥x.xx · 缓存 xx%」芯片直接补上（现有行显示 Input/Output tokens，价格与命中率由本插件补齐） |
| 时间筛选 | 今天 / 昨天 / 最近 7 天 / 最近 30 天 / 本月 / 上月 / 自定义（≤30 天，日期选择） |
| ~~自选 API Key~~（已砍） | 用户确认不做：API Key 分组（含 keyAliases 配置与按 Key 分组表）不在 v1 范围内 |
| 发布到 dsh-plugin 生态 | 在 dsh-web-ui 家族仓库 packages/dsh-token-cost 维护，可独立 npm 发布（@deepseek-ai/dsh-token-cost），也可经 dsh-web-ui-all 聚合安装 |

## 2. 数据来源（关键设计）

DSH 把每个会话的完整事件流持久化为 immutable JSONL generation：当前 v2 是
`$DSH_HOME/sessions/<cwd-slug>/<session-id>/session.v2.jsonl(.zstd)`；插件也读取
v1 `session.v1.jsonl(.zstd)` 与 v0 `session.jsonl(.zstd)`。同一目录只选择数字版本
最高的 canonical generation，避免把迁移保留的多代文件重复计费。

与计费相关的事件：

- `request/context`：`{provider, model}` —— 每个请求一次，跟随其后的是该请求的 usage 事件
- v0/v1 `assistant/chunk`（`chunk.type === 'usage'`）与 `assistant/message.data.usage`
- v2 `assistant/message.data.usage`（缺失时取 embedded stream 最后 usage）与 `assistant/attempt.data.stream`
- `session` / `session/title`：会话元信息（创建时间、cwd、标题）

字段语义（dsh-llm-deepseek 的 mapUsage 注释确认）：
`inputTokens = prompt_tokens - cache_hit`（**缓存未命中**部分，不含命中）；`cacheReadTokens = cache_hit`（**命中**部分）。两者不相交，相加即全部输入。

### 2.1 记账方式：增量 ledger

- host 进程维护 `$DSH_HOME/storages/dsh-token-cost/ledger.json`：`{version, sessions: {<sessionId>: {file, mtimeMs, size, title, cwd, createdAt, records[]}}}`
- 每次查询先 `sync()`：glob 全部会话日志，仅重新解析 mtime/size 变化的文件（通常只有当前会话在变），删除已消失的会话
- 单条 record：`{time, model, provider, inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, reasoningTokens}`
- 内存缓存解析结果，避免重复解压；zstd 解压用 fzstd（纯 JS，零依赖）
- 首次查询时自动回填历史全部会话（本机 5 个会话，秒级完成）

## 3. 价格引擎（两套方案 + 自动切换）

官方页面（api-docs.deepseek.com/quick_start/pricing，2026-08-14 抓取）：
**现行方案 A（2026-08-16T16:00Z 之前）**：平价（元/百万 tokens）
- v4-flash：命中 0.02 / 未命中 1 / 输出 2；v4-pro：0.025 / 3 / 6
- USD：flash 0.0028/0.14/0.28；pro 0.003625/0.435/0.87
**新方案 B（2026-08-16T16:00Z = 北京时间 2026-08-17 00:00 起）**：峰谷定价，高峰按东八区 09:00-12:00、14:00-18:00 判定（与官方公告一致），为闲时 2 倍
- v4-flash：闲时 命中0.05/未命中1.5/输出4.5，高峰 0.10/3.0/9.0（USD 0.007/0.22/0.66；0.014/0.44/1.32）
- v4-pro：闲时 0.15/4.5/13.5，高峰 0.30/9.0/27.0（USD 0.022/0.66/1.98；0.044/1.32/3.96）
- 旧模型 deepseek-chat/deepseek-reasoner 不在公告内，两方案均保持旧平价（chat 2/0.5/8 元，reasoner 4/1/16 元；USD 0.27/0.07/1.10、0.55/0.14/2.19）

### 自动切换逻辑（涨价预适配）

`PriceScheme[]` 有序数组，每条 `effectiveFrom`（UTC 毫秒）。对每条 usage 记录取
`max(scheme.effectiveFrom <= record.time)` 的方案；方案带 `peak` 时按记录时间
在东八区（`peakOffsetMinutes = 480`）的小时判断高峰/闲时。**将来再涨价只需追加一条新方案，无需改代码。**
设置项 `priceMode`：`auto`（默认，按时间自动切换）/ 强制 A / 强制 B；另有 `customPrices`
JSON 可覆盖/新增任意模型价格。配置页以表单编辑该字段：先从 ledger 发现未定价
模型，再填当前币种的 miss/hit/output；第三方模型默认 `flat`，避免套用 DeepSeek
峰谷倍率。只填一种币种时按 `1 USD = 7.25 CNY` 补另一侧。费用仍在查询时计算，
补价后历史立刻回算。配置页只保留高峰时段（东八区）与币种状态。
`GET /api/dsh-token-cost/models` 返回 builtin / custom / unpriced 目录。

费用 = miss/1e6 × 未命中单价 + hit/1e6 × 命中单价 + output/1e6 × 输出单价
（DeepSeek 扣费规则：消耗 token 数 × 模型单价；缓存写入在本代模型不单独计价）。

## 4. Host 半区（src/index.ts + ledger.ts + parser.ts + pricing.ts + routes.ts）

- 服务注入：`webServer`；通过两代共有的 `SettingsProvider.register/watch` 可选绑定 `settings`，注册命名空间 `token-cost`
- 路由（loopback 护栏，同 dsh-ssh）：
  - `GET /api/dsh-token-cost/status`：ledger 统计 + 当前方案/下次切换
  - `GET /api/dsh-token-cost/summary?from&to&tz`：汇总（总 token/费用、按模型、按会话、按日）；`tz` 为客户端 UTC 偏移分钟，byDay 按客户端本地日切分（跨零点/时区切换正确）
  - `GET /api/dsh-token-cost/sessions`：会话列表
  - `GET /api/dsh-token-cost/session/:id`：单会话记录 + 合计（弹窗/芯片用）
  - `GET /api/dsh-token-cost/models`：内置 / 自定义 / 未定价模型目录（配置页用）
  - `POST /api/dsh-token-cost/resync`：强制全量重扫
- 费用一律在 host 计算（价格引擎单一事实源），响应同时携带 cny/usd，客户端按设置显示

## 5. Browser 半区（src/client/）

- `conversation.composer.dock`（官方 list 槽，scope session，自带 sessionId/useProjection）：
  注册「费用芯片」——轮询单会话汇总，显示 `≈¥0.12 · 缓存 68%`；点击弹单会话明细
  （记录表：时间/模型/输入(命中+未命中)/输出/费用；底部合计 + 缓存命中率）
- `settings.plugin.item`（官方 ui-settings-plugins 声明的 keyed 槽）：设置卡片，三个 Tab
  - 汇总：筛选条（7 种预设 + 自定义日期）+ 4 张统计卡（费用/输入/输出/缓存命中率）
    + 按模型表 + 按会话表 + 每日趋势表
  - 会话：全部会话列表（点击打开明细弹窗，同单会话视图）
  - 配置：币种（cny/usd）、计价模式（auto/方案A/方案B）、自定义价格表
    （发现未定价模型 + 表单录入，底层仍写 customPrices JSON）、重新扫描按钮
- 本地化 zh/en；格式化（金额、token 缩写 12.3K/1.2M）

## 6. 验证与发布

- vitest 单测：parser（真实日志 fixture）、pricing（两方案边界时间、高峰/闲时）、ledger 增量
- 构建：tsdown（shared/tsdown.client.ts 预设）> 安装 link 包 > 重启 dsh web > 路由 + UI 验证
- 发布：README 中英双语（安装/配置/价格方案说明/免责声明）+ 提交 dsh-web-ui 家族仓库；
  npm publish 与 GitHub 需用户授权
