# improved-compact

`improved-compact` 是 DeepSeek Harness（DSH）的仓库外上下文压缩 Provider。它禁用基础 profile 中的 `compaction-basic` 并作为唯一 Provider 继续提供同一个 `ctx.compaction` 服务，同时复用上游已经验证的事务式摘要、工具调用配对、session log 重放、手动 `/compact` 和上下文溢出恢复机制。

候选策略在上游实现之上增加五项确定性保护：

- **分层触发：** 默认在窗口 60% 时先做无模型裁剪，80% 时才调用摘要模型；
- **工具感知裁剪：** 保留头尾，并从被删除的中段恢复目标、约束、纠正、错误、路径、命令和 `key=value` 精确行；`request_user_input`、goal 和 todo 类工具默认不裁剪；
- **纠正优先：** 同一赋值采用 last-write-wins，旧值不会因为更早出现而覆盖后续纠正；
- **用户与精确值保护：** 最近一条直接用户消息在其尾部不超过硬阈值 50% 时原文保留，否则以有界 `Verbatim Anchors` 写入 checkpoint；疑似密码、密钥和 token 行不会被复制进该附录；
- **摘要质量门：** 缺失或乱序的原生八段 checkpoint 拒绝落盘；连续压缩时将摘要限定为 1800 个 Unicode code points，按完整行和章节裁剪，避免重复摘要膨胀与语义漂移。

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
| `logLifecycle` | `false` | 输出加载/卸载诊断；实际压缩决策仍通过标准 logger 可观察 |

错误配置会在插件加载时失败，例如软阈值与硬阈值重叠、头尾预算放不进工具阈值、重复工具名或重复摘要上限小于固定章节骨架。

## 安装到 DSH profile

在该目录的上一级执行：

```sh
dsh plugin --profile compact-dev add ./dsh-compact
dsh --profile compact-dev --dump-config
```

这里的 `./dsh-compact` 是当前源码仓库目录；安装后的插件标识是 `improved-compact`。

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
        logLifecycle: false

- id: tool-result-pruner
  name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
  disabled: true
```

需要覆盖时，在 profile 的 `cordis.patch.yml` 中重述目标 row 的完整 `config`。`modelPolicies` 可为不同 provider/model 设置不同硬阈值和保留预算；`softPruneRatio` 必须低于其中每个已解析硬阈值。

卸载：

```sh
dsh plugin --profile compact-dev remove improved-compact
```

移除 `improved-compact` 后，其 patch 不再参与组合，基础 profile 的 `@deepseek-ai/dsh-compaction-basic` 和 `@deepseek-ai/dsh-compaction-tool-result-pruner` 会恢复；已有 session log 无需迁移，因为候选只写上游标准事件。上线时仍建议先使用影子或小比例 canary，并保留移除插件作为回滚点。

## 已知边界

- 高信号提取是确定性规则，不做 LLM 语义分类；未带标签、路径、命令或赋值形态的中段自然语言仍可能被删除。
- rich content block 的顺序会保留，但字符预算只计算 text block；图像等非文本块不会被压缩。
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
