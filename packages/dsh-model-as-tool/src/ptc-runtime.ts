/**
 * PTC runtime integration: a guarded mount and the ONE authorized tool pipeline.
 *
 * The directive is explicit that this is repository work, not a missing upstream product:
 *
 *   "Use the existing `@deepseek-ai/dsh-ptc-runtime` interface and a compatible
 *    `@deepseek-ai/dsh-ptc-runtime-node` backend. Compose its filesystem, subprocess,
 *    sandbox, and policy dependencies. **Do not call `ctx.ptcRuntime` without mounting a
 *    provider and then report the missing service as an unavailable upstream product.**"
 *
 *   "Native DSH PTC and external `tool_mode_run` must use the SAME authorized tool
 *    pipeline."
 *
 * Two facts shape the mount, both discovered by reading the DSH source rather than guessed:
 *
 * 1. **The base bundle already mounts a provider.** `packages/bundle/base/cordis.patch.yml`
 *    registers `@deepseek-ai/dsh-ptc-runtime-node`, so an UNGUARDED `ctx.plugin(...)`
 *    throws `service "ptcRuntime" has been registered at <...>`. The guard is mandatory in
 *    both outcomes, so it is not conditional on which host this finds.
 * 2. **The composed services are the inject list**, not something the plugin supplies:
 *    `static inject = ['fs','subprocess','sandbox','sandboxPolicy']`. Mounting them here
 *    would hit the same duplicate-service throw.
 *
 * Everything that touches Cordis or DSH is INJECTED, so the guard logic and the authorized
 * pipeline are testable without a live runtime.
 *
 * @module @try-works/dsh-model-as-tool/ptc-runtime
 */

import {
  authorizeProgramTools,
  describeRejections,
  type ProgramAuthority,
  type ToolBinding,
} from './ptc-authority.ts'

/** The service key the abstract runtime registers itself under. */
export const PTC_SERVICE = 'ptcRuntime'

/** A Cordis-like context, narrowed to what this module needs. */
export interface PtcHostContext {
  /** Resolve a service, or `undefined` when nothing provides it. */
  get(service: string): unknown
  /** Mount a plugin. */
  plugin(plugin: unknown, config?: Record<string, unknown>): Promise<unknown> | unknown
}

/** What a mount attempt did. */
export interface MountOutcome {
  /**
   * Whether this call performed the mount.
   *
   * `false` means the host ALREADY had a provider, which is the expected case inside a
   * full DSH deployment and is a SUCCESS rather than a skip — the distinction is what
   * stops "already present" being reported as "unavailable".
   */
  readonly mounted: boolean
  /** Why it did not mount, when it did not. */
  readonly reason?: 'already-provided' | 'backend-unavailable'
  /** The service that is now usable, whichever path produced it. */
  readonly service: string
}

/**
 * Mount the Node PTC backend, but only when nothing already provides the service.
 *
 * @param ctx - the host context.
 * @param backend - the backend plugin, or `undefined` when it could not be resolved.
 * @param config - backend configuration.
 * @returns what happened.
 */
export async function mountPtcRuntimeIfAbsent(
  ctx: PtcHostContext,
  backend: unknown,
  config: Record<string, unknown> = {},
): Promise<MountOutcome> {
  /**
   * THE GUARD. Checked first, because the base bundle mounts a provider and an unguarded
   * `ctx.plugin` throws rather than being idempotent.
   */
  if (ctx.get(PTC_SERVICE) !== undefined) {
    return { mounted: false, reason: 'already-provided', service: PTC_SERVICE }
  }
  if (backend === undefined || backend === null) {
    /**
     * Reported as a REASON, not an exception: a deployment without the backend can still
     * run native tools, and failing the whole plugin load would remove working
     * functionality because an optional one is absent.
     */
    return { mounted: false, reason: 'backend-unavailable', service: PTC_SERVICE }
  }
  await ctx.plugin(backend, config)
  return { mounted: true, service: PTC_SERVICE }
}

/** The default budgets, mirroring the backend's own documented defaults. */
export const PTC_DEFAULT_BUDGETS = {
  timeoutMs: 120_000,
  maxTimeoutMs: 600_000,
  maxOutputBytes: 64 * 1024 * 1024,
  maxOldGenerationSizeMb: 512,
} as const

/** One authorized binding, ready to expose to a program. */
export interface BindingNamespace {
  /** The global the program sees, e.g. `tools`. */
  readonly global: string
  readonly functions: Record<string, ToolBinding>
}

/** A request to build the program-visible bindings. */
export interface BindingRequest {
  /** The tool names the program declares it will call. */
  readonly requested: readonly string[]
  /** What is granted and what is visible. */
  readonly authority: ProgramAuthority
  /** The global identifier the program sees. */
  readonly global?: string
  /**
   * Resolves one tool name to a binding.
   *
   * The CALLER supplies this so that native PTC and external `tool_mode_run` reach tools
   * through the same execution function rather than through two implementations of it.
   */
  readonly resolve: (name: string) => ToolBinding | undefined
}

/** The outcome of building bindings. */
export type BindingOutcome =
  | { readonly ok: true; readonly namespace: BindingNamespace }
  | { readonly ok: false; readonly message: string }

