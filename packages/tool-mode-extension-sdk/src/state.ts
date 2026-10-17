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

/**
 * Per-deployment readiness (EXT-25 dimension 4; the RES-04 state set).
 *
 * The eight states answer TWO questions, and conflating them is the mistake RES-04
 * names: readiness determines whether a call is POSSIBLE, while residency determines
 * how it is ADMITTED. A prepared-but-cold deployment is callable — it simply loads
 * first — and reporting it as uncallable would withdraw a working tool and make the
 * tool surface flicker on every warm/cold transition.
 */
export type ModelReadiness =
  | 'unavailable'
  | 'needs-preparation'
  | 'preparing'
  | 'prepared-cold'
  | 'loading'
  | 'ready'
  | 'busy'
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
  /**
   * The process that published this extension's surface, when it is active.
   *
   * Publication handles are IN-MEMORY, so a fresh process cannot see whether the
   * handles it lacks died with a previous process or belong to a live one. Recording
   * the owner makes that distinction durable: a restarted process may restore an
   * `active` extension whose owner is gone, and must refuse one whose owner is alive.
   */
  readonly ownerPid?: number
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
  if (readiness.some(value => value === 'failed' || value === 'unavailable')) return 'faulted'
  // A COLD deployment is not "preparing": it is usable and will load on first use, so
  // reporting it as preparing would tell an operator to wait for something that
  // already works.
  if (readiness.some(value => value === 'needs-preparation' || value === 'preparing' || value === 'loading')) {
    return 'preparing'
  }

  if (!state.tools.some(tool => tool.enabled)) return 'no-tools-enabled'
  return 'ready'
}

/**
 * Whether a caller may invoke a tool right now, using ONLY persisted state.
 *
 * Export authorization is deliberately NOT part of this check: a local caller
 * being able to call a tool says nothing about whether an external client may, and
 * conflating the two is exactly what EXT-25 separates.
 *
 * SCOPE — read this before using it as an admission decision. This helper sees the
 * state FILE, which records operator intent and readiness; it cannot see which
 * contributions were actually PUBLISHED, because that is process-local. It therefore
 * answers "is this tool enabled and is every declared deployment callable", which is
 * NOT the same question as "was this tool published and can it be dispatched".
 *
 * `ExtensionLifecycle.admits()` is the admission decision: it additionally requires the
 * tool to be in the committed published surface, and it evaluates readiness per BINDING
 * rather than over every deployment. This function remains the pure-state predicate the
 * state tests exercise, and a host that used it alone would admit tools that publication
 * withheld. Prefer `ExtensionLifecycle.admits()` wherever a lifecycle is available.
 * @param state - the orthogonal state.
 * @param toolName - the tool being invoked.
 * @returns whether the persisted state alone admits the invocation.
 */
export function admitsInvocation(state: ExtensionState, toolName: string): boolean {
  if (state.installation !== 'installed') return false
  if (state.desiredActivation !== 'active') return false
  if (state.observedActivation !== 'active') return false
  const tool = state.tools.find(candidate => candidate.toolName === toolName)
  if (tool === undefined || !tool.enabled) return false
  // PREPARATION determines callability; RESIDENCY does not. An earlier version
  // required `ready` here, which made a prepared-but-cold deployment uncallable and
  // so withdrew a tool that works. `prepared-cold`, `loading` and `busy` are all
  // callable; only a deployment that is unavailable, unprepared or failed is not.
  return Object.values(state.readiness).every(value => CALLABLE_READINESS.has(value))
}

/**
 * The readiness states in which a call is possible (RES-04).
 *
 * A cold but prepared deployment is callable: the call simply loads first.
 */
const CALLABLE_READINESS: ReadonlySet<ModelReadiness> = new Set<ModelReadiness>([
  'prepared-cold',
  'loading',
  'ready',
  'busy',
])

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
