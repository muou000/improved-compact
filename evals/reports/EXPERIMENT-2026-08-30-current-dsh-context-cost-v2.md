# improved-compact 当前 DSH 上下文与成本治理实验 v2

## 决策

本轮改造可以进入本地使用、影子运行或小比例 canary，但仍不自动晋级为稳定版本。当前 DSH 的 keyless 开发集证明候选修复了已知的中段事实丢失，并保持重放、工具配对与摘要结构门；代价是压缩后 estimated token 节省比原生低 5.64 个百分点。新增 8KB spill 默认值显著降低 8KB--50KB 工具输出在后续请求中的重复内联成本，并保留完整可读取副本。请求预算默认只告警，不改变模型路由或输出上限。

## 问题与假设

本轮针对三项当前问题：

1. 评测运行器依赖已从 DSH 移除的 `CallId`，无法在当前 checkout 复跑；
2. 基础 profile 在 50,000 UTF-8 bytes 才 spill，而压缩层在 8,192 code points 处理长工具结果，导致中等长度输出在多个请求中反复计入上下文；
3. 压缩策略只有事后结果，没有部署可配置的请求告警、硬阻断和输出预算入口。

假设是：兼容当前 `ToolCallId` 后可恢复同 runner 对照；把 spill 调整为 8,192 bytes 可在不丢失完整原文的前提下限制即时工具输出；基于标准 token meter、`request/context`、`agent/request` 和 `llm/stream` 的预算策略可提供可回放限额和不记录正文的诊断。

## 实现边界

- 仅修改仓库外 `improved-compact` 插件；上游 `D:\deepseek-harness` 保持干净。
- 安装补丁把基础 `spill-policy.maxInlineBytes` 从 50,000 覆盖为 8,192，继续使用上游 spill store、预览与定位符。
- 请求预算默认 `warnAtRatio: 0.9`，绝对告警、阻断和输出上限均默认关闭。
- 显式输出上限通过 `agent/request` 进入标准 `request/header`；预算观测不写提示词或工具结果正文。
- 评测器同时接受当前 `ToolCallId` 与旧版 `CallId`，但候选声明不再导出旧类型依赖。

## 固定环境

- DSH commit：`cd5ef8148158c3a752a658978873241fdf8e2bbc`，运行时工作区干净，版本 `0.1.2-alpha.1`。
- 环境：Windows x64，Node.js `v26.8.1`。
- 数据集：`dsh-native-compaction-baseline-v1`，4 个开发用合成案例；SHA-256 `41376db5d50cf5fc6750427568736c7272128940f154fdbbc79cb381801cbfcd`。
- runner SHA-256：`d349b2eca8ae81c8defeda0ae833b6aa81ac7f32d0d2f1533ba6e45638cd79df`。
- scorer SHA-256：`fe5f056b987fa0403d0cf713a00e6a7e81c2b1a79b84aea45a08e9cd5ebd27fb`。
- 候选构建 SHA-256：`ae4cbe7579a71eb42bbff71f350e4810877deaadba61b2c99b221f52a6e2f491`。
- 原生与候选各 5 次重复；每组 20 个案例结果。

## 压缩对照

| 指标 | 当前 DSH 原生 | improved-compact | 变化 |
| --- | ---: | ---: | ---: |
| 压缩成功率 | 100% | 100% | 持平 |
| 字面锚点，micro | 95.45% | 100% | +4.55 pp |
| 后续检查，micro | 90.00% | 100% | +10.00 pp |
| 后续检查，macro | 87.50% | 100% | +12.50 pp |
| estimated token 节省，macro | 71.15% | 65.51% | -5.64 pp |
| 语义 digest | 1/5 unique | 1/5 unique | 均稳定 |
| 结构门、重放、no-op、工具配对 | 全部通过 | 全部通过 | 持平 |
| 本机四案均值 | 15.73 ms | 22.38 ms | +6.65 ms |

原生失败集中在 `tool-prune-middle-loss`：锚点召回 80%，后续检查 50%；候选为 100%/100%。其余三个案例两组质量均为 100%。本地时延只反映确定性扫描和日志事务，不代表网络模型延迟。

## Spill 对照

同一 39,955-byte 纯文本工具结果通过当前 DSH 真实 `ToolRuntime`、`SpillStore` 与 `spill-policy` 执行：

| 指标 | 基础 50KB | 插件 8KB |
| --- | ---: | ---: |
| 模型可见结果 | 39,955 bytes | 8,192 bytes |
| 完整原文写入 spill | 否 | 是，39,955 bytes |
| 原文 SHA-256 一致 | 不适用 | 是 |
| 定位符存在 | 否 | 是 |
| 每个后续请求避免内联 | 0 | 31,763 bytes（79.50%） |

该结果证明字节上限与可恢复性，不等价于 provider token 或费用节省。`read` 豁免、rich content、PTC 日志和存储失败由上游测试覆盖，本 smoke 未重复这些分支。

## 请求预算证据

插件测试覆盖：输出预留参与比例计算；硬阈值优先于告警；adapter 默认输出上限通过 `agent/request` 被显式收紧；持续压力默认只告警一次；诊断不包含请求正文；阻断线低于告警线时加载失败。默认配置只告警，因而本轮 5 次候选评测与加入预算前的结果一致。

## 运行命令

```powershell
pnpm run check
pnpm run eval:baseline:native -- --dsh-root D:\deepseek-harness --runs 5
pnpm run eval:candidate:native -- --dsh-root D:\deepseek-harness --runs 5
pnpm run eval:spill -- --dsh-root D:\deepseek-harness
```

另用临时 `DSH_HOME` 执行当前 DSH 的 `plugin add` 与 `--dump-config`，确认实际组合中基础 compaction 和原生 pruner 被禁用、唯一候选 Provider 已插入、spill 为 8,192，并包含完整请求预算默认值。

## 未验证风险

- 当前 4 个案例仍是参与过策略设计的开发集，不是未见 holdout；不能据此证明泛化或统计显著性。
- 本轮没有重新运行真实模型、真实编码任务、provider 账单、近窗口压力、图片或并行工具场景。
- 8KB spill 会让模型先看到预览与定位符；中段信息需要按需读取，真实任务中的额外读取率尚未测量。
- token meter 会系统性低估部分 CJK 与 JSON；默认只告警。硬阻断必须先按真实 provider usage 校准。
- 候选以更低压缩率换取更高保真，仍需由 `dsh-eval` 在 held-out 真实任务上按成功率、成本、延迟和稳定性共同判定。

## 回滚

移除 `improved-compact` 插件即可同时恢复基础 `compaction-basic`、原生 tool-result pruner 和 50KB spill 配置。候选只写 DSH 标准事件与上游 spill 引用，已有 session log 无需迁移。若只需放宽输出内联预算，可在 profile 的后置 patch 中单独覆盖 `spill-policy.maxInlineBytes`，无需卸载压缩 Provider。
