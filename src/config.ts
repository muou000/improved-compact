import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import type {
  AdaptiveCompactionConfig,
  ResolvedAdaptiveConfig,
  ResolvedSemanticToolResultConfig,
} from './types.ts'

const DEFAULT_SOFT_PRUNE_RATIO = 0.6
const DEFAULT_SUMMARY_THRESHOLD_RATIO = 0.8
const MIN_PRUNE_MARKER_CHARS = 3

const BASE_KEYS: ReadonlySet<string> = new Set([
  'thresholdRatio',
  'retainRatio',
  'retainTokens',
  'summarizationProvider',
  'summarizationModel',
  'maxTokens',
  'compactionRetries',
  'maxOverflowRetries',
  'modelPolicies',
  'auto',
])

const ADAPTIVE_KEYS: ReadonlySet<string> = new Set([
  'softPruneRatio',
  'protectedRecentUserMessages',
  'maxProtectedTailRatio',
  'validateSummaryStructure',
  'repeatSummaryMaxChars',
  'toolResult',
  'verbatimAnchors',
  'requestBudget',
  'logLifecycle',
])

const TOOL_RESULT_KEYS: ReadonlySet<string> = new Set([
  'thresholdChars',
  'headChars',
  'tailChars',
  'signalChars',
  'protectedToolNames',
])

const VERBATIM_KEYS: ReadonlySet<string> = new Set(['maxChars', 'maxAnchors'])
const REQUEST_BUDGET_KEYS: ReadonlySet<string> = new Set([
  'warnAtTokens',
  'blockAtTokens',
  'warnAtRatio',
  'blockAtRatio',
  'maxOutputTokens',
  'logEveryRequest',
])

/** Split plugin-only fields from the configuration accepted by the upstream backend. */
export function baseCompactionConfig(config: AdaptiveCompactionConfig): BasicCompactionConfig {
  const base: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (BASE_KEYS.has(key)) base[key] = value
  }
  return base as BasicCompactionConfig
}

/** Resolve adaptive fields and reject tier overlap or misspelled plugin keys. */
export function resolveAdaptiveConfig(config: AdaptiveCompactionConfig = {}): ResolvedAdaptiveConfig {
  validateKeys(config, new Set([...BASE_KEYS, ...ADAPTIVE_KEYS]), 'improved-compact config')
  const softPruneRatio = config.softPruneRatio ?? DEFAULT_SOFT_PRUNE_RATIO
  assertRatio('improved-compact config.softPruneRatio', softPruneRatio)
  validateSoftTier(softPruneRatio, config)

  const protectedRecentUserMessages = config.protectedRecentUserMessages ?? 1
  assertNonNegativeInteger(
    'improved-compact config.protectedRecentUserMessages',
    protectedRecentUserMessages,
  )
  const maxProtectedTailRatio = config.maxProtectedTailRatio ?? 0.5
  assertNonNegativeRatio('improved-compact config.maxProtectedTailRatio', maxProtectedTailRatio)
  const validateSummaryStructure = config.validateSummaryStructure ?? true
  assertBoolean('improved-compact config.validateSummaryStructure', validateSummaryStructure)
  const repeatSummaryMaxChars = config.repeatSummaryMaxChars ?? 1_800
  assertNonNegativeInteger('improved-compact config.repeatSummaryMaxChars', repeatSummaryMaxChars)
  if (repeatSummaryMaxChars > 0 && repeatSummaryMaxChars < 512) {
    throw new Error('improved-compact config.repeatSummaryMaxChars must be 0 or at least 512')
  }
  const logLifecycle = config.logLifecycle ?? false
  assertBoolean('improved-compact config.logLifecycle', logLifecycle)

  const toolResult = resolveToolResult(config.toolResult)
  const verbatimAnchors = config.verbatimAnchors ?? {}
  validateObject(verbatimAnchors, 'improved-compact config.verbatimAnchors')
  validateKeys(verbatimAnchors, VERBATIM_KEYS, 'improved-compact config.verbatimAnchors')
  const maxChars = verbatimAnchors.maxChars ?? 4_096
  const maxAnchors = verbatimAnchors.maxAnchors ?? 64
  assertNonNegativeInteger('improved-compact config.verbatimAnchors.maxChars', maxChars)
  assertNonNegativeInteger('improved-compact config.verbatimAnchors.maxAnchors', maxAnchors)
  if (maxChars > 0 && maxChars < 64) {
    throw new Error('improved-compact config.verbatimAnchors.maxChars must be 0 or at least 64')
  }
  const requestBudget = resolveRequestBudget(config.requestBudget)

  return Object.freeze({
    softPruneRatio,
    protectedRecentUserMessages,
    maxProtectedTailRatio,
    validateSummaryStructure,
    repeatSummaryMaxChars,
    toolResult,
    verbatimAnchors: Object.freeze({ maxChars, maxAnchors }),
    requestBudget,
    logLifecycle,
  })
}

