/**
 * Loading an extension through its public entry (EXT-17, EXT-19).
 *
 * The host reaches an extension ONLY through `./tool-mode` and the interfaces in
 * `runtime.ts`. It never imports a file inside the package, never reaches into an
 * adapter registry the host owns, and never special-cases a model name. That is
 * what makes BASE-09's "no private built-in adapter path" true rather than
 * aspirational: a first-party package and a third-party package are loaded by the
 * same function, so there is no second route that only first-party code can take.
 *
 * Loading is split from activation deliberately. `loadExtensionModule` validates
 * the SHAPE of the export; `activateExtension` calls `create()`. EXT-19 requires
 * `create()` to be lightweight, and keeping the two calls separate is what lets a
 * host reject a malformed package without ever running its code.
 *
 * @module @try-works/tool-mode-extension-sdk/load
 */

import { pathToFileURL } from 'node:url'
import { ManagementError } from './errors.ts'
import {
  EXTENSION_API_VERSION,
  type ExtensionContextV1,
  type ExtensionInstanceV1,
  type ToolModeExtensionV1,
} from './runtime.ts'
import type { ExtensionDiscovery } from './discovery.ts'

/** The public entry subpath every module extension declares. */
export const EXTENSION_ENTRY = './tool-mode'

/**
 * Resolve the absolute path of an installed extension's public entry.
 *
 * The path comes from the package's own `exports` map rather than from a
 * convention, so the host reads the same declaration a Node resolver would and a
 * package that points its entry elsewhere keeps working.
 * @param discovery - the package discovery result.
 * @returns the absolute entry path.
 * @throws ManagementError when the package declares no importable `./tool-mode` entry.
 */
export function resolveExtensionEntry(discovery: ExtensionDiscovery): string {
  if (discovery.entryPath === undefined) {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'activate',
      `the package declares no importable ${EXTENSION_ENTRY} export, so it has no module entry`,
      `Declare "${EXTENSION_ENTRY}": "./<file>.js" in package.json exports; the host does not guess entry points.`,
    )
  }
  return discovery.entryPath
}

/**
 * Import an extension's public entry and validate its shape.
 *
 * Importing runs the package's module top level, which is why EXT-19 constrains it
 * to be lightweight, and why the shape is checked BEFORE `create()` is called.
 * @param entryPath - absolute path of the module to import.
 * @returns the validated extension.
 * @throws ManagementError when the import fails or the export is malformed.
 */
export async function loadExtensionModule(entryPath: string): Promise<ToolModeExtensionV1> {
  let module: Record<string, unknown>
  try {
    module = await import(pathToFileURL(entryPath).href) as Record<string, unknown>
  } catch (error) {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'activate',
      `the extension entry could not be imported: ${error instanceof Error ? error.message : String(error)}`,
      'Confirm the entry is a valid ES module and that its dependencies are installed.',
    )
  }

  const candidate = (module.default ?? module.extension) as Partial<ToolModeExtensionV1> | undefined
  if (candidate === undefined || typeof candidate !== 'object') {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'activate',
      'the extension entry default-exports nothing usable',
      `Default-export an object with apiVersion ${EXTENSION_API_VERSION} and create(context).`,
    )
  }
  if (candidate.apiVersion !== EXTENSION_API_VERSION) {
    throw new ManagementError(
      'INCOMPATIBLE_PROTOCOL',
      'activate',
      `the extension declares apiVersion ${String(candidate.apiVersion)}, but this host implements ${EXTENSION_API_VERSION}`,
      'Install a build of the extension for this API major, or upgrade the host.',
    )
  }
  if (typeof candidate.create !== 'function') {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'activate',
      'the extension entry default-exports no create(context) function',
      'Implement create() on the default export.',
    )
  }
  return candidate as ToolModeExtensionV1
}

/**
 * Activate a loaded extension.
 *
 * @param extension - the validated extension.
 * @param context - the host-issued context.
 * @returns the activated instance.
 * @throws ManagementError when `create()` fails or returns no usable instance.
 */
export async function activateExtension(
  extension: ToolModeExtensionV1,
  context: ExtensionContextV1,
): Promise<ExtensionInstanceV1> {
  let instance: ExtensionInstanceV1
  try {
    instance = await extension.create(context)
  } catch (error) {
    throw new ManagementError(
      'EXTENSION_FAULT',
      'activate',
      `the extension failed to activate: ${error instanceof Error ? error.message : String(error)}`,
      'Check the extension diagnostics; the package was not published.',
    )
  }
  if (instance === null || typeof instance !== 'object' || typeof instance.createProvider !== 'function') {
    throw new ManagementError(
      'INVALID_EXTENSION',
      'activate',
      'the extension returned no createProvider(modelId, configuration)',
      'Return an instance implementing the ExtensionInstanceV1 contract.',
    )
  }
  if (typeof instance.dispose !== 'function') {
    // A missing dispose is worse than a missing feature: the host would have no
    // way to release the instance, so deactivation could never fully stop.
    throw new ManagementError(
      'INVALID_EXTENSION',
      'activate',
      'the extension instance implements no dispose(reason)',
      'Implement dispose() so the host can release the instance on deactivation.',
    )
  }
  return instance
}
