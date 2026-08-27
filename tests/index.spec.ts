import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'

describe('dsh-compact plugin', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('mounts quietly with the default configuration', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const ctx = new Context()
    const fiber = await ctx.plugin(plugin, {})

    expect(info).not.toHaveBeenCalled()

    await fiber.dispose()
  })

  it('disposes lifecycle diagnostics with its plugin fiber', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const ctx = new Context()
    const fiber = await ctx.plugin(plugin, { logLifecycle: true })

    expect(info).toHaveBeenCalledWith('[dsh-compact] loaded')

    await fiber.dispose()

    expect(info).toHaveBeenLastCalledWith('[dsh-compact] unloaded')
  })
})
