import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  aggregateRepetitions,
  evaluateChecks,
  scoreAnchors,
  scoreToolPairs,
  semanticDigest,
  stableJson,
  validateDataset,
} from './scorers/native-baseline.mjs'

const DETERMINISTIC_MODEL = 'deterministic-baseline'
const SIGNAL = new AbortController().signal
const REQUIRED_SUMMARY_SECTIONS = [
  '## Primary Request and Intent',
  '## Key Technical Concepts',
  '## Files and Code',
  '## Errors and Fixes',
  '## Pending Jobs',
  '## Current Work',
  '## Next Step',
  '## Critical Context',
]

const pluginRoot = fileURLToPath(new URL('../', import.meta.url))
const datasetPath = join(pluginRoot, 'evals', 'cases', 'native-baseline-v1.json')

function parseArgs(argv) {
  const options = {
    runs: 5,
    mode: 'deterministic',
    strategy: 'native',
    dshRoot: process.env.DSH_ROOT,
    dshHome: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    provider: 'openai',
    model: 'gpt-5.6-luna',
    output: undefined,
    caseIds: [],
    allowDirtyUpstream: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') {
      continue
    } else if (argument === '--strategy') {
      options.strategy = argv[index + 1]
      if (!['native', 'candidate'].includes(options.strategy)) {
        throw new Error('--strategy must be native or candidate')
      }
      index += 1
    } else if (argument === '--mode') {
      options.mode = argv[index + 1]
      if (!['deterministic', 'configured-model'].includes(options.mode)) {
        throw new Error('--mode must be deterministic or configured-model')
      }
      index += 1
    } else if (argument === '--runs') {
      const value = Number(argv[index + 1])
      if (!Number.isInteger(value) || value < 1) throw new Error('--runs must be a positive integer')
      options.runs = value
      index += 1
    } else if (argument === '--dsh-root') {
      options.dshRoot = argv[index + 1]
      if (options.dshRoot === undefined) throw new Error('--dsh-root requires a path')
      index += 1
    } else if (argument === '--dsh-home') {
      options.dshHome = argv[index + 1]
      if (options.dshHome === undefined) throw new Error('--dsh-home requires a path')
      index += 1
    } else if (argument === '--provider') {
      options.provider = argv[index + 1]
      if (options.provider === undefined) throw new Error('--provider requires an id')
      index += 1
    } else if (argument === '--model') {
      options.model = argv[index + 1]
      if (options.model === undefined) throw new Error('--model requires an id')
      index += 1
    } else if (argument === '--case') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('--case requires an id')
      options.caseIds.push(value)
      index += 1
    } else if (argument === '--output') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('--output requires a path')
      options.output = isAbsolute(value) ? value : resolve(pluginRoot, value)
      index += 1
    } else if (argument === '--allow-dirty-upstream') {
      options.allowDirtyUpstream = true
    } else {
      throw new Error(`unknown argument: ${argument}`)
    }
  }
  options.output ??= join(
    pluginRoot,
    'evals',
    '.local',
    `${options.strategy}-${options.mode === 'deterministic' ? 'keyless' : 'configured-model'}.json`,
  )
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
    if (await pathExists(join(root, 'packages', 'compaction', 'compaction-basic', 'package.json'))) return root
  }
  throw new Error('unable to locate deepseek-harness; pass --dsh-root or set DSH_ROOT')
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

async function newestMtime(path) {
  const entries = await readdir(path, { withFileTypes: true })
  let newest = 0
  for (const entry of entries) {
    const entryPath = join(path, entry.name)
    if (entry.isDirectory()) newest = Math.max(newest, await newestMtime(entryPath))
    else newest = Math.max(newest, (await stat(entryPath)).mtimeMs)
  }
  return newest
}

