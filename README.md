# improved-compact

`improved-compact` 是 DeepSeek Harness（DSH）的仓库外上下文压缩 Provider。它禁用基础 profile 中的 `compaction-basic` 并作为唯一 Provider 继续提供同一个 `ctx.compaction` 服务，同时复用上游已经验证的事务式摘要、工具调用配对、session log 重放、手动 `/compact` 和上下文溢出恢复机制。

候选策略在上游实现之上增加六项确定性保护：

- **分层触发：** 默认在窗口 60% 时先做无模型裁剪，80% 时才调用摘要模型；
- **工具感知裁剪：** 保留头尾，并从被删除的中段恢复目标、约束、纠正、错误、路径、命令和 `key=value` 精确行；`request_user_input`、goal 和 todo 类工具默认不裁剪；
- **纠正优先：** 同一赋值采用 last-write-wins，旧值不会因为更早出现而覆盖后续纠正；
- **用户与精确值保护：** 最近一条直接用户消息在其尾部不超过硬阈值 50% 时原文保留，否则以有界 `Verbatim Anchors` 写入 checkpoint；疑似密码、密钥和 token 行不会被复制进该附录；
- **摘要质量门：** 缺失或乱序的原生八段 checkpoint 拒绝落盘；连续压缩时将摘要限定为 1800 个 Unicode code points，按完整行和章节裁剪，避免重复摘要膨胀与语义漂移。
- **请求成本预算：** 默认只在估算输入与输出预留合计达到上下文窗口 90% 时告警；可配置绝对 token 告警/阻断线和输出上限，阻断与限额均使用公开请求事件，不读取或记录提示词正文。

安装补丁还会把基础 profile 的 `spill-policy.maxInlineBytes` 从 50000 调整为 8192。超限纯文本由 DSH 上游 spill policy 保存完整副本，并在 session log 中留下有界预览和可读取定位符；这让大工具输出从产生时就不再反复占用后续请求，同时保持可回放和按需恢复。`read` 等上游明确豁免的结果仍由本插件的压力裁剪层处理。

所有模型可见替换都使用上游 `compaction/prune` 或 `compaction/summary` 事件，引用被替换的原始 event seq；插件不新增 DSH 当前持久化目录无法识别的私有 session event。卸载插件 fiber 会同步卸载 `ctx.compaction` 及自动监听器，不持有定时器、观察器或后台任务。

## 开发

要求 Node.js `^22.19.0 || >=24.0.0` 和 pnpm 11。

```sh
pnpm install
pnpm run check
```

构建产物位于 `lib/`。

基线与候选评测见 [`evals/README.md`](evals/README.md)。它们针对同一固定 DSH checkout、数据集和评分器，量化关键信息召回、后续结构化查询、工具配对、连续压缩漂移、token 节省和稳定性：

```sh
pnpm run eval:baseline:native -- --dsh-root /path/to/deepseek-harness --runs 5
pnpm run eval:candidate:native -- --dsh-root /path/to/deepseek-harness --runs 5
```

使用 DSH 已配置的真实模型进行重复评测：

```sh
pnpm run eval:baseline:model -- --provider openai --model gpt-5.6-luna --runs 5
pnpm run eval:candidate:model -- --provider openai --model gpt-5.6-luna --runs 5
```

当前基线结果见 [`evals/reports/BASELINE-2026-08-27-dsh-native-v1.md`](evals/reports/BASELINE-2026-08-27-dsh-native-v1.md) 和 [`evals/reports/BASELINE-2026-08-27-gpt-5.6-luna-v1.md`](evals/reports/BASELINE-2026-08-27-gpt-5.6-luna-v1.md)，候选对照与限制见 [`evals/reports/EXPERIMENT-2026-08-27-improved-compact-v1.md`](evals/reports/EXPERIMENT-2026-08-27-improved-compact-v1.md)。

## 配置

基础字段（`thresholdRatio`、`retainRatio`/`retainTokens`、摘要模型、重试和 `modelPolicies`）与 `compaction-basic` 保持一致。新增字段如下：

