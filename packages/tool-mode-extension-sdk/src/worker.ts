/**
 * The managed extension worker (EXT-20, the SDK half).
 *
 * An extension's executable entry runs OUTSIDE the host, in a managed Node
 * child process with a scrubbed startup environment and a bounded
 * line-delimited JSON protocol. This module is the host-side of that bridge;
 * {@link ./worker/worker-child.ts} is the child.
 *
 * What "managed" means here, concretely:
 *
 * - **Scrubbed environment.** The child env is built from an explicit
 *   ALLOWLIST (the platform basics a Node child needs: PATH, SystemRoot,
 *   TEMP/TMP, PATHEXT, COMSPEC, WINDIR) plus names the operator explicitly
 *   passed through — NEVER `process.env` wholesale, so a credential or a
 *   planted marker in the host environment does not leak into extension code.
 * - **Bounded protocol.** One JSON message per line; lines over
 *   `maxLineBytes` and inputs over `maxInputBytes` are refused, and a child
 *   that violates the framing is killed and faulted rather than trusted.
 * - **Timeouts on every phase.** Spawn must answer `ready` within
 *   `readyTimeoutMs`; a cancelled invoke must settle within `killTimeoutMs` or
 *   the child is killed; a dispose that outlives the grace is killed.
 * - **One process per extension identity**, reused across invocations, with a
 *   restart-on-exit policy: a child that exits (crash or protocol violation)
 *   faults its in-flight calls and the NEXT invoke spawns a fresh one.
 *
 * **The boundary, documented:** a worker failure fails the CALL with the SDK's
 * management-error vocabulary (EXTENSION_FAULT / INVALID_EXTENSION), never the
 * host process — the extension runs in another process by design, and this
 * module never lets a child's exit, hang or protocol violation propagate as an
 * uncaught failure in the caller.
 *
 * Distinct process lifetime per extension generation is the caller's
 * discipline (EXT-20): the host half disposes the old worker and creates a new
 * one when the activation generation advances. `generation` is recorded here
 * so diagnostics can name which generation a worker served.
 *
 * @module @try-works/tool-mode-extension-sdk/worker
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ManagementError } from './errors.ts'
import type { JsonObject, PreparedAssetMapV1, ProviderInspectionV1 } from './runtime.ts'
import type { Writable } from 'node:stream'

/** The environment names a Node child needs to start, and nothing else. */
const ENV_ALLOWLIST: readonly string[] = ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATHEXT', 'COMSPEC']

/** Default bounds; every one is overridable for a tighter deployment. */
export interface WorkerLimits {
  /** Longest protocol line admitted, either direction. Default 1 MiB. */
  readonly maxLineBytes?: number
  /** Largest serialized input admitted. Default 4 MiB. */
  readonly maxInputBytes?: number
  /** How long spawn may take to answer `ready`. Default 30 s. */
  readonly readyTimeoutMs?: number
  /** How long a cancelled or disposing child may outlive the request. Default 5 s. */
  readonly killTimeoutMs?: number
  /** Deadline for one request-scoped path broker reply. Default 5 s. */
  readonly resolvePathTimeoutMs?: number
}

/** Options for {@link ManagedExtensionWorker.create}. */
export interface ManagedWorkerOptions {
  /** The extension identity the worker serves; one process per identity. */
  readonly extensionId: string
  /** Absolute path of the built `./tool-mode` entry (plain Node ESM). */
  readonly entryPath: string
  /** The activation generation this worker serves (EXT-20 lifetime discipline). */
  readonly generation: number
  /** Explicit environment names to pass through, on top of the allowlist. */
  readonly envPassthrough?: readonly string[]
  /** The Node executable; defaults to the caller's own. */
  readonly nodePath?: string
  /** Bounds and deadlines. */
  readonly limits?: WorkerLimits
  /** Where child stderr diagnostics go; defaults to stderr. */
  readonly diagnostics?: (line: string) => void
}

