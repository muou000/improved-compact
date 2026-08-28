import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'

/** Character budgets for deterministic, signal-aware tool-result pruning. */
export interface SemanticToolResultConfig {
  /** Prune when visible text exceeds this many Unicode code points. */
  thresholdChars?: number
  /** Maximum leading Unicode code points retained verbatim. */
  headChars?: number
  /** Maximum trailing Unicode code points retained verbatim. */
  tailChars?: number
  /** Maximum budget used by high-signal lines recovered from the removed middle. */
  signalChars?: number
  /** Tool names whose results must never be pruned by this policy. */
  protectedToolNames?: string[]
}

/** Budget for the deterministic exact-value appendix added to LLM summaries. */
export interface VerbatimAnchorConfig {
  /** Maximum appendix size in Unicode code points; `0` disables the appendix. */
  maxChars?: number
  /** Maximum number of exact high-signal lines; `0` disables the appendix. */
  maxAnchors?: number
}

/** Adaptive policy layered over DSH's replay-safe basic compaction backend. */
export interface AdaptiveCompactionConfig extends BasicCompactionConfig {
  /** Run the model-free pruning tier at this fraction of the context window. */
  softPruneRatio?: number
  /** Preserve this many latest direct human messages from automatic summary ranges. */
  protectedRecentUserMessages?: number
  /** Maximum fraction of the hard threshold the protected user tail may consume. */
  maxProtectedTailRatio?: number
  /** Reject an LLM checkpoint that omits or reorders the native required sections. */
  validateSummaryStructure?: boolean
  /** Character ceiling applied only when consolidating an existing checkpoint; `0` disables it. */
  repeatSummaryMaxChars?: number
  /** Deterministic tool-result pruning policy. */
  toolResult?: SemanticToolResultConfig
  /** Deterministic exact-value appendix policy. */
  verbatimAnchors?: VerbatimAnchorConfig
  /** Emit concise load and unload diagnostics. */
  logLifecycle?: boolean
}

/** Validated immutable tool-result pruning policy. */
export interface ResolvedSemanticToolResultConfig {
  readonly thresholdChars: number
  readonly headChars: number
  readonly tailChars: number
  readonly signalChars: number
  readonly protectedToolNames: readonly string[]
}

/** Validated immutable exact-value appendix policy. */
export interface ResolvedVerbatimAnchorConfig {
  readonly maxChars: number
  readonly maxAnchors: number
}

/** Validated adaptive-only policy fields; base fields are validated upstream. */
export interface ResolvedAdaptiveConfig {
  readonly softPruneRatio: number
  readonly protectedRecentUserMessages: number
  readonly maxProtectedTailRatio: number
  readonly validateSummaryStructure: boolean
  readonly repeatSummaryMaxChars: number
  readonly toolResult: ResolvedSemanticToolResultConfig
  readonly verbatimAnchors: ResolvedVerbatimAnchorConfig
  readonly logLifecycle: boolean
}
