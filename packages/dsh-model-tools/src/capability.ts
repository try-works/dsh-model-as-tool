/**
 * Capability resolution: decide whether a catalog model can actually run in
 * this DSH process, and by which route.
 *
 * The rule this module enforces is that a model becomes a tool only when an
 * adapter can really invoke it. Every other model stays catalogued and
 * reportable, so `model_tools` can explain what is missing instead of the agent
 * discovering a broken tool at call time.
 *
 * @module @dsh-plugins/dsh-model-tools/capability
 */

import { createRequire } from 'node:module'
import type { CapabilityVerdict, ModelCatalogEntry } from './types.ts'

/**
 * Node resolution context for this plugin.
 *
 * The plugin must resolve model packages from the DSH installation that is
 * hosting it, not from its own nested `node_modules`, so that an operator who
 * installs `@desert-ant-labs/tongue` into the profile gets a working tool.
 */
const requireFromHere = createRequire(import.meta.url)

/**
 * Whether a package specifier resolves from this plugin's installation.
 *
 * Resolution deliberately does not load the module: importing a model package
 * pulls in a WASM or native runtime, and capability probing must stay cheap
 * enough to run at plugin load.
 * @param specifier - package name, optionally with a subpath.
 * @returns whether Node can resolve the specifier.
 */
export function canResolve(specifier: string): boolean {
  try {
    requireFromHere.resolve(specifier)
    return true
  } catch {
    return false
  }
}

/** Join a package and its documented subpath into one specifier. */
export function packageSpecifier(pkg: string, subpath: string | null): string {
  return subpath === null ? pkg : `${pkg}${subpath}`
}

/** Reason text for a model that has no runnable route on any platform. */
function unavailableReason(entry: ModelCatalogEntry): string {
  if (entry.closedBeta) {
    return `${entry.name} is in closed beta: the weights are published at ${entry.hfRepo} but no SDK ships them yet, so it cannot be installed as a tool.`
  }
  if (entry.appleOnly) {
    return `${entry.name} is Apple-only (Core ML/MLX through the Swift package); there is no JavaScript SDK, so it cannot run in a Node process.`
  }
  if (entry.npmPackage === null) {
    return `${entry.name} has no npm package; only the Desert Ant CLI (macOS/Linux) can run it.`
  }
  return `${entry.name} has no runtime available to this process.`
}

/**
 * Resolve how (and whether) one model can run here.
 *
 * The verdict prefers a directly loadable package, then an ONNX Runtime-backed
 * one, and only then the externally installed CLI. `requiresRuntime` is checked
 * against the same resolution context, so an operator sees "install
 * onnxruntime-node" rather than an import failure mid-transcription.
 * @param entry - the catalog entry to resolve.
 * @param options - overrides for testing; `resolve` and `platform` replace the process facts.
 * @returns the verdict, including the reason for every negative one.
 */
export function resolveCapability(
  entry: ModelCatalogEntry,
  options: {
    readonly resolve?: (specifier: string) => boolean
    readonly platform?: NodeJS.Platform
  } = {},
): CapabilityVerdict {
  const resolve = options.resolve ?? canResolve
  const platform = options.platform ?? process.platform

  if (entry.closedBeta || entry.appleOnly || entry.npmPackage === null) {
    // `browser-only` entries keep their npm route below even off Windows: the
    // verdict is about THIS process, and the caller may be on the platform the
    // package does support.
    if (entry.npmPackage === null) {
      const cli = entry.cliVerb
      if (cli !== null && resolve('@desert-ant-labs/cli') === false) {
        return { runnable: false, route: 'unavailable', reason: unavailableReason(entry) }
      }
      return { runnable: false, route: 'unavailable', reason: unavailableReason(entry) }
    }
  }

  const pkg = entry.npmPackage
  if (pkg === null) {
    return { runnable: false, route: 'unavailable', reason: unavailableReason(entry) }
  }

  const missingRuntimes = entry.requiresRuntime.filter(name => !resolve(name))
  if (missingRuntimes.length > 0) {
    return {
      runnable: false,
      route: 'unavailable',
      reason: `${entry.name} needs ${missingRuntimes.join(', ')} to run here; install it beside the plugin (npm i ${missingRuntimes.join(' ')}).`,
      missing: missingRuntimes,
    }
  }

  const native = packageSpecifier(pkg, entry.npmSubpath)
  const onnx = entry.requiresRuntime.length > 0

  // A declared ONNX runtime wins over the package's own default entry: for
  // these packages the default import is the browser build, which refuses to
  // initialize in Node.
  if (onnx) {
    if (resolve(pkg)) {
      const resolved = [...entry.requiresRuntime, pkg]
      return {
        runnable: true,
        route: 'npm-onnxruntime',
        reason: `${entry.name} runs through ${entry.requiresRuntime.join(', ')}.`,
        resolved,
      }
    }
    return {
      runnable: false,
      route: 'unavailable',
      reason: `${entry.name} requires the ${pkg} package, which is not installed.`,
      missing: [pkg],
    }
  }

  if (resolve(native)) {
    // Off Windows a `browser-only` entry may still be runnable on the platform
    // its prebuilt core targets; on Windows the upstream error is explicit.
    if (platform === 'win32' && entry.windowsSupport === 'browser-only') {
      return {
        runnable: false,
        route: 'unavailable',
        reason: `${entry.name} has no prebuilt native build for win32-${process.arch}: ${pkg}${entry.npmSubpath ?? ''} supports linux-x64, linux-arm64 and darwin-arm64 only.`,
        resolved: [native],
      }
    }
    return {
      runnable: true,
      route: 'npm-native',
      reason: `${entry.name} resolves ${native} for this platform.`,
      resolved: [native],
    }
  }

  if (platform === 'win32' && entry.windowsSupport === 'browser-only') {
    return {
      runnable: false,
      route: 'unavailable',
      reason: `${entry.name} has no prebuilt native build for win32-${process.arch}; ${pkg} ships one for linux-x64, linux-arm64 and darwin-arm64 only.`,
      missing: [native],
    }
  }
  return {
    runnable: false,
    route: 'unavailable',
    reason: `${entry.name} requires the ${native} package, which is not installed.`,
    missing: [native],
  }
}

/** One model plus its resolved capability verdict. */
export interface ResolvedModel {
  readonly entry: ModelCatalogEntry
  readonly verdict: CapabilityVerdict
}

/**
 * Resolve every catalog entry.
 * @param entries - validated catalog entries.
 * @param options - resolution overrides, forwarded to {@link resolveCapability}.
 * @returns one record per entry, in catalog order.
 */
export function resolveCatalog(
  entries: readonly ModelCatalogEntry[],
  options: Parameters<typeof resolveCapability>[1] = {},
): ResolvedModel[] {
  return entries.map(entry => ({ entry, verdict: resolveCapability(entry, options) }))
}
