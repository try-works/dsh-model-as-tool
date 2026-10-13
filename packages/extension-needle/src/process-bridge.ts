/**
 * The managed process bridge: how this extension runs a native executable.
 *
 * Needle has no npm package. The native route is a 1.5 MB `needle.exe` that answers one
 * prompt and exits, so the bridge that launches it is the entire runtime surface of this
 * package. Every property below exists because its absence is a class of defect that a
 * diff review does not catch:
 *
 * - **Argument arrays, never a shell.** The prompt, the tool schemas and the system text
 *   all originate with a caller, so any of them can contain `"`, `&`, `|`, `^` or a
 *   newline. Building a command LINE would hand those characters to `cmd.exe`, which is
 *   the difference between "the model read a prompt" and "the host ran a command". The
 *   bridge therefore only ever produces `argv`, and `shell` is hard-coded to `false`.
 * - **A scrubbed environment.** A child inherits `process.env` by default, which on a
 *   developer or CI machine carries `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `HF_TOKEN`
 *   and every proxy credential in the session. A model process has no business holding
 *   any of them, so the bridge builds the child environment from a closed allow-list and
 *   never merges the parent's.
 * - **Bounded I/O.** A native engine that writes an unbounded amount to stderr will
 *   exhaust memory before it is read, and `maxBuffer`-style options that merely TRUNCATE
 *   leave a half-read stream and a live child. This bridge counts bytes as they arrive
 *   and KILLS the child when either stream passes its cap, then reports a limit breach
 *   rather than a partial answer.
 * - **Cancellation and a timeout that both really terminate.** An `AbortSignal` that only
 *   detaches the listener leaves an orphaned engine holding 80 MB of weights and a lock
 *   on the weights file. Both paths kill the child and report `cancelled`/`timed-out`;
 *   neither is allowed to decay into an empty success.
 * - **No listener, ever.** `needle.exe` contains the `--serve` HTTP server: its import
 *   table names `WS2_32.dll` and its strings carry `WSAStartup`, `listen`, `bind` and
 *   `http://127.0.0.1:%d`. The bridge refuses that argv structurally (see
 *   `assertNoListenerArgument`), because "we simply do not pass it" is a convention and a
 *   refused argument is an invariant.
 *
 * This module NEVER touches the network itself. It imports from `node:child_process`,
 * `node:buffer` and `node:path` and nothing else; `tests/process-bridge.test.ts` asserts
 * that structurally as well as behaviourally.
 *
 * @module @try-works/extension-needle/process-bridge
 */

import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { join } from 'node:path'

/**
 * Environment variables the child may inherit, by exact name.
 *
 * Deliberately tiny, and deliberately a POSITIVE list. A deny-list would have to
 * enumerate every secret a machine might hold and would be wrong the moment someone
 * exports a new one; this list is closed, so an unlisted variable is absent by
 * construction rather than by remembering to exclude it.
 */
const ENV_ALLOW_LIST: readonly string[] = [
  // The loader and the C runtime need this to resolve anything at all.
  'PATH',
  // Windows itself: `GetSystemDirectory`, the locale tables and the CRT's own lookups
  // consult it, and a child without it fails before `main()`.
  'SystemRoot',
  // Temp space. `TEMP` and `TMP` are both here because Windows toolchains disagree
  // about which one they read.
  'TEMP',
  'TMP',
  // Present on some Windows images, absent on others; harmless metadata only.
  'SystemDrive',
  'windir',
  'NUMBER_OF_PROCESSORS',
]

/**
 * Argument flags that would make the engine listen on a socket, or name a port.
 *
 * Checked as PREFIXES against `key=value` forms as well as exact matches, so
 * `--port=8080` is refused by the same rule as `--port 8080`.
 */
const LISTENER_FLAGS: readonly string[] = ['--serve', '--port']

/** Default cap on each output stream, in bytes. */
export const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024

/** Default cap on bytes written to a child's stdin. Independent of the body, so a body
 * larger than the policy allows is REFUSED rather than accommodated. */
export const DEFAULT_MAX_INPUT_BYTES = 4 * 1024 * 1024

