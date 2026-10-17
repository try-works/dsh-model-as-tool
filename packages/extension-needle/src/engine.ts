/**
 * The engine call: argv construction and envelope reading.
 *
 * `needle.exe` is a one-shot CLI: it loads a `.cact`, answers one `--prompt`, prints one
 * JSON object on stdout, and exits. Everything this package does with the model goes
 * through the single function here, and the function is deliberately split in three:
 *
 * 1. `buildEngineArgv` is PURE. It turns a typed request into an argument vector and
 *    nothing else, so the whole surface that reaches a process — which file, which
 *    prompt, which flags — is inspectable without running anything, and a test can assert
 *    the absences (`--serve` above all) directly.
 * 2. `buildToolsDocument` is PURE and produces the `--tools` JSON as a value, so the
 *    document handed to the engine is a value in this process before it is a file on disk.
 * 3. `invokeEngine` writes the approved scratch files, runs the bridge, and reads the
 *    envelope. It is the only function that touches the filesystem or spawns.
 *
 * ## One-shot, deliberately
 *
 * The engine keeps a conversation in process memory: `--serve` accumulates turns and
 * exposes `POST /reset` to start a new one, and the C ABI has `needle_reset()`. The CLI
 * has no reset flag, so the only way to GUARANTEE a call starts from a clean state is to
 * start a new process. This module therefore never reuses an engine: every invocation is a
 * fresh `needle.exe`. That is slower by a second per call and it is worth it, because
 * "the engine might have carried state over" is not a defect a caller can detect from the
 * outside.
 *
 * @module @try-works/extension-needle/engine
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertNoListenerArgument, runProcess, type ProcessOutcome } from './process-bridge.ts'

/**
 * NDL-06: the qualified local-no-telemetry posture, enforced by THIS package's
 * code rather than assumed from the binary: every engine child process is
 * handed the documented opt-out controls. The binary's own honored variable
 * set is NOT independently verified (recorded honestly in the manifest's
 * telemetryContent), so the posture is enforced at the spawn boundary on top
 * of the bridge's scrubbed allow-list environment.
 */
export const NEEDLE_TELEMETRY_ENV = {
  NEEDLE_TELEMETRY: '0',
  DO_NOT_TRACK: '1',
} as const
import type { OfferedTool } from './contracts.ts'

/** One request to the engine. */
export interface EngineRequest {
  /** Absolute path of the verified `needle.exe`. */
  readonly enginePath: string
  /** Absolute path of the verified `needle3.cact`. */
  readonly weightsPath: string
  /** The user request, verbatim. */
  readonly prompt: string
  /** The tools the model may propose calls to. */
  readonly tools: readonly OfferedTool[]
  /** Session facts, e.g. the date and locale. */
  readonly system?: string
  /**
   * Path of the written `--tools` document, when tools are offered.
   *
   * A path rather than a value, so `buildEngineArgv` stays pure: the file is written by
   * `invokeEngine`, and the pure builder never has to know where.
   */
  readonly toolsPath?: string
  /** Response-token budget. */
  readonly maxNewTokens: number
  /** Wall-clock budget in milliseconds. */
  readonly timeoutMs: number
  /** Cap on each output stream in bytes. */
  readonly maxOutputBytes: number
  /** Thread budget, when the operator has set one. */
  readonly threads?: number
}

/** The flags the pinned engine accepts. Present so an unknown flag is a code change here
 * rather than a string built at a call site. */
export interface EngineArguments {
  readonly enginePath: string
  readonly args: readonly string[]
}

/**
 * Build the argument vector for one one-shot engine call.
 *
 * PURE, and that is the point: this is the whole process surface of the extension, so it
 * is the one function that must be testable without a process, a shell or a model.
 *
 * Every element is a SEPARATE argv entry. The prompt is one element whatever it contains —
 * quotes, ampersands, carets, newlines, a `--model` lookalike — because argv is not a
 * command line. Note the absence of `--serve` and `--port`: they are not "not passed", they
 * are refused by `assertNoListenerArgument` inside the bridge, so a future call site cannot
 * reintroduce them by assembling its own vector.
 * @param request - the typed request.
 * @returns the executable and its argument vector.
 */
