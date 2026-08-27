/**
 * Configurable lifecycle scaffold for the dsh-compact plugin.
 * @module dsh-compact
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

/** Stable Cordis plugin name. */
export const name = 'dsh-compact'

/** User-configurable plugin options. */
export interface Config {
  /** Emit diagnostic messages when the plugin loads and unloads. */
  logLifecycle?: boolean
}

/** Runtime validation and defaults for {@link Config}. */
export const Config: Schema<Config> = Schema.object({
  logLifecycle: Schema.boolean().default(false),
})

/**
 * Mount the plugin into a Cordis context.
 *
 * @param ctx - The lifecycle-scoped Cordis context.
 * @param config - Validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.logLifecycle) return

  ctx.effect(() => {
    console.info('[dsh-compact] loaded')
    return () => console.info('[dsh-compact] unloaded')
  })
}