/**
 * Build the scrubbed child environment (EXT-20).
 *
 * The allowlist is the platform's Node bootstrap minimum; the operator's
 * explicit `passthrough` names are the only additions. Everything else the
 * parent holds — credentials, markers, DSH internals — is absent in the child.
 * @param env - the parent environment to scrub.
 * @param passthrough - explicit names to carry over.
 * @returns the child environment.
 */
export function scrubbedEnv(
  env: NodeJS.ProcessEnv = process.env,
  passthrough: readonly string[] = [],
): Record<string, string> {
  const scrubbed: Record<string, string> = {}
  for (const name of [...ENV_ALLOWLIST, ...passthrough]) {
    const value = env[name]
    if (typeof value === 'string') scrubbed[name] = value
  }
  // The marker a well-behaved child may branch on, and a probe for scrub tests.
  scrubbed['TOOL_MODE_MANAGED_WORKER'] = '1'
  return scrubbed
}

/** The child module this package ships, resolved relative to this module. */
const CHILD_URL = new URL('./worker/worker-child.js', import.meta.url)

/** Reserved wire tag; user objects containing it are refused, never reinterpreted. */
const BINARY_TAG = '$toolModeBinaryV1'

/** A protocol object is never null, an array, or a scalar. */
export function isWorkerObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Lossless bounded wire codec. Other non-JSON/typed values fail explicitly. */
export function workerWire(value: unknown, direction: 'encode' | 'decode', maxBytes: number): unknown {
  let bytes = 0
  let nodes = 0
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 100_000 || depth > 64) throw new Error('worker value exceeds structural limits')
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (direction === 'encode' && (ArrayBuffer.isView(item) || item instanceof ArrayBuffer)) {
      if (!(item instanceof Uint8Array) && !(item instanceof Float32Array)) {
        throw new Error(`unsupported worker typed value: ${item.constructor.name}`)
      }
      bytes += item.byteLength
      if (bytes > maxBytes) throw new Error('worker binary payload exceeds byte limit')
      const type = item instanceof Float32Array ? 'Float32Array' : 'Uint8Array'
      // Float32 values use a defined little-endian wire representation.
      const data = Buffer.alloc(item.byteLength)
      if (item instanceof Float32Array) item.forEach((v, i) => data.writeFloatLE(v, i * 4))
      else data.set(item)
      return { [BINARY_TAG]: type, data: data.toString('base64') }
    }
    if (Array.isArray(item)) return item.map(v => visit(v, depth + 1))
    if (!isWorkerObject(item)) throw new Error(`unsupported worker value: ${typeof item}`)
    if (Object.hasOwn(item, BINARY_TAG)) {
      if (direction === 'encode') throw new Error(`reserved worker wire key: ${BINARY_TAG}`)
      const type = item[BINARY_TAG]
      const data = item['data']
      if (Object.keys(item).length !== 2 || (type !== 'Uint8Array' && type !== 'Float32Array')
        || typeof data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
        throw new Error('malformed worker binary value')
      }
      if (data.length > Math.ceil(maxBytes / 3) * 4) throw new Error('worker binary payload exceeds byte limit')
      const decoded = Buffer.from(data, 'base64')
      bytes += decoded.length
      if (bytes > maxBytes || decoded.toString('base64') !== data) throw new Error('worker binary payload exceeds limit or is noncanonical')
      if (type === 'Uint8Array') return new Uint8Array(decoded)
      if (decoded.length % 4 !== 0) throw new Error('malformed Float32Array worker value')
      const result = new Float32Array(decoded.length / 4)
      for (let i = 0; i < result.length; i++) result[i] = decoded.readFloatLE(i * 4)
      return result
    }
    if (direction === 'encode' && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new Error(`unsupported worker value: ${item.constructor?.name ?? 'object'}`)
    }
    return Object.fromEntries(Object.entries(item).map(([key, v]) => [key, visit(v, depth + 1)]))
  }
  return visit(value, 0)
}

