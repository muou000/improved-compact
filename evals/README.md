# DSH 压缩基线与候选对照评测

这里保存基线与候选共同使用的版本化案例、评分器和运行器。当前 `native-baseline-v1` 用合成数据覆盖：

- 当前目标、用户约束、事实、决定、错误和待办的保留；
- 后来纠正对旧值的覆盖，以及基于压缩后上下文的结构化查询；
- 默认 `8192/4096/1024` 工具结果裁剪、工具调用/结果配对；
- 新内容进入后连续两次压力压缩的语义漂移；
- session log 重放等价、压缩后立即重试近似幂等；
- token 节省、摘要调用契约和多次运行的语义稳定性。

案例均为无真实用户数据的合成 fixture。`tool-prune-middle-loss` 有意把一个关键事实放在长工具输出的中部，用于确认评分器能检出默认裁剪策略的信息损失；基线不要求所有案例全绿。

## 运行

要求相邻 `deepseek-harness` checkout 干净并已构建 host library。默认自动检查常见相邻路径，也可以显式传入：

```powershell
pnpm run eval:baseline:native -- --dsh-root D:\deepseek-harness --runs 5
```

输出写入被忽略的 `evals/.local/native-keyless.json`。报告记录上游 commit、数据集及关键构建产物 SHA-256、每次运行的语义摘要 digest、逐案例分数和本机延迟。语义 digest 排除墙钟时间和随机 compaction id，因此相同输入与实现应在重复运行中完全一致。

在同一数据集和上游版本上运行候选：

```powershell
pnpm run eval:candidate:native -- --dsh-root D:\deepseek-harness --runs 5
```

`--strategy native|candidate` 是同一运行器的显式开关；默认仍是 `native`，因此已有基线评分语义不变。为避免新运行覆盖旧文件，默认输出名现在带策略：`native-keyless.json`、`candidate-keyless.json`、`native-configured-model.json` 或 `candidate-configured-model.json`。候选运行前必须先 `pnpm run build`，报告会额外记录 `lib/index.js` 的 SHA-256。

使用 DSH `settings.yaml` 和 credentials service 中已经配置的真实模型：

```powershell
pnpm run eval:baseline:model -- --provider openai --model gpt-5.6-luna --runs 5
pnpm run eval:candidate:model -- --provider openai --model gpt-5.6-luna --runs 5
```

真实模型模式不复制或输出凭据。由于配置模型的真实上下文窗口为 272k，而合成 fixture 只有数千 tokens，该模式把案例压力阈值设为 1200/2400 estimated tokens，使每波历史触发一次有用压缩；保留预算、原生摘要提示、事务和模型路由不变，候选软阈值按同一比例保持为硬阈值的 75%。报告同时给出总体成功率和排除模型/API 调用失败后的条件质量，调用失败不会由评测器额外重试或从样本中静默删除。

已固化的基线报告：

- [`reports/BASELINE-2026-08-27-dsh-native-v1.md`](reports/BASELINE-2026-08-27-dsh-native-v1.md)：确定性 keyless 机械基线；
- [`reports/BASELINE-2026-08-27-gpt-5.6-luna-v1.md`](reports/BASELINE-2026-08-27-gpt-5.6-luna-v1.md)：DSH 已配置真实模型的 5 次重复基线；
- [`reports/EXPERIMENT-2026-08-27-improved-compact-v1.md`](reports/EXPERIMENT-2026-08-27-improved-compact-v1.md)：同数据集、同模型、各 5 次的基线/候选对照。

## 证据边界

keyless 模式让确定性 scripted adapter 通过原生 `LlmRuntime` 及所选 Provider 返回固定规则生成的八段 checkpoint。它适合验证阈值、保留区域、tool-result pruning、消息配对、事件事务、重放、token-meter 以及评分器稳定性。

它不能证明真实模型能生成同等质量的摘要，也不能代表网络延迟、成本或提供商 tokenizer。真实模型结果同样只是开发集证据：当前 4 个案例参与了策略设计，不可充当未见 holdout；5 次重复可以暴露方差，但不足以证明统计显著改进。真实部署还应增加真实编码任务、长工具输出分布、安全样本和 canary 回滚证据。
