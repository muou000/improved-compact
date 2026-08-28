import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { baseCompactionConfig, resolveAdaptiveConfig } from './config.ts'
import { SemanticToolResultPruner } from './pruner.ts'
import { boundStructuredSummary, textFromBlocks, validateAndAugmentSummary } from './signals.ts'
import type { AdaptiveCompactionConfig, ResolvedAdaptiveConfig } from './types.ts'

const customConfig = z.object({
  softPruneRatio: z.number(),
  protectedRecentUserMessages: z.number().step(1).min(0),
  maxProtectedTailRatio: z.number(),
  validateSummaryStructure: z.boolean(),
  repeatSummaryMaxChars: z.number().step(1).min(0),
  toolResult: z.object({
    thresholdChars: z.number().step(1).min(1),
    headChars: z.number().step(1).min(0),
    tailChars: z.number().step(1).min(0),
    signalChars: z.number().step(1).min(0),
    protectedToolNames: z.array(z.string()),
  }),
  verbatimAnchors: z.object({
    maxChars: z.number().step(1).min(0),
    maxAnchors: z.number().step(1).min(0),
  }),
  logLifecycle: z.boolean(),
})

interface SummaryInput {
  readonly system?: string
  readonly tools?: readonly ToolSchema[]
  readonly messages: readonly Message[]
}

/** Adaptive DSH compaction provider preserving the upstream durable transaction. */
export class AdaptiveCompactionEngine extends BasicCompactionEngine {
  static override Config = z.intersect([
    BasicCompactionEngine.Config,
    customConfig,
  ]) as unknown as z<AdaptiveCompactionConfig>

  /** Validated plugin-owned fields, separate from the inherited base config. */
  readonly adaptiveConfig: ResolvedAdaptiveConfig

  /** Deterministic replay-safe tool-result pruning policy. */
  readonly semanticPruner: SemanticToolResultPruner

  private readonly protectedTailBudgets = new WeakMap<Session, number>()

  constructor(ctx: Context, config: AdaptiveCompactionConfig = {}) {
    const adaptiveConfig = resolveAdaptiveConfig(config)
    super(ctx, baseCompactionConfig(config))
    this.adaptiveConfig = adaptiveConfig
    this.semanticPruner = new SemanticToolResultPruner(ctx, adaptiveConfig.toolResult)
  }

  /**
   * Add an earlier model-free tier. The native backend still owns threshold
   * resolution, retries, overflow handling, and the durable summary transaction.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    if (trigger !== 'pressure' && trigger !== 'context-overflow') {
      throw new TypeError(`improved-compact: unknown compaction trigger ${String(trigger)}`)
    }
    const target = agent.session.requestHeader()?.config
    if (target === undefined || target.provider.length === 0 || target.model.length === 0) return null
    const beforeTokens = this.ctx.tokenMeter.measure(agent.session).totalTokens
    let prunedCount = 0
    let charsRemoved = 0

    if (trigger === 'context-overflow') {
      const pruned = this.semanticPruner.pruneSession(agent.session)
      prunedCount = pruned.pruned.length
      charsRemoved = pruned.charsRemoved
    } else {
      const context = (await this.ctx.llm.resolveModelInfo(
        target.provider,
        target.model,
        signal,
      )).context
      if (context !== undefined) {
        if (!Number.isInteger(context.contextWindow) || context.contextWindow <= 0) {
          return super.compactIfNeeded(agent, trigger, signal)
        }
        const softThreshold = Math.floor(context.contextWindow * this.adaptiveConfig.softPruneRatio)
        if (beforeTokens < softThreshold) return null
        const modelPolicy = this.config.modelPolicies.find(policy => (
          policy.provider === target.provider && policy.model === target.model
        ))
        const hardThreshold = Math.floor(
          context.contextWindow * (modelPolicy?.thresholdRatio ?? this.config.thresholdRatio),
        )
        this.protectedTailBudgets.set(
          agent.session,
          Math.floor(hardThreshold * this.adaptiveConfig.maxProtectedTailRatio),
        )
        signal.throwIfAborted()
        const pruned = this.semanticPruner.pruneSession(agent.session)
        prunedCount = pruned.pruned.length
        charsRemoved = pruned.charsRemoved
      }
    }

    try {
      const result = await super.compactIfNeeded(agent, trigger, signal)
      this.logDecision(
        trigger,
        beforeTokens,
        this.ctx.tokenMeter.measure(agent.session).totalTokens,
        prunedCount,
        charsRemoved,
        result,
      )
      return result
    } catch (error: unknown) {
      if (prunedCount > 0) {
        const message = error instanceof Error ? error.message : String(error)
        this.ctx.logger.warn(
          `improved-compact ${trigger}: semantic prune landed (${prunedCount} result(s), `
          + `${charsRemoved} chars removed) but summary phase failed: ${message}`,
        )
      }
      throw error
    } finally {
      this.protectedTailBudgets.delete(agent.session)
    }
  }

  /** Validate the native eight-section checkpoint and append exact source anchors. */
  protected override async summarize(
    input: SummaryInput,
    agent: Agent,
    signal?: AbortSignal,
  ) {
    const result = await super.summarize(input, agent, signal)
    const repeated = input.messages.some(message => textFromBlocks(message.content).includes('<compacted-summary>'))
    let summary = validateAndAugmentSummary(result.summary, input.messages, {
      validateStructure: this.adaptiveConfig.validateSummaryStructure,
      maxAnchors: this.adaptiveConfig.verbatimAnchors.maxAnchors,
      maxChars: this.adaptiveConfig.verbatimAnchors.maxChars,
      appendExistingAnchors: repeated,
    })
    if (repeated
      && this.adaptiveConfig.validateSummaryStructure
      && this.adaptiveConfig.repeatSummaryMaxChars > 0) {
      summary = boundStructuredSummary(summary, this.adaptiveConfig.repeatSummaryMaxChars)
    }
    return { ...result, summary }
  }

