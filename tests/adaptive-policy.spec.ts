import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import {
  boundStructuredSummary,
  extractVerbatimAnchors,
  REQUIRED_SUMMARY_SECTIONS,
  validateAndAugmentSummary,
} from '../src/signals.ts'
import { pruneToolResultContent } from '../src/pruner.ts'
import { resolveAdaptiveConfig } from '../src/config.ts'

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

function message(text: string): Message {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

const validSummary = REQUIRED_SUMMARY_SECTIONS
  .map(section => `${section}\n- (none)`)
  .join('\n\n')

describe('adaptive compaction policy', () => {
  it('retains a high-signal fact from the middle of an oversized tool result', () => {
    const config = resolveAdaptiveConfig({})
    const original: ContentBlock[] = [{
      type: 'text',
      text: [
        'Fact: tool_head_status=started\n',
        'H'.repeat(4_500),
        '\nFact: hidden_nonce=blue-lantern-731\n',
        'M'.repeat(4_500),
        '\nFact: tool_tail_status=complete',
      ].join(''),
    }]

    const pruned = pruneToolResultContent(original, config.toolResult)

    expect(pruned).not.toBeNull()
    expect(textOf(pruned ?? [])).toContain('hidden_nonce=blue-lantern-731')
    expect(Array.from(textOf(pruned ?? [])).length).toBeLessThanOrEqual(config.toolResult.thresholdChars)
    expect(pruneToolResultContent(pruned ?? [], config.toolResult)).toBeNull()
  })

  it('uses last-write-wins for exact assignments and drops stale values', () => {
    const anchors = extractVerbatimAnchors([
      message('Fact: deploy_region=us-east-1'),
      message('Correction: deploy_region=eu-west-1\nPending: run pnpm test'),
    ], { maxAnchors: 64, maxChars: 4_096 })

    expect(anchors).toContain('Correction: deploy_region=eu-west-1')
    expect(anchors).not.toContain('Fact: deploy_region=us-east-1')
    expect(anchors).toContain('Pending: run pnpm test')
  })

  it('does not copy credential-shaped lines into deterministic anchors', () => {
    const anchors = extractVerbatimAnchors([
      message('Fact: api_key=do-not-copy\nFact: target_file=/workspace/src/index.ts'),
    ], { maxAnchors: 64, maxChars: 4_096 })

    expect(anchors).not.toContain('Fact: api_key=do-not-copy')
    expect(anchors).toContain('Fact: target_file=/workspace/src/index.ts')
  })

  it('fails closed on a malformed checkpoint instead of landing silent loss', () => {
    expect(() => validateAndAugmentSummary(
      [{ type: 'text', text: '## Primary Request and Intent\n- incomplete' }],
      [message('Fact: target_file=/workspace/src/index.ts')],
      { validateStructure: true, maxAnchors: 64, maxChars: 4_096 },
    )).toThrow(/missing required section/i)
  })

  it('adds a bounded verbatim section with exact paths and commands', () => {
    const augmented = validateAndAugmentSummary(
      [{ type: 'text', text: validSummary }],
      [message([
        'Fact: target_file=/workspace/src/index.ts',
        'Pending: pnpm test -- --runInBand',
      ].join('\n'))],
      { validateStructure: true, maxAnchors: 64, maxChars: 4_096 },
    )
    const text = textOf(augmented)

    expect(text).toContain('## Verbatim Anchors')
    expect(text).toContain('target_file=/workspace/src/index.ts')
    expect(text).toContain('pnpm test -- --runInBand')
    expect(Array.from(text.slice(text.indexOf('## Verbatim Anchors'))).length).toBeLessThanOrEqual(4_096)
  })

  it('does not duplicate exact lines the model checkpoint already preserved', () => {
    const exact = 'Fact: target_file=/workspace/src/index.ts'
    const augmented = validateAndAugmentSummary(
      [{ type: 'text', text: `${validSummary}\n- ${exact}` }],
      [message(exact)],
      { validateStructure: true, maxAnchors: 64, maxChars: 4_096 },
    )
    const text = textOf(augmented)

    expect(text.match(new RegExp(exact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1)
    expect(text).not.toContain('## Verbatim Anchors')
  })

  it('bounds a repeated checkpoint while retaining structure and exact anchors', () => {
    const verbose = REQUIRED_SUMMARY_SECTIONS.map(section => [
      section,
      ...Array.from({ length: 10 }, (_, index) => `- verbose detail ${index} ${'x'.repeat(60)}`),
    ].join('\n')).join('\n\n')
      + '\n\n## Verbatim Anchors\n- Correction: storage_driver=postgres'

    const bounded = boundStructuredSummary([{ type: 'text', text: verbose }], 800)
    const text = textOf(bounded)

    expect(Array.from(text).length).toBeLessThanOrEqual(800)
    for (const section of REQUIRED_SUMMARY_SECTIONS) expect(text).toContain(section)
    expect(text).toContain('Correction: storage_driver=postgres')
  })

  it('rejects overlapping soft-prune and summary tiers at load time', () => {
    expect(() => resolveAdaptiveConfig({ softPruneRatio: 0.8, thresholdRatio: 0.8 }))
      .toThrow(/softPruneRatio.*less than.*thresholdRatio/i)
  })

  it('rejects a protected tail budget above the hard threshold', () => {
    expect(() => resolveAdaptiveConfig({ maxProtectedTailRatio: 1 }))
      .toThrow(/maxProtectedTailRatio.*\[0, 1\)/i)
  })

  it('rejects a repeated-summary ceiling too small for the fixed structure', () => {
    expect(() => resolveAdaptiveConfig({ repeatSummaryMaxChars: 400 }))
      .toThrow(/repeatSummaryMaxChars.*at least 512/i)
  })

  it('rejects a nonzero verbatim budget too small for its framing', () => {
    expect(() => resolveAdaptiveConfig({ verbatimAnchors: { maxChars: 32 } }))
      .toThrow(/verbatimAnchors\.maxChars.*at least 64/i)
  })

  it('rejects request budget hard limits below their warning limits', () => {
    expect(() => resolveAdaptiveConfig({
      requestBudget: { warnAtTokens: 1_000, blockAtTokens: 900 },
    })).toThrow(/blockAtTokens.*at least warnAtTokens/i)
    expect(() => resolveAdaptiveConfig({
      requestBudget: { warnAtRatio: 0.8, blockAtRatio: 0.7 },
    })).toThrow(/blockAtRatio.*at least warnAtRatio/i)
  })
})
