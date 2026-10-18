/**
 * Host Loader face of the `modelTools` Remote namespace (`./typert` export).
 *
 * `@deepseek-ai/dsh-typert-loader` imports this module for the `model-tools`
 * Loader entry, validates the manifest, and registers `TYPERT.invocations` in
 * the Host Typert registry, where the Gateway dispatches them. The descriptors
 * come from `./spec.mjs`, the same source the Client artifact and the browser
 * chunk are built from.
 */

import { buildHostManifest } from './spec.mjs'

/** Host contribution registered by the Typert loader. */
export const TYPERT = buildHostManifest()
