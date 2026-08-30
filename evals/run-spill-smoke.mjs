import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SIGNAL = new AbortController().signal
const pluginRoot = fileURLToPath(new URL('../', import.meta.url))

function parseArgs(argv) {
  const options = {
    dshRoot: process.env.DSH_ROOT,
    output: join(pluginRoot, 'evals', '.local', 'spill-current.json'),
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') continue
    if (argument === '--dsh-root') {
      options.dshRoot = argv[index + 1]
      if (options.dshRoot === undefined) throw new Error('--dsh-root requires a path')
      index += 1
      continue
    }
    if (argument === '--output') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('--output requires a path')
      options.output = isAbsolute(value) ? value : resolve(pluginRoot, value)
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${argument}`)
  }
  return options
}

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function resolveDshRoot(explicitRoot) {
  const candidates = [
    explicitRoot,
    resolve(pluginRoot, '..', '..', '..', 'deepseek-harness'),
    resolve(pluginRoot, '..', '..', 'deepseek-harness'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    const root = resolve(candidate)
    if (await pathExists(join(root, 'packages', 'spill', 'spill-policy', 'package.json'))) return root
  }
  throw new Error('unable to locate deepseek-harness; pass --dsh-root or set DSH_ROOT')
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

async function importRuntime(dshRoot) {
  const load = relativePath => import(pathToFileURL(join(dshRoot, relativePath)).href)
  const [cordis, systemPrompt, tools, spill, spillPolicy, llm, session] = await Promise.all([
    load('vendor/cordis/lib/index.js'),
    load('packages/core/system-prompt/lib/index.js'),
    load('packages/core/tools/lib/index.js'),
    load('packages/spill/spill/lib/index.js'),
    load('packages/spill/spill-policy/lib/index.js'),
    load('packages/llm/llm/lib/index.js'),
    load('packages/core/session/lib/index.js'),
  ])
  return {
    Context: cordis.Context,
    SystemPrompt: systemPrompt.default,
    ToolRuntime: tools.default,
    defineContentToolFixture: tools.defineContentToolFixture,
    SpillStore: spill.SpillStore,
    SpillLocator: spill.SpillLocator,
    SpillPolicy: spillPolicy,
    ToolCallId: llm.ToolCallId,
    SessionId: session.SessionId,
  }
}

function textOf(content) {
  return content.filter(block => block.type === 'text').map(block => block.text).join('')
}

async function runPolicy(runtime, cap, body, label) {
  class MemorySpillStore extends runtime.SpillStore {
    saves = []

    async saveText(input) {
      this.saves.push(input)
      return {
        locator: runtime.SpillLocator(`/spill/${label}/${input.suggestedName}`),
        bytes: Buffer.byteLength(input.content, 'utf8'),
        retrievalHint: 'Read the spill locator when the omitted middle is needed.',
      }
    }
  }

  const ctx = new runtime.Context()
  await ctx.plugin(runtime.SystemPrompt)
  await ctx.plugin(runtime.ToolRuntime)
  await ctx.plugin(MemorySpillStore)
  await ctx.plugin(runtime.SpillPolicy, { maxInlineBytes: cap })
  ctx.tools.register(runtime.defineContentToolFixture({
    name: 'spill_probe',
    description: 'Return a deterministic oversized text fixture.',
    parameters: {},
    async execute() {
      return [{ type: 'text', text: body }]
    },
  }))
  const result = await ctx.tools.execute({
    signal: SIGNAL,
    callId: runtime.ToolCallId(`spill-${label}`),
    name: 'spill_probe',
    arguments: {},
    agent: { session: { header: { id: runtime.SessionId(`spill-${label}`) } } },
  })
  const text = textOf(result.content)
  const store = ctx.spillStore
  const observation = {
    cap,
    originalBytes: Buffer.byteLength(body, 'utf8'),
    modelFacingBytes: Buffer.byteLength(text, 'utf8'),
    spilled: store.saves.length === 1,
    savedBytes: store.saves[0] === undefined
      ? 0
      : Buffer.byteLength(store.saves[0].content, 'utf8'),
    savedSha256: store.saves[0] === undefined
      ? null
      : createHash('sha256').update(store.saves[0].content).digest('hex'),
    locatorPresent: text.includes(`/spill/${label}/spill_probe.txt`),
    isError: result.isError,
  }
  await ctx.fiber.dispose()
  return observation
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const dshRoot = await resolveDshRoot(options.dshRoot)
  const dirty = git(dshRoot, ['status', '--porcelain'])
  if (dirty.length > 0) throw new Error('deepseek-harness is dirty; spill evidence requires a clean upstream checkout')
  const runtime = await importRuntime(dshRoot)
  if (typeof runtime.ToolCallId !== 'function') {
    throw new Error('current DSH LLM package does not export ToolCallId')
  }
  const body = `HEAD\n${'x'.repeat(19_950)}\nFact: hidden_middle=spill-recovery-required\n${'y'.repeat(19_950)}\nTAIL`
  const bodySha256 = createHash('sha256').update(body).digest('hex')
  const baseline = await runPolicy(runtime, 50_000, body, 'baseline')
  const candidate = await runPolicy(runtime, 8_192, body, 'candidate')
  const gates = {
    baselineStayedInline: !baseline.spilled && baseline.modelFacingBytes === baseline.originalBytes,
    candidateSpilledFullText: candidate.spilled
      && candidate.savedBytes === candidate.originalBytes
      && candidate.savedSha256 === bodySha256,
    candidatePreviewBounded: candidate.modelFacingBytes <= candidate.cap,
    candidateLocatorPresent: candidate.locatorPresent,
    callsSucceeded: !baseline.isError && !candidate.isError,
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    upstream: {
      root: dshRoot,
      commit: git(dshRoot, ['rev-parse', 'HEAD']),
      dirty: false,
    },
    fixture: { bytes: Buffer.byteLength(body, 'utf8'), sha256: bodySha256 },
    baseline,
    candidate,
    avoidedInlineBytesPerSubsequentRequest: baseline.modelFacingBytes - candidate.modelFacingBytes,
    avoidedInlineRatio: 1 - candidate.modelFacingBytes / baseline.modelFacingBytes,
    gates,
    passed: Object.values(gates).every(Boolean),
    limitations: [
      'This smoke measures deterministic UTF-8 payload reduction and spill recoverability, not provider token billing.',
      'The fixture uses one plain-text native tool result; read-tool exemptions, rich content, PTC dispatch logs, and storage failures remain covered by upstream DSH tests.',
    ],
  }
  await mkdir(dirname(options.output), { recursive: true })
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`baseline inline: ${baseline.modelFacingBytes} bytes`)
  console.log(`candidate inline: ${candidate.modelFacingBytes} bytes`)
  console.log(`avoided per subsequent request: ${report.avoidedInlineBytesPerSubsequentRequest} bytes (${(report.avoidedInlineRatio * 100).toFixed(2)}%)`)
  console.log(`full spill recoverable: ${String(gates.candidateSpilledFullText && gates.candidateLocatorPresent)}`)
  console.log(`report: ${options.output}`)
  if (!report.passed) process.exitCode = 2
}

await main()