/** Default wall-clock budget for one one-shot engine call, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 120_000

/** How long a killed child is given to exit before it is reported as stubborn. */
const EXIT_GRACE_MS = 2_000

/** Why a bridge call ended. */
export type ProcessOutcomeKind =
  /** The child exited on its own; the exit code says whether it succeeded. */
  | 'exited'
  /** The caller's `AbortSignal` fired, and the child was killed. */
  | 'cancelled'
  /** The wall-clock budget expired, and the child was killed. */
  | 'timed-out'
  /** A stream passed its byte cap, and the child was killed. */
  | 'output-overflow'
  /** The child could not be started at all (missing file, bad cwd, EACCES). */
  | 'spawn-failed'

/** The result of one bridge call. A discriminated union so a caller cannot read the
 * exit code of a call that never exited. */
export interface ProcessOutcome {
  readonly kind: ProcessOutcomeKind
  /** Present for `exited` only. */
  readonly exitCode?: number | null
  /** Decoded stdout. Always bounded by `maxOutputBytes`. */
  readonly stdout: string
  /** Decoded stderr. Always bounded by `maxOutputBytes`. */
  readonly stderr: string
  /** Exact bytes accepted on stdout, which is what the cap is enforced against. */
  readonly stdoutBytes: number
  /** Exact bytes accepted on stderr. */
  readonly stderrBytes: number
  /** Wall-clock duration of the call. */
  readonly durationMs: number
  /** A human-readable explanation for every non-`exited` outcome. */
  readonly note?: string
}

/** One bridge request. */
export interface ProcessRequest {
  /** Absolute path of the executable. Never a command string. */
  readonly command: string
  /** The argument vector, each element passed to the process as ONE argument. */
  readonly args: readonly string[]
  /** Working directory. */
  readonly cwd?: string
  /** Extra environment entries, on top of the allow-list. Never `process.env`. */
  readonly env?: Readonly<Record<string, string>>
  /** Cancellation. An aborted signal kills the child. */
  readonly signal?: AbortSignal
  /** Wall-clock budget in milliseconds. */
  readonly timeoutMs?: number
  /** Cap on EACH output stream in bytes. */
  readonly maxOutputBytes?: number
  /** Cap on bytes written to the child's stdin. */
  readonly maxInputBytes?: number
}

/** The input the bridge accepts when a body is supplied. */
export interface ProcessInput {
  readonly body?: string
}

/**
 * Refuse an argument vector that would open a listener.
 *
 * `needle.exe --serve` binds an HTTP server on 127.0.0.1:8080 whose turns accumulate into
 * one conversation, so it is simultaneously a network surface and a stateful one. The
 * directive for this slice forbids a public engine listener, and the deployment is
 * one-shot; making that a REFUSAL rather than an omission means a later change that
 * threads a caller-controlled flag through cannot reintroduce it quietly.
 * @param args - the proposed argument vector.
 * @throws Error naming the offending element.
 */
export function assertNoListenerArgument(args: readonly string[]): void {
  for (const arg of args) {
    const flag = LISTENER_FLAGS.find(candidate => arg === candidate || arg.startsWith(`${candidate}=`))
    if (flag !== undefined) {
      throw new Error(
        `the argument ${JSON.stringify(arg)} would start the engine's HTTP listener; `
        + `this extension runs one-shot processes only and never passes ${flag}`,
      )
    }
  }
}

/**
 * Lower-case a Windows environment name.
 *
 * Windows environment names are case-INSENSITIVE, so `Path`, `PATH` and `path` are the
 * same variable to the loader. Comparing them case-sensitively would let the allow-list
 * miss a real variable whose casing differs on another image, which is exactly how a
 * "scrubbed" environment turns out not to be scrubbed.
 * @param name - the variable name.
 * @returns the comparison key.
 */
function envKey(name: string): string {
  return process.platform === 'win32' ? name.toLowerCase() : name
}

/**
 * Build the child environment from a closed allow-list.
 *
 * The parent environment is READ for the allow-listed names and is never spread. That
 * ordering matters: `{ ...process.env, PATH }` looks equivalent and is not — it forwards
 * every secret in the session, and a later reader has to audit the spread rather than
 * this function.
 * @param extra - additional entries a caller has justified, e.g. a locale.
 * @param parent - the environment to read from; defaults to the process's own.
 * @returns the complete environment for the child.
 */
