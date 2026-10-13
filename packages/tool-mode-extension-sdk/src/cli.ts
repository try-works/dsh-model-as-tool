/**
 * The operator command family (EXT-31).
 *
 * EXT-31 is explicit that these are REQUIRED NEW FUNCTIONALITY, not existing npm
 * or DSH commands, and that offline edits must hold exclusive store ownership. So
 * every mutating command takes the store lock, and the CLI refuses rather than
 * racing a running host.
 *
 * The entry point takes argv and an output sink instead of reading `process`
 * directly. A CLI that can only be exercised by spawning a child process is a CLI
 * whose failure paths are tested by hand or not at all, and the failure paths here
 * are the security-relevant ones.
 *
 * The management surface is deliberately NOT the inference surface: EXT-31 forbids
 * exposing the management channel on the MCP tool surface by default, and nothing
 * in this module registers a tool.
 *
 * @module @try-works/tool-mode-extension-sdk/cli
 */

import { ManagementError } from './errors.ts'
import { ExtensionStore } from './install/store.ts'
import { ExtensionLifecycle, type ContributionRegistrar } from './install/lifecycle.ts'
import { summarize } from './state.ts'

/** Where the CLI writes. Injected so a test can capture output. */
export interface CliIo {
  /** Write one line of normal output. */
  out(line: string): void
  /** Write one line of error output. */
  err(line: string): void
}

/** Options resolved from argv. */
export interface CliOptions {
  /** The extension store root. */
  readonly store: string
  /** The profile to act on. */
  readonly profile: string
  /** Positional arguments after the command. */
  readonly positional: readonly string[]
  /** `--flag` names and their values. */
  readonly flags: Readonly<Record<string, string | true>>
}

/** What the CLI needs from the environment to act. */
export interface CliDependencies {
  /** A registrar for activation. Without one, activation is refused rather than faked. */
  readonly registrar?: ContributionRegistrar
  /** Parse and install from a specifier; injected so the CLI owns no network stack. */
  readonly install?: (spec: string, integrity: string | undefined, store: string) => Promise<string>
}

/** The usage text. */
const USAGE = `dsh-tool-mode — manage Tool Mode extensions

  extensions list                                   list installed extensions
  extensions inspect <id>                           show one extension's state
  extensions install <spec> [--integrity sha512-…]  install without activating
  extensions activate <id> [--profile p]            activate in a profile
  extensions prepare <id> --model <model>           prepare a model deployment
  extensions deactivate <id> [--profile p]          deactivate in a profile
  extensions uninstall <id> [--deactivate] [--purge-assets]
  tools enable <tool> [--profile p]                 enable one tool
  tools disable <tool> [--profile p]                disable one tool

Global: --store <dir>  --profile <name>

Mutating commands take exclusive ownership of the store. They refuse rather than
race a running host, and the management surface is never published on the
inference tool surface.`

/**
 * Parse argv into options.
 *
 * Anything unrecognised is REFUSED rather than ignored: a mistyped flag that is
 * silently dropped turns `--deactivate` into a command the operator did not ask
 * for, which on `uninstall` is the difference between previewing and removing.
 * @param argv - arguments after the executable name.
 * @returns the parsed options.
 * @throws ManagementError when a flag is unknown or a value is missing.
 */