async function assertBuiltUpstream(dshRoot, allowDirtyUpstream, mode) {
  const dirty = git(dshRoot, ['status', '--porcelain'])
  if (dirty.length > 0 && !allowDirtyUpstream) {
    throw new Error('deepseek-harness is dirty; commit/stash it or pass --allow-dirty-upstream for an explicitly non-release run')
  }
  const packageRoots = [
    'vendor/cordis',
    'packages/compaction/compaction-basic',
    'packages/compaction/compaction-tool-result-pruner',
    'packages/llm/llm',
    'packages/llm/token-meter',
    'packages/core/session',
    ...mode === 'configured-model' ? [
      'packages/llm/llm-pi-ai',
      'packages/settings/settings-file',
      'packages/credentials/credentials-local',
    ] : [],
  ]
  for (const relativeRoot of packageRoots) {
    const packageRoot = join(dshRoot, relativeRoot)
    const built = join(packageRoot, 'lib', 'index.js')
    if (!await pathExists(built)) {
      throw new Error(`deepseek-harness build is missing for ${relativeRoot}; build the upstream host libraries first`)
    }
    if (await newestMtime(join(packageRoot, 'src')) > (await stat(built)).mtimeMs) {
      throw new Error(`deepseek-harness sources are newer than lib/index.js for ${relativeRoot}; rebuild upstream before baselining`)
    }
  }
  return dirty
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function importUpstream(dshRoot, strategy) {
  const load = relativePath => import(pathToFileURL(join(dshRoot, relativePath)).href)
  const [cordis, basic, llm, tokenMeter, session, pruner, piAi, settingsFile, credentialsLocal] = await Promise.all([
    load('vendor/cordis/lib/index.js'),
    load('packages/compaction/compaction-basic/lib/index.js'),
    load('packages/llm/llm/lib/index.js'),
    load('packages/llm/token-meter/lib/index.js'),
    load('packages/core/session/lib/index.js'),
    load('packages/compaction/compaction-tool-result-pruner/lib/index.js'),
    load('packages/llm/llm-pi-ai/lib/index.js'),
    load('packages/settings/settings-file/lib/index.js'),
    load('packages/credentials/credentials-local/lib/index.js'),
  ])
  const candidate = strategy === 'candidate'
    ? await import(pathToFileURL(join(pluginRoot, 'lib', 'index.js')).href)
    : undefined
  return {
    Context: cordis.Context,
    BasicCompactionEngine: basic.BasicCompactionEngine,
    LlmAdapter: llm.LlmAdapter,
    LlmRuntime: llm.LlmRuntime,
    TokenMeter: tokenMeter.TokenMeter,
    Session: session.Session,
    SessionId: session.SessionId,
    ToolResultPruner: pruner.ToolResultPruner,
    LlmPiAi: piAi,
    FileSettingsProvider: settingsFile.FileSettingsProvider,
    LocalCredentialProvider: credentialsLocal.LocalCredentialProvider,
    CallId: llm.CallId,
    createMessage: llm.createMessage,
    createToolResultMessage: llm.createToolResultMessage,
    createUserMessage: llm.createUserMessage,
    BlockAssembler: llm.BlockAssembler,
    AdaptiveCompactionEngine: candidate?.AdaptiveCompactionEngine,
  }
}

function flattenBlocks(blocks) {
  return blocks.map((block) => {
    if (block.type === 'text') return block.text
    if (block.type === 'tool-result') return flattenBlocks(block.content)
    return ''
  }).filter(Boolean).join('\n')
}

function flattenMessages(messages) {
  return messages.map(message => flattenBlocks(message.content)).filter(Boolean).join('\n')
}

function evidenceLines(messages) {
  const evidence = []
  const seen = new Set()
  for (const rawLine of flattenMessages(messages).split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^-\s+/, '')
    const match = /^(Goal|Constraint|Fact|Decision|Pending|Error|Correction):\s*.+$/.exec(line)
    if (match === null || seen.has(line)) continue
    seen.add(line)
    evidence.push({ kind: match[1], line })
  }
  return evidence
}

function bullets(lines) {
  return lines.length === 0 ? '- (none)' : lines.map(line => `- ${line}`).join('\n')
}

function deterministicCheckpoint(messages) {
  const evidence = evidenceLines(messages)
  const ofKind = (...kinds) => evidence.filter(item => kinds.includes(item.kind)).map(item => item.line)
  const fileFacts = evidence.filter(item => item.kind === 'Fact' && item.line.includes('/')).map(item => item.line)
  const nonFileFacts = evidence.filter(item => item.kind === 'Fact' && !item.line.includes('/')).map(item => item.line)
  const pending = ofKind('Pending')
  const decisions = ofKind('Decision')
  return [
    '## Primary Request and Intent',
    bullets(ofKind('Goal')),
    '',
    '## Key Technical Concepts',
    bullets(nonFileFacts),
    '',
    '## Files and Code',
    bullets(fileFacts),
    '',
    '## Errors and Fixes',
    bullets(ofKind('Error')),
    '',
    '## Pending Jobs',
    bullets(pending),
    '',
    '## Current Work',
    bullets(decisions.slice(-1)),
    '',
    '## Next Step',
    bullets(pending.slice(-1)),
    '',
    '## Critical Context',
    bullets([...ofKind('Constraint', 'Correction'), ...decisions]),
  ].join('\n')
}

