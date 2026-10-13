/**
 * Command transports: reaching a model that is not an in-process npm package.
 *
 * Two transports share one shape:
 *
 * - **cli** — runs the Desert Ant CLI (`desertant`/`da`), which exposes every
 *   shipping model as `desertant <verb> … --json` and runs on macOS and Linux.
 * - **remote** — POSTs to a bridge the user runs on a machine that can execute
 *   the model. This is what makes an Apple-only model such as Title reachable
 *   from a Windows host.
 *
 * Both are injected with their side-effecting primitive (`CommandRunner`,
 * `HttpPost`) so behaviour is testable without spawning a process or opening a
 * socket, and so a deployment can substitute its own runner.
 *
 * @module @dsh-plugins/dsh-model-tools/transport
 */

import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { ModelCatalogEntry } from './types.ts'
import { throwIfAborted, type JsonValue } from './adapters/types.ts'

/** One invocation to route through a transport. */
export interface TransportRequest {
  /** The catalog entry being invoked. */
  readonly entry: ModelCatalogEntry
  /** Validated tool arguments; the first declared parameter is the primary input. */
  readonly args: Readonly<Record<string, unknown>>
  /** Caller cancellation. */
  readonly signal: AbortSignal
}

/** Outcome of running one command. */
export interface CommandOutcome {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Run a command to completion. Injectable so tests need no real process. */
export type CommandRunner = (
  command: string,
  argv: readonly string[],
  signal: AbortSignal,
) => Promise<CommandOutcome>

/** Post a JSON body and read the response. Injectable for the same reason. */
export type HttpPost = (
  url: string,
  body: unknown,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
) => Promise<{ readonly status: number; readonly body: string }>

/** A model invoked out-of-process. */
export interface CommandTransport {
  readonly kind: 'cli' | 'remote'
  invoke(request: TransportRequest): Promise<Record<string, JsonValue>>
}

/** The Desert Ant CLI's exit codes, as documented for agents. */
export const CLI_EXIT_RUNTIME_ERROR = 1
export const CLI_EXIT_USAGE_ERROR = 64

/**
 * Default command name. `da` is the short alias the CLI installs.
 */
export const DEFAULT_CLI_COMMAND = 'desertant'

/** The path every bridge must serve. */
export const BRIDGE_PATH = '/invoke'

/**
 * Whether a command is on PATH.
 *
 * Probed by scanning PATH rather than by running the command, because this runs
 * at plugin load and a capability probe must not start a process (or pay a
 * CLI's startup cost) just to decide what to advertise.
 * @param command - command name or an absolute path.
 * @param pathValue - the PATH to search; defaults to the process environment.
 * @returns whether an executable file of that name exists.
 */
export function commandExists(command: string, pathValue?: string): boolean {
  // An explicit path is checked directly; a bare name is searched on PATH.
  if (command.includes('/') || command.includes('\\')) {
    return isExecutable(command)
  }
  const searchPath = pathValue ?? process.env.PATH ?? ''
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
    : ['']
  for (const directory of searchPath.split(delimiter)) {
    if (directory.length === 0) continue
    for (const extension of extensions) {
      if (isExecutable(join(directory, command + extension))) return true
    }
  }
  return false
}

/** Whether a path is an existing executable file. */
function isExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Split the tool arguments into the CLI's positional inputs and its
 * `--option key=value` flags.
 *
 * The first declared catalog parameter is the primary input, matching how the
 * registrar marks it required. A file model accepts several paths positionally
 * (the CLI loads the model once for all of them), so a primary declared as a
 * string list becomes several positionals. Everything else becomes an option,
 * with lists comma-joined because the CLI's option syntax is `key=value`.
 * @param entry - the catalog entry being invoked.
 * @param args - validated tool arguments.
 * @returns the positional inputs and the option list.
 */
export function splitArguments(
  entry: ModelCatalogEntry,
  args: Readonly<Record<string, unknown>>,
): { positionals: string[]; options: [string, string][] } {
  const names = Object.keys(entry.tool.params)
  const primaryName = names[0]
  if (primaryName === undefined) {
    throw new Error(`${entry.name} declares no parameters, so its input cannot be addressed`)
  }
  const primaryValue = args[primaryName]
  let positionals: string[]
  if (typeof primaryValue === 'string' && primaryValue.length > 0) {
    positionals = [primaryValue]
  } else if (Array.isArray(primaryValue) && primaryValue.length > 0
    && primaryValue.every(item => typeof item === 'string' && item.length > 0)) {
    positionals = primaryValue as string[]
  } else {
    throw new Error(`argument "${primaryName}" must be a non-empty string or list of paths`)
  }

  const options: [string, string][] = []
  for (const name of names.slice(1)) {
    const value = args[name]
    if (value === undefined) continue
    if (Array.isArray(value)) {
      options.push([name.replaceAll('_', '-'), value.map(String).join(',')])
    } else if (typeof value === 'boolean' || typeof value === 'number') {
      options.push([name.replaceAll('_', '-'), String(value)])
    } else if (typeof value === 'string') {
      options.push([name.replaceAll('_', '-'), value])
    } else {
      throw new Error(`argument "${name}" must be a string, number, boolean or string list`)
    }
  }
  return { positionals, options }
}

/**
 * Build the CLI argv for one invocation.
 *
 * `--json` is what makes stdout a single JSON value, and it also implies
 * `--no-color`, so no escape sequences have to be stripped.
 * @param entry - the catalog entry being invoked.
 * @param args - validated tool arguments.
 * @returns the argv to run, after the command itself.
 */
export function buildArgv(
  entry: ModelCatalogEntry,
  args: Readonly<Record<string, unknown>>,
): string[] {
  const verb = entry.cliVerb
  if (verb === null) throw new Error(`${entry.name} has no CLI verb, so the CLI cannot run it`)
  const { positionals, options } = splitArguments(entry, args)
  const argv = [verb, ...positionals, '--json']
  for (const [key, value] of options) argv.push('--option', `${key}=${value}`)
  return argv
}

/**
 * Parse the CLI's stdout into a canonical value.
 *
 * The CLI writes exactly one JSON value to stdout under `--json` and keeps every
 * diagnostic on stderr, so a parse failure means the command did not behave as
 * documented rather than that output needs cleaning.
 * @param entry - the model, for error messages.
 * @param outcome - the completed command.
 * @returns the parsed value.
 * @throws when the exit code is non-zero or stdout is not a single JSON value.
 */
export function parseCliOutcome(
  entry: ModelCatalogEntry,
  outcome: CommandOutcome,
): Record<string, JsonValue> {
  if (outcome.code === CLI_EXIT_USAGE_ERROR) {
    throw new Error(
      `${entry.name}: the CLI rejected the call (exit 64). ${outcome.stderr.trim() || 'usage error'}`,
    )
  }
  if (outcome.code === CLI_EXIT_RUNTIME_ERROR) {
    throw new Error(
      `${entry.name} failed (exit 1). ${outcome.stderr.trim() || 'runtime error'}`,
    )
  }
  if (outcome.code !== 0) {
    throw new Error(
      `${entry.name}: the CLI exited ${outcome.code}. ${outcome.stderr.trim() || 'unknown failure'}`,
    )
  }
  const text = outcome.stdout.trim()
  if (text.length === 0) {
    throw new Error(`${entry.name}: the CLI produced no JSON on stdout`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `${entry.name}: the CLI stdout was not JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return asRecord(entry, parsed)
}

/**
 * Wrap a JSON value as the object a tool output schema requires.
 * @param entry - the model, for error messages.
 * @param value - the parsed value.
 * @returns the value as a record; a non-object is wrapped under `result`.
 */
function asRecord(entry: ModelCatalogEntry, value: unknown): Record<string, JsonValue> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, JsonValue>
  }
  if (Array.isArray(value)) return { result: value as JsonValue[] }
  // A scalar result is still a result; naming it keeps the output contract
  // stable instead of failing a call that actually succeeded.
  void entry
  return { result: value as JsonValue }
}

/** Spawn a command and capture its output. */
export const spawnRunner: CommandRunner = (command, argv, signal) =>
  new Promise<CommandOutcome>((resolve, reject) => {
    // `shell: false` keeps argv elements from being re-interpreted by a shell,
    // so a model input containing quotes or `&` cannot become a second command.
    const child = spawn(command, [...argv], { shell: false, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const onAbort = (): void => {
      if (settled) return
      settled = true
      child.kill()
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      reject(new Error(`cannot run "${command}": ${error.message}`))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })

/** POST JSON with the global fetch and read the response as text. */
export const fetchPost: HttpPost = async (url, body, headers, signal) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  })
  return { status: response.status, body: await response.text() }
}

/** Options shared by both out-of-process transports. */
export interface TransportOptions {
  /** Command name or path for the CLI transport. */
  readonly cliCommand?: string
  /** Bridge base URL for the remote transport. */
  readonly endpoint?: string
  /** Optional bearer token sent to the bridge. */
  readonly token?: string
  /** Injected command runner. */
  readonly run?: CommandRunner
  /** Injected HTTP poster. */
  readonly post?: HttpPost
}

/**
 * Build the CLI transport for one model.
 * @param entry - the catalog entry, which must declare a CLI verb.
 * @param options - command name and injected runner.
 * @returns the transport.
 */
export function createCliTransport(
  entry: ModelCatalogEntry,
  options: TransportOptions = {},
): CommandTransport {
  const command = options.cliCommand ?? DEFAULT_CLI_COMMAND
  const run = options.run ?? spawnRunner
  return {
    kind: 'cli',
    async invoke({ args, signal }) {
      throwIfAborted(signal)
      const argv = buildArgv(entry, args)
      const outcome = await run(command, argv, signal)
      throwIfAborted(signal)
      return parseCliOutcome(entry, outcome)
    },
  }
}

/**
 * Build the remote transport for one model.
 *
 * The bridge contract is deliberately small so a user can implement it in a few
 * lines on a machine that can run the model:
 *
 * ```
 * POST <endpoint>/invoke
 *   { "model": "title", "verb": "title", "input": "<primary>", "options": { "max-tokens": "96" } }
 *   → 200 { "ok": true,  "result": <the model's JSON> }
 *   → 4xx { "ok": false, "error": "<message>" }
 * ```
 * @param entry - the catalog entry to reach.
 * @param options - endpoint, optional token, injected poster.
 * @returns the transport.
 */
export function createRemoteTransport(
  entry: ModelCatalogEntry,
  options: TransportOptions = {},
): CommandTransport {
  const endpoint = options.endpoint
  if (endpoint === undefined || endpoint.length === 0) {
    throw new Error('the remote transport requires an endpoint')
  }
  const post = options.post ?? fetchPost
  const url = `${endpoint.replace(/\/+$/, '')}${BRIDGE_PATH}`
  const headers: Record<string, string> = options.token === undefined
    ? {}
    : { authorization: `Bearer ${options.token}` }

  return {
    kind: 'remote',
    async invoke({ args, signal }) {
      throwIfAborted(signal)
      const verb = entry.cliVerb
      if (verb === null) throw new Error(`${entry.name} declares no verb for the bridge to run`)
      const { positionals, options: flags } = splitArguments(entry, args)
      const response = await post(
        url,
        {
          model: entry.id,
          verb,
          // A file model may pass several paths; `input` carries them all so the
          // bridge does not have to know which models take more than one.
          input: positionals.length === 1 ? positionals[0] : positionals,
          options: Object.fromEntries(flags),
        },
        headers,
        signal,
      )
      throwIfAborted(signal)
      return parseBridgeResponse(entry, response)
    },
  }
}

/**
 * Interpret one bridge response.
 * @param entry - the model, for error messages.
 * @param response - the HTTP status and body.
 * @returns the model's result as a canonical value.
 * @throws when the bridge reports a failure or an unreadable body.
 */
export function parseBridgeResponse(
  entry: ModelCatalogEntry,
  response: { readonly status: number; readonly body: string },
): Record<string, JsonValue> {
  let parsed: unknown
  try {
    parsed = JSON.parse(response.body)
  } catch {
    throw new Error(
      `${entry.name}: the bridge returned a non-JSON body (HTTP ${response.status})`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${entry.name}: the bridge returned an unexpected body shape`)
  }
  const envelope = parsed as Record<string, unknown>
  if (envelope.ok !== true) {
    const detail = typeof envelope.error === 'string' ? envelope.error : `HTTP ${response.status}`
    throw new Error(`${entry.name}: the bridge could not run the model. ${detail}`)
  }
  return asRecord(entry, envelope.result)
}
