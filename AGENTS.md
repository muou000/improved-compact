# AGENTS.md

`dsh-compact` 是独立发布的 DeepSeek Harness（DSH）仓库外 Cordis 插件，目标是在不修改 DSH agent loop 的前提下改进上下文压缩的保真、成本与可恢复性。

## 开始工作

先阅读本仓库 `README.md`，再定位上游 `deepseek-harness` checkout，阅读其中的 `docs/architecture.md`、`packages/compaction/README.md` 以及相关公开类型。若该 checkout 位于 `dsh-plugins` submodule 工作区内，同时遵循父目录的 `AGENTS.md`、`docs/PLUGIN_STANDARD.md` 和 `docs/EVALUATION.md`；独立 clone 时，本文件仍是最低规则。

将 `deepseek-harness` checkout 视为只读上游参考，除非任务明确要求修改它。不要导入上游未导出的源码路径或复制其内部实现。

## 插件边界

- 通过 `ctx.compaction`、agent/session typed events、system-prompt registry 等公开扩展点实现功能。
- 不为实现压缩策略直接修改 agent loop；缺少扩展点时记录最小上游需求。
- Cordis 注册、listener、timer、watcher、任务和临时资源必须绑定 fiber 生命周期并可卸载。
- 模型可见的压缩摘要必须有稳定来源，能够从 session log 或带版本的持久事件重建。
- 配置使用 Schemastery 校验。token 预算、阈值、模型和策略选择不得硬编码。

## 压缩不变量

- 保留当前目标、用户约束、已确认事实、关键决定、未完成事项、文件位置和仍有诊断价值的错误证据。
- 保持消息顺序、说话者归属、工具调用与结果配对；摘要明确区分事实、用户声明和推断。
- 不能因输入超预算而静默丢失高优先级信息；失败要么回退到明确策略，要么携带原因终止。
- 对相同日志和配置的区域选择与预算计算应确定。连续压缩应近似幂等，并测量语义漂移。
- 不把密钥、完整私密内容、隐藏推理或未经处理的大型工具输出复制到日志、fixture 或报告。

## 自优化规则

压缩策略自优化采用“稳定基线 → 独立候选 → 评测 → 晋级/拒绝 → 可回滚版本”。运行中的插件不得覆盖当前代码、评分器或稳定配置。候选记录父版本、配置、模型、输入数据摘要和生成时间；保留评测集不得用于迭代调参。

任何宣称的改进都同时报告任务成功、关键事实召回、约束保留、工具配对、token、延迟、成本和失败案例。单次 LLM 输出或仅凭摘要观感不能作为晋级证据。

## 代码与测试

- 使用 ESM、TypeScript strict 模式和命名导出 `name`、`Config`、`apply`。
- 公共导出提供简洁 JSDoc；只在外部数据入口做运行时验证。
- 单元测试覆盖配置、区域选择、预算、失败和幂等不变量。
- 组合测试通过真实 Loader 与 `cordis.patch.yml` 加载插件，并验证卸载和日志投影。
- 策略变化需要基线/候选评测；模型或用户可见变化需要可重复 snapshot 或端到端证据。
- 测试验证压缩后的后续任务结果，不只检查摘要包含关键词。

提交前运行：

```powershell
pnpm run check
git diff --check
```

只报告实际运行的检查。需要密钥的真实模型试验未运行时，明确说明其仍待验证。
