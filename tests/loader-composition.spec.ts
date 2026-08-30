import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include, {
  applyEntryPatches,
  entryListSchema,
  type PatchOptions,
} from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { afterEach, describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import * as plugin from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('improved-compact real Loader composition', () => {
  it('applies the shipped patch over base rows and registers one adaptive provider', async () => {
    root = await mkdtemp(join(tmpdir(), 'improved-compact-loader-'))
    const configPath = join(root, 'cordis.yml')
    const baseText = [
      "- id: llm\n  name: '@deepseek-ai/dsh-llm'",
      "- id: sessions\n  name: '@deepseek-ai/dsh-session'",
      "- id: token-meter\n  name: '@deepseek-ai/dsh-token-meter'",
      "- id: compaction-basic\n  name: '@deepseek-ai/dsh-compaction-basic'",
      "- id: tool-result-pruner\n  name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
      "- id: spill-policy\n  name: '@deepseek-ai/dsh-spill-policy'\n  config:\n    maxInlineBytes: 50000",
      '',
    ].join('\n')
    const base = yaml.load(baseText, { schema: entryListSchema })
    if (!Array.isArray(base)) throw new Error('base fixture must contain an entry list')
    const patchText = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    const patches = yaml.load(patchText, { schema: entryListSchema })
    if (!Array.isArray(patches)) throw new Error('cordis.patch.yml must contain a patch list')
    const warnings: string[] = []
    const composed = applyEntryPatches(
      base,
      patches as PatchOptions[],
      message => warnings.push(message),
    )
    expect(warnings).toEqual([])
    await writeFile(configPath, JSON.stringify(composed, null, 2))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const spillConfigs: unknown[] = []
    const spillPolicyProbe = {
      name: 'spill-policy-probe',
      apply(_ctx: Context, config: unknown) {
        spillConfigs.push(config)
      },
    }
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-llm', LlmRuntime],
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-token-meter', TokenMeter],
      ['@deepseek-ai/dsh-spill-policy', spillPolicyProbe],
      ['improved-compact', plugin],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    expect(context.compaction).toBeInstanceOf(plugin.AdaptiveCompactionEngine)
    expect(context.compaction).toHaveProperty('adaptiveConfig.softPruneRatio', 0.6)
    expect(context.get('toolResultPruner')).toBeUndefined()
    const entries = [...context.loader.entries()]
    expect(entries.find(entry => entry.options.id === 'compaction-basic')?.disabled).toBe(true)
    expect(entries.find(entry => entry.options.id === 'improved-compact')?.options.name).toBe('improved-compact')
    expect(entries.find(entry => entry.options.id === 'tool-result-pruner')?.disabled).toBe(true)
    expect(entries.find(entry => entry.options.id === 'spill-policy')?.options.config)
      .toEqual({ maxInlineBytes: 8192 })
    expect(spillConfigs).toEqual([{ maxInlineBytes: 8192 }])
  })
})
