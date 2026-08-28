import { createHash } from 'node:crypto'

const KNOWN_CATEGORIES = new Set([
  'constraint',
  'correction',
  'decision',
  'error',
  'fact',
  'goal',
  'pending',
  'tool-result',
])

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
}

export function validateDataset(dataset) {
  if (dataset === null || typeof dataset !== 'object') throw new Error('dataset must be an object')
  if (dataset.schemaVersion !== 1) throw new Error('dataset.schemaVersion must be 1')
  assertNonEmptyString(dataset.datasetId, 'dataset.datasetId')
  if (!Array.isArray(dataset.cases) || dataset.cases.length === 0) {
    throw new Error('dataset.cases must be a non-empty array')
  }

  const caseIds = new Set()
  for (const [caseIndex, caseSpec] of dataset.cases.entries()) {
    assertNonEmptyString(caseSpec?.id, `cases[${caseIndex}].id`)
    if (caseIds.has(caseSpec.id)) throw new Error(`duplicate case id: ${caseSpec.id}`)
    caseIds.add(caseSpec.id)
    if (!Number.isInteger(caseSpec.contextWindow) || caseSpec.contextWindow < 1) {
      throw new Error(`${caseSpec.id}.contextWindow must be a positive integer`)
    }
    if (!Array.isArray(caseSpec.waves) || caseSpec.waves.length === 0
      || caseSpec.waves.some(wave => !Array.isArray(wave) || wave.length === 0)) {
      throw new Error(`${caseSpec.id}.waves must contain non-empty turn arrays`)
    }
    if (!Array.isArray(caseSpec.anchors) || caseSpec.anchors.length === 0) {
      throw new Error(`${caseSpec.id}.anchors must be a non-empty array`)
    }
    const anchorIds = new Set()
    for (const anchor of caseSpec.anchors) {
      assertNonEmptyString(anchor.id, `${caseSpec.id}.anchor.id`)
      assertNonEmptyString(anchor.needle, `${caseSpec.id}.${anchor.id}.needle`)
      if (!KNOWN_CATEGORIES.has(anchor.category)) {
        throw new Error(`${caseSpec.id}.${anchor.id}.category is unknown: ${String(anchor.category)}`)
      }
      if (anchorIds.has(anchor.id)) throw new Error(`duplicate anchor id in ${caseSpec.id}: ${anchor.id}`)
      anchorIds.add(anchor.id)
    }
    if (!Array.isArray(caseSpec.checks) || caseSpec.checks.length === 0) {
      throw new Error(`${caseSpec.id}.checks must be a non-empty array`)
    }
  }
  return dataset
}

export function scoreAnchors(text, anchors) {
  const byCategory = {}
  const missing = []
  for (const anchor of anchors) {
    const present = text.includes(anchor.needle)
    const category = byCategory[anchor.category] ?? { hit: 0, total: 0, recall: 0 }
    category.total += 1
    if (present) category.hit += 1
    else missing.push(anchor.id)
    category.recall = category.hit / category.total
    byCategory[anchor.category] = category
  }
  const hit = anchors.length - missing.length
  return {
    hit,
    total: anchors.length,
    recall: hit / anchors.length,
    missing,
    byCategory,
  }
}

export function lastAssignment(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = [...text.matchAll(new RegExp(`(?:^|\\s)${escaped}=([^\\s;,<]+)`, 'gm'))]
  return matches.at(-1)?.[1]
}

export function scoreToolPairs(pairStates) {
  const entries = Object.entries(pairStates).map(([callId, state]) => ({ callId, ...state }))
  const split = entries.filter(entry => entry.callPresent !== entry.resultPresent)
  return {
    totalObserved: entries.length,
    balanced: split.length === 0,
    splitCallIds: split.map(entry => entry.callId),
    states: entries,
  }
}

export function evaluateChecks(text, pairStates, checks) {
  const results = checks.map((check) => {
    if (check.kind === 'lastAssignment') {
      const actual = lastAssignment(text, check.key)
      return { id: check.id, passed: actual === check.expected, expected: check.expected, actual: actual ?? null }
    }
    if (check.kind === 'structuredToolPair') {
      const state = pairStates[check.callId] ?? { callPresent: false, resultPresent: false, ordered: false }
      const passed = state.callPresent && state.resultPresent && state.ordered
      return { id: check.id, passed, expected: 'ordered structured call/result pair', actual: state }
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

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortValue(value[key])]))
  }
  return value
}

export function stableJson(value) {
  return JSON.stringify(sortValue(value))
}

export function semanticDigest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length
}

function standardDeviation(values) {
  const average = mean(values)
  return Math.sqrt(mean(values.map(value => (value - average) ** 2)))
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]
}

