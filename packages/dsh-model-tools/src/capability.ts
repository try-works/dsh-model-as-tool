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
import { DEFAULT_CLI_COMMAND } from './transport.ts'
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
    return `${entry.name} is Apple-only (Core ML/MLX through the Swift package); there is no JavaScript SDK, so it cannot run in a Node process. Point \`remote.endpoint\` at a bridge on an Apple machine to reach it.`
  }
  if (entry.npmPackage === null && entry.cliVerb === null) {
    return `${entry.name} has no npm package and no CLI verb, so no transport can reach it.`
  }
  if (entry.npmPackage === null) {
    return `${entry.name} has no npm package; run it through the Desert Ant CLI (macOS/Linux) with \`cli.enabled\`, or through a bridge with \`remote.endpoint\`.`
  }
  return `${entry.name} has no runtime available to this process.`
}

/** Whether the CLI can carry this model at all. */
function cliCapable(entry: ModelCatalogEntry): boolean {
  return entry.cliVerb !== null && !entry.closedBeta
}

/**
 * Resolve how (and whether) one model can run here.
 *
 * Transport preference is deliberate: an in-process package is fastest and
 * needs no external service, so it wins; the CLI is local but out-of-process;
 * the bridge is last because it depends on another machine. A user who would
 * rather route everything through a bridge can disable the other two.
 * @param entry - the catalog entry to resolve.
 * @param options - overrides for testing; `resolve`, `platform` and the transport switches replace the process facts.
 * @returns the verdict, including the reason for every negative one.
 */
export function resolveCapability(
  entry: ModelCatalogEntry,
  options: {
    readonly resolve?: (specifier: string) => boolean
    readonly platform?: NodeJS.Platform
    /** Whether the Desert Ant CLI is on PATH. */
    readonly cliAvailable?: boolean
    /** Whether a bridge endpoint is configured. */
    readonly remoteEndpoint?: string | undefined
    /** Turn off in-process npm resolution, to force another transport. */
    readonly allowNpm?: boolean
  } = {},
): CapabilityVerdict {
  const resolve = options.resolve ?? canResolve
  const platform = options.platform ?? process.platform
  const allowNpm = options.allowNpm ?? true
  const remoteEndpoint = options.remoteEndpoint

  // A bridge is checked first among the fallbacks because it is the only route
  // for Apple-only models, which have neither a package nor (for some) a verb.
  const bridgeUsable = remoteEndpoint !== undefined && remoteEndpoint.length > 0 && !entry.closedBeta

  const pkg = entry.npmPackage
  // Why the in-process route did not pan out. Kept so the final verdict can name
  // the exact missing piece ("install onnxruntime-node") instead of falling back
  // to a generic sentence once the CLI and bridge have also been ruled out.
  let npmMiss: { reason: string; missing: string[] } | undefined

  if (pkg !== null && allowNpm) {
    const missingRuntimes = entry.requiresRuntime.filter(name => !resolve(name))
    if (missingRuntimes.length > 0) {
      npmMiss = {
        reason: `${entry.name} needs ${missingRuntimes.join(', ')} to run here; install it beside the plugin (npm i ${missingRuntimes.join(' ')}).`,
        missing: missingRuntimes,
      }
    } else {
      const native = packageSpecifier(pkg, entry.npmSubpath)
      const onnx = entry.requiresRuntime.length > 0

      // A declared ONNX runtime wins over the package's own default entry: for
      // these packages the default import is the browser build, which refuses
      // to initialize in Node.
      if (onnx) {
        if (resolve(pkg)) {
          return {
            runnable: true,
            route: 'npm-onnxruntime',
            reason: `${entry.name} runs through ${entry.requiresRuntime.join(', ')}.`,
            resolved: [...entry.requiresRuntime, pkg],
          }
        }
        npmMiss = {
          reason: `${entry.name} requires the ${pkg} package, which is not installed.`,
          missing: [pkg],
        }
      } else if (platform === 'win32' && entry.windowsSupport === 'browser-only') {
        npmMiss = {
          reason: `${entry.name} has no prebuilt native build for win32-${process.arch}: ${native} supports linux-x64, linux-arm64 and darwin-arm64 only.`,
          missing: [native],
        }
      } else if (resolve(native)) {
        return {
          runnable: true,
          route: 'npm-native',
          reason: `${entry.name} resolves ${native} for this platform.`,
          resolved: [native],
        }
      } else {
        npmMiss = {
          reason: `${entry.name} requires the ${native} package, which is not installed.`,
          missing: [native],
        }
      }
    }
  }

  // The CLI runs every shipping model on macOS and Linux, so it is checked
  // before giving up — including for models whose npm prebuild is missing here.
  if (cliCapable(entry) && (options.cliAvailable ?? false)) {
    return {
      runnable: true,
      route: 'cli',
      reason: `${entry.name} runs through the Desert Ant CLI (\`${DEFAULT_CLI_COMMAND} ${entry.cliVerb}\`).`,
      resolved: [DEFAULT_CLI_COMMAND],
    }
  }

  if (bridgeUsable) {
    return {
      runnable: true,
      route: 'remote',
      reason: `${entry.name} is reached through the bridge at ${remoteEndpoint}.`,
      resolved: [remoteEndpoint as string],
    }
  }

  if (npmMiss !== undefined && !entry.closedBeta && !entry.appleOnly) {
    return {
      runnable: false,
      route: 'unavailable',
      reason: npmMiss.reason,
      missing: npmMiss.missing,
    }
  }
  return { runnable: false, route: 'unavailable', reason: unavailableReason(entry) }
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
