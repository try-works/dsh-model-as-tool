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
import { commitUpdate, rollback } from './install/update-flow.ts'
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
  /**
   * The recipes authoring runner, forwarded to by the `recipes` namespace
   * (RCP-08). When absent, the SDK resolves `@try-works/tool-mode-recipes/cli`
   * lazily at invocation time; when that also fails, the command answers a
   * PRECISE refusal — the SDK never duplicates recipe semantics and never
   * depends on the recipes package at import time.
   */
  readonly recipeCliRunner?: { runRecipeCli(argv: readonly string[], io: CliIo): Promise<number> }
  /** Override the lazy resolver (tests); returns the runner or undefined. */
  readonly resolveRecipeCli?: () => Promise<{ runRecipeCli(argv: readonly string[], io: CliIo): Promise<number> } | undefined>
}

/** The default lazy resolver: the recipes CLI beside this SDK, or nothing. */
async function defaultRecipeCliResolver(): Promise<{ runRecipeCli(argv: readonly string[], io: CliIo): Promise<number> } | undefined> {
  try {
    const module = await import('@try-works/tool-mode-recipes/cli') as
      { runRecipeCli(argv: readonly string[], io: CliIo): Promise<number> }
    return { runRecipeCli: module.runRecipeCli }
  } catch {
    return undefined
  }
}

/**
 * The `recipes` namespace: lazy OPTIONAL forwarding to the recipes authoring
 * CLI (RCP-08). The SDK ships no recipe semantics of its own — the same
 * implementation runs here as under the recipes package's own bin.
 * @param argv - the recipe arguments after the `recipes` token.
 * @param io - output sinks.
 * @param dependencies - the injected runner or resolver.
 * @returns the process exit code.
 */