function createDeterministicAdapter(LlmAdapter, contextWindow) {
  return new class extends LlmAdapter {
    calls = []

    resolveModel(provider, model) {
      return Promise.resolve({
        provider,
        id: model,
        name: model,
        context: { contextWindow },
      })
    }

    async * stream(options) {
      const instruction = flattenBlocks(options.messages.at(-1)?.content ?? [])
      this.calls.push({
        provider: options.provider,
        model: options.model,
        purpose: options.purpose ?? null,
        maxTokens: options.maxTokens ?? null,
        summarySectionsRequested: REQUIRED_SUMMARY_SECTIONS.every(section => instruction.includes(section)),
      })
      const summary = deterministicCheckpoint(options.messages.slice(0, -1))
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: summary }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }()
}

function turnText(lines, turn, side, fillerRepeat) {
  const filler = `${side}_background_${turn}_detail `
  return [...lines, filler.repeat(fillerRepeat)].join('\n')
}

function toolResultText(parts) {
  return parts.map((part) => {
    if (typeof part.text === 'string') return part.text
    if (typeof part.repeat === 'string' && Number.isInteger(part.count) && part.count >= 0) {
      return part.repeat.repeat(part.count)
    }
    throw new Error('invalid tool result part')
  }).join('')
}

function appendTurn(runtime, session, state, turnSpec, target) {
  const turn = state.openTurn ?? state.nextTurn
  if (state.openTurn === null) session.append('turn/start', { turn })
  const userText = turnText(turnSpec.userLines ?? [], turn, 'user', turnSpec.fillerRepeat ?? 0)
  session.append('user/message', runtime.createUserMessage({
    content: [{ type: 'text', text: userText }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  if (!state.routed) {
    session.append('request/header', {
      header: { config: target },
      reason: 'initial',
    })
    state.routed = true
  }

  const content = [{
    type: 'text',
    text: turnText(turnSpec.assistantLines ?? [], turn, 'assistant', turnSpec.fillerRepeat ?? 0),
  }]
  if (turnSpec.tool !== undefined) {
    content.push({
      type: 'tool-call',
      id: runtime.CallId(turnSpec.tool.callId),
      name: turnSpec.tool.name,
      arguments: turnSpec.tool.arguments,
    })
  }
  session.append('assistant/message', {
    turn,
    step: 1,
    message: runtime.createMessage({
      role: 'assistant',
      content,
      source: { kind: 'model', ...target },
    }),
  }, { surfaceOp: 'append' })

  if (turnSpec.tool !== undefined) {
    const callId = runtime.CallId(turnSpec.tool.callId)
    session.append('tool/call', {
      turn,
      step: 1,
      callId,
      name: turnSpec.tool.name,
      arguments: turnSpec.tool.arguments,
    })
    session.append('tool/result', {
      turn,
      step: 1,
      message: runtime.createToolResultMessage({
        callId,
        content: [{ type: 'text', text: toolResultText(turnSpec.tool.resultParts) }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
  }
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  state.openTurn = null
  state.nextTurn = turn + 1
}

function appendWave(runtime, session, state, turns, target) {
  for (const turn of turns) appendTurn(runtime, session, state, turn, target)
  session.append('turn/start', { turn: state.nextTurn })
  state.openTurn = state.nextTurn
  state.nextTurn += 1
}

function messageForSurfaceEvent(event) {
  if (event.type === 'user/message') return event.data
  if (event.type === 'assistant/message' || event.type === 'tool/result') return event.data.message
  return undefined
}

function projectSurface(session) {
  return session.surface.nodes.map((seq) => {
    const event = session.events[seq]
    const message = event === undefined ? undefined : messageForSurfaceEvent(event)
    return {
      seq,
      type: event?.type ?? 'missing',
      text: message === undefined ? '' : flattenBlocks(message.content),
    }
  })
}

function visibleText(session) {
  return projectSurface(session).map(node => node.text).filter(Boolean).join('\n')
}

function surfaceMessages(session) {
  return session.surface.nodes
    .map(seq => messageForSurfaceEvent(session.events[seq]))
    .filter(message => message !== undefined)
}

function allCallIds(events) {
  const ids = new Set()
  for (const event of events) {
    if (event.type === 'tool/call') ids.add(event.data.callId)
    if (event.type === 'tool/result') ids.add(event.data.message.source.callId)
  }
  return ids
}

function pairStates(session) {
  const states = Object.fromEntries([...allCallIds(session.events)].map(callId => [callId, {
    callPresent: false,
    resultPresent: false,
    ordered: false,
  }]))
  const positions = Object.fromEntries(Object.keys(states).map(callId => [callId, {}]))
  for (const [surfaceIndex, seq] of session.surface.nodes.entries()) {
    const event = session.events[seq]
    if (event?.type === 'assistant/message') {
      for (const block of event.data.message.content) {
        if (block.type !== 'tool-call') continue
        states[block.id] ??= { callPresent: false, resultPresent: false, ordered: false }
        positions[block.id] ??= {}
        states[block.id].callPresent = true
        positions[block.id].call = surfaceIndex
      }
    }
    if (event?.type === 'tool/result') {
      const callId = event.data.message.source.callId
      states[callId] ??= { callPresent: false, resultPresent: false, ordered: false }
      positions[callId] ??= {}
      states[callId].resultPresent = true
      positions[callId].result = surfaceIndex
    }
  }
  for (const [callId, state] of Object.entries(states)) {
    state.ordered = state.callPresent && state.resultPresent && positions[callId].call < positions[callId].result
  }
  return states
}

function eventCount(session, type) {
  return session.events.filter(event => event.type === type).length
}

function caseSemantic(caseResult) {
  return {
    id: caseResult.id,
    passMetrics: caseResult.passMetrics,
    compactionPasses: caseResult.compactionPasses,
    summaryCalls: caseResult.summaryCalls,
    pruneEventCount: caseResult.pruneEventCount,
    finalTokens: caseResult.finalTokens,
    tokenSavingsRatio: caseResult.tokenSavingsRatio,
    anchorScore: caseResult.anchorScore,
    checkScore: caseResult.checkScore,
    toolPairScore: caseResult.toolPairScore,
    anchorDrift: caseResult.anchorDrift,
    replayEquivalent: caseResult.replayEquivalent,
    immediateNoop: caseResult.immediateNoop,
    summaryContractSatisfied: caseResult.summaryContractSatisfied,
    failure: caseResult.failure,
    downstreamFailure: caseResult.downstreamFailure,
  }
}

function safeError(error) {
  return {
    name: error instanceof Error ? error.name : 'Error',
    code: typeof error?.code === 'string' ? error.code : null,
    message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
  }
}

function observeModelCalls(ctx) {
  const calls = []
  ctx.on('llm/stream', (options, next) => {
    const instruction = flattenBlocks(options.messages.at(-1)?.content ?? [])
    const call = {
      provider: options.provider,
      model: options.model,
      purpose: options.purpose ?? null,
      maxTokens: options.maxTokens ?? null,
      summarySectionsRequested: REQUIRED_SUMMARY_SECTIONS.every(section => instruction.includes(section)),
      durationMs: 0,
      usage: null,
      finish: null,
      error: null,
    }
    calls.push(call)
    const started = performance.now()
    const stream = next()
    return (async function* observedStream() {
      try {
        for await (const chunk of stream) {
          if (chunk.type === 'usage') call.usage = chunk.usage
          if (chunk.type === 'finish') call.finish = chunk.reason.kind
          yield chunk
        }
      } catch (error) {
        call.error = safeError(error)
        throw error
      } finally {
        call.durationMs = performance.now() - started
      }
    })()
  })
  return calls
}

async function disposeFibers(fibers) {
  for (const fiber of [...fibers].reverse()) await fiber.dispose()
}

async function createCaseHarness(runtime, caseSpec, options) {
  const ctx = new runtime.Context()
  void new runtime.LlmRuntime(ctx)
  void new runtime.TokenMeter(ctx)
  const target = options.mode === 'deterministic'
    ? { provider: DETERMINISTIC_MODEL, model: DETERMINISTIC_MODEL }
    : { provider: options.provider, model: options.model }
  const fibers = []
  let calls
  let modelInfo
  let compactConfig
  if (options.mode === 'deterministic') {
    const adapter = createDeterministicAdapter(runtime.LlmAdapter, caseSpec.contextWindow)
    ctx.llm.registerAdapter([DETERMINISTIC_MODEL], adapter)
    calls = adapter.calls
    compactConfig = { auto: false }
    modelInfo = {
      provider: DETERMINISTIC_MODEL,
      id: DETERMINISTIC_MODEL,
      context: { contextWindow: caseSpec.contextWindow },
    }
  } else {
    calls = observeModelCalls(ctx)
    fibers.push(await ctx.plugin(runtime.FileSettingsProvider, {
      dshHome: options.dshHome,
      watch: false,
    }))
    fibers.push(await ctx.plugin(runtime.LocalCredentialProvider, {
      dshHome: options.dshHome,
      watch: false,
    }))
    fibers.push(await ctx.plugin(runtime.LlmPiAi, { providers: {} }))
    modelInfo = await ctx.llm.resolveModelInfo(target.provider, target.model, SIGNAL)
    const actualContextWindow = modelInfo.context?.contextWindow
    if (!Number.isInteger(actualContextWindow) || actualContextWindow < 1) {
      throw new Error(`configured model ${target.provider}/${target.model} has no positive context window`)
    }
    const simulatedThresholdTokens = caseSpec.contextWindow
    compactConfig = {
      auto: false,
      thresholdRatio: simulatedThresholdTokens / actualContextWindow,
      retainTokens: Math.floor(caseSpec.contextWindow * 0.16),
      summarizationProvider: target.provider,
      summarizationModel: target.model,
    }
  }
  const pruner = options.strategy === 'native' ? new runtime.ToolResultPruner(ctx) : null
  if (options.strategy === 'candidate' && runtime.AdaptiveCompactionEngine === undefined) {
    throw new Error('candidate strategy requested but improved-compact build did not export AdaptiveCompactionEngine')
  }
  const compact = options.strategy === 'native'
    ? new runtime.BasicCompactionEngine(ctx, compactConfig)
    : new runtime.AdaptiveCompactionEngine(ctx, {
        ...compactConfig,
        softPruneRatio: compactConfig.thresholdRatio === undefined
          ? 0.6
          : compactConfig.thresholdRatio * 0.75,
        protectedRecentUserMessages: 1,
        validateSummaryStructure: true,
      })
  return {
    ctx,
    target,
    calls,
    modelInfo,
    pruner,
    compact,
    dispose: () => disposeFibers(fibers),
  }
}

function failedAnchorScore(anchors) {
  const byCategory = {}
  for (const anchor of anchors) {
    const category = byCategory[anchor.category] ?? { hit: 0, total: 0, recall: 0 }
    category.total += 1
    byCategory[anchor.category] = category
  }
  return { hit: 0, total: anchors.length, recall: 0, missing: anchors.map(anchor => anchor.id), byCategory }
}

function failedCheckScore(checks, failure) {
  const failures = checks.map(check => ({
    id: check.id,
    passed: false,
    expected: check.expected ?? 'ordered structured call/result pair',
    actual: { compactionError: failure },
  }))
  return { passed: 0, total: checks.length, rate: 0, failures, results: failures }
}

function parseJsonObject(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end < start) throw new Error('downstream query returned no JSON object')
  const value = JSON.parse(text.slice(start, end + 1))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('downstream query JSON must be an object')
  }
  return value
}

async function queryCompressedContext(runtime, ctx, target, session, checks) {
  const assignments = checks.filter(check => check.kind === 'lastAssignment')
  if (assignments.length === 0) return {}
  const requested = assignments.map(check => `- ${JSON.stringify(check.id)}: value of ${check.key}`).join('\n')
  const prompt = [
    'Answer the following questions using only the established conversation context above.',
    'Return exactly one JSON object. Its keys must be the quoted ids below; each value must be the exact technical value from context, or null when unavailable.',
    'Do not add Markdown, explanation, or extra keys.',
    '',
    requested,
  ].join('\n')
  const assembler = new runtime.BlockAssembler()
  const messages = [
    ...surfaceMessages(session),
    runtime.createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: 'improved-compact-eval' },
    }),
  ]
  for await (const chunk of ctx.llm.stream({
    provider: target.provider,
    model: target.model,
    messages,
    maxTokens: 512,
    sessionId: session.id,
  })) assembler.push(chunk)
  if (assembler.finish.kind !== 'stop') {
    throw new Error(`downstream query finished with ${assembler.finish.kind}`)
  }
  const text = assembler.blocks()
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
  return parseJsonObject(text)
}

function evaluateModelChecks(outputs, pairState, checks) {
  const results = checks.map((check) => {
    if (check.kind === 'lastAssignment') {
      const raw = outputs[check.id]
      const actual = raw === null || raw === undefined ? null : String(raw)
      return { id: check.id, passed: actual === check.expected, expected: check.expected, actual }
    }
    if (check.kind === 'structuredToolPair') {
      const state = pairState[check.callId] ?? { callPresent: false, resultPresent: false, ordered: false }
      return {
        id: check.id,
        passed: state.callPresent && state.resultPresent && state.ordered,
        expected: 'ordered structured call/result pair',
        actual: state,
      }
    }
    throw new Error(`unknown check kind: ${String(check.kind)}`)
  })
  const passed = results.filter(result => result.passed).length
  return {
    passed,
    total: results.length,
    rate: passed / results.length,
    failures: results.filter(result => !result.passed),
    results,
  }
}

async function runCase(runtime, caseSpec, repetition, options) {
  const harness = await createCaseHarness(runtime, caseSpec, options)
  const { ctx, target, calls, modelInfo, pruner, compact } = harness
  const session = runtime.Session.create(runtime.SessionId(`${caseSpec.id}-run-${repetition}`))
  const agent = { session, options: target }
  const state = { nextTurn: 1, openTurn: null, routed: false }
  const passMetrics = []
  let failure = null

  try {
    for (const [waveIndex, wave] of caseSpec.waves.entries()) {
      appendWave(runtime, session, state, wave, target)
      const beforeTokens = ctx.tokenMeter.measure(session).totalTokens
      let result = null
      try {
        result = await compact.compactIfNeeded(agent, 'pressure', SIGNAL)
      } catch (error) {
        failure = safeError(error)
      }
      const afterTokens = ctx.tokenMeter.measure(session).totalTokens
      const text = visibleText(session)
      passMetrics.push({
        wave: waveIndex + 1,
        beforeTokens,
        afterTokens,
        savingsRatio: beforeTokens === 0 ? 0 : (beforeTokens - afterTokens) / beforeTokens,
        compacted: result !== null,
        shadowedNodes: result?.shadowedSeqs.length ?? 0,
        anchorHitIds: caseSpec.anchors.filter(anchor => text.includes(anchor.needle)).map(anchor => anchor.id),
      })
      if (failure !== null) break
    }

    let noopResult = null
    if (failure === null) {
      try {
        noopResult = await compact.compactIfNeeded(agent, 'pressure', SIGNAL)
      } catch (error) {
        failure = safeError(error)
      }
    }
    const text = visibleText(session)
    const states = pairStates(session)
    let downstreamOutputs = {}
    let downstreamFailure = null
    if (failure === null && options.mode === 'configured-model') {
      try {
        downstreamOutputs = await queryCompressedContext(runtime, ctx, target, session, caseSpec.checks)
      } catch (error) {
        downstreamFailure = safeError(error)
      }
    }
    const anchorScore = failure === null ? scoreAnchors(text, caseSpec.anchors) : failedAnchorScore(caseSpec.anchors)
    const checkScore = failure === null
      ? downstreamFailure === null
        ? options.mode === 'configured-model'
          ? evaluateModelChecks(downstreamOutputs, states, caseSpec.checks)
          : evaluateChecks(text, states, caseSpec.checks)
        : failedCheckScore(caseSpec.checks, downstreamFailure)
      : failedCheckScore(caseSpec.checks, failure)
    const toolPairScore = scoreToolPairs(states)
    const firstPassHitIds = new Set(passMetrics[0]?.anchorHitIds ?? [])
    const finalHitIds = new Set(caseSpec.anchors.filter(anchor => text.includes(anchor.needle)).map(anchor => anchor.id))
    const replay = runtime.Session.create(runtime.SessionId(`${caseSpec.id}-replay-${repetition}`), [...session.events])
    const compactionCalls = calls.filter(call => call.purpose === 'compaction')
    const downstreamCalls = calls.filter(call => call.purpose !== 'compaction')
    const summaryContractSatisfied = compactionCalls.length > 0 && compactionCalls.every(call =>
      call.provider === target.provider
      && call.model === target.model
      && call.maxTokens === 8192
      && call.summarySectionsRequested)
    const tokenSavingsRatio = passMetrics.reduce((sum, pass) => sum + pass.savingsRatio, 0) / passMetrics.length

    return {
      id: caseSpec.id,
      description: caseSpec.description,
      contextWindow: caseSpec.contextWindow,
      evaluationThresholdTokens: Math.round(
        (modelInfo.context?.contextWindow ?? caseSpec.contextWindow) * compact.config.thresholdRatio,
      ),
      resolvedModel: {
        provider: modelInfo.provider,
        id: modelInfo.id,
        context: modelInfo.context ?? null,
      },
       strategy: options.strategy,
       nativeConfig: compact.config,
       prunerConfig: pruner?.config ?? compact.adaptiveConfig.toolResult,
      passMetrics,
      compactionPasses: passMetrics.filter(pass => pass.compacted).length,
      summaryCalls: compactionCalls.length,
      summaryCallContracts: compactionCalls,
      downstreamCalls: downstreamCalls.length,
      downstreamCallContracts: downstreamCalls,
      pruneEventCount: eventCount(session, 'compaction/prune'),
      finalTokens: ctx.tokenMeter.measure(session).totalTokens,
      tokenSavingsRatio,
      anchorScore,
      checkScore,
      toolPairScore,
      anchorDrift: [...firstPassHitIds].filter(id => !finalHitIds.has(id)),
      replayEquivalent: stableJson(projectSurface(session)) === stableJson(projectSurface(replay)),
      immediateNoop: failure === null && noopResult === null,
      summaryContractSatisfied,
      failure,
      downstreamFailure,
    }
  } finally {
    await harness.dispose()
  }
}

async function runRepetition(runtime, cases, repetition, options) {
  const started = performance.now()
  const results = []
  for (const caseSpec of cases) results.push(await runCase(runtime, caseSpec, repetition, options))
  const semantic = results.map(caseSemantic)
  return {
    repetition,
    durationMs: performance.now() - started,
    semanticDigest: semanticDigest(semantic),
    cases: results,
  }
}

async function dependencyHashes(dshRoot, strategy) {
  const paths = {
    compactionBasic: 'packages/compaction/compaction-basic/lib/index.js',
    toolResultPruner: 'packages/compaction/compaction-tool-result-pruner/lib/index.js',
    tokenMeter: 'packages/llm/token-meter/lib/index.js',
    llm: 'packages/llm/llm/lib/index.js',
    session: 'packages/core/session/lib/index.js',
    llmPiAi: 'packages/llm/llm-pi-ai/lib/index.js',
    settingsFile: 'packages/settings/settings-file/lib/index.js',
    credentialsLocal: 'packages/credentials/credentials-local/lib/index.js',
  }
  const hashes = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name, path]) => [
    name,
    { path, sha256: await sha256File(join(dshRoot, path)) },
  ])))
  if (strategy === 'candidate') {
    hashes.dshCompactCandidate = {
      path: 'lib/index.js',
      sha256: await sha256File(join(pluginRoot, 'lib', 'index.js')),
    }
  }
  return hashes
}