export function buildScrubbedEnv(
  extra: Readonly<Record<string, string>> = {},
  parent: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const allowed = new Set(ENV_ALLOW_LIST.map(envKey))
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue
    if (!allowed.has(envKey(name))) continue
    env[name] = value
  }
  // An extra entry is applied LAST and is the caller's explicit statement, so it may
  // override an allow-listed value. It can never bring back an excluded name, because the
  // allow-list is checked against the PARENT above and `extra` is the caller's own data.
  for (const [name, value] of Object.entries(extra)) {
    if (value !== undefined) env[name] = value
  }
  return env
}

/**
 * The names present in a child environment, for diagnostics and for tests.
 *
 * Exposed so a test can assert the SHAPE of the environment without depending on the
 * values on the machine running it.
 * @param env - the built environment.
 * @returns the sorted variable names.
 */
export function environmentNames(env: Readonly<Record<string, string>>): string[] {
  return Object.keys(env).sort()
}

/** Accumulates a stream with a hard byte cap, remembering whether the cap was passed. */
class BoundedSink {
  private readonly chunks: Buffer[] = []
  private accepted = 0
  private overflowed = false

  constructor(private readonly limit: number) {}

  /** Append a chunk, counting the bytes actually accepted. */
  push(chunk: Buffer): void {
    if (this.overflowed) return
    const remaining = this.limit - this.accepted
    if (chunk.length > remaining) {
      // Keep only the part that fits, so the retained text is a prefix of the real
      // output rather than a concatenation that never appeared.
      if (remaining > 0) this.chunks.push(chunk.subarray(0, remaining))
      this.accepted += Math.max(remaining, 0)
      this.overflowed = true
      return
    }
    this.chunks.push(chunk)
    this.accepted += chunk.length
  }

  /** Exact bytes accepted. */
  get bytes(): number {
    return this.accepted
  }

  /** Whether the cap was passed. */
  get exceeded(): boolean {
    return this.overflowed
  }

