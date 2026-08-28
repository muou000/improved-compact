import { describe, expect, it } from 'vitest'
import {
  aggregateRepetitions,
  evaluateChecks,
  lastAssignment,
  scoreAnchors,
  scoreToolPairs,
  semanticDigest,
  validateDataset,
} from './native-baseline.mjs'

describe('native compaction baseline scorers', () => {
  it('scores anchors by category and reports exact missing ids', () => {
    const score = scoreAnchors('Goal: keep_it\nConstraint: safe=true', [
      { id: 'goal', category: 'goal', needle: 'Goal: keep_it' },
      { id: 'constraint', category: 'constraint', needle: 'Constraint: safe=true' },
      { id: 'pending', category: 'pending', needle: 'Pending: run_tests=true' },
    ])

    expect(score).toMatchObject({ hit: 2, total: 3, recall: 2 / 3, missing: ['pending'] })
    expect(score.byCategory.pending).toEqual({ hit: 0, total: 1, recall: 0 })
  })

  it('uses the last visible assignment so corrections are testable as behavior', () => {
    const text = 'Fact: deploy_region=eu-west-1\nCorrection: deploy_region=ap-southeast-1'

    expect(lastAssignment(text, 'deploy_region')).toBe('ap-southeast-1')
    expect(evaluateChecks(text, {}, [
      { id: 'region', kind: 'lastAssignment', key: 'deploy_region', expected: 'ap-southeast-1' },
    ])).toMatchObject({ passed: 1, total: 1, rate: 1 })
  })

  it('distinguishes a balanced pair from a split pair and requires ordering', () => {
    const states = {
      complete: { callPresent: true, resultPresent: true, ordered: true },
      split: { callPresent: true, resultPresent: false, ordered: false },
    }

    expect(scoreToolPairs(states)).toMatchObject({ balanced: false, splitCallIds: ['split'] })
    expect(evaluateChecks('', states, [
      { id: 'pair', kind: 'structuredToolPair', callId: 'complete' },
    ])).toMatchObject({ passed: 1, total: 1 })
  })

  it('validates unique case and anchor identities', () => {
    const valid = {
      schemaVersion: 1,
      datasetId: 'fixture-v1',
      cases: [{
        id: 'case-a',
        contextWindow: 100,
        waves: [[{}]],
        anchors: [{ id: 'goal', category: 'goal', needle: 'Goal: x' }],
        checks: [{ id: 'x', kind: 'lastAssignment', key: 'x', expected: 'y' }],
      }],
    }

    expect(validateDataset(valid)).toBe(valid)
    expect(() => validateDataset({ ...valid, cases: [valid.cases[0], valid.cases[0]] }))
      .toThrow('duplicate case id')
  })

  it('separates semantic stability from wall-clock variation', () => {
    const semantic = { id: 'case-a', score: 1 }
    const cases = [{
      id: 'case-a',
      anchorScore: { hit: 2, total: 2, recall: 1, missing: [] },
      checkScore: { passed: 1, total: 1, rate: 1, failures: [] },
      tokenSavingsRatio: 0.5,
      compactionPasses: 1,
      passMetrics: [{ compacted: true }],
      immediateNoop: true,
      replayEquivalent: true,
      summaryContractSatisfied: true,
      toolPairScore: { balanced: true },
      failure: null,
      downstreamFailure: null,
    }]
    const repetitions = [8, 13, 5].map(durationMs => ({
      durationMs,
      semanticDigest: semanticDigest(semantic),
      cases,
    }))

    expect(aggregateRepetitions(repetitions)).toMatchObject({
      stable: true,
      repetitions: 3,
      anchorRecall: 1,
      anchorRecallMicro: 1,
      compactionSuccessRate: 1,
      anchorRecallConditional: 1,
      downstreamSuccess: 1,
      downstreamSuccessMicro: 1,
      downstreamQuerySuccessRate: 1,
      downstreamSuccessConditional: 1,
      tokenSavingsRatio: 0.5,
      structuralGatesPassed: true,
      durationMs: { min: 5, max: 13, standardDeviation: expect.any(Number) },
    })
  })
})