/** Explicit host-selected, serialized configuration only; never pass grants or env. */
export interface WorkerRequestOptions {
  readonly configuration?: Readonly<JsonObject>
  readonly signal?: AbortSignal
}

type RequestKind = 'invoke' | 'inspect' | 'load' | 'unload'
interface Pending {
  readonly id: string
  readonly kind: RequestKind
  readonly resolve: (value: Record<string, unknown>) => void
  readonly reject: (error: Error) => void
  readonly resolvePath?: (candidate: string) => string | Promise<string>
}

/** Shared envelope guard; every protocol frame is bounded before this runs. */
export function workerFrame(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!isWorkerObject(value) || typeof value['kind'] !== 'string'
    || Object.keys(value).some(key => !fields.includes(key))) throw new Error('malformed protocol frame')
}
export function workerId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
}

/**
 * One managed extension worker process.
 *
 * Spawn is LAZY: the first invocation starts the child, and later invocations
 * reuse it. A child that exits is replaced on the next invocation; the
 * in-flight calls at exit time fault with EXTENSION_FAULT.
 */
export class ManagedExtensionWorker {
  readonly extensionId: string
  readonly generation: number
  readonly #entryPath: string
  readonly #nodePath: string
  readonly #limits: Required<WorkerLimits>
  readonly #diagnostics: (line: string) => void
  readonly #scrubbed: Record<string, string>
  #child: ChildProcess | undefined
  #ready = false
  #buffer = ''
  #stderrTail = ''
  #sequence = 0
  #pending = new Map<string, Pending>()
  #disposed = false
  #starting: Promise<void> | undefined
  #disposing: Promise<void> | undefined
  #diagnosticBytes = 0
  #brokerPending = new Set<string>()

  private constructor(options: ManagedWorkerOptions) {
    this.extensionId = options.extensionId
    this.generation = options.generation
    this.#entryPath = options.entryPath
    this.#nodePath = options.nodePath ?? process.execPath
    this.#diagnostics = options.diagnostics ?? (line => { process.stderr.write(`${line}\n`) })
    this.#limits = {
      maxLineBytes: options.limits?.maxLineBytes ?? 1024 * 1024,
      maxInputBytes: options.limits?.maxInputBytes ?? 4 * 1024 * 1024,
      readyTimeoutMs: options.limits?.readyTimeoutMs ?? 30_000,
      killTimeoutMs: options.limits?.killTimeoutMs ?? 5_000,
      resolvePathTimeoutMs: options.limits?.resolvePathTimeoutMs ?? 5_000,
    }
    for (const value of Object.values(this.#limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('worker limits must be positive safe integers')
    }
    this.#scrubbed = scrubbedEnv(process.env, options.envPassthrough)
  }

  /** Build a worker; nothing is spawned until the first invocation. */
  static create(options: ManagedWorkerOptions): ManagedExtensionWorker {
    return new ManagedExtensionWorker(options)
  }

  /** Whether the worker process is currently alive. */
  get alive(): boolean {
    return this.#child !== undefined && this.#child.exitCode === null && this.#child.signalCode === null
  }

  /** The worker's pid, when it has one. */
  get pid(): number | undefined {
    return this.alive ? this.#child?.pid : undefined
  }

  /** How many invocations are in flight. */
  get inFlight(): number {
    return this.#pending.size
  }