export function buildEngineArgv(request: EngineRequest): EngineArguments {
  const args: string[] = ['--model', request.weightsPath]

  // The tool document, when the caller offers tools. Written before the call and named
  // here, so the vector the bridge issues is the vector this function returned.
  if (request.toolsPath !== undefined) {
    args.push('--tools', request.toolsPath)
  }

  // `--fail-input-overflow` is passed ALWAYS: a turn that would not fit the context window
  // is refused rather than silently trimmed into a different question. A silently trimmed
  // prompt produces an answer to something the caller did not ask, which is
  // indistinguishable from a wrong answer.
  args.push('--fail-input-overflow')

  if (request.system !== undefined && request.system.length > 0) {
    args.push('--system', request.system)
  }
  args.push('--max', String(request.maxNewTokens))
  if (request.threads !== undefined) {
    args.push('--threads', String(request.threads))
  }
  args.push('--prompt', request.prompt)

  // FINAL CHECK before the vector is handed back. The bridge checks again before spawning,
  // and both checks exist deliberately: this one catches a caller-supplied PROMPT or SYSTEM
  // text that is a bare listener flag — `['--system', '--serve']` is what a caller produces
  // by passing "--serve" as their system text, and an argument parser is entitled to read
  // that as the flag rather than as the value. Checking here means the defect is found while
  // the request is still a value, not after a process exists.
  assertNoListenerArgument(args)
  return { enginePath: request.enginePath, args }
}

/**
 * Build the `--tools` document the engine expects: a JSON array in OpenAI function form.
 *
 * The nested form is the documented one. Both the nested and a flat form were observed to
 * work on the pinned binary, and the nested form is what `needle.agent` itself writes — so
 * the documented shape is used rather than the shorthand that happens to work today.
 * @param tools - the offered tools.
 * @returns the document, as text.
 */
export function buildToolsDocument(tools: readonly OfferedTool[]): string {
  return JSON.stringify(
    tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    })),
    null,
    0,
  )
}

/** One function call, as the engine reports it. */
export interface EngineFunctionCall {
  readonly name: string
  readonly arguments: Record<string, unknown>
}

/** The engine's grounding report. */
export interface EngineValidation {
  readonly ungrounded: readonly unknown[]
  readonly negation: boolean
}

/** The engine's one JSON object, decoded and narrowed. */
export interface EngineEnvelope {
  /** `call` or `respond`, as the engine reports it. */
  readonly type: string
  /** Whether the engine considered the turn successful. */
  readonly success: boolean
  readonly error: string | null
  readonly errorCode: string | null
  /** Why the turn was refused, when it was. */
  readonly reason: string | null
  readonly functionCalls: readonly EngineFunctionCall[]
  /** Calls the engine withheld. Reported rather than dropped. */
  readonly suppressedCalls: readonly EngineFunctionCall[]
  readonly reasoning: string
  readonly confidence: number | null
  readonly validation: EngineValidation | null
  /** The raw object, so a caller can see a field this module does not model. */
  readonly raw: Record<string, unknown>
}

/** Why an engine call did not produce a usable envelope. */
export class EngineCallError extends Error {
  constructor(
    message: string,
    /** The bridge outcome, when a process ran. */
    readonly outcome: ProcessOutcome | undefined,
  ) {
    super(message)
    this.name = 'EngineCallError'
  }
}

/** Read a string field, or null. */
function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Read one function call, refusing a shape that is not a name plus an object. */
function readCall(value: unknown): EngineFunctionCall | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const name = record.name
  if (typeof name !== 'string' || name.length === 0) return undefined
  const rawArguments = record.arguments
  const args = typeof rawArguments === 'object' && rawArguments !== null && !Array.isArray(rawArguments)
    ? rawArguments as Record<string, unknown>
    : {}
  return { name, arguments: args }
}

/**
 * Decode the engine's stdout into an envelope.
 *
 * The engine prints ONE JSON object and nothing else on a successful run, but an engine
 * that fails mid-load prints a diagnostic and exits non-zero, and a partially written line
 * is a real possibility. So this reads the LAST non-empty line and prefers the last line
 * that parses, rather than assuming the whole stream is JSON. A caller then gets either a
 * decoded envelope or a refusal that quotes what actually arrived.
 * @param stdout - the child's stdout.
 * @returns the envelope.
 * @throws EngineCallError when no line decodes to an object.
 */