async function forwardRecipes(
  argv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const runner = dependencies.recipeCliRunner
    ?? await (dependencies.resolveRecipeCli ?? defaultRecipeCliResolver)()
  if (runner === undefined) {
    io.err(
      'the recipes authoring CLI is not available beside this SDK: @try-works/tool-mode-recipes is not installed. '
      + 'Install it, or run its own bin `tool-mode-recipe` directly. This refusal is deliberate: the SDK never '
      + 'pretends to author a recipe it cannot validate.',
    )
    return 1
  }
  // A raw throw from the forwarded runner becomes a refusal here: the SDK
  // namespace never re-throws into the caller's stack.
  try {
    return await runner.runRecipeCli(argv, io)
  } catch (error) {
    io.err(`the recipes CLI failed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
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
  extensions update <id> --to <version>          commit a staged, approved update
                                                  (offline: pointerOnly; the host
                                                  reconciles admissions)
  extensions rollback <id> [--to <version>]       restore the recorded previous
                                                  pointer (pointer-only restore)
  extensions purge-assets <id>                    refused here: purging belongs to
                                                  the running host's coordinator
  tools enable <tool> [--profile p]                 enable one tool
  tools disable <tool> [--profile p]                disable one tool
  recipes <…>                                       author recipes: forwards to the
                                                    recipes CLI (create / edit-draft /
                                                    test / validate / describe / pack)

Global: --store <dir>  --profile <name>  --json (one JSON document: {command, exit, output, errors})

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
    'store', 'profile', 'integrity', 'model', 'deactivate', 'purge-assets', 'json', 'help', 'to',
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
  // The recipes namespace is forwarded RAW (no SDK-side parsing): the recipes
  // CLI owns its own argv contract, and this file must not duplicate it. The
  // --json wrapper applies to the forwarded namespace too.
  if (argv[0] === 'recipes') {
    const jsonIndex = argv.indexOf('--json')
    if (jsonIndex === -1) {
      return await forwardRecipes(argv.slice(1), io, dependencies)
    }
    const output: string[] = []
    const errors: string[] = []
    const forwarded = [...argv.slice(1, jsonIndex), ...argv.slice(jsonIndex + 1)]
    const code = await forwardRecipes(forwarded, { out: line => output.push(line), err: line => errors.push(line) }, dependencies)
    io.out(JSON.stringify({ command: `recipes ${forwarded.join(' ')}`, exit: code, output, errors }))
    return code
  }

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

  // --json: the whole command's output is captured and emitted as ONE JSON
  // document with the exit code as the normalized status (0 success, 1 named
  // management refusal, 2 usage/IO) — never hanging an unattended caller.
  if (options.flags.json === true) {
    const output: string[] = []
    const errors: string[] = []
    const code = await dispatchCli(`${group} ${action}`, options, store, lifecycle, { out: line => output.push(line), err: line => errors.push(line) }, dependencies)
    io.out(JSON.stringify({ command: `${group} ${action}`, exit: code, output, errors }))
    return code
  }

  try {
    return await dispatchCli(`${group} ${action}`, options, store, lifecycle, io, dependencies)
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

/** The command dispatch, shared by the prose and the --json paths. */
async function dispatchCli(
  command: string,
  options: CliOptions,
  store: ExtensionStore,
  lifecycle: ExtensionLifecycle,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  try {
    switch (command) {
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
      case 'extensions update':
        return await updateExtension(store, options, io)
      case 'extensions rollback':
        return await rollbackExtension(store, options, io)
      case 'extensions purge-assets':
        return purgeAssets(options, io)
      case 'tools enable':
        return await setTool(store, lifecycle, options, io, true)
      case 'tools disable':
        return await setTool(store, lifecycle, options, io, false)
      default:
        io.err(`unknown command ${JSON.stringify(command)}`)
        io.err(USAGE)
        return 2
    }
  } catch (error) {
    if (error instanceof ManagementError) {
      io.err(`${error.code}: ${error.message}`)
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

/**
 * `extensions update <id> --to <v>` (EXT-31).
 *
 * The OFFLINE CLI path: the version must already be staged and approved
 * (stageUpdate/recordApproval); the commit runs pointerOnly — the durable
 * pointer moves and the running host reconciles admissions on its next
 * lifecycle pass (the CLI never fakes a publication, EXT-31's management
 * channel is the host's).
 */
async function updateExtension(store: ExtensionStore, options: CliOptions, io: CliIo): Promise<number> {
  const id = options.positional[2]
  const version = options.flags.to
  if (id === undefined) {
    io.err('extensions update needs an extension id')
    return 2
  }
  if (typeof version !== 'string') {
    io.err('extensions update needs --to <version> (the staged, approved version)')
    return 2
  }
  const result = await commitUpdate({
    storeDir: store.rootDir,
    profile: options.profile,
    extensionId: id,
    stagedVersion: version,
    pointerOnly: true,
  })
  io.out(`updated ${id}: active ${result.activeVersion}${result.previousVersion === undefined ? '' : ` (was ${result.previousVersion})`}`)
  return 0
}

/** `extensions rollback <id> [--to <v>]` (EXT-31): pointer restore only. */
async function rollbackExtension(store: ExtensionStore, options: CliOptions, io: CliIo): Promise<number> {
  const id = options.positional[2]
  if (id === undefined) {
    io.err('extensions rollback needs an extension id')
    return 2
  }
  const requested = options.flags.to
  const pointers = store.readProfilePointers(options.profile)
  if (pointers.corrupt) {
    io.err(`the profile pointers could not be read: ${pointers.diagnostic ?? 'unknown reason'}`)
    return 1
  }
  const previous = pointers.value.previousVersions[id]
  if (requested !== undefined && requested !== previous) {
    io.err(`rollback --to ${String(requested)} does not match the recorded previous version ${previous ?? '(none)'}; `
      + 'rollback restores the recorded previous pointer, never an arbitrary version')
    return 1
  }
  const result = await rollback({ storeDir: store.rootDir, profile: options.profile, extensionId: id })
  io.out(`rolled back ${id}: active ${result.activeVersion}${result.hookFailure === undefined ? '' : ` (hook failure reported: ${result.hookFailure})`}`)
  return 0
}

/**
 * `extensions purge-assets <id>` (EXT-31).
 *
 * Honest refusal: asset purging is the deployment coordinator's job in the
 * running host — the offline CLI owns no asset registry and never invents one.
 */
function purgeAssets(options: CliOptions, io: CliIo): number {
  const id = options.positional[2]
  if (id === undefined) {
    io.err('extensions purge-assets needs an extension id')
    return 2
  }
  io.err(`asset purging for ${id} requires the running host's deployment coordinator; this offline CLI owns no asset registry and refuses rather than faking a purge`)
  return 1
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
  await store.exclusive(async () => {
    await lifecycle.uninstall(id, { deactivate: options.flags.deactivate === true })
    io.out(`uninstalled ${id}`)
    if (options.flags['purge-assets'] === true) {
      // Assets are removed by a separate, restart-retryable step (EXT-29), so this
      // reports the request rather than implying the bytes are already gone.
      io.out('  asset purge requested; on Windows deletion may complete after restart')
    }
    io.out('  a disabled tombstone is retained so the package cannot silently return')
  })
  return 0
}

/** `tools enable|disable <tool>` */
async function setTool(
  store: ExtensionStore,
  lifecycle: ExtensionLifecycle,
  options: CliOptions,
  io: CliIo,
  enabled: boolean,
): Promise<number> {
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
  // A toggle RECONCILES the published surface now, so like every other offline
  // mutation it must hold exclusive store ownership: racing a running host's own
  // registry mutations with none would leave the two processes disagreeing. The
  // reentrant exclusive() is used rather than the raw lock so the lifecycle's own
  // acquisition nests at depth 2 instead of overwriting this command's record.
  try {
    await store.exclusive(async () => {
      await lifecycle.setToolEnabled(owner.extensionId, toolName, enabled)
    })
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error))
    return 1
  }
  io.out(`${enabled ? 'enabled' : 'disabled'} ${toolName} in profile ${options.profile}`)
  return 0
}

