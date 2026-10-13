/**
 * Adapter registry: the one place that maps a catalog model to the code that
 * can invoke it.
 *
 * Two kinds of adapter exist. A **model adapter** is written by hand for a model
 * with a real in-process SDK (Tongue, Voz). A **transport adapter** is generic:
 * it drives any model through the Desert Ant CLI or a user-hosted bridge, using
 * only the catalog's verb and parameter declarations.
 *
 * @module @try-works/dsh-model-as-tool/adapters/index
 */

import type { ModelCatalogEntry } from '../types.ts'
import type { AdapterFactory, ModelAdapter } from './types.ts'
import { createTongueAdapter } from './tongue.ts'
import { createVozAdapter } from './voz.ts'
import {
  createCliTransport,
  createRemoteTransport,
  type CommandTransport,
  type TransportOptions,
} from '../transport.ts'

/**
 * Every hand-written adapter this plugin ships, in priority order.
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
 * Options that decide which transports a model may use.
 *
 * `routes` is normally the capability resolver's verdict, which is what keeps
 * the adapter and the reported reason from disagreeing: a model is only offered
 * through a transport the resolver already proved usable.
 */
export interface TransportSelection extends TransportOptions {
  /** The resolved route for this model. */
  readonly route: string
}

/**
 * Wrap a command transport as a model adapter.
 *
 * The transport already returns the canonical object, so this is a pure
 * adaptation of shape rather than a second place that knows how to parse a
 * result.
 * @param entry - the catalog entry.
 * @param transport - the CLI or remote transport.
 * @returns the adapter.
 */
function transportAdapter(entry: ModelCatalogEntry, transport: CommandTransport): ModelAdapter {
  return {
    modelId: entry.id,
    invoke: ({ args, signal }) => transport.invoke({ entry, args, signal }),
  }
}

/**
 * Create the adapter for one entry.
 *
 * A hand-written adapter always wins for the model it serves: an in-process
 * call is faster and needs no external service. Everything else falls to the
 * transport the capability resolver selected.
 * @param entry - the catalog entry.
 * @param options - the resolved route plus transport settings.
 * @param factories - hand-written adapter factories, defaulting to the shipped set.
 * @returns the adapter, or undefined when no factory or transport serves this model.
 */
export function createAdapter(
  entry: ModelCatalogEntry,
  options: TransportSelection = { route: 'npm-native' },
  factories: readonly AdapterFactory[] = ADAPTER_FACTORIES,
): ModelAdapter | undefined {
  for (const factory of factories) {
    const adapter = factory(entry)
    if (adapter !== undefined) return adapter
  }

  // No hand-written adapter: the model is reachable only through a transport.
  if (options.route === 'cli') return transportAdapter(entry, createCliTransport(entry, options))
  if (options.route === 'remote') {
    return transportAdapter(entry, createRemoteTransport(entry, options))
  }
  return undefined
}

export type { AdapterFactory, AdapterInvocation, JsonValue, ModelAdapter } from './types.ts'
export type { CommandTransport, TransportOptions } from '../transport.ts'
