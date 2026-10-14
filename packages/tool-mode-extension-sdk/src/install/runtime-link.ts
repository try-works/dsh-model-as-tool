/**
 * Make the runtime SDK resolvable from inside an installed extension (EXT-02, EXT-19).
 *
 * THE GAP THIS CLOSES. Installing a package puts it at
 * `<store>/extensions/<id>/<version>/`, which has no `node_modules`. An extension that
 * declares `@try-works/tool-mode-extension-sdk` — which is what the extension protocol
 * requires it to depend on — therefore cannot import it, and its entry fails with
 * `ERR_MODULE_NOT_FOUND`. The package is discoverable and activatable and cannot RUN.
 *
 * This is the same class of problem the host hit when its own dependency was unpublished:
 * a package is only loadable where its dependencies resolve. The store has no install step,
 * so the link has to be made deliberately.
 *
 * WHY A DIRECTORY LINK RATHER THAN A COPY. The SDK is HOST-PROVIDED and versioned with the
 * host, so copying it into every install would ship N copies that drift independently — and
 * an extension running against a stale copy of the runtime is worse than one that refuses
 * to start. The link keeps a single implementation.
 *
 * A JUNCTION ON WINDOWS: `symlinkSync` with a `'dir'` type needs elevation, while a
 * junction does not, and junctions are the realistic Windows case in this repository's
 * other escape tests for the same reason.
 *
 * @module @try-works/tool-mode-extension-sdk/install/runtime-link
 */

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** The one runtime dependency an extension is allowed to have (EXT-02). */
export const RUNTIME_SDK_NAME = '@try-works/tool-mode-extension-sdk'

/**
 * Locate this package's own root.
 *
 * Resolved from the SDK itself rather than from the caller, so the link points at the
 * runtime the INSTALLER is running from — the one that will actually execute the extension.
 * @returns the absolute package root, or undefined when it cannot be found.
 */
export function runtimeSdkRoot(): string | undefined {
  try {
    const require = createRequire(import.meta.url)
    // `package.json` rather than the entry, because the ROOT is what must be linked and the
    // entry may be remapped by an exports condition.
    return dirname(require.resolve(`${RUNTIME_SDK_NAME}/package.json`))
  } catch {
    return undefined
  }
}

/** What linking did. */
export interface RuntimeLinkOutcome {
  readonly linked: boolean
  /** Why it did not link, when it did not. */
  readonly reason?: 'already-present' | 'sdk-not-locatable' | 'link-failed' | 'sdk-shadowed'
  /** The path the link was made at. */
  readonly path?: string
  /** A failure detail worth reporting rather than swallowing. */
  readonly detail?: string
}

/**
 * Make the runtime SDK resolvable from an installed extension.
 *
 * @param installPath - the installed package directory.
 * @param sdkRoot - where the runtime lives; resolved automatically when omitted.
 * @returns what happened, which is reported rather than assumed.
 */
export function linkRuntimeSdk(installPath: string, sdkRoot = runtimeSdkRoot()): RuntimeLinkOutcome {
  if (sdkRoot === undefined) {
    /**
     * NOT FATAL. An extension that imports nothing (a declarative or tool-only package)
     * runs fine without the link, so refusing the whole install would break working
     * packages to fix a problem they do not have.
     */
    return { linked: false, reason: 'sdk-not-locatable' }
  }

  const scopeDirectory = join(installPath, 'node_modules', '@try-works')
  const linkPath = join(scopeDirectory, 'tool-mode-extension-sdk')

  /**
   * A PRE-EXISTING ENTRY IS NOT ASSUMED TO BE OURS.
   *
   * This was a real, reproduced escape. The first version returned `already-present` if
   * ANYTHING existed at the link path — and an archive may legitimately SHIP that
   * directory, because nothing about it is a traversal or an illegal name. The installer
   * then never made the host link, and Node resolved the extension's bare
   * `import '@try-works/tool-mode-extension-sdk'` to the PACKAGE-SUPPLIED module. The
   * package was executing against its own copy of the runtime, and the operator was told
   * the link was "already-present", which reads as success.
   *
   * The check is now on the CONTENT, not the existence: the entry must be the same package
   * at the same version as the runtime the installer is running from. Anything else is
   * refused, and refusal is the right answer rather than replacement — silently deleting
   * files an archive shipped would make the installed bytes differ from the verified
   * digest the operator approved.
   */
  if (existsSync(linkPath)) {
    const shipped = readPackageIdentity(linkPath)
    const ours = readPackageIdentity(sdkRoot)
    if (shipped === undefined || ours === undefined || shipped.name !== ours.name || shipped.version !== ours.version) {
      return {
        linked: false,
        reason: 'sdk-shadowed',
        path: linkPath,
        detail: `the package ships its own ${RUNTIME_SDK_NAME}`
          + `${shipped === undefined ? ' (unreadable)' : `@${shipped.version}`}, `
          + `but the host provides ${ours === undefined ? 'an unreadable runtime' : `@${ours.version}`}. `
          + 'An extension must run against the host runtime, so this install is refused.',
      }
    }
    return { linked: false, reason: 'already-present', path: linkPath, detail: `the host runtime @${ours.version} is already linked` }
  }

  try {
    mkdirSync(scopeDirectory, { recursive: true })
    /**
     * A junction, which on Windows does not require elevation. `type` is ignored on POSIX,
     * where this becomes a plain directory symlink.
     */
    symlinkSync(sdkRoot, linkPath, 'junction')
    return { linked: true, path: linkPath }
  } catch (error) {
    // Clean up a half-made link so a retry is not blocked by a broken entry.
    rmSync(linkPath, { recursive: true, force: true })
    return {
      linked: false,
      reason: 'link-failed',
      path: linkPath,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Read a package's name and version, or undefined when it cannot be read. */
function readPackageIdentity(packageRoot: string): { readonly name: string; readonly version: string } | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      name?: unknown
      version?: unknown
    }
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') return undefined
    return { name: manifest.name, version: manifest.version }
  } catch {
    // An unreadable or absent manifest is NOT an identity match. A planted directory with
    // a broken manifest must not be treated as the host runtime.
    return undefined
  }
}

/**
 * Remove a runtime link, for an uninstall (EXT-24).
 *
 * Removed separately from the package directory so a caller that removes the link but keeps
 * the package — or the reverse — does not end up with an extension whose imports resolve
 * against a runtime it was not installed for.
 * @param installPath - the installed package directory.
 * @returns whether a link was removed.
 */
export function unlinkRuntimeSdk(installPath: string): boolean {
  const linkPath = join(installPath, 'node_modules', '@try-works', 'tool-mode-extension-sdk')
  if (!existsSync(linkPath)) return false
  rmSync(linkPath, { recursive: true, force: true })
  return true
}
