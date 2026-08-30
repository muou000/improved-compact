import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmCallConfig, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-token-meter'
import type { ResolvedRequestBudgetConfig } from './types.ts'

export type RequestBudgetLevel = 'ok' | 'warn' | 'block'

/** Detached cost facts for one ordinary agent request. */
export interface RequestBudgetObservation {
  readonly level: RequestBudgetLevel
  readonly estimatedInputTokens: number
  readonly reservedOutputTokens: number
  readonly projectedTokens: number
  readonly contextWindow: number | undefined
  readonly projectedRatio: number | undefined
  readonly reasons: readonly string[]
}

/** Evaluate configured absolute and context-relative request limits. */
export function evaluateRequestBudget(
  estimatedInputTokens: number,
  reservedOutputTokens: number,
  contextWindow: number | undefined,
  config: ResolvedRequestBudgetConfig,
): RequestBudgetObservation {
  assertNonNegativeInteger('estimatedInputTokens', estimatedInputTokens)
  assertNonNegativeInteger('reservedOutputTokens', reservedOutputTokens)
  if (contextWindow !== undefined && (!Number.isInteger(contextWindow) || contextWindow <= 0)) {
    throw new Error('improved-compact request budget: contextWindow must be a positive integer')
  }
  const projectedTokens = estimatedInputTokens + reservedOutputTokens
  if (!Number.isSafeInteger(projectedTokens)) {
    throw new Error('improved-compact request budget: projected token count exceeds the safe integer range')
  }
  const projectedRatio = contextWindow === undefined ? undefined : projectedTokens / contextWindow
  const blockReasons = matchingReasons(
    'block',
    estimatedInputTokens,
    projectedRatio,
    config.blockAtTokens,
    config.blockAtRatio,
  )
  const warnReasons = matchingReasons(
    'warn',
    estimatedInputTokens,
    projectedRatio,
    config.warnAtTokens,
    config.warnAtRatio,
  )
  return Object.freeze({
    level: blockReasons.length > 0 ? 'block' : warnReasons.length > 0 ? 'warn' : 'ok',
    estimatedInputTokens,
    reservedOutputTokens,
    projectedTokens,
    contextWindow,
    projectedRatio,
    reasons: Object.freeze(blockReasons.length > 0 ? blockReasons : warnReasons),
  })
}

function matchingReasons(
  level: 'warn' | 'block',
  estimatedInputTokens: number,
  projectedRatio: number | undefined,
  tokenThreshold: number,
  ratioThreshold: number,
): string[] {
  const reasons: string[] = []
  if (tokenThreshold > 0 && estimatedInputTokens >= tokenThreshold) {
    reasons.push(`${level}AtTokens=${tokenThreshold}`)
  }
  if (ratioThreshold > 0 && projectedRatio !== undefined && projectedRatio >= ratioThreshold) {
    reasons.push(`${level}AtRatio=${ratioThreshold}`)
  }
  return reasons
}

/** Request-cost observer and optional fail-closed budget gate. */
export class RequestBudgetPolicy {
  private readonly lastLevel = new WeakMap<Session, RequestBudgetLevel>()

  constructor(
    private readonly ctx: Context,
    readonly config: ResolvedRequestBudgetConfig,
  ) {
    if (config.maxOutputTokens > 0) this.registerOutputCap()
    if (config.warnAtRatio > 0
      || config.blockAtRatio > 0
      || config.warnAtTokens > 0
      || config.blockAtTokens > 0) this.registerRequestGate()
  }

  private registerOutputCap(): void {
    this.ctx.on('agent/request', async ({ signal }, next): Promise<LlmCallConfig> => {
      const proposed = await next()
      signal.throwIfAborted()
      const configured = proposed.maxTokens
      if (configured !== undefined) {
        return configured <= this.config.maxOutputTokens
          ? proposed
          : { ...proposed, maxTokens: this.config.maxOutputTokens }
      }
      const model = await this.ctx.llm.resolveModelInfo(proposed.provider, proposed.model, signal)
      signal.throwIfAborted()
      if (model.defaultMaxTokens === undefined
        || model.defaultMaxTokens <= this.config.maxOutputTokens) return proposed
      return { ...proposed, maxTokens: this.config.maxOutputTokens }
    })
  }

  private registerRequestGate(): void {
    this.ctx.on('llm/stream', (options, next): AsyncIterable<StreamChunk> => {
      if (options.purpose !== undefined || options.sessionId === undefined) return next()
      const session = this.ctx.sessions.get(options.sessionId)
      if (session === undefined) return next()
      const observation = this.observe(session, options)
      if (observation.level === 'ok') {
        this.lastLevel.delete(session)
        return next()
      }

      const message = this.message(options, observation)
      if (observation.level === 'block') {
        this.ctx.logger.error(message)
        return blockedRequest(message, options.signal)
      }
      if (this.config.logEveryRequest || this.lastLevel.get(session) !== 'warn') {
        this.ctx.logger.warn(message)
      }
      this.lastLevel.set(session, 'warn')
      return next()
    })
  }

  private observe(session: Session, options: GenerateOptions): RequestBudgetObservation {
    const context = session.requestContext()
    const contextWindow = context?.provider === options.provider && context.model === options.model
      ? context.contextWindow
      : undefined
    return evaluateRequestBudget(
      this.ctx.tokenMeter.measure(session).totalTokens,
      options.maxTokens ?? 0,
      contextWindow,
      this.config,
    )
  }

  private message(options: GenerateOptions, observation: RequestBudgetObservation): string {
    const ratio = observation.projectedRatio === undefined
      ? 'unknown'
      : observation.projectedRatio.toFixed(3)
    return `improved-compact request budget ${observation.level}: route=${options.provider}/${options.model}, `
      + `estimatedInput=${observation.estimatedInputTokens}, reservedOutput=${observation.reservedOutputTokens}, `
      + `projected=${observation.projectedTokens}, contextWindow=${observation.contextWindow ?? 'unknown'}, `
      + `ratio=${ratio}, reasons=${observation.reasons.join(',')}`
  }
}

function blockedRequest(message: string, signal: AbortSignal | undefined): AsyncIterable<StreamChunk> {
  return (async function* blocked(): AsyncGenerator<StreamChunk> {
    signal?.throwIfAborted()
    throw new Error(message)
  })()
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`improved-compact request budget: ${name} must be a non-negative safe integer`)
  }
}
