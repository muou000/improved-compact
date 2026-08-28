import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'

/** Native checkpoint sections whose presence and order are part of the DSH contract. */
export const REQUIRED_SUMMARY_SECTIONS = [
  '## Primary Request and Intent',
  '## Key Technical Concepts',
  '## Files and Code',
  '## Errors and Fixes',
  '## Pending Jobs',
  '## Current Work',
  '## Next Step',
  '## Critical Context',
] as const

const VERBATIM_HEADER = '## Verbatim Anchors'
const LABEL_PATTERN = /^(Goal|Constraint|Fact|Decision|Pending|Error|Correction|Command|Path):\s*\S/i
const ASSIGNMENT_PATTERN = /\b([A-Za-z_][\w.-]{1,63})\s*=\s*([^\s,;]+)/
const COMMAND_PATTERN = /^(?:\$\s+|>\s+|pnpm\s|npm\s|npx\s|node\s|python\s|pytest\s|git\s|cargo\s|go\s+test\b)/i
const PATH_PATTERN = /(?:\b[A-Za-z]:\\[^\r\n]+|(?:^|\s)\/(?:[^/\s]+\/)+[^/\s]+)/
const SECRET_PATTERN = /\b(?:api[_-]?key|authorization|password|passwd|secret|access[_-]?token|private[_-]?key)\s*[:=]/i

interface SignalCandidate {
  readonly line: string
  readonly index: number
  readonly priority: number
  readonly assignmentKey?: string
}

/** Extract exact high-signal lines from replayed messages under deterministic budgets. */
export function extractVerbatimAnchors(
  messages: readonly Message[],
  budget: { readonly maxAnchors: number; readonly maxChars: number },
): string[] {
  return selectSignalLines(
    messages.flatMap(message => textFromBlocks(message.content)).join('\n'),
    budget,
  )
}

/** Extract exact high-signal lines from arbitrary text, including a tool-result middle. */
export function selectSignalLines(
  text: string,
  budget: { readonly maxAnchors: number; readonly maxChars: number },
): string[] {
  if (budget.maxAnchors === 0 || budget.maxChars === 0) return []
  const candidates: SignalCandidate[] = []
  const assignmentPositions = new Map<string, number>()
  const exactPositions = new Map<string, number>()

  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = normalizeLine(rawLine)
    if (line.length === 0 || SECRET_PATTERN.test(line) || !isSignalLine(line)) continue
    const assignment = ASSIGNMENT_PATTERN.exec(line)
    const assignmentKey = assignment?.[1]
    const candidate: SignalCandidate = {
      line,
      index,
      priority: signalPriority(line),
      ...(assignmentKey === undefined ? {} : { assignmentKey: assignmentKey.toLowerCase() }),
    }
    if (candidate.assignmentKey !== undefined) {
      const previous = assignmentPositions.get(candidate.assignmentKey)
      if (previous !== undefined) candidates[previous] = candidate
      else {
        assignmentPositions.set(candidate.assignmentKey, candidates.length)
        candidates.push(candidate)
      }
      continue
    }
    if (exactPositions.has(line)) continue
    exactPositions.set(line, candidates.length)
    candidates.push(candidate)
  }

  // Corrections, hard constraints, failures, goals, and pending work are
  // selected before general facts; final output returns to source order.
  const ranked = [...candidates].sort((left, right) => (
    right.priority - left.priority || right.index - left.index
  ))
  const selected: SignalCandidate[] = []
  let usedChars = 0
  for (const candidate of ranked) {
    if (selected.length >= budget.maxAnchors) break
    const cost = Array.from(candidate.line).length + 3
    if (usedChars + cost > budget.maxChars) continue
    selected.push(candidate)
    usedChars += cost
  }
  return selected.sort((left, right) => left.index - right.index).map(candidate => candidate.line)
}

/** Validate the model checkpoint and add a bounded deterministic exact-value appendix. */
export function validateAndAugmentSummary(
  summary: readonly ContentBlock[],
  messages: readonly Message[],
  config: {
    readonly validateStructure: boolean
    readonly maxAnchors: number
    readonly maxChars: number
    readonly appendExistingAnchors?: boolean
  },
): ContentBlock[] {
  const text = textFromBlocks(summary)
  if (text.trim().length === 0) throw new Error('improved-compact summary is empty')
  if (config.validateStructure) validateSummaryStructure(text)
  if (config.maxAnchors === 0 || config.maxChars === 0) return [...summary]

  const base = stripExistingVerbatimAppendix(text).trimEnd()
  const headerCost = Array.from(`\n\n${VERBATIM_HEADER}\n`).length
  if (config.maxChars <= headerCost) return [...summary]
  const anchors = extractVerbatimAnchors(messages, {
    maxAnchors: config.maxAnchors,
    maxChars: config.maxChars - headerCost,
  }).filter(line => config.appendExistingAnchors === true || !base.includes(line))
  if (anchors.length === 0) return [...summary]
  const appendix = `${VERBATIM_HEADER}\n${anchors.map(line => `- ${line}`).join('\n')}`
  return [{ type: 'text', text: `${base}\n\n${appendix}` }]
}

/**
 * Bound a repeated checkpoint without dropping required sections or cutting a
 * technical line mid-value. Exact appendix lines win the deterministic budget.
 */