export function readEngineEnvelope(stdout: string): EngineEnvelope {
  const lines = stdout.split(/\r?\n/).filter(line => line.trim().length > 0)
  let parsed: Record<string, unknown> | undefined
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] as string
    try {
      const value = JSON.parse(line) as unknown
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>
        break
      }
    } catch {
      // Not this line; an earlier one may still be the envelope.
    }
  }
  if (parsed === undefined) {
    throw new EngineCallError(
      `the engine printed no JSON object on stdout; the last line was ${JSON.stringify(
        (lines[lines.length - 1] ?? '').slice(0, 400),
      )}`,
      undefined,
    )
  }
  const calls = Array.isArray(parsed.function_calls)
    ? parsed.function_calls.map(readCall).filter((call): call is EngineFunctionCall => call !== undefined)
    : []
  const suppressed = Array.isArray(parsed.suppressed_calls)
    ? parsed.suppressed_calls.map(readCall).filter((call): call is EngineFunctionCall => call !== undefined)
    : []
  const rawValidation = parsed.validation
  const validation = typeof rawValidation === 'object' && rawValidation !== null
    ? {
      ungrounded: Array.isArray((rawValidation as Record<string, unknown>).ungrounded)
        ? ((rawValidation as Record<string, unknown>).ungrounded as unknown[])
        : [],
      negation: (rawValidation as Record<string, unknown>).negation === true,
    }
    : null
  return {
    type: stringOrNull(parsed.type) ?? 'unknown',
    // A field the engine omits defaults to false: an envelope that does not say it
    // succeeded must not be read as one that did.
    success: parsed.success === true,
    error: stringOrNull(parsed.error),
    errorCode: stringOrNull(parsed.error_code),
    reason: stringOrNull(parsed.reason),
    functionCalls: calls,
    suppressedCalls: suppressed,
    reasoning: stringOrNull(parsed.reasoning) ?? '',
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
    validation,
    raw: parsed,
  }
}

/** What one engine call produced. */
export interface EngineResult {
  readonly envelope: EngineEnvelope
  readonly outcome: ProcessOutcome
  /** The argument vector that was issued, recorded so a caller can see exactly what ran. */
  readonly argv: readonly string[]
}

/**
 * Run one one-shot engine call.
 *
 * Approved temporary files: the `--tools` document goes into a fresh directory created by
 * `mkdtemp` under the system temp root, with a random suffix, and is removed in a `finally`
 * block. It is never written into the package, the storage directory or the caller's
 * working directory, so a hostile or merely large tool document cannot land somewhere it
 * would be read later.
 * @param request - the typed request.
 * @param signal - cancellation, forwarded to the bridge.
 * @returns the envelope and the bridge outcome.
 * @throws EngineCallError when the process failed, was cancelled, timed out, overflowed, or
 * printed nothing decodable.
 */
export async function invokeEngine(
  request: EngineRequest,
  signal?: AbortSignal,
): Promise<EngineResult> {
  const scratch = await mkdtemp(join(tmpdir(), 'extension-needle-'))
  try {
    let toolsPath: string | undefined
    if (request.tools.length > 0) {
      toolsPath = join(scratch, 'tools.json')
      await writeFile(toolsPath, buildToolsDocument(request.tools), 'utf8')
    }
    const { enginePath, args } = buildEngineArgv(
      toolsPath === undefined ? request : { ...request, toolsPath },
    )
    const outcome = await runProcess(
      {
        command: enginePath,
        args,
        cwd: scratch,
        timeoutMs: request.timeoutMs,
        maxOutputBytes: request.maxOutputBytes,
        // NDL-06: the qualified local-no-telemetry posture (see the const).
        env: { ...NEEDLE_TELEMETRY_ENV },
        ...signal === undefined ? {} : { signal },
      },
    )
    if (outcome.kind !== 'exited') {
      throw new EngineCallError(
        outcome.kind === 'cancelled'
          ? 'the invocation was cancelled and the engine process was terminated'
          : outcome.kind === 'timed-out'
            ? `the engine exceeded its ${request.timeoutMs} ms budget and was terminated`
            : outcome.kind === 'output-overflow'
              ? `the engine exceeded the ${request.maxOutputBytes}-byte output cap and was terminated`
              : outcome.note ?? 'the engine process could not be started',
        outcome,
      )
    }
    if (outcome.exitCode !== 0) {
      // The engine's own diagnostics go to stderr, and they are the most useful thing to
      // report: "cannot load ...: unreadable" and "no model loaded" both arrive this way.
      throw new EngineCallError(
        `the engine exited with code ${String(outcome.exitCode)}: `
        + `${(outcome.stderr.trim() || outcome.stdout.trim() || '(no output)').slice(0, 400)}`,
        outcome,
      )
    }
    return { envelope: readEngineEnvelope(outcome.stdout), outcome, argv: args }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}
