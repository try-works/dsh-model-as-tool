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
import { createVozAdapter } from './voz.ts'
import type { ProviderBridge } from '../provider-bridge.ts'
import {
  createCliTransport,
  createRemoteTransport,
  type CommandTransport,
  type TransportOptions,
} from '../transport.ts'

/**
 * Hand-written adapters still living inside the host.
 *
 * EMPTY, and it must stay that way: BASE-09 requires every model-specific
 * implementation to be an independently versioned extension package with no
 * private built-in path. Tongue was extracted to
 * `@try-works/extension-desert-ant-tongue` and is now reached through the public
 * extension API like any third-party package.
 *
 * Voz is the remaining deviation and is held in `voz.ts` rather than listed here,
 * so its removal is a single deletion rather than an edit to a list that looks
 * legitimate. The extension is `@try-works/extension-desert-ant-voz`.
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
  // The one remaining built-in path, pending extraction to
  // `@try-works/extension-desert-ant-voz`. It is confined to this single call so
  // its removal deletes code rather than a lookup.
  return createVozAdapter(entry)
}

export type { AdapterFactory, AdapterInvocation, JsonValue, ModelAdapter } from './types.ts'
export type { CommandTransport, TransportOptions } from '../transport.ts'