export function aggregateRepetitions(repetitions) {
  if (!Array.isArray(repetitions) || repetitions.length === 0) {
    throw new Error('repetitions must be a non-empty array')
  }
  const digests = repetitions.map(repetition => repetition.semanticDigest)
  const durationMs = repetitions.map(repetition => repetition.durationMs)
  const firstCases = repetitions[0].cases
  const allCases = repetitions.flatMap(repetition => repetition.cases)
  const compactionCompletedCases = allCases.filter(item => item.failure == null)
  const downstreamCompletedCases = compactionCompletedCases.filter(item => item.downstreamFailure == null)
  const structuralFailures = repetitions.flatMap(repetition => repetition.cases.flatMap((item) => {
    const label = `run-${repetition.repetition}/${item.id}`
    const failures = []
    if (!item.passMetrics.every(pass => pass.compacted)) failures.push(`${label}:pressure-did-not-compact`)
    if (!item.immediateNoop) failures.push(`${label}:immediate-repeat-was-not-noop`)
    if (!item.replayEquivalent) failures.push(`${label}:replay-mismatch`)
    if (!item.summaryContractSatisfied) failures.push(`${label}:summary-contract`)
    if (!item.toolPairScore.balanced) failures.push(`${label}:split-tool-pair`)
    return failures
  }))
  const caseAggregates = firstCases.map((firstCase, caseIndex) => {
    const samples = repetitions.map(repetition => repetition.cases[caseIndex])
    if (samples.some(sample => sample.id !== firstCase.id)) {
      throw new Error(`case order changed at index ${caseIndex}`)
    }
    const anchorRecall = samples.map(sample => sample.anchorScore.recall)
    const downstreamSuccess = samples.map(sample => sample.checkScore.rate)
    const tokenSavingsRatio = samples.map(sample => sample.tokenSavingsRatio)
    const compactionCompleted = samples.filter(sample => sample.failure == null)
    const downstreamCompleted = compactionCompleted.filter(sample => sample.downstreamFailure == null)
    return {
      id: firstCase.id,
      compactionSuccessRate: compactionCompleted.length / samples.length,
      downstreamQuerySuccessRate: downstreamCompleted.length / samples.length,
      anchorRecall: mean(anchorRecall),
      anchorRecallMin: Math.min(...anchorRecall),
      anchorRecallMax: Math.max(...anchorRecall),
      anchorRecallStandardDeviation: standardDeviation(anchorRecall),
      downstreamSuccess: mean(downstreamSuccess),
      downstreamSuccessMin: Math.min(...downstreamSuccess),
      downstreamSuccessMax: Math.max(...downstreamSuccess),
      downstreamSuccessStandardDeviation: standardDeviation(downstreamSuccess),
      downstreamSuccessConditional: downstreamCompleted.length === 0
        ? null
        : mean(downstreamCompleted.map(sample => sample.checkScore.rate)),
      tokenSavingsRatio: mean(tokenSavingsRatio),
      tokenSavingsRatioMin: Math.min(...tokenSavingsRatio),
      tokenSavingsRatioMax: Math.max(...tokenSavingsRatio),
      missingAnchorIds: [...new Set(samples.flatMap(sample => sample.anchorScore.missing))],
      failedCheckIds: [...new Set(samples.flatMap(sample => sample.checkScore.failures.map(failure => failure.id)))],
      compactionPasses: samples.map(sample => sample.compactionPasses),
    }
  })
  return {
    repetitions: repetitions.length,
    stable: new Set(digests).size === 1,
    uniqueSemanticDigests: [...new Set(digests)],
    structuralGatesPassed: structuralFailures.length === 0,
    structuralFailures,
    durationMs: {
      min: Math.min(...durationMs),
      mean: mean(durationMs),
      standardDeviation: standardDeviation(durationMs),
      p95: percentile(durationMs, 0.95),
      max: Math.max(...durationMs),
    },
    anchorRecall: mean(caseAggregates.map(item => item.anchorRecall)),
    anchorRecallMicro: allCases.reduce((hit, item) => hit + item.anchorScore.hit, 0)
      / allCases.reduce((total, item) => total + item.anchorScore.total, 0),
    compactionSuccessRate: compactionCompletedCases.length / allCases.length,
    anchorRecallConditional: compactionCompletedCases.length === 0
      ? null
      : compactionCompletedCases.reduce((hit, item) => hit + item.anchorScore.hit, 0)
        / compactionCompletedCases.reduce((total, item) => total + item.anchorScore.total, 0),
    downstreamSuccess: mean(caseAggregates.map(item => item.downstreamSuccess)),
    downstreamSuccessMicro: allCases.reduce((passed, item) => passed + item.checkScore.passed, 0)
      / allCases.reduce((total, item) => total + item.checkScore.total, 0),
    downstreamQuerySuccessRate: downstreamCompletedCases.length / allCases.length,
    downstreamSuccessConditional: downstreamCompletedCases.length === 0
      ? null
      : downstreamCompletedCases.reduce((passed, item) => passed + item.checkScore.passed, 0)
        / downstreamCompletedCases.reduce((total, item) => total + item.checkScore.total, 0),
    tokenSavingsRatio: mean(caseAggregates.map(item => item.tokenSavingsRatio)),
    cases: caseAggregates,
  }
}