  /** Keep the latest direct human messages outside automatic compaction spans. */
  override compactRegion(
    start: number,
    end: number,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    const protectedEnd = this.protectedRangeEnd(agent.session, start, end)
    if (protectedEnd === null) {
      throw new Error(
        'improved-compact: no tool-balanced summary range remains before protected recent user messages',
      )
    }
    return super.compactRegion(start, protectedEnd, agent, signal)
  }

  private protectedRangeEnd(session: Session, start: number, requestedEnd: number): number | null {
    const count = this.adaptiveConfig.protectedRecentUserMessages
    if (count === 0) return requestedEnd
    const nodes = [...session.surface.nodes]
    const startIndex = nodes.indexOf(start)
    const endIndex = nodes.indexOf(requestedEnd)
    if (startIndex === -1 || endIndex < startIndex) return null
    const directUserIndices: number[] = []
    for (const [index, seq] of nodes.entries()) {
      const event = session.events[seq]
      if (event?.type === 'user/message' && event.data.source.kind === 'user') {
        directUserIndices.push(index)
      }
    }
    const budget = this.protectedTailBudgets.get(session)
    if (budget === undefined || budget === 0) return requestedEnd
    const tokenNodes = this.ctx.tokenMeter.measure(session).nodes
    const tokensBySeq = new Map(tokenNodes.map(node => [node.seq, node.tokens]))
    const protectedIndices = directUserIndices.slice(-count)
    const earliestProtected = protectedIndices.find(index => (
      nodes.slice(index).reduce((sum, seq) => sum + (tokensBySeq.get(seq) ?? 0), 0) <= budget
    ))
    if (earliestProtected === undefined || earliestProtected > endIndex) return requestedEnd
    for (let candidate = earliestProtected - 1; candidate >= startIndex; candidate -= 1) {
      const seq = nodes[candidate]
      if (seq !== undefined && toolPairingBalancedAfter(session, seq)) return seq
    }
    return null
  }

  private logDecision(
    trigger: CompactionTrigger,
    beforeTokens: number,
    afterTokens: number,
    prunedCount: number,
    charsRemoved: number,
    result: CompactionResult | null,
  ): void {
    if (!this.adaptiveConfig.logLifecycle && prunedCount === 0 && result === null) return
    this.ctx.logger.info(
      `improved-compact ${trigger}: before=${beforeTokens} tokens, after=${afterTokens} tokens, `
      + `pruned=${prunedCount} `
      + `tool result(s)/${charsRemoved} chars, summarized=${String(result !== null)}`
    )
  }
}

export default AdaptiveCompactionEngine
