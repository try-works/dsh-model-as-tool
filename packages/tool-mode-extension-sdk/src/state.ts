/**
 * Orthogonal extension state (EXT-25).
 *
 * The governing rule is that ONE boolean cannot describe six independent facts.
 * A package can be installed but never activated; activated but its model not yet
 * prepared; prepared but its tool disabled for this profile; enabled but not
 * exported to an external client. Collapsing those into `enabled` is how a UI ends
 * up claiming a tool works when a caller cannot reach it.
 *
 * This module models each dimension separately and derives the operator-facing
 * summary from them, so the summary can never disagree with the parts.
 *
 * @module @try-works/tool-mode-extension-sdk/state
 */

/** Host-owned package inventory state (EXT-25, dimension 1). */
export type InstallationState =
  | 'absent'
  | 'staged'
  | 'installed'
  | 'uninstalling'
  | 'cleanup-pending'

/** What the operator asked for, per named profile (EXT-25, dimension 2). */
export type DesiredActivation = 'active' | 'inactive'

/** What the host observes, per named profile (EXT-25, dimension 3). */
export type ObservedActivation =
  | 'inactive'
  | 'activating'
  | 'active'
  | 'deactivating'
  | 'failed'
  | 'quarantined'

/** Per-deployment model readiness (EXT-25, dimension 4; SPEC §11 states). */
export type ModelReadiness =
  | 'unprepared'
  | 'preparing'
  | 'ready'
  | 'resident'
  | 'failed'

/** Per-profile tool selection (EXT-25, dimension 5). */
export interface ToolSelection {
  readonly toolName: string
  /** Whether the tool is enabled in this profile. */
  readonly enabled: boolean
  /** The implementation selected to serve it, when the host chose one. */
  readonly selectedImplementation?: string
}

/** Separate server/client grants and licence decisions (EXT-25, dimension 6). */
export type ExportAuthorization = 'not-exported' | 'granted' | 'denied' | 'revoked'

/** The complete orthogonal state of one extension in one profile. */
export interface ExtensionState {
  /** Extension identity. */
  readonly extensionId: string
  /** Host-owned package inventory state; not profile-scoped. */
  readonly installation: InstallationState
  /** What the operator asked for in this profile. */
  readonly desiredActivation: DesiredActivation
  /** What the host observes in this profile. */
  readonly observedActivation: ObservedActivation
  /** Model readiness keyed by exact deployment identity, not by model name. */
  readonly readiness: Readonly<Record<string, ModelReadiness>>
  /** Tool selection in this profile. */
  readonly tools: readonly ToolSelection[]
  /** Export authorization, which is independent of local enablement. */
  readonly export: ExportAuthorization
}

/** The operator-facing summary, derived rather than stored. */
export type ExtensionSummary =
  /** Available and callable. */
  | 'ready'
  /** Installed and activated, but a model is not prepared yet. */
  | 'preparing'
  /** Installed and activated, but every tool is disabled here. */
  | 'no-tools-enabled'
  /** Installed, deliberately not activated. */
  | 'inactive'
  /** Activation failed or the host quarantined it. */
  | 'faulted'
  /** Uninstall started; deletion is pending. */
  | 'cleanup-pending'
  /** Not installed. */
  | 'absent'

/**
 * Derive the operator-facing summary from the orthogonal state.
 *
 * Ordering is the whole point: a faulted activation outranks a readiness problem,
 * because reporting "preparing" for a package whose activation failed would tell
 * an operator to wait for something that will never finish.
 * @param state - the orthogonal state.
 * @returns the summary an operator surface should show.
 */
export function summarize(state: ExtensionState): ExtensionSummary {
  if (state.installation === 'absent') return 'absent'
  if (state.installation === 'cleanup-pending' || state.installation === 'uninstalling') {
    return 'cleanup-pending'
  }
  if (state.observedActivation === 'failed' || state.observedActivation === 'quarantined') {
    return 'faulted'
  }
  // Desired-inactive is reported as inactive even mid-transition, because the
  // operator's intent is what the surface is describing.
  if (state.desiredActivation === 'inactive') return 'inactive'
  if (state.observedActivation !== 'active') return 'inactive'

  const readiness = Object.values(state.readiness)
  if (readiness.some(value => value === 'failed')) return 'faulted'
  if (readiness.some(value => value === 'unprepared' || value === 'preparing')) return 'preparing'

  if (!state.tools.some(tool => tool.enabled)) return 'no-tools-enabled'
  return 'ready'
}

/**
 * Whether a caller may invoke a tool right now.
 *
 * Export authorization is deliberately NOT part of this check: a local caller
 * being able to call a tool says nothing about whether an external client may, and
 * conflating the two is exactly what EXT-25 separates.
 * @param state - the orthogonal state.
 * @param toolName - the tool being invoked.
 * @returns whether the invocation is admitted.
 */
export function admitsInvocation(state: ExtensionState, toolName: string): boolean {
  if (state.installation !== 'installed') return false
  if (state.desiredActivation !== 'active') return false
  if (state.observedActivation !== 'active') return false
  const tool = state.tools.find(candidate => candidate.toolName === toolName)
  if (tool === undefined || !tool.enabled) return false
  return Object.values(state.readiness).every(value => value === 'ready' || value === 'resident')
}

/** Build the state of a newly installed but not yet activated extension. */
export function installedInactive(extensionId: string): ExtensionState {
  return {
    extensionId,
    installation: 'installed',
    desiredActivation: 'inactive',
    observedActivation: 'inactive',
    readiness: {},
    tools: [],
    export: 'not-exported',
  }
}
