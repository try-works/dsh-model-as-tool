/**
 * Adapter registry: the one place that maps a catalog model to the code that
 * can invoke it.
 *
 * Adding a model to the plugin means writing an adapter and registering it
 * here; the capability resolver decides whether it is offered in this process.
 *
 * @module @dsh-plugins/dsh-model-tools/adapters/index
 */

import type { ModelCatalogEntry } from '../types.ts'
import type { AdapterFactory, ModelAdapter } from './types.ts'
import { createTongueAdapter } from './tongue.ts'
import { createVozAdapter } from './voz.ts'

/**
 * Every adapter this plugin ships, in priority order.
 *
 * Each factory returns undefined for the entries it does not serve, so the
 * lookup is a linear scan rather than a switch, and a model with no adapter yet
 * simply has no tool.
 */
export const ADAPTER_FACTORIES: readonly AdapterFactory[] = [
  createTongueAdapter,
  createVozAdapter,
]

/**
 * Create the adapter for one entry.
 * @param entry - the catalog entry.
 * @param factories - adapter factories, defaulting to the shipped set.
 * @returns the adapter, or undefined when no factory serves this model yet.
 */
export function createAdapter(
  entry: ModelCatalogEntry,
  factories: readonly AdapterFactory[] = ADAPTER_FACTORIES,
): ModelAdapter | undefined {
  for (const factory of factories) {
    const adapter = factory(entry)
    if (adapter !== undefined) return adapter
  }
  return undefined
}

export type { AdapterFactory, AdapterInvocation, JsonValue, ModelAdapter } from './types.ts'
