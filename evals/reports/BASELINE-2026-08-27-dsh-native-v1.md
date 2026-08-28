# DSH 原生上下文压缩基线 v1

## 决策

建立 `compaction-basic` 加默认 `tool-result-pruner` 的 keyless 稳定基线，不做候选晋级判断。该基线可用于后续 `improved-compact` 策略的逐案例 A/B 对照。

基线稳定性通过，但不是全绿基线：长工具输出中部的关键事实被原生 head/tail 裁剪删除，必须作为已知失败保留。

## 基线、数据与环境

- DSH commit：`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`，工作区干净。
- 数据集：`dsh-native-compaction-baseline-v1`，4 个合成案例，22 个信息锚点，10 个后续任务检查。
- 数据集 SHA-256：`41376db5d50cf5fc6750427568736c7272128940f154fdbbc79cb381801cbfcd`。
- runner SHA-256：`8f6f59737fec2c765211873702c3784ccb43300ba41707370aea41228dbcb253`。
- scorer SHA-256：`fe5f056b987fa0403d0cf713a00e6a7e81c2b1a79b84aea45a08e9cd5ebd27fb`。
- 运行环境：Windows x64，Node.js `v22.20.0`。
- 原生策略参数：`thresholdRatio=0.8`、`retainRatio=0.16`、`maxTokens=8192`、`compactionRetries=1`。评测关闭自动 listener，直接以 `pressure` 触发同一原生策略路径。
- 默认工具裁剪参数：`thresholdChars=8192`、`headChars=4096`、`tailChars=1024`。

确定性 adapter 通过原生 `LlmRuntime`、原生八段摘要提示、区域选择、压缩事务、session log 和 token-meter 路径运行。它只固定摘要生成边缘，避免模型随机性污染策略机械基线。

## 稳定性门槛

- 同一进程重复 10 次时，所有排除墙钟时间和随机 compaction id 的语义结果必须只有一个 digest。
- 再启动一个独立进程重复 5 次，digest 必须与首轮一致。
- 每个案例压缩后立即再次检查压力必须为 no-op。
- 每个案例从完整 session log 重建后的模型可见 surface 必须一致。
- 每次摘要调用必须保持原生 `purpose=compaction`、`maxTokens=8192` 和八段提示结构。

以上门槛全部通过。15 次运行的唯一语义 digest 均为：

`59104f966afbbe143170f998d181cbcc11b5b9434a9b5ccac8f3ae1abe611c36`

## 结果

| 案例 | 压缩次数 | 锚点召回 | 后续任务成功 | 平均 token 节省 | 结果 |
| --- | ---: | ---: | ---: | ---: | --- |
| `continuity-core` | 1 | 6/6 | 3/3 | 74.93% | 通过 |
| `correction-wins` | 1 | 5/5 | 2/2 | 75.73% | 通过；后来的 region 修正生效 |
| `tool-prune-middle-loss` | 1 | 4/5 | 1/2 | 60.05% | 稳定失败；中部事实丢失，最新工具 pair 保持结构化配对 |
| `repeat-compaction-drift` | 2 | 6/6 | 3/3 | 73.87% | 通过；两次压缩后无锚点漂移 |

聚合结果：

- 锚点召回：macro `95.00%`，micro `21/22 = 95.45%`。
- 后续任务成功：macro `87.50%`，micro `9/10 = 90.00%`。
- token 节省 macro 平均：`71.15%`。
- session log 重放：`4/4` 一致。
- 压缩后立即重试 no-op：`4/4`。
- 工具调用/结果 split：`0`；最新 `artifact-read-731` 调用和结果都保留且顺序正确。
- 摘要调用契约：全部满足。

10 次主运行的本机 keyless 总耗时均值为 `11.66 ms`，标准差 `5.17 ms`，最小 `8.12 ms`，P95/最大 `26.40 ms`。该延迟只用于发现本地回归，不代表真实模型网络延迟。

## 已知失败与解释

`tool-prune-middle-loss` 的 9000 余字符工具结果把 `hidden_nonce=blue-lantern-731` 放在默认保留 head 与 tail 之间。原生策略先运行 model-free pruner，再选择摘要区域；因此该事实在摘要模型看到输入前已经被不可逆地从模型可见 surface 删除。结果稳定表现为：

- `tool_head_status=started` 和 `tool_tail_status=complete` 保留；
- `hidden_nonce=blue-lantern-731` 丢失；
- 基于压缩后上下文查询 `hidden_nonce` 失败；
- 工具调用和结果仍保持结构化配对。

这证明只测工具配对、摘要格式或整体 token 节省不足以判断压缩保真度。后续候选至少应修复这一逐案例回归，同时保持其他不变量。

## 未验证风险

- 未调用真实模型，因此未验证原生摘要提示在真实模型上的关键信息召回、纠正合并、幻觉率、输出截断、费用和网络延迟。
- token 统计来自 DSH 原生 heuristic token-meter；确定性 adapter 没有提供 provider usage，不能当作特定模型 tokenizer 的精确计数。
- 当前只有 4 个合成案例，不覆盖图片、多个并行工具调用、summary 失败/超时、context-overflow 恢复、跨语言长文本和真实编码任务最终文件状态。
- 数据集目前适合开发和验证，不是不可见 holdout；候选晋级前还需要独立保留集和真实任务层评测。

本机完整 JSON 证据由 `pnpm run eval:baseline:native` 生成在 `evals/.local/`，不提交包含运行路径与临时明细的原始报告。