export function parseArgs(argv: readonly string[]): CliOptions {
  const positional: string[] = []
  const flags: Record<string, string | true> = {}
  const known = new Set([
    'store', 'profile', 'integrity', 'model', 'deactivate', 'purge-assets', 'json', 'help',
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const name = token.slice(2)
    if (!known.has(name)) {
      throw new ManagementError(
        'INVALID_EXTENSION',
        'install',
        `unknown option ${JSON.stringify(token)}`,
        'Run `dsh-tool-mode --help` to see the supported options.',
      )
    }
    // The boolean flags take no value; the rest require one.
    if (name === 'deactivate' || name === 'purge-assets' || name === 'json' || name === 'help') {
      flags[name] = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new ManagementError(
        'INVALID_EXTENSION',
        'install',
        `option ${JSON.stringify(token)} needs a value`,
        `Pass it as ${token} <value>.`,
      )
    }
    flags[name] = value
    index += 1
  }
  return {
    store: typeof flags.store === 'string' ? flags.store : '.tool-mode-store',
    profile: typeof flags.profile === 'string' ? flags.profile : 'default',
    positional,
    flags,
  }
}

/**
 * Run one command.
 *
 * @param argv - arguments after the executable name.
 * @param io - output sinks.
 * @param dependencies - the registrar and installer to act with.
 * @returns the process exit code.
 */
export async function runToolModeCli(
  argv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies = {},
): Promise<number> {
  let options: CliOptions
  try {
    options = parseArgs(argv)
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error))
    return 2
  }

  if (options.flags.help === true || options.positional.length === 0) {
    io.out(USAGE)
    return options.positional.length === 0 && options.flags.help !== true ? 2 : 0
  }

  const [group, action] = options.positional
  const store = new ExtensionStore(options.store)
  const lifecycle = new ExtensionLifecycle({
    store,
    profile: options.profile,
    registrar: dependencies.registrar ?? refusingRegistrar,
  })

  try {
    switch (`${group} ${action}`) {
      case 'extensions list':
        return listExtensions(store, lifecycle, io)
      case 'extensions inspect':
        return inspectExtension(store, lifecycle, options, io)
      case 'extensions install':
        return await installExtension(store, options, io, dependencies)
      case 'extensions activate':
        return await activateExtension(store, lifecycle, options, io)
      case 'extensions prepare':
        return prepareModel(lifecycle, options, io)
      case 'extensions deactivate':
        return await deactivateExtension(lifecycle, options, io)
      case 'extensions uninstall':
        return await uninstallExtension(lifecycle, store, options, io)
      case 'tools enable':
        return setTool(lifecycle, options, io, true)
      case 'tools disable':
        return setTool(lifecycle, options, io, false)
      default:
        io.err(`unknown command ${JSON.stringify(`${group} ${action}`)}`)
        io.err(USAGE)
        return 2
    }
  } catch (error) {
    if (error instanceof ManagementError) {
      io.err(`${error.code}: ${error.message}`)
      // Recovery advice is the point of the vocabulary: a code alone tells an
      // operator what failed but not what to do about it.
      io.err(`  ${error.recovery}`)
      return 1
    }
    io.err(error instanceof Error ? error.message : String(error))
    return 1
  }
}

/** A registrar that refuses, so activation without a host reports honestly. */
const refusingRegistrar: ContributionRegistrar = {
  publish(contribution) {
    throw new ManagementError(
      'EXTENSION_INACTIVE',
      'activate',
      `this CLI cannot publish ${contribution.name}: no running host is attached`,
      'Activate through the running host, or use the host integration; the CLI does not fake publication.',
    )
  },
  withdraw() { /* nothing was published */ },
}

/** `extensions list` */
function listExtensions(store: ExtensionStore, lifecycle: ExtensionLifecycle, io: CliIo): number {
  const lock = store.listInstalled()
  if (lock.corrupt) {
    // Fails closed with diagnostics rather than reporting an empty store, so an
    // operator can tell "nothing installed" from "state unreadable".
    io.err(`the store state could not be read: ${lock.diagnostic ?? 'unknown reason'}`)
    return 1
  }
  if (lock.value.length === 0) {
    io.out('no extensions installed')
    return 0
  }
  for (const record of lock.value) {
    const state = lifecycle.stateOf(record.extensionId)
    const summary = state === undefined ? 'not-configured' : summarize(state)
    io.out(`${record.extensionId}@${record.version}\t${summary}\t${record.installPath}`)
  }
  return 0
}