export function boundStructuredSummary(
  summary: readonly ContentBlock[],
  maxChars: number,
): ContentBlock[] {
  const text = textFromBlocks(summary)
  if (Array.from(text).length <= maxChars) return [...summary]
  const groups = parseSummaryGroups(text)
  const selected = groups.map(() => new Set<number>())
  const candidates: Array<{ group: number; line: number; priority: number; order: number }> = []
  const appendixIndex = groups.length - 1
  let order = 0
  for (const [groupIndex, lines] of groups.entries()) {
    for (const lineIndex of lines.keys()) {
      const first = lineIndex === 0
      const priority = groupIndex === appendixIndex
        ? 100
        : first
          ? sectionPriority(groupIndex)
          : 20
      candidates.push({ group: groupIndex, line: lineIndex, priority, order })
      order += 1
    }
  }
  candidates.sort((left, right) => right.priority - left.priority || left.order - right.order)

  let rendered = renderSummaryGroups(groups, selected)
  if (Array.from(rendered).length > maxChars) {
    throw new Error(`improved-compact repeatSummaryMaxChars (${maxChars}) is too small for required sections`)
  }
  const selectedText = new Set<string>()
  for (const candidate of candidates) {
    const line = groups[candidate.group]?.[candidate.line]
    if (line === undefined || selectedText.has(line)) continue
    selected[candidate.group]?.add(candidate.line)
    const next = renderSummaryGroups(groups, selected)
    if (Array.from(next).length <= maxChars) {
      rendered = next
      selectedText.add(line)
    } else {
      selected[candidate.group]?.delete(candidate.line)
    }
  }
  validateSummaryStructure(rendered)
  return [{ type: 'text', text: rendered }]
}

/** Flatten text and nested tool-result blocks without inventing content. */
export function textFromBlocks(blocks: readonly ContentBlock[]): string {
  const lines: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') lines.push(block.text)
    else if (block.type === 'tool-result') lines.push(textFromBlocks(block.content))
  }
  return lines.filter(Boolean).join('\n')
}

function validateSummaryStructure(text: string): void {
  let previous = -1
  for (const section of REQUIRED_SUMMARY_SECTIONS) {
    const first = text.indexOf(section)
    if (first === -1) throw new Error(`improved-compact summary missing required section "${section}"`)
    if (first <= previous) throw new Error(`improved-compact summary section "${section}" is out of order`)
    if (text.indexOf(section, first + section.length) !== -1) {
      throw new Error(`improved-compact summary repeats required section "${section}"`)
    }
    previous = first
  }
}

function stripExistingVerbatimAppendix(text: string): string {
  const index = text.indexOf(VERBATIM_HEADER)
  return index === -1 ? text : text.slice(0, index)
}

function parseSummaryGroups(text: string): string[][] {
  const appendixIndex = text.indexOf(VERBATIM_HEADER)
  const groups = REQUIRED_SUMMARY_SECTIONS.map((section, index) => {
    const start = text.indexOf(section) + section.length
    const nextRequired = REQUIRED_SUMMARY_SECTIONS[index + 1]
    const requiredEnd = nextRequired === undefined ? text.length : text.indexOf(nextRequired)
    const end = appendixIndex > start && appendixIndex < requiredEnd ? appendixIndex : requiredEnd
    return contentLines(text.slice(start, end))
  })
  groups.push(appendixIndex === -1
    ? []
    : contentLines(text.slice(appendixIndex + VERBATIM_HEADER.length)))
  return groups
}

function contentLines(text: string): string[] {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const normalized = raw.trim().replace(/^[-*]\s+/, '').trim()
    if (normalized.length === 0 || normalized === '(none)' || seen.has(normalized)) continue
    seen.add(normalized)
    lines.push(normalized)
  }
  return lines
}

function renderSummaryGroups(groups: readonly string[][], selected: readonly Set<number>[]): string {
  const parts: string[] = []
  for (const [index, section] of REQUIRED_SUMMARY_SECTIONS.entries()) {
    const lines = [...(selected[index] ?? [])].sort((left, right) => left - right)
      .flatMap(lineIndex => groups[index]?.[lineIndex] ?? [])
    parts.push(section, lines.length === 0 ? '- (none)' : lines.map(line => `- ${line}`).join('\n'))
  }
  const appendixIndex = REQUIRED_SUMMARY_SECTIONS.length
  const anchors = [...(selected[appendixIndex] ?? [])].sort((left, right) => left - right)
    .flatMap(lineIndex => groups[appendixIndex]?.[lineIndex] ?? [])
  if (anchors.length > 0) {
    parts.push(VERBATIM_HEADER, anchors.map(line => `- ${line}`).join('\n'))
  }
  return parts.join('\n\n')
}

function sectionPriority(index: number): number {
  // Primary request, files, failures, pending/current/next, and critical
  // context each receive at least one line before background concepts expand.
  return [90, 60, 80, 80, 90, 90, 90, 90][index] ?? 50
}

function normalizeLine(rawLine: string): string {
  return rawLine.trim().replace(/^(?:[-*]|\d+\.)\s+/, '').trim()
}

function isSignalLine(line: string): boolean {
  return LABEL_PATTERN.test(line)
    || ASSIGNMENT_PATTERN.test(line)
    || COMMAND_PATTERN.test(line)
    || PATH_PATTERN.test(line)
}

function signalPriority(line: string): number {
  if (/^Correction:/i.test(line)) return 7
  if (/^(?:Constraint|Error):/i.test(line)) return 6
  if (/^(?:Goal|Pending):/i.test(line)) return 5
  if (/^Decision:/i.test(line)) return 4
  if (/^(?:Fact|Command|Path):/i.test(line)) return 3
  return 2
}
