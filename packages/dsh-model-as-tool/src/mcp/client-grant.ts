/**
 * Per-client external grants (SEC-04, SEC-01 tails, SEC-03).
 *
 * Before this module, every external MCP call dispatched through the HOST'S OWN
 * interactive grant: the surface's `execute` ran `ctx.tools.execute` under the operator's
 * grant, with `callerKind: 'interactive'` — so an external client was the operator as far
 * as authorization and receipts were concerned, and the round-65 review recorded exactly
 * that as a false claim to the contrary. SEC-04 requires an ISOLATED external execution
 * context per client instead.
 *
 * This module is the grant half of that isolation. It derives a grant per AUTHENTICATED
 * client at the point where the identity is already verified — the HTTP layer, after the
 * static-token or OAuth check — and the derived identity travels with the call as CALLER
 * IDENTITY, never as a second dispatch path:
 *
 * - the DEFAULT allowed set is the live published surface (the registered contracts plus
 *   `tool_mode_run` — never `model_tools`, which stays host-local);
 * - a per-client override narrows that set, so two clients can hold different grants;
 * - the grant carries the CLIENT'S OWN `grantId` (`external:<clientId>`), recording
 *   policy and limits, so a receipt records who called rather than pretending the
 *   operator did — and a requested tool list can never extend any of it (BASE-05).
 *
 * @module @try-works/dsh-model-as-tool/mcp/client-grant
 */

import { DEFAULT_LIMITS, type GrantLimits } from '../authority.ts'

/** The per-client grant policy an operator configures. */
export interface ClientGrantConfig {
  /**
   * The default allowed-tools set every authenticated client receives.
   *
   * Absent means the LIVE published surface at request time — the surface is the
   * operator's export decision, so deriving the default from it keeps one source of
   * truth. A non-empty list narrows the default for every client.
   */
  readonly allowedTools?: readonly string[]
  /** Whether the client's calls may be recorded; defaults to `receipts` (OBS-02). */
  readonly recordingPolicy?: 'none' | 'receipts'
  /** Resource limits; defaults are {@link DEFAULT_LIMITS}. */
  readonly limits?: Partial<GrantLimits>
  /** Per-client overrides, keyed by the authenticated client identity. */
  readonly perClient?: Readonly<Record<string, {
    /** The client's own allowed set; absent inherits the default above. */
    readonly allowedTools?: readonly string[]
    readonly recordingPolicy?: 'none' | 'receipts'
    readonly limits?: Partial<GrantLimits>
  }>>
}

/**
 * The authenticated caller an external request runs as (SEC-04).
 *
 * Pure identity plus the derived grant — nothing executable, nothing caller-supplied.
 */
export interface ExternalCaller {
  /** The authenticated client identity (static-token `clientId` or OAuth subject). */
  readonly clientId: string
  /** The client's OWN grant identity, recorded in receipts — never the operator's. */
  readonly grantId: string
  /** The tool names this client may invoke. */
  readonly allowedTools: readonly string[]
  readonly recordingPolicy: 'none' | 'receipts'
  readonly limits: GrantLimits
}

/** Read a valid recording policy, defaulting to the observable one. */
function recordingPolicyOf(value: 'none' | 'receipts' | undefined): 'none' | 'receipts' {
  return value === 'none' ? 'none' : 'receipts'
}

/**
 * Derive one client's grant at authentication time.
 *
 * The client identity is INPUT — it must already be verified by the transport; nothing
 * here authenticates, so a caller cannot reach this function with a chosen identity.
 * @param clientId - the authenticated client identity.
 * @param config - the operator's per-client grant policy, or undefined for the default.
 * @param surfaceTools - the tool names the host currently publishes.
 * @returns the derived caller identity and grant.
 */
export function resolveClientGrant(
  clientId: string,
  config: ClientGrantConfig | undefined,
  surfaceTools: readonly string[],
): ExternalCaller {
  const perClient = config?.perClient?.[clientId]
  const requested = perClient?.allowedTools ?? config?.allowedTools ?? surfaceTools
  const onSurface = new Set(surfaceTools)
  // H3: the grant is INTERSECTED with the live published surface. An override is a
  // static list, and a typo in it must not silently grant a tool the operator never
  // meant to name — while an override that names a tool the surface does not (yet)
  // publish grants nothing for it rather than a phantom allowance. The DEFAULT
  // (the surface itself) passes through the intersection unchanged.
  const allowedTools = requested.filter(name => onSurface.has(name))
  return {
    clientId,
    // The client's OWN identity: a receipt that says `external:<id>` names the caller
    // without pretending the operator made the call.
    grantId: `external:${clientId}`,
    allowedTools,
    recordingPolicy: recordingPolicyOf(perClient?.recordingPolicy ?? config?.recordingPolicy),
    limits: { ...DEFAULT_LIMITS, ...config?.limits, ...perClient?.limits },
  }
}