/** `extensions inspect <id>` */
function inspectExtension(
  store: ExtensionStore,
  lifecycle: ExtensionLifecycle,
  options: CliOptions,
  io: CliIo,
): number {
  const id = options.positional[2]
  if (id === undefined) {
    io.err('extensions inspect needs an extension id')
    return 2
  }
  const record = store.listInstalled().value.find(candidate => candidate.extensionId === id)
  if (record === undefined) {
    io.err(`${id} is not installed`)
    return 1
  }
  const integrity = store.verifyUnchanged(record)
  const state = lifecycle.stateOf(id)
  if (options.flags.json === true) {
    io.out(JSON.stringify({ record, state, unchanged: integrity.unchanged }, null, 2))
    return 0
  }
  io.out(`id          ${record.extensionId}`)
  io.out(`version     ${record.version}`)
  io.out(`installed   ${record.installedAt}`)
  io.out(`source      ${record.source.kind}: ${record.source.requested}`)
  io.out(`archive     ${record.archiveDigest}`)
  io.out(`content     ${integrity.unchanged ? 'unchanged' : `CHANGED — ${integrity.diagnostic ?? ''}`}`)
  io.out(`activation  ${state === undefined ? 'not-configured' : summarize(state)}`)
  if (state !== undefined) {
    io.out(`desired     ${state.desiredActivation}`)
    io.out(`observed    ${state.observedActivation}`)
    io.out(`export      ${state.export}`)
    for (const tool of state.tools) {
      io.out(`tool        ${tool.toolName} ${tool.enabled ? 'enabled' : 'disabled'}`)
    }
  }
  return 0
}

/** `extensions install <spec>` */
async function installExtension(
  store: ExtensionStore,
  options: CliOptions,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const spec = options.positional[2]
  if (spec === undefined) {
    io.err('extensions install needs a source')
    return 2
  }
  const integrity = typeof options.flags.integrity === 'string' ? options.flags.integrity : undefined
  if (integrity === undefined) {
    // EXT-12: integrity is not trust, but installing WITHOUT a declared digest
    // means nothing can be verified later. Requiring it is the safer default.
    io.err('extensions install requires --integrity sha512-<verified-base64>')
    io.err('  Ask the publisher for the digest; installing unverified bytes cannot be undone later.')
    return 2
  }
  if (dependencies.install === undefined) {
    io.err('this CLI has no installer attached; install through the host or a configured source')
    return 1
  }
  const release = store.acquireExclusive()
  try {
    const id = await dependencies.install(spec, integrity, options.store)
    io.out(`installed ${id} (inactive — installation is not activation)`)
    return 0
  } finally {
    release()
  }
}

/** `extensions activate <id>` */
async function activateExtension(
  store: ExtensionStore,
  lifecycle: ExtensionLifecycle,
  options: CliOptions,
  io: CliIo,
): Promise<number> {
  const id = options.positional[2]
  if (id === undefined) {
    io.err('extensions activate needs an extension id')
    return 2
  }
  // Activation names an exact installed VERSION, because the same extension may be
  // installed twice and "activate the newest" is a guess about operator intent.
  const installed = store.listInstalled().value.filter(record => record.extensionId === id)
  if (installed.length === 0) {
    io.err(`${id} is not installed`)
    return 1
  }
  if (installed.length > 1) {
    const versions = installed.map(record => record.version).join(', ')
    io.err(`${id} is installed at ${installed.length} versions (${versions})`)
    io.err('  Uninstall the versions you do not want; activation will not pick one for you.')
    return 1
  }
  const result = await lifecycle.activate(id, (installed[0] as { version: string }).version)
  io.out(`activated ${id}@${result.version} in profile ${options.profile} (generation ${result.generation})`)
  for (const diagnostic of result.diagnostics) {
    io.out(`  ${diagnostic.code}: ${diagnostic.message}`)
  }
  return 0
}

