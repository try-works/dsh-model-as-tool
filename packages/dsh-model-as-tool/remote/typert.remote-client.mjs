/**
 * Client face of the `modelTools` Remote namespace (`./remote` export).
 *
 * A standard DSH Client assembly imports this module and mounts it through
 * `ctx.remote.$mount(...)`; this plugin's own browser half mounts the same
 * contribution from its package-local lazy-CJS chunk
 * (`client/client.model-tools.js`), because the client module system serves
 * only `./client` for an installed plugin.
 */

import { buildContribution } from './spec.mjs'

/** Mountable contribution exposing `describe`, `installExtension`, `enable`, `disable`. */
export const TYPERT_REMOTE = buildContribution()

export default TYPERT_REMOTE