/**
 * Build the namespace a program may call (CODE-03, SEC-03).
 *
 * Refuses the WHOLE request when any name is unattainable, so a program never runs against
 * a smaller namespace than it declares.
 *
 * @param request - what to bind.
 * @returns the namespace, or the refusal message.
 */
export function buildToolBindings(request: BindingRequest): BindingOutcome {
  const decision = authorizeProgramTools({ requested: request.requested }, request.authority, request.resolve)
  if (!decision.ok) {
    return { ok: false, message: describeRejections(decision.rejections) }
  }
  const global = request.global ?? 'tools'
  /**
   * The namespace global obeys the same portability rule the backend enforces, so an
   * invalid one is refused here with a clear reason rather than by the runtime later.
   */
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(global)) {
    return {
      ok: false,
      message: `the binding namespace "${global}" is not a language-portable identifier; `
        + 'the same namespace list must work against every backend',
    }
  }
  return { ok: true, namespace: { global, functions: decision.bindings } }
}

/**
 * The budgets a run is admitted with (RES-10).
 *
 * A requested budget is clamped to the ceiling rather than refused: a caller asking for
 * longer than policy allows gets policy's figure, which is the direction that cannot be
 * widened by asking.
 * @param requestedMs - what the caller asked for, if anything.
 * @returns the admitted budget.
 */
export function admitTimeout(requestedMs: number | null | undefined): number {
  if (requestedMs === null) {
    // `null` means "no deadline". That is a request to REMOVE a limit, so it is clamped to
    // the ceiling rather than honoured — otherwise a caller could opt out of budgeting.
    return PTC_DEFAULT_BUDGETS.maxTimeoutMs
  }
  if (requestedMs === undefined) return PTC_DEFAULT_BUDGETS.timeoutMs
  if (!Number.isFinite(requestedMs) || requestedMs <= 0) return PTC_DEFAULT_BUDGETS.timeoutMs
  return Math.min(requestedMs, PTC_DEFAULT_BUDGETS.maxTimeoutMs)
}

/**
 * Whether the confinement acceptance tests have passed on this deployment
 * (CODE-09).
 *
 * This is the SINGLE release-gate flip point. It is a module-level flag with a
 * TEST-ONLY setter so the acceptance test that eventually passes can open the
 * gate for its own proof — the "export APPEARS when the gate opens" case must be
 * executable before the gate opens in production, not exercised there for the
 * first time. Production builds leave it false.
 */
let confinementEvidence = false

/** The current confinement evidence (CODE-09). */
export function confinementDemonstrated(): boolean {
  return confinementEvidence
}

/**
 * The environment marker that arms the test seam (CODE-09).
 *
 * The setter below SHIPS in the built artifact (there is no separate test
 * bundle), so it must be inert in every normal process. It therefore refuses to
 * move the gate unless the OPERATOR started this process with an explicit
 * marker — which is itself an operator action, so opening the gate always costs
 * an operator decision and never happens by config, by import or by accident.
 * The acceptance test sets the marker; production never does.
 */
const CONFINEMENT_SEAM_ENV = 'DSH_PTC_CONFINEMENT_SEAM'
const CONFINEMENT_SEAM_TOKEN = 'open-for-acceptance-test'

/**
 * Set the confinement evidence (TEST SEAM, CODE-09).
 *
 * The setter is the seam the acceptance test uses. It is inert — throws without
 * moving anything — unless the process carries the explicit environment marker,
 * so the built artifact cannot have the gate opened by code that merely imports
 * it. A production build never sets the marker.
 * @param value - the evidence state to adopt.
 */
export function setConfinementDemonstratedForTest(value: boolean): void {
  if (process.env[CONFINEMENT_SEAM_ENV] !== CONFINEMENT_SEAM_TOKEN) {
    throw new Error(
      'the confinement evidence is a release gate; the acceptance-test seam is '
      + 'closed in this process because the operator marker is absent',
    )
  }
  confinementEvidence = value
}

/**
 * Whether generated-code execution may be exposed to callers (CODE-08, CODE-10).
 *
 * Exposure is the CONJUNCTION of two independent facts, and neither can stand in
 * for the other:
 *
 * - CODE-09: the specification's confinement tests must have passed. They have
 *   not run here, so this half is false — no configuration can open it.
 * - CODE-10: the OPERATOR must have granted hosted code execution, which is a
 *   separate consent from ordinary model-tool access. The caller passes the
 *   operator's grant in, so the gate has a real input rather than being a literal.
 *
 * A host with the grant flipped but no confinement evidence stays closed; a host
 * with confinement evidence but no operator grant stays closed too.
 * @param operatorGranted - whether the operator granted hosted code execution.
 * @returns whether a caller may be served.
 */
export function mayExposeToClients(operatorGranted: boolean): boolean {
  return operatorGranted && confinementDemonstrated()
}

/**
 * Describe why generated-code execution is withheld, naming WHICH fact is unmet.
 * @param operatorGranted - whether the operator granted hosted code execution.
 * @returns the reason callers are given.
 */
export function exposureWithheldReason(operatorGranted: boolean): string {
  if (!operatorGranted) {
    return 'generated-code execution is disabled: the operator has not granted hosted '
      + 'code execution (CODE-10); it is a separate consent from model-tool access'
  }
  return 'generated-code execution is withheld until the confinement tests pass; '
    + 'the runtime is mounted and usable in-process, and no production client is served it'
}