  /** The accepted bytes, decoded as UTF-8. */
  text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

/** Validate the numeric options once, so a bad budget fails before a process exists. */
function assertBudgets(timeoutMs: number, maxOutputBytes: number, maxInputBytes: number): void {
  for (const [name, value] of [
    ['timeoutMs', timeoutMs],
    ['maxOutputBytes', maxOutputBytes],
    ['maxInputBytes', maxInputBytes],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer, received ${String(value)}`)
    }
  }
}

/**
 * Run one managed child process.
 *
 * One-shot by design: the bridge always starts a NEW process, so there is no conversation
 * state to reset and no `POST /reset` to rely on. The engine keeps its turns in process
 * memory, so process-per-call is what makes "request-state reset" a structural property
 * rather than a promise.
 * @param request - what to run.
 * @param input - an optional stdin body.
 * @returns the outcome, which is never a thrown error for a child that ran.
 * @throws Error only for a request the bridge refuses to issue (listener flag, bad budget).
 */
export async function runProcess(
  request: ProcessRequest,
  input: ProcessInput = {},
): Promise<ProcessOutcome> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const body = input.body ?? ''
  const maxInputBytes = request.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES
  assertBudgets(timeoutMs, maxOutputBytes, maxInputBytes)
  // Refuse BEFORE spawning: a refused request must not leave a process behind.
  assertNoListenerArgument(request.args)

  const env = buildScrubbedEnv(request.env ?? {})
  const startedAt = Date.now()
  const out = new BoundedSink(maxOutputBytes)
  const err = new BoundedSink(maxOutputBytes)

  return await new Promise<ProcessOutcome>((resolve) => {
    let settled = false
    let kind: ProcessOutcomeKind | undefined
    let note: string | undefined
    /** Set once the child is gone, so the two kill paths can share one settle step. */
    let exited = false
    let graceTimer: NodeJS.Timeout | undefined

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(request.command, [...request.args], {
        // TRIPLE redundant on purpose. `shell: false` is the load-bearing one; the
        // `windowsVerbatimArguments: false` assertion documents that argv, not a command
        // line, is what reaches the process.
        shell: false,
        windowsVerbatimArguments: false,
        windowsHide: true,
        cwd: request.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({
        kind: 'spawn-failed',
        stdout: '',
        stderr: '',
        stdoutBytes: 0,
        stderrBytes: 0,
        durationMs: Date.now() - startedAt,
        note: `${request.command} could not be started: ${describe(error)}`,
      })
      return
    }

    const duration = (): number => Date.now() - startedAt

    const finish = (exitCode?: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      request.signal?.removeEventListener('abort', onAbort)
      const outcome: ProcessOutcome = {
        kind: kind ?? 'exited',
        ...kind === undefined || kind === 'exited' ? { exitCode: exitCode ?? null } : {},
        stdout: out.text(),
        stderr: err.text(),
        stdoutBytes: out.bytes,
        stderrBytes: err.bytes,
        durationMs: duration(),
        ...note === undefined ? {} : { note },
      }
      resolve(outcome)
    }

    /** Terminate the child and give it a bounded window to actually die. */
    const kill = (why: ProcessOutcomeKind, explanation: string): void => {
      if (kind === undefined) {
        kind = why
        note = explanation
      }
      if (exited) return
      try {
        child.kill('SIGKILL')
      } catch {
        // A child that died between the check and the kill is the outcome we wanted.
      }
      // The 'close' handler settles. This timer is the backstop for a process that
      // ignores termination, so the bridge can never hang on a wedged engine.
      graceTimer ??= setTimeout(() => {
        if (!settled) finish(null)
      }, EXIT_GRACE_MS)
      graceTimer.unref?.()
    }

    const onAbort = (): void => {
      kill('cancelled', 'the caller aborted the invocation, so the engine process was terminated')
    }

    const timer = setTimeout(() => {
      kill('timed-out', `the engine exceeded its ${timeoutMs} ms budget and was terminated`)
    }, timeoutMs)
    timer.unref?.()

    child.stdout?.on('data', (chunk: Buffer) => {
      out.push(chunk)
      if (out.exceeded) {
        kill(
          'output-overflow',
          `stdout passed the ${maxOutputBytes}-byte cap and the engine process was terminated`,
        )
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      err.push(chunk)
      if (err.exceeded) {
        kill(
          'output-overflow',
          `stderr passed the ${maxOutputBytes}-byte cap and the engine process was terminated`,
        )
      }
    })

    // A child whose stdin is never ended waits forever, which is a hang rather than a
    // slow answer. The body is written and the stream closed unconditionally.
    const stdin = child.stdin
    if (stdin !== null && stdin !== undefined) {
      stdin.on('error', () => {
        // EPIPE from a child that exited early is not a bridge failure; the exit code
        // already carries the real story.
        stdin.destroy()
      })
      const payload = Buffer.from(body, 'utf8')
      if (payload.length > maxInputBytes) {
        kill('output-overflow', `the stdin body is ${payload.length} bytes, over the ${maxInputBytes}-byte cap`)
      } else if (payload.length > 0) {
        stdin.write(payload)
      }
      stdin.end()
    }

    child.on('error', (error: Error) => {
      // A spawn failure arrives here rather than as a throw, so the outcome is recorded
      // and no process is left running.
      if (kind === undefined) {
        kind = 'spawn-failed'
        note = `${request.command} could not be started: ${error.message}`
      }
      finish(null)
    })
    child.on('close', (code: number | null) => {
      exited = true
      finish(code)
    })

    if (request.signal !== undefined) {
      if (request.signal.aborted) {
        // Abort-before-spawn still has to be honoured: the caller changed its mind, and
        // reporting an empty success would be a lie about work that did happen.
        onAbort()
      } else {
        request.signal.addEventListener('abort', onAbort, { once: true })
      }
    }
  })
}

/** Render an unknown thrown value as a message. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The default temporary directory for engine scratch files, under the real temp root. */
export function defaultTempDir(): string {
  const base = process.env.TEMP ?? process.env.TMP ?? '.'
  return join(base, 'extension-needle')
}