function resolveRequestBudget(
  configured: AdaptiveCompactionConfig['requestBudget'],
): ResolvedAdaptiveConfig['requestBudget'] {
  const config = configured ?? {}
  validateObject(config, 'improved-compact config.requestBudget')
  validateKeys(config, REQUEST_BUDGET_KEYS, 'improved-compact config.requestBudget')
  const warnAtTokens = config.warnAtTokens ?? 0
  const blockAtTokens = config.blockAtTokens ?? 0
  const warnAtRatio = config.warnAtRatio ?? 0.9
  const blockAtRatio = config.blockAtRatio ?? 0
  const maxOutputTokens = config.maxOutputTokens ?? 0
  const logEveryRequest = config.logEveryRequest ?? false
  assertNonNegativeInteger('improved-compact config.requestBudget.warnAtTokens', warnAtTokens)
  assertNonNegativeInteger('improved-compact config.requestBudget.blockAtTokens', blockAtTokens)
  assertOptionalRatio('improved-compact config.requestBudget.warnAtRatio', warnAtRatio)
  assertOptionalRatio('improved-compact config.requestBudget.blockAtRatio', blockAtRatio)
  assertNonNegativeInteger('improved-compact config.requestBudget.maxOutputTokens', maxOutputTokens)
  assertBoolean('improved-compact config.requestBudget.logEveryRequest', logEveryRequest)
  if (warnAtTokens > 0 && blockAtTokens > 0 && blockAtTokens < warnAtTokens) {
    throw new Error('improved-compact config.requestBudget.blockAtTokens must be at least warnAtTokens')
  }
  if (warnAtRatio > 0 && blockAtRatio > 0 && blockAtRatio < warnAtRatio) {
    throw new Error('improved-compact config.requestBudget.blockAtRatio must be at least warnAtRatio')
  }
  return Object.freeze({
    warnAtTokens,
    blockAtTokens,
    warnAtRatio,
    blockAtRatio,
    maxOutputTokens,
    logEveryRequest,
  })
}

function resolveToolResult(configured: AdaptiveCompactionConfig['toolResult']): ResolvedSemanticToolResultConfig {
  const config = configured ?? {}
  validateObject(config, 'improved-compact config.toolResult')
  validateKeys(config, TOOL_RESULT_KEYS, 'improved-compact config.toolResult')
  const thresholdChars = config.thresholdChars ?? 8_192
  const headChars = config.headChars ?? 3_072
  const tailChars = config.tailChars ?? 1_024
  const signalChars = config.signalChars ?? 2_048
  assertPositiveInteger('improved-compact config.toolResult.thresholdChars', thresholdChars)
  assertNonNegativeInteger('improved-compact config.toolResult.headChars', headChars)
  assertNonNegativeInteger('improved-compact config.toolResult.tailChars', tailChars)
  assertNonNegativeInteger('improved-compact config.toolResult.signalChars', signalChars)
  if (headChars + tailChars + MIN_PRUNE_MARKER_CHARS > thresholdChars) {
    throw new Error(
      'improved-compact config.toolResult: headChars + tailChars must leave room for a prune marker '
      + `inside thresholdChars (${headChars} + ${tailChars} + ${MIN_PRUNE_MARKER_CHARS} > ${thresholdChars})`,
    )
  }
  const protectedToolNames = config.protectedToolNames
    ?? ['request_user_input', 'create_goal', 'update_goal', 'todo_write']
  if (!Array.isArray(protectedToolNames)
    || protectedToolNames.some(name => typeof name !== 'string' || name.length === 0)) {
    throw new Error('improved-compact config.toolResult.protectedToolNames must contain non-empty strings')
  }
  if (new Set(protectedToolNames).size !== protectedToolNames.length) {
    throw new Error('improved-compact config.toolResult.protectedToolNames must not contain duplicates')
  }
  return Object.freeze({
    thresholdChars,
    headChars,
    tailChars,
    signalChars,
    protectedToolNames: Object.freeze([...protectedToolNames]),
  })
}

function validateSoftTier(softPruneRatio: number, config: AdaptiveCompactionConfig): void {
  const defaultThreshold = config.thresholdRatio ?? DEFAULT_SUMMARY_THRESHOLD_RATIO
  const thresholds = [defaultThreshold]
  if (Array.isArray(config.modelPolicies)) {
    for (const policy of config.modelPolicies) thresholds.push(policy.thresholdRatio ?? defaultThreshold)
  }
  for (const threshold of thresholds) {
    if (typeof threshold === 'number' && softPruneRatio >= threshold) {
      throw new Error(
        `improved-compact config.softPruneRatio (${softPruneRatio}) must be less than every resolved `
        + `thresholdRatio (${threshold})`,
      )
    }
  }
}

function validateObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
}

function validateKeys(value: object, allowed: ReadonlySet<string>, name: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${name}: unknown key "${key}"`)
  }
}

function assertRatio(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} (${String(value)}) must be a number in (0, 1]`)
  }
}

function assertNonNegativeRatio(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error(`${name} (${String(value)}) must be a number in [0, 1)`)
  }
}

function assertOptionalRatio(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} (${String(value)}) must be a number in [0, 1]`)
  }
}

function assertPositiveInteger(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} (${String(value)}) must be a positive integer`)
  }
}

function assertNonNegativeInteger(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} (${String(value)}) must be a non-negative integer`)
  }
}

function assertBoolean(name: string, value: unknown): asserts value is boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`)
}