function aggregateCalls(calls) {
  const durations = calls.map(call => call.durationMs).filter(value => Number.isFinite(value))
  const usage = {}
  for (const call of calls) {
    for (const [key, value] of Object.entries(call.usage ?? {})) {
      if (typeof value === 'number' && Number.isFinite(value)) usage[key] = (usage[key] ?? 0) + value
    }
  }
  const sorted = [...durations].sort((left, right) => left - right)
  const percentile95 = sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
  const successes = calls.filter(call => call.error === null && call.finish === 'stop').length
  return {
    calls: calls.length,
    successes,
    successRate: calls.length === 0 ? 0 : successes / calls.length,
    usage,
    durationMs: durations.length === 0
      ? null
      : {
          min: Math.min(...durations),
          mean: durations.reduce((sum, value) => sum + value, 0) / durations.length,
          p95: percentile95,
          max: Math.max(...durations),
        },
  }
}

function printSummary(report, output) {
  console.log(`mode: ${report.mode}`)
  if (report.model !== undefined) console.log(`model: ${report.model.provider}/${report.model.id}`)
  console.log(`dataset: ${report.dataset.id} (${report.dataset.caseCount} cases)`)
  console.log(`upstream: ${report.upstream.commit}`)
  console.log(`repetitions: ${report.aggregate.repetitions}; semantic stability: ${report.aggregate.stable ? 'stable' : 'UNSTABLE'}`)
  console.table(report.aggregate.cases.map(item => ({
    case: item.id,
    compactionSuccess: item.compactionSuccessRate.toFixed(3),
    anchorRecall: item.anchorRecall.toFixed(3),
    downstreamSuccess: item.downstreamSuccess.toFixed(3),
    downstreamConditional: item.downstreamSuccessConditional?.toFixed(3) ?? '-',
    tokenSavings: item.tokenSavingsRatio.toFixed(3),
    missing: item.missingAnchorIds.join(',') || '-',
    failedChecks: item.failedCheckIds.join(',') || '-',
  })))
  console.log(`report: ${output}`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const dshRoot = await resolveDshRoot(options.dshRoot)
  const dirty = await assertBuiltUpstream(dshRoot, options.allowDirtyUpstream, options.mode)
  if (options.strategy === 'candidate') {
    const candidateBuild = join(pluginRoot, 'lib', 'index.js')
    if (!await pathExists(candidateBuild)) throw new Error('candidate build is missing; run pnpm build first')
    if (await newestMtime(join(pluginRoot, 'src')) > (await stat(candidateBuild)).mtimeMs) {
      throw new Error('candidate sources are newer than lib/index.js; run pnpm build first')
    }
  }
  const datasetRaw = await readFile(datasetPath, 'utf8')
  const dataset = validateDataset(JSON.parse(datasetRaw))
  const selectedCases = options.caseIds.length === 0
    ? dataset.cases
    : dataset.cases.filter(caseSpec => options.caseIds.includes(caseSpec.id))
  const missingCaseIds = options.caseIds.filter(id => !selectedCases.some(caseSpec => caseSpec.id === id))
  if (missingCaseIds.length > 0) throw new Error(`unknown case id(s): ${missingCaseIds.join(', ')}`)
  const runtime = await importUpstream(dshRoot, options.strategy)
  const repetitions = []
  for (let repetition = 1; repetition <= options.runs; repetition += 1) {
    repetitions.push(await runRepetition(runtime, selectedCases, repetition, options))
  }
  const configuredModel = options.mode === 'configured-model'
    ? {
        provider: options.provider,
        id: options.model,
        context: repetitions[0]?.cases[0]?.resolvedModel.context ?? null,
      }
    : undefined
  const modelCallAggregate = options.mode === 'configured-model'
    ? {
        summaries: aggregateCalls(repetitions.flatMap(repetition =>
          repetition.cases.flatMap(caseResult => caseResult.summaryCallContracts))),
        downstreamQueries: aggregateCalls(repetitions.flatMap(repetition =>
          repetition.cases.flatMap(caseResult => caseResult.downstreamCallContracts))),
      }
    : undefined
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    strategy: options.strategy,
    mode: options.mode === 'deterministic'
      ? `keyless-deterministic-adapter-through-${options.strategy === 'native' ? 'native-compaction-basic' : 'improved-compact-candidate'}`
      : `configured-model-through-${options.strategy === 'native' ? 'native-compaction-basic' : 'improved-compact-candidate'}`,
    ...configuredModel === undefined ? {} : { model: configuredModel },
    ...modelCallAggregate === undefined ? {} : { modelCallAggregate },
    limitations: options.mode === 'deterministic'
      ? [
           `The deterministic adapter exercises the ${options.strategy} routing, region, pruning, transaction, replay, and token-meter paths, but does not measure real-model summary quality.`,
          'Token counts use the native token-meter heuristic because the deterministic adapter reports no provider usage.',
          'Latency is local keyless execution time and is not representative of a network model call.',
        ]
      : [
          'The fixture pressure thresholds are set to 1200/2400 estimated tokens while retention uses the original synthetic budgets, so the configured 272k model can exercise one useful compaction without sending a near-window-sized prompt or being forced into artificial repeat summarization.',
          'Exact anchor matching is deliberately conservative and can count a faithful paraphrase as a miss; structured follow-up checks are reported separately.',
          'The four synthetic cases are a development/validation set, not an unseen holdout or a full coding-task benchmark.',
        ],
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    dataset: {
      id: dataset.datasetId,
      schemaVersion: dataset.schemaVersion,
      caseCount: selectedCases.length,
      selectedCaseIds: selectedCases.map(caseSpec => caseSpec.id),
      path: 'evals/cases/native-baseline-v1.json',
      sha256: createHash('sha256').update(datasetRaw).digest('hex'),
    },
    evaluationArtifacts: {
      runner: {
        path: 'evals/run-native-baseline.mjs',
        sha256: await sha256File(fileURLToPath(import.meta.url)),
      },
      scorer: {
        path: 'evals/scorers/native-baseline.mjs',
        sha256: await sha256File(join(pluginRoot, 'evals', 'scorers', 'native-baseline.mjs')),
      },
    },
    upstream: {
      root: dshRoot,
      commit: git(dshRoot, ['rev-parse', 'HEAD']),
      describe: git(dshRoot, ['describe', '--always', '--dirty']),
      dirty: dirty.length > 0,
       dependencyHashes: await dependencyHashes(dshRoot, options.strategy),
    },
    repetitionDigests: repetitions.map(({ repetition, durationMs, semanticDigest: digest }) => ({
      repetition,
      durationMs,
      semanticDigest: digest,
    })),
    repetitions,
    aggregate: aggregateRepetitions(repetitions),
  }
  await mkdir(dirname(options.output), { recursive: true })
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  printSummary(report, options.output)
  if (options.mode === 'deterministic' && !report.aggregate.stable) process.exitCode = 2
  else if (options.mode === 'deterministic' && !report.aggregate.structuralGatesPassed) process.exitCode = 3
}

await main()