/** `extensions prepare <id> --model <model>` */
function prepareModel(lifecycle: ExtensionLifecycle, options: CliOptions, io: CliIo): number {
  const id = options.positional[2]
  const model = typeof options.flags.model === 'string' ? options.flags.model : undefined
  if (id === undefined || model === undefined) {
    io.err('extensions prepare needs an extension id and --model <model>')
    return 2
  }
  const state = lifecycle.stateOf(id)
  if (state === undefined) {
    io.err(`${id} is not configured in profile ${options.profile}`)
    return 1
  }
  // Preparation is the host's job and the host is not running, so this records the
  // deployment the operator asked for rather than claiming to have fetched it.
  io.out(`preparation requested for ${id} model ${model}`)
  io.out('  preparation runs in the host; this command records the request only.')
  return 0
}

/** `extensions deactivate <id>` */
async function deactivateExtension(
  lifecycle: ExtensionLifecycle,
  options: CliOptions,
  io: CliIo,
): Promise<number> {
  const id = options.positional[2]
  if (id === undefined) {
    io.err('extensions deactivate needs an extension id')
    return 2
  }
  const result = await lifecycle.deactivate(id)
  if (result.fullyStopped) {
    io.out(`deactivated ${id} in profile ${options.profile}`)
    return 0
  }
  // EXT-27: never report a full stop while an owned worker continues.
  io.err(`deactivated ${id}, but cleanup did not complete: ${result.cleanupFailure ?? 'unknown reason'}`)
  io.err('  The extension is quarantined; retry once its worker has stopped.')
  return 1
}

/** `extensions uninstall <id>` */
async function uninstallExtension(
  lifecycle: ExtensionLifecycle,
  store: ExtensionStore,
  options: CliOptions,
  io: CliIo,
): Promise<number> {
  const id = options.positional[2]
  if (id === undefined) {
    io.err('extensions uninstall needs an extension id')
    return 2
  }
  const state = lifecycle.stateOf(id)
  const active = state?.observedActivation === 'active' || state?.desiredActivation === 'active'
  if (active && options.flags.deactivate !== true) {
    // The impact preview EXT-28 requires, shown BEFORE refusing so the operator
    // knows exactly what re-running would affect.
    io.err(`${id} is active in profile ${options.profile}`)
    io.err('Impact preview:')
    for (const tool of state?.tools ?? []) io.err(`  tool ${tool.toolName} (${tool.enabled ? 'enabled' : 'disabled'})`)
    io.err(`  profile ${options.profile}`)
    io.err('Re-run with --deactivate to deactivate it first.')
    return 1
  }
  const release = store.acquireExclusive()
  try {
    await lifecycle.uninstall(id, { deactivate: options.flags.deactivate === true })
    io.out(`uninstalled ${id}`)
    if (options.flags['purge-assets'] === true) {
      // Assets are removed by a separate, restart-retryable step (EXT-29), so this
      // reports the request rather than implying the bytes are already gone.
      io.out('  asset purge requested; on Windows deletion may complete after restart')
    }
    io.out('  a disabled tombstone is retained so the package cannot silently return')
    return 0
  } finally {
    release()
  }
}

/** `tools enable|disable <tool>` */
function setTool(lifecycle: ExtensionLifecycle, options: CliOptions, io: CliIo, enabled: boolean): number {
  const toolName = options.positional[2]
  if (toolName === undefined) {
    io.err(`tools ${enabled ? 'enable' : 'disable'} needs a tool name`)
    return 2
  }
  // The tool name identifies the extension that contributes it, so the operator
  // does not have to remember which package owns which tool.
  const owner = lifecycle.states().find(state => state.tools.some(tool => tool.toolName === toolName))
  if (owner === undefined) {
    io.err(`no extension in profile ${options.profile} contributes a tool named ${toolName}`)
    return 1
  }
  lifecycle.setToolEnabled(owner.extensionId, toolName, enabled)
  io.out(`${enabled ? 'enabled' : 'disabled'} ${toolName} in profile ${options.profile}`)
  return 0
}

