import type { Context } from '@deepseek-ai/cordis'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { CallId, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-token-meter'
import { selectSignalLines } from './signals.ts'
import type { ResolvedSemanticToolResultConfig } from './types.ts'

const OPEN_MARKER = '\n\n<improved-compact-pruned>\n'
const SIGNAL_LABEL = 'Preserved high-signal lines:\n'
const CLOSE_MARKER = '</improved-compact-pruned>\n\n'

/** One durable tool-result replacement produced by the semantic pruning tier. */
export interface SemanticPrunedEntry {
  readonly originalSeq: number
  readonly replacementSeq: number
  readonly callId: CallId
  readonly toolName: string | undefined
  readonly charsBefore: number
  readonly charsAfter: number
}

/** Aggregate result of one stable-surface semantic pruning pass. */
export interface SemanticPruneResult {
  readonly pruned: readonly SemanticPrunedEntry[]
  readonly charsRemoved: number
}

/** Measure visible text in Unicode code points. */
export function measureToolResultContent(blocks: readonly ContentBlock[]): number {
  let chars = 0
  for (const block of blocks) {
    if (block.type === 'text') chars += Array.from(block.text).length
  }
  return chars
}

/** Replace an oversized text middle while recovering bounded signal lines from it. */
export function pruneToolResultContent(
  blocks: readonly ContentBlock[],
  config: ResolvedSemanticToolResultConfig,
): ContentBlock[] | null {
  const totalChars = measureToolResultContent(blocks)
  if (totalChars <= config.thresholdChars) return null

  const markerBudget = config.thresholdChars - config.headChars - config.tailChars
  const allText = blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  const points = Array.from(allText)
  const retainedHead = points.slice(0, config.headChars).join('')
  const retainedTail = points.slice(Math.max(0, points.length - config.tailChars)).join('')
  const wrapperCost = Array.from(OPEN_MARKER + SIGNAL_LABEL + CLOSE_MARKER).length
  const signalBudget = Math.max(0, Math.min(config.signalChars, markerBudget - wrapperCost))
  const signals = selectSignalLines(allText, {
    maxAnchors: Number.MAX_SAFE_INTEGER,
    maxChars: signalBudget,
  }).filter(line => !retainedHead.includes(line) && !retainedTail.includes(line))
  let marker = signals.length === 0
    ? '\n…\n'
    : `${OPEN_MARKER}${SIGNAL_LABEL}${signals.map(line => `- ${line}`).join('\n')}\n${CLOSE_MARKER}`
  while (Array.from(marker).length > markerBudget && signals.length > 0) {
    signals.pop()
    marker = signals.length === 0
      ? '\n…\n'
      : `${OPEN_MARKER}${SIGNAL_LABEL}${signals.map(line => `- ${line}`).join('\n')}\n${CLOSE_MARKER}`
  }
  if (Array.from(marker).length > markerBudget) {
    marker = Array.from(marker).slice(0, markerBudget).join('')
  }

  const removedStart = config.headChars
  const removedEnd = totalChars - config.tailChars
  const pruned: ContentBlock[] = []
  let consumed = 0
  let markerInserted = false
  for (const block of blocks) {
    if (block.type !== 'text') {
      pruned.push(block)
      continue
    }
    const points = Array.from(block.text)
    const blockStart = consumed
    const blockEnd = blockStart + points.length
    const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart))
    const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart))
    const intersectsRemoved = blockStart < removedEnd && blockEnd > removedStart
    const insertion = intersectsRemoved && !markerInserted ? marker : ''
    if (insertion.length > 0) markerInserted = true
    const text = points.slice(0, headEnd).join('') + insertion + points.slice(tailStart).join('')
    if (text.length > 0) pruned.push({ ...block, text })
    consumed = blockEnd
  }
  if (!markerInserted) throw new Error('improved-compact prune could not locate the removed text span')
  const after = measureToolResultContent(pruned)
  if (after > config.thresholdChars || after >= totalChars) {
    throw new Error('improved-compact prune replacement must be smaller and inside thresholdChars')
  }
  return pruned
}

interface SnapshotCandidate {
  readonly seq: number
  readonly event: SessionEvent<'tool/result'>
}

/** Replay-safe session mutator using the native compaction shadow-price protocol. */
export class SemanticToolResultPruner {
  constructor(
    private readonly ctx: Context,
    readonly config: ResolvedSemanticToolResultConfig,
  ) {}

  pruneSession(session: Session): SemanticPruneResult {
    const toolNames = toolNamesByCallId(session)
    const protectedNames = new Set(this.config.protectedToolNames)
    const candidates: SnapshotCandidate[] = []
    for (const seq of [...session.surface.nodes]) {
      const event = session.events[seq]
      if (event?.type === 'tool/result') candidates.push({ seq, event })
    }

    const pruned: SemanticPrunedEntry[] = []
    let charsRemoved = 0
    for (const { seq, event } of candidates) {
      const callId = event.data.message.source.callId
      const toolName = toolNames.get(callId)
      if (toolName !== undefined && protectedNames.has(toolName)) continue
      const result = event.data.message.content[0]
      if (result.type !== 'tool-result') {
        throw new Error(`improved-compact prune: tool/result event ${seq} has malformed message content`)
      }
      const content = pruneToolResultContent(result.content, this.config)
      if (content === null) continue
      const charsBefore = measureToolResultContent(result.content)
      const charsAfter = measureToolResultContent(content)
      const message = freezeMessage<ToolResultMessage>({
        ...event.data.message,
        content: [{ ...result, content }],
      })
      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(event.data.message),
      })
      const replacement = session.append('tool/result', {
        ...event.data,
        message,
      }, {
        surfaceOp: { op: 'replace', start: seq, end: seq },
        sourceEventSeqs: [seq],
      })
      pruned.push({
        originalSeq: seq,
        replacementSeq: replacement.seq,
        callId,
        toolName,
        charsBefore,
        charsAfter,
      })
      charsRemoved += charsBefore - charsAfter
    }
    return { pruned, charsRemoved }
  }
}

function toolNamesByCallId(session: Session): Map<CallId, string> {
  const names = new Map<CallId, string>()
  for (const event of session.events) {
    if (event.type === 'tool/call') names.set(event.data.callId, event.data.name)
  }
  return names
}
