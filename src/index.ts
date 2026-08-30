/** Adaptive, replay-safe context compaction provider for DeepSeek Harness. */
import type { Context } from '@deepseek-ai/cordis'
import { AdaptiveCompactionEngine } from './engine.ts'
import type { AdaptiveCompactionConfig } from './types.ts'

export { AdaptiveCompactionEngine } from './engine.ts'
export { resolveAdaptiveConfig } from './config.ts'
export {
  boundStructuredSummary,
  extractVerbatimAnchors,
  REQUIRED_SUMMARY_SECTIONS,
  validateAndAugmentSummary,
} from './signals.ts'
export {
  measureToolResultContent,
  pruneToolResultContent,
  SemanticToolResultPruner,
} from './pruner.ts'
export { evaluateRequestBudget, RequestBudgetPolicy } from './budget.ts'
export type { RequestBudgetLevel, RequestBudgetObservation } from './budget.ts'
export type {
  AdaptiveCompactionConfig,
  ResolvedAdaptiveConfig,
  ResolvedSemanticToolResultConfig,
  ResolvedRequestBudgetConfig,
  ResolvedVerbatimAnchorConfig,
  RequestBudgetConfig,
  SemanticToolResultConfig,
  VerbatimAnchorConfig,
} from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'improved-compact'

/** User-configurable plugin options. */
export type Config = AdaptiveCompactionConfig

/** Runtime schema composed from the native backend and adaptive fields. */
export const Config = AdaptiveCompactionEngine.Config

/** Required upstream services; Cordis defers loading until they are present. */
export const inject = AdaptiveCompactionEngine.inject

/**
 * Mount the plugin into a Cordis context.
 *
 * @param ctx - The lifecycle-scoped Cordis context.
 * @param config - Validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const engine = new AdaptiveCompactionEngine(ctx, config)
  if (!engine.adaptiveConfig.logLifecycle) return

  ctx.effect(() => {
    console.info('[improved-compact] loaded')
    return () => console.info('[improved-compact] unloaded')
  })
}
