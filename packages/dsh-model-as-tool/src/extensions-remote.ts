/**
 * Host-side registration of the `modelTools` Remote namespace.
 *
 * The Host Gateway resolves each generated invocation through the Cordis
 * service named by its descriptor (`modelTools`) and refuses a service without
 * a visible `typertRemote` binding. The generated Host artifact
 * (`remote/typert.host.mjs`, published as `./typert`) is registered
 * automatically by `@deepseek-ai/dsh-typert-loader` for this package's Loader
 * entry; this module supplies the other half: a bound, provided service object.
 *
 * Keeping both facts in one helper makes a half-wired composition fail loudly
 * at apply time instead of on the first Remote call.
 *
 * The browser half is `remote/spec.mjs` + `client/client.model-tools.js`; the
 * method-name split between the wire (`installExtension`) and the Host service
 * (`install`) is documented in `./extensions-api.ts`.
 *
 * @module @try-works/dsh-model-as-tool/extensions-remote
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelToolsRemote } from './extensions-api.ts'

/** Cordis service key the Host dispatch resolves through the descriptor. */
export const MODEL_TOOLS_SERVICE = 'modelTools'
/** Wire namespace the Client mounts as `ctx.remote.modelTools`. */
export const MODEL_TOOLS_NAMESPACE = 'modelTools'

/**
 * The binding shape the Gateway reads from a service object.
 * Mirrors the protocol's `TypertGatewayBinding` without importing the harness.
 */
export interface ModelToolsBinding {
  readonly service: object
  readonly serviceKey: string
  readonly namespace: string
}

/** The public methods the Host service must expose for dispatch to work. */
const REQUIRED_METHODS = ['describe', 'install', 'enable', 'disable'] as const

/**
 * Attach the Gateway's `typertRemote` binding to a prepared service object.
 * @param service - the implementation of {@link ModelToolsRemote}.
 * @returns the same service, now bindable to the `modelTools` namespace.
 * @throws TypeError when a required method is missing.
 */
export function bindModelToolsRemote<T extends ModelToolsRemote>(service: T): T {
  const missing = REQUIRED_METHODS.filter(method => service[method] === undefined)
  if (missing.length > 0) {
    throw new TypeError(
      `model-tools: the Remote service is missing ${missing.map(method => JSON.stringify(method)).join(', ')}; `
      + 'the modelTools namespace cannot be dispatched',
    )
  }
  if (Object.hasOwn(service, 'typertRemote')) return service
  Object.defineProperty(service, 'typertRemote', {
    value: Object.freeze({
      service,
      serviceKey: MODEL_TOOLS_SERVICE,
      namespace: MODEL_TOOLS_NAMESPACE,
    } satisfies ModelToolsBinding),
    enumerable: false,
    configurable: false,
    writable: false,
  })
  return service
}

/**
 * Provide the bound extension service as the `modelTools` Cordis service.
 *
 * The Host artifact registers strict descriptors for:
 * `describe`, `installExtension` (dispatching to the service's `install`),
 * `enable`, and `disable`.
 *
 * @param ctx - the plugin's Cordis context that should own the service.
 * @param service - the prepared {@link ModelToolsRemote} implementation.
 * @throws TypeError when the service cannot satisfy the wire contract.
 */
export function provideModelToolsService(ctx: Context, service: ModelToolsRemote): void {
  ctx.provide(MODEL_TOOLS_SERVICE, bindModelToolsRemote(service))
}
