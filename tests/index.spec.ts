import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'

function createContext(): Context {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  void new SessionStore(ctx)
  void new TokenMeter(ctx)
  return ctx
}

describe('improved-compact plugin', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('mounts quietly with the default configuration', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const ctx = createContext()
    const fiber = await ctx.plugin(plugin, {})

    expect(info).not.toHaveBeenCalled()
    expect(ctx.compaction).toBeInstanceOf(plugin.AdaptiveCompactionEngine)

    await fiber.dispose()
  })

  it('disposes lifecycle diagnostics with its plugin fiber', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const ctx = createContext()
    const fiber = await ctx.plugin(plugin, { logLifecycle: true })

    expect(info).toHaveBeenCalledWith('[improved-compact] loaded')

    await fiber.dispose()

    expect(info).toHaveBeenLastCalledWith('[improved-compact] unloaded')
  })
})
