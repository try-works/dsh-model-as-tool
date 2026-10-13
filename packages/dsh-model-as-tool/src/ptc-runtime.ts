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
 * Whether generated-code execution may be exposed to callers yet (CODE-08).
 *
 * The directive is explicit: "Do not expose generated-code execution to production
 * clients before the specification's confinement tests pass." Those tests have not run
 * here, so this returns false and the caller refuses rather than relying on a comment.
 * @returns always false until confinement is demonstrated.
 */
export function mayExposeToClients(): boolean {
  return false
}

/**
 * Describe why generated-code execution is withheld.
 * @returns the reason callers are given.
 */
export function exposureWithheldReason(): string {
  return 'generated-code execution is withheld until the confinement tests pass; '
    + 'the runtime is mounted and usable in-process, and no production client is served it'
}
