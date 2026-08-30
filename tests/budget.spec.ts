import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, {
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { evaluateRequestBudget } from '../src/budget.ts'
import { resolveAdaptiveConfig } from '../src/config.ts'
import * as plugin from '../src/index.ts'

const SIGNAL = new AbortController().signal

class BudgetAdapter extends LlmAdapter {
  calls = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 1_000 },
      defaultMaxTokens: 800,
    })
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function createContext(): { ctx: Context; adapter: BudgetAdapter } {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  void new SessionStore(ctx)
  void new TokenMeter(ctx)
  const adapter = new BudgetAdapter()
  ctx.llm.registerAdapter(['budget'], adapter)
  return { ctx, adapter }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('request budget policy', () => {
  it('gives hard limits precedence over warnings and includes output reserve', () => {
    const config = resolveAdaptiveConfig({
      requestBudget: {
        warnAtTokens: 500,
        blockAtTokens: 900,
        warnAtRatio: 0.5,
        blockAtRatio: 0.9,
      },
    }).requestBudget

    expect(evaluateRequestBudget(400, 200, 1_000, config)).toMatchObject({
      level: 'warn',
      projectedTokens: 600,
      projectedRatio: 0.6,
      reasons: ['warnAtRatio=0.5'],
    })
    expect(evaluateRequestBudget(900, 100, 1_000, config)).toMatchObject({
      level: 'block',
      projectedTokens: 1_000,
      projectedRatio: 1,
      reasons: ['blockAtTokens=900', 'blockAtRatio=0.9'],
    })
  })

  it('caps an adapter default through the logged agent/request configuration seam', async () => {
    const { ctx } = createContext()
    const fiber = await ctx.plugin(plugin, {
      auto: false,
      requestBudget: { maxOutputTokens: 256, warnAtRatio: 0 },
    })
    const config = await agentEvents(ctx, {} as Agent).waterfall(
      'agent/request',
      { turn: 1, step: 1, signal: SIGNAL },
      () => Promise.resolve({ provider: 'budget', model: 'model' }),
    )

    expect(config).toEqual({ provider: 'budget', model: 'model', maxTokens: 256 })
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('warns once per pressure episode without logging request content', async () => {
    const { ctx } = createContext()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const fiber = await ctx.plugin(plugin, {
      auto: false,
      requestBudget: { warnAtRatio: 0.5 },
    })
    const session = ctx.sessions.create(SessionId('request-budget-warning'))
    session.append('request/header', {
      header: {
        config: { provider: 'budget', model: 'model', maxTokens: 100 },
        system: `private-marker-${'x'.repeat(1_200)}`,
      },
      reason: 'initial',
    })
    session.append('request/context', {
      provider: 'budget',
      model: 'model',
      contextWindow: 500,
    })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      for await (const _chunk of ctx.llm.stream({
        provider: 'budget',
        model: 'model',
        messages: [],
        maxTokens: 100,
        sessionId: session.id,
        signal: SIGNAL,
      })) {
        // Drain the stream so the real waterfall and adapter both complete.
      }
    }

    const budgetWarnings = warn.mock.calls
      .map(([message]) => String(message))
      .filter(message => message.includes('improved-compact request budget warn'))
    expect(budgetWarnings).toHaveLength(1)
    expect(budgetWarnings[0]).toContain('route=budget/model')
    expect(budgetWarnings[0]).not.toContain('private-marker')
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('blocks before adapter dispatch when an explicit hard ratio is exceeded', async () => {
    const { ctx, adapter } = createContext()
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    const fiber = await ctx.plugin(plugin, {
      auto: false,
      requestBudget: { warnAtRatio: 0.4, blockAtRatio: 0.5 },
    })
    const session = ctx.sessions.create(SessionId('request-budget-block'))
    session.append('request/header', {
      header: {
        config: { provider: 'budget', model: 'model', maxTokens: 100 },
        system: 'x'.repeat(1_200),
      },
      reason: 'initial',
    })
    session.append('request/context', {
      provider: 'budget',
      model: 'model',
      contextWindow: 500,
    })

    const drain = async (): Promise<void> => {
      for await (const _chunk of ctx.llm.stream({
        provider: 'budget',
        model: 'model',
        messages: [],
        maxTokens: 100,
        sessionId: session.id,
        signal: SIGNAL,
      })) {
        // A blocked middleware stream produces no chunks.
      }
    }
    await expect(drain()).rejects.toThrow(/request budget block/)
    expect(adapter.calls).toBe(0)
    expect(error).toHaveBeenCalledOnce()
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