| 字段 | 默认值 | 作用 |
| --- | ---: | --- |
| `softPruneRatio` | `0.6` | 进入确定性工具结果裁剪层；必须小于所有硬摘要阈值 |
| `protectedRecentUserMessages` | `1` | 自动压缩时尝试原文保留的最近直接用户消息数 |
| `maxProtectedTailRatio` | `0.5` | 用户消息及其后续尾部可占硬阈值的最大比例；超过后改用摘要锚点 |
| `validateSummaryStructure` | `true` | 要求八个原生章节存在、唯一且有序 |
| `repeatSummaryMaxChars` | `1800` | 只约束包含旧 checkpoint 的连续摘要；`0` 关闭 |
| `toolResult.thresholdChars` | `8192` | 工具结果进入裁剪的字符阈值 |
| `toolResult.headChars` / `tailChars` | `3072` / `1024` | 原文头尾预算 |
| `toolResult.signalChars` | `2048` | 从中段恢复的高信号行预算 |
| `toolResult.protectedToolNames` | approval/goal/todo 工具 | 永不裁剪的工具名列表 |
| `verbatimAnchors.maxChars` / `maxAnchors` | `4096` / `64` | checkpoint 精确附录预算；任一为 `0` 时关闭 |
| `requestBudget.warnAtTokens` / `blockAtTokens` | `0` / `0` | 按估算输入 token 告警或阻断；`0` 关闭相应绝对阈值 |
| `requestBudget.warnAtRatio` / `blockAtRatio` | `0.9` / `0` | 按“估算输入 + 输出预留”占窗口比例告警或阻断；`0` 关闭 |
| `requestBudget.maxOutputTokens` | `0` | 限制显式或 adapter 默认输出预算；`0` 保持原路由设置 |
| `requestBudget.logEveryRequest` | `false` | 压力持续期间是否逐请求重复告警；默认每段压力期一次 |
| `logLifecycle` | `false` | 输出加载/卸载诊断；实际压缩决策仍通过标准 logger 可观察 |

错误配置会在插件加载时失败，例如软阈值与硬阈值重叠、头尾预算放不进工具阈值、重复工具名、重复摘要上限小于固定章节骨架，或请求阻断线低于告警线。

`requestBudget` 的比例使用当前 session log、标准 token meter 与最新 `request/context` 计算。比例包含请求的输出预留，因此比只看历史消息更早暴露“输入还能放下，但没有响应空间”的情况。默认告警不改变请求；只有显式设置 `blockAtTokens`、`blockAtRatio` 或 `maxOutputTokens` 才会改变运行行为。输出上限通过 `agent/request` 写入标准 `request/header`，可由日志重建。

## 安装到 DSH profile

在该目录的上一级执行：

```sh
dsh plugin --profile compact-dev add ./improved-compact
dsh --profile compact-dev --dump-config
```

源码仓库目录与安装后的插件标识均为 `improved-compact`。

配置层会按原生 package name 校验并禁用基础 Provider，插入候选 row，同时关闭会抢先丢弃中段的原生均匀 pruner：

```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  disabled: true

- insert:
    - id: improved-compact
      name: improved-compact
      config:
        softPruneRatio: 0.6
        thresholdRatio: 0.8
        retainRatio: 0.16
        protectedRecentUserMessages: 1
        maxProtectedTailRatio: 0.5
        validateSummaryStructure: true
        repeatSummaryMaxChars: 1800
        requestBudget:
          warnAtTokens: 0
          blockAtTokens: 0
          warnAtRatio: 0.9
          blockAtRatio: 0
          maxOutputTokens: 0
          logEveryRequest: false
        logLifecycle: false

- id: tool-result-pruner
  name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
  disabled: true

- id: spill-policy
  name: '@deepseek-ai/dsh-spill-policy'
  config:
    maxInlineBytes: 8192
```

需要覆盖时，在 profile 的 `cordis.patch.yml` 中重述目标 row 的完整 `config`。例如本地工具输出必须保留更多内联内容时，可在插件补丁之后覆盖 `spill-policy.maxInlineBytes`；设得更高会增加每次后续请求的上下文成本。`modelPolicies` 可为不同 provider/model 设置不同硬阈值和保留预算；`softPruneRatio` 必须低于其中每个已解析硬阈值。

卸载：

```sh
dsh plugin --profile compact-dev remove improved-compact
```

移除 `improved-compact` 后，其 patch 不再参与组合，基础 profile 的 `@deepseek-ai/dsh-compaction-basic` 和 `@deepseek-ai/dsh-compaction-tool-result-pruner` 会恢复；已有 session log 无需迁移，因为候选只写上游标准事件。上线时仍建议先使用影子或小比例 canary，并保留移除插件作为回滚点。

## 已知边界

- 高信号提取是确定性规则，不做 LLM 语义分类；未带标签、路径、命令或赋值形态的中段自然语言仍可能被删除。
- rich content block 的顺序会保留，但字符预算只计算 text block；图像等非文本块不会被压缩。
- spill 阈值按 UTF-8 字节计，语义裁剪阈值按 Unicode code points 计；非 ASCII 输出可能更早进入可逆 spill，这是有意的保守预算。
- 请求预算沿用 DSH token meter 的估算误差；默认只告警。启用硬阻断前应根据真实 provider usage 校准，不能把该估算当作账单数字。
- 容量感知用户尾部保护可能因小窗口或超长单轮而降级为 checkpoint 锚点，这是为保证压缩可收敛的显式取舍。
- 当前评测是 4 个开发用合成场景、每种策略 5 次，不是未见 holdout；真实项目上的任务成功率与隐私/安全红队仍需另行验证。

## 目录结构

```text
src/               配置、策略引擎、语义裁剪与摘要保护
tests/             单元、回放、生命周期和真实 Loader 组合测试
evals/             共享数据集、评分器、基线/候选运行器与报告
cordis.patch.yml   安装到 profile 时应用的配置层
tsdown.config.ts   ESM 与类型声明构建
```