  /**
   * Run one invocation in the managed process.
   *
   * The caller's abort cancels the invocation BY MESSAGE; a child that does
   * not settle within `killTimeoutMs` after cancellation is killed and the
   * call fails with EXTENSION_FAULT — a hung extension can never hang the
   * caller. There is no normal inference deadline here; a caller-owned request
   * timeout can abort its signal. Killing this shared process also faults all
   * noncancelled in-flight calls, without labelling them caller cancellations.
   * Every failure here is a ManagementError with the SDK's own vocabulary;
   * nothing propagates from the child as a raw throw.
   * @param request - which deployment to call, with what input.
   * @returns the extension's payload.
   * @throws ManagementError on worker fault, timeout, protocol violation or a
   *   refused input.
   */
  async invoke(request: {
    readonly implementationId: string
    readonly input: JsonObject
    readonly signal?: AbortSignal
    readonly configuration?: Readonly<JsonObject>
    /** Trusted host authority for THIS request only. Omitted means deny. */
    readonly resolvePath?: (candidate: string) => string | Promise<string>
  }): Promise<JsonObject> {
    const result = await this.#request('invoke', {
      implementationId: request.implementationId, input: request.input,
      ...(request.configuration === undefined ? {} : { configuration: request.configuration }),
    }, request)
    return result['value'] as JsonObject
  }

  /** Inspect the exact manifest model, entirely in the managed process. */
  async inspect(modelId: string, options: WorkerRequestOptions = {}): Promise<ProviderInspectionV1> {
    const result = await this.#request('inspect', { modelId, ...(options.configuration === undefined ? {} : { configuration: options.configuration }) }, options)
    return result['inspection'] as unknown as ProviderInspectionV1
  }

  /** Load ONLY handles explicitly prepared and verified by the host. No auto-load. */
  async load(modelId: string, options: WorkerRequestOptions & { readonly assets: Readonly<PreparedAssetMapV1> }): Promise<void> {
    const assets = options.assets.assetIds.map(id => {
      const handle = options.assets.get(id)
      if (!workerId(id) || handle === undefined || typeof handle.path !== 'string' || typeof handle.digest !== 'string') throw new Error('invalid host-prepared asset handle')
      return { id, path: handle.path, digest: handle.digest }
    })
    if (new Set(assets.map(asset => asset.id)).size !== assets.length) throw new Error('duplicate host-prepared asset id')
    await this.#request('load', { modelId, assets, ...(options.configuration === undefined ? {} : { configuration: options.configuration }) }, options)
  }

  /** Release a selected model provider's loaded resources without disposing it. */
  async unload(modelId: string, options: WorkerRequestOptions = {}): Promise<void> {
    await this.#request('unload', { modelId, ...(options.configuration === undefined ? {} : { configuration: options.configuration }) }, options)
  }

  async #request(kind: RequestKind, payload: Record<string, unknown>, request: WorkerRequestOptions & {
    readonly resolvePath?: (candidate: string) => string | Promise<string>
  }): Promise<Record<string, unknown>> {
    if (this.#disposed) {
      throw new ManagementError(
        'EXTENSION_FAULT',
        'invoke',
        `the worker for ${this.extensionId} was disposed`,
        'Activate the extension generation again; a disposed worker does not serve calls.',
      )
    }
    const id = `${kind === 'invoke' ? 'inv' : kind}-${this.extensionId}-${++this.#sequence}`
    let input: unknown
    let serialized: string
    try {
      if (kind === 'invoke' && !isWorkerObject(payload['input'])) throw new Error('worker input must be an object')
      if (payload['configuration'] !== undefined && !isWorkerObject(payload['configuration'])) throw new Error('configuration must be an object')
      if (kind === 'invoke' ? !workerId(payload['implementationId']) : !workerId(payload['modelId'])) throw new Error('invalid model or implementation id')
      input = workerWire(payload, 'encode', this.#limits.maxInputBytes)
      serialized = JSON.stringify(input)
    } catch (error) {
      throw new ManagementError('EXTENSION_FAULT', 'invoke', `worker input serialization failed: ${String(error)}`,
        'Use JSON values or supported bounded Uint8Array/Float32Array media values.')
    }
    if (Buffer.byteLength(serialized, 'utf8') > this.#limits.maxInputBytes) {
      throw new ManagementError(
        'EXTENSION_FAULT',
        'invoke',
        `the input for ${String(payload['implementationId'] ?? payload['modelId'])} is ${Buffer.byteLength(serialized, 'utf8')} bytes, `
        + `over the ${this.#limits.maxInputBytes} worker limit`,
        'Reduce the input, or raise the worker input limit deliberately.',
      )
    }
    await this.#ensureReady()

    if (this.#disposed) throw new ManagementError('EXTENSION_FAULT', 'invoke', 'the worker was disposed during startup', 'Create a new worker.')
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      // This is a cancellation-settle deadline, NOT an inference timeout.
      // Even an unref'd timer fires while the child pipes keep the loop alive,
      // so do not create it at all until the caller actually aborts.
      let killTimer: ReturnType<typeof setTimeout> | undefined
      const cleanup = (): void => {
        clearTimeout(killTimer)
        request.signal?.removeEventListener('abort', abortListener)
        this.#pending.delete(id)
      }
      const settled = (value: Record<string, unknown>): void => {
        cleanup()
        resolve(value)
      }
      const failed = (error: Error): void => {
        cleanup()
        reject(error)
      }
      const abortListener = (): void => {
        // Cancellation BY MESSAGE: only a process kill can bound a child that
        // ignores abort (including a runaway synchronous handler).
        if (killTimer !== undefined || !this.#pending.has(id)) return
        killTimer = setTimeout(() => {
          failed(new ManagementError(
            'EXTENSION_FAULT',
            'invoke',
            `the worker for ${this.extensionId} did not settle the cancelled invocation within ${this.#limits.killTimeoutMs} ms; the process was killed`,
            'The extension hung; it will be restarted on the next invocation.',
          ))
          this.#kill('a cancelled invocation did not settle')
          // All calls share this process. Peers fail as worker faults, NOT as
          // caller cancellations; clear their listeners/deadlines immediately.
          this.#faultAll('the process was killed because another invocation did not settle after abort')
        }, this.#limits.killTimeoutMs)
        try {
          this.#write({ kind: 'cancel', invokeId: id })
        } catch (error) {
          failed(error as Error)
        }
      }
      this.#pending.set(id, { id, kind, resolve: settled, reject: failed, ...(request.resolvePath === undefined ? {} : { resolvePath: request.resolvePath }) })

      try {
        // An already-aborted signal must still send invoke BEFORE cancel, so
        // the child has an invocation controller to receive the cancellation.
        this.#write({ id, kind, ...(input as Record<string, unknown>) })
        if (request.signal?.aborted === true) abortListener()
        else request.signal?.addEventListener('abort', abortListener, { once: true })
      } catch (error) {
        failed(error as Error)
      }
    })
  }

  /** Spawn (or re-spawn) the child and wait for its `ready` line. */
  async #ensureReady(): Promise<void> {
    if (this.#starting !== undefined) return this.#starting
    this.#starting = this.#start()
    try { await this.#starting } finally { this.#starting = undefined }
  }

  async #start(): Promise<void> {
    if (this.alive && this.#ready) return
    this.#kill('a fresh worker is taking over')
    this.#ready = false
    this.#buffer = ''

    const child = spawn(this.#nodePath, [
      fileURLToPath(CHILD_URL),
      '--entry', this.#entryPath,
      '--extension-id', this.extensionId,
      '--generation', String(this.generation),
      '--max-line-bytes', String(this.#limits.maxLineBytes),
      '--max-input-bytes', String(this.#limits.maxInputBytes),
      '--resolve-path-timeout-ms', String(this.#limits.resolvePathTimeoutMs),
    ], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      env: this.#scrubbed,
      windowsHide: true,
    })
    this.#child = child

    child.stdio[3]?.on('error', () => {
      if (this.#child !== child) return
      this.#kill('the worker path broker pipe failed')
      this.#faultAll('the worker path broker pipe failed')
    })
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { if (this.#child === child) this.#ingest(chunk) })
    child.stdin?.on('error', () => {
      if (this.#child !== child) return
      this.#kill('the worker input pipe failed')
      this.#faultAll('the worker input pipe failed')
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.length === 0) continue
        this.#stderrTail = `${this.#stderrTail}${line}\n`.slice(-64 * 1024)
        this.#diagnostics(`[worker ${this.extensionId}] ${line}`)
      }
    })
    child.on('exit', (code, signal) => {
      if (this.#child !== child) return
      this.#ready = false
      this.#faultAll(`the worker process exited (code ${String(code)}, signal ${String(signal)})`)
    })
    child.on('error', error => {
      if (this.#child !== child) return
      this.#ready = false
      this.#faultAll(`the worker process could not be spawned: ${error.message}`)
    })

    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        child.stdout?.removeListener('data', check)
        child.removeListener('exit', exited)
        child.removeListener('error', errored)
      }
      const timer = setTimeout(() => {
        cleanup()
        this.#kill('the worker did not answer ready')
        reject(new ManagementError(
          'EXTENSION_FAULT',
          'invoke',
          `the worker for ${this.extensionId} did not report ready within ${this.#limits.readyTimeoutMs} ms`,
          'Inspect the extension entry; a worker that cannot start is refused, not waited on.',
        ))
      }, this.#limits.readyTimeoutMs)
      const check = (): void => {
        if (this.#ready) {
          cleanup()
          resolve()
        }
      }
      const exited = (): void => {
        cleanup()
        reject(new ManagementError(
          'EXTENSION_FAULT',
          'invoke',
          `the worker for ${this.extensionId} exited before reporting ready`,
          'Inspect the extension entry and the worker diagnostics.',
        ))
      }
      const errored = (error: Error): void => {
        cleanup()
        reject(new ManagementError(
          'EXTENSION_FAULT',
          'invoke',
          `the worker for ${this.extensionId} could not be spawned: ${error.message}`,
          'Inspect the Node executable and the worker diagnostics.',
        ))
      }
      child.stdout?.on('data', check)
      child.once('exit', exited)
      child.once('error', errored)
      check()
    })
  }

  /** Consume stdout bytes, honoring the line cap and dispatching messages. */
  #ingest(chunk: string): void {
    this.#buffer += chunk
    let newline = this.#buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline)
      this.#buffer = this.#buffer.slice(newline + 1)
      this.#dispatch(line)
      if (this.#child === undefined) { this.#buffer = ''; return }
      newline = this.#buffer.indexOf('\n')
    }
    // The un-terminated tail counts against the cap: a child streaming
    // endless bytes without a newline is a framing violation.
    if (Buffer.byteLength(this.#buffer, 'utf8') > this.#limits.maxLineBytes) {
      this.#kill('a protocol line exceeded the length cap')
      this.#faultAll(`a protocol line exceeded the ${this.#limits.maxLineBytes}-byte cap`)
    }
  }

  /** Both per-line and per-worker lifetime diagnostic caps. */
  #diagnose(message: string): void {
    const remaining = 64 * 1024 - this.#diagnosticBytes
    if (remaining <= 0) return
    const line = Buffer.from(message).subarray(0, Math.min(4096, remaining)).toString('utf8')
    this.#diagnosticBytes += Buffer.byteLength(line)
    this.#stderrTail = `${this.#stderrTail}${line}\n`.slice(-64 * 1024)
    try { this.#diagnostics(`[worker ${this.extensionId}] ${line}`) } catch { /* diagnostics cannot fault the host */ }
  }

  /** Dedicated reply pipe preserves InvocationContextV1's synchronous API. */
  #resolvePath(message: Record<string, unknown>): void {
    const child = this.#child
    const id = message['id'] as string
    const invokeId = message['invokeId'] as string
    const pending = this.#pending.get(invokeId)
    if (this.#brokerPending.has(id) || this.#brokerPending.size >= 128 || pending?.kind !== 'invoke') {
      this.#kill('invalid path broker request scope')
      this.#faultAll('invalid path broker request scope')
      return
    }
    this.#brokerPending.add(id)
    let finished = false
    const reply = (answer: { path: string } | { error: string }): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      this.#brokerPending.delete(id)
      if (child !== this.#child) return
      const line = JSON.stringify({ kind: 'resolvePathResult', id, invokeId, ...answer })
      if (Buffer.byteLength(line) > this.#limits.maxLineBytes) {
        this.#kill('path broker result exceeded line cap'); this.#faultAll('path broker result exceeded line cap'); return
      }
      ;(child?.stdio[3] as Writable | undefined)?.write(`${line}\n`, error => {
        if (error && child === this.#child) { this.#kill('path broker pipe failed'); this.#faultAll('path broker pipe failed') }
      })
    }
    const timer = setTimeout(() => reply({ error: 'path access denied: host path broker deadline elapsed' }), this.#limits.resolvePathTimeoutMs)
    void Promise.resolve().then(async () => {
      if (pending.resolvePath === undefined) throw new Error('path access denied: managed worker has no configured host path authority')
      const path = await pending.resolvePath(message['candidate'] as string)
      if (typeof path !== 'string' || path.length === 0 || Buffer.byteLength(path) > 16 * 1024) throw new Error('path access denied: invalid canonical host path')
      if (!this.#pending.has(invokeId)) throw new Error('path access denied: request is no longer active')
      reply({ path })
    }).catch(error => reply({ error: String(error).slice(0, 4096) }))
  }

  /** Dispatch one child line. */
  #dispatch(line: string): void {
    if (Buffer.byteLength(line, 'utf8') > this.#limits.maxLineBytes) {
      this.#kill('a protocol line exceeded the length cap')
      this.#faultAll(`a protocol line exceeded the ${this.#limits.maxLineBytes}-byte cap`)
      return
    }
    let message: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (!isWorkerObject(parsed) || typeof parsed['kind'] !== 'string') throw new Error('expected an object with a string kind')
      message = parsed
      const kind = message['kind']
      const keys = kind === 'ready' ? ['kind'] : kind === 'result' ? ['kind', 'id', 'result']
        : kind === 'error' ? ['kind', 'id', 'message'] : kind === 'fault' ? ['kind', 'message']
          : kind === 'resolvePath' ? ['kind', 'id', 'invokeId', 'candidate'] : []
      if (keys.length === 0) throw new Error('unknown protocol kind')
      workerFrame(message, keys)
      if ((kind === 'result' || kind === 'error' || kind === 'resolvePath') && !workerId(message['id'])) throw new Error('invalid response id')
      if ((kind === 'error' || kind === 'fault') && typeof message['message'] !== 'string') throw new Error('invalid error message')
      if (kind === 'resolvePath' && (!workerId(message['invokeId']) || typeof message['candidate'] !== 'string'
        || Buffer.byteLength(message['candidate']) > 16 * 1024)) throw new Error('malformed path broker request')
      if (kind === 'result') {
        const result = workerWire(message['result'], 'decode', this.#limits.maxLineBytes)
        if (!isWorkerObject(result)) throw new Error('result must be a typed object')
        const type = result['type']
        const pending = this.#pending.get(message['id'] as string)
        if (!['invoke', 'inspect', 'load', 'unload'].includes(type as string) || (pending !== undefined && type !== pending.kind)) throw new Error('mismatched result type')
        if (Object.keys(result).some(key => !(type === 'invoke' ? ['type', 'value'] : type === 'inspect' ? ['type', 'inspection'] : ['type']).includes(key))) throw new Error('unknown typed result fields')
        if (type === 'invoke' && (!isWorkerObject(result['value']) || ArrayBuffer.isView(result['value']))) throw new Error('invoke result must be an object')
        if (type === 'inspect') {
          const inspection = result['inspection']
          if (!isWorkerObject(inspection) || !['unavailable', 'needs-preparation', 'preparing', 'prepared-cold', 'loading', 'ready', 'busy', 'failed'].includes(inspection['readiness'] as string)
            || !Array.isArray(inspection['features']) || !inspection['features'].every(item => typeof item === 'string')
            || !Array.isArray(inspection['missing']) || !inspection['missing'].every(item => isWorkerObject(item) && typeof item['name'] === 'string' && typeof item['reason'] === 'string')
            || (inspection['reason'] !== undefined && typeof inspection['reason'] !== 'string')
            || (inspection['runtimeVersion'] !== undefined && typeof inspection['runtimeVersion'] !== 'string')) throw new Error('malformed inspection result')
        }
        message['result'] = result
      }
    } catch (error) {
      this.#kill('the worker wrote a malformed protocol line')
      this.#faultAll(`the worker wrote a malformed protocol line: ${String(error)}`)
      return
    }
    switch (message.kind) {
      case 'ready': {
        this.#ready = true
        break
      }
      case 'resolvePath': {
        this.#resolvePath(message)
        break
      }
      case 'result': {
        const pending = this.#pending.get(message.id as string)
        if (pending === undefined) break
        pending.resolve(message['result'] as Record<string, unknown>)
        break
      }
      case 'error': {
        const pending = this.#pending.get(message.id as string)
        if (pending === undefined) break
        pending.reject(new ManagementError(
          'EXTENSION_FAULT',
          'invoke',
          `the extension worker reported a failure: ${message.message ?? 'no message'}`,
          'The extension failed in its managed process; the host was not affected.',
        ))
        break
      }
      case 'fault': {
        this.#kill('the worker reported a fault')
        this.#faultAll(message.message as string)
        break
      }
      default: {
        this.#kill('the worker sent an unknown message kind')
        this.#faultAll(`the worker sent an unknown message kind ${JSON.stringify(message.kind)}`)
      }
    }
  }

  /** Reject every in-flight call because the child can no longer serve them. */
  #faultAll(reason: string): void {
    const fault = new ManagementError(
      'EXTENSION_FAULT',
      'invoke',
      `the managed worker for ${this.extensionId} failed: ${reason}`,
      'The extension runs in a managed process; restart it by invoking again, or inspect the worker diagnostics.',
    )
    for (const pending of this.#pending.values()) pending.reject(fault)
    this.#pending.clear()
  }

  /** Write one protocol line to the child. */
  #write(message: unknown): void {
    const line = JSON.stringify(message)
    if (Buffer.byteLength(line, 'utf8') > this.#limits.maxLineBytes) {
      throw new ManagementError(
        'EXTENSION_FAULT',
        'invoke',
        'the worker request exceeded the protocol line cap',
        'Reduce the request, or raise the worker line limit deliberately.',
      )
    }
    this.#child?.stdin?.write(`${line}\n`)
  }

  /** Terminate the child, hard. Idempotent. */
  #kill(reason: string): void {
    const child = this.#child
    this.#child = undefined
    this.#ready = false
    if (child === undefined) return
    this.#diagnose(`killing: ${reason}`)
    try {
      child.stdin?.end()
    } catch { /* the pipe may already be closed */ }
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    } catch { /* an already-dead child needs no kill */ }
  }

  /**
   * Dispose the worker: ask the child to stop, then kill it after the grace.
   */
  async dispose(): Promise<void> {
    if (this.#disposing !== undefined) return this.#disposing
    this.#disposed = true
    this.#faultAll('the worker was disposed')
    this.#disposing = (async () => {
      const child = this.#child
      if (child === undefined || !this.alive) return
      await new Promise<void>(resolve => {
        const finish = (): void => {
          clearTimeout(timer)
          child.removeListener('exit', finish)
          resolve()
        }
        const timer = setTimeout(() => {
          this.#kill('dispose grace elapsed')
          // Join the killed child too; SIGKILL completion is observed, not guessed.
          if (child.exitCode !== null || child.signalCode !== null) finish()
        }, this.#limits.killTimeoutMs)
        child.once('exit', finish)
        try { this.#write({ kind: 'dispose', reason: 'shutdown' }) } catch { this.#kill('dispose write failed') }
        if (child.exitCode !== null || child.signalCode !== null) finish()
      })
    })()
    return this.#disposing
  }
}
