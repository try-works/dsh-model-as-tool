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
import type { ProviderBridge } from '../provider-bridge.ts'
import {
  createCliTransport,
  createRemoteTransport,
  type CommandTransport,
  type TransportOptions,
} from '../transport.ts'

/**
 * Hand-written adapters living inside the host.
 *
 * EMPTY, and it must stay that way (BASE-09). Every model-specific implementation
 * is now an independently versioned extension package reached through the public
 * extension API: Tongue is `@try-works/extension-desert-ant-tongue` and Voz is
 * `@try-works/extension-desert-ant-voz`. The host holds no adapter for any model,
 * so a first-party package has no privilege a published one lacks.
 *
 * The parameter is kept rather than deleted because a test may still inject
 * factories, and an empty list DOCUMENTED as needing to stay empty is a stronger
 * statement than a removed hook.
 */
export const ADAPTER_FACTORIES: readonly AdapterFactory[] = []

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
 *
 * The lookup is ASYNC because an extension-backed model is reached by importing
 * and activating its package, which cannot happen in a synchronous call. The
 * order is deliberate: a declared extension binding wins, then a hand-written
 * factory, then a transport.
 * @param entry - the catalog entry.
 * @param options - the resolved route plus transport settings.
 * @param factories - hand-written adapter factories, defaulting to the shipped set.
 * @param bridge - the extension provider bridge, when extensions are available.
 * @returns the adapter, or undefined when no extension, factory or transport serves this model.
 */
export function createAdapter(
  entry: ModelCatalogEntry,
  options: TransportSelection = { route: 'npm-native' },
  factories: readonly AdapterFactory[] = ADAPTER_FACTORIES,
  bridge?: ProviderBridge,
): ModelAdapter | undefined {
  // A declared extension binding is the model's own statement of who implements
  // it, so it is consulted before any host-side knowledge.
  if (bridge !== undefined && entry.provider !== undefined) {
    return bridge.adapterFor(entry)
  }

  for (const factory of factories) {
    const adapter = factory(entry)
    if (adapter !== undefined) return adapter
  }

  // No extension and no factory: the model is reachable only through a transport.
  if (options.route === 'cli') return transportAdapter(entry, createCliTransport(entry, options))
  if (options.route === 'remote') {
    return transportAdapter(entry, createRemoteTransport(entry, options))
  }
  // No extension, no factory and no transport serves this model. Returning
  // undefined is correct: a model with no implementation simply has no tool,
  // rather than falling back to something that cannot run it.
  return undefined
}

export type { AdapterFactory, AdapterInvocation, JsonValue, ModelAdapter } from './types.ts'
export type { CommandTransport, TransportOptions } from '../transport.ts'
