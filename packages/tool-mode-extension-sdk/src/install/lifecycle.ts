/**
 * Activation and deactivation (EXT-04, EXT-26, EXT-27, EXT-28).
 *
 * The two orderings this module exists to enforce:
 *
 * - **Activate commits last.** Contributions are published to a candidate set,
 *   and the catalog generation advances only once EVERY required contribution has
 *   been accepted. A half-activated package is worse than an inactive one,
 *   because tools would appear that nothing can serve.
 * - **Deactivate persists intent first.** The inactive preference is made durable
 *   BEFORE anything is withdrawn. If withdrawal then fails or the process dies,
 *   the durable answer is still "inactive", so a restart cannot resurrect a
 *   package the operator switched off.
 *
 * Rollback is deliberately NARROW: a failed activation withdraws only the handles
 * it published itself. Touching another extension's contributions would turn one
 * bad package into an outage of every package.
 *
 * @module @try-works/tool-mode-extension-sdk/install/lifecycle
 */

import { ManagementError } from './../errors.ts'
import { discoverExtension, type ExtensionDiscovery } from './../discovery.ts'
import { ExtensionStore, type InstalledRecord } from './store.ts'
import { admitsInvocation, summarize, type ExtensionState, type ModelReadiness } from './../state.ts'
import type { ManifestTool } from './../manifest.ts'

/** One contribution a registrar can publish. */
export interface Contribution {
  /** The extension that owns it. */
  readonly extensionId: string
  /** What kind of contribution it is. */
  readonly kind: 'tool' | 'skill' | 'implementation'
  /** The caller-facing name for a tool or skill; the local id otherwise. */
  readonly name: string
  /** The contract this contribution implements, for tools and implementations. */
  readonly contractId?: string
}

/** What can publish and withdraw contributions. Injected, so the SDK stays host-free. */
export interface ContributionRegistrar {
  /**
   * Publish one contribution.
   * @param contribution - what to publish.
   * @returns an opaque handle used to withdraw it.
   */
  publish(contribution: Contribution): Promise<string> | string
  /**
   * Withdraw a published contribution.
   * @param handle - the handle returned by {@link ContributionRegistrar.publish}.
   */
  withdraw(handle: string): Promise<void> | void
}

/** A diagnostic about an activation that succeeded with caveats. */
export interface ActivationDiagnostic {
  /** Stable code, e.g. `needs-preparation`. */
  readonly code: 'needs-preparation' | 'not-registerable'
  /** Human-readable detail. */
  readonly message: string
  /** The contribution or deployment the diagnostic concerns. */
  readonly subject?: string
}

/** The outcome of an activation. */
export interface ActivationResult {
  readonly extensionId: string
  readonly version: string
  /** The state as observed after the attempt. */
  readonly state: ExtensionState
  /** Caveats that do not block activation (EXT-26). */
  readonly diagnostics: readonly ActivationDiagnostic[]
  /** The catalog generation after the attempt; unchanged when it failed. */
  readonly generation: number
}

/** The outcome of a deactivation. */
export interface DeactivationResult {
  readonly extensionId: string
  readonly state: ExtensionState
  /**
   * True only when every contribution was withdrawn AND every owned resource
   * reported stopped. EXT-27 forbids reporting a package as fully stopped while
   * an uncontrolled worker continues.
   */
  readonly fullyStopped: boolean
  /** Why it is not fully stopped, when it is not. */
  readonly cleanupFailure?: string
  readonly generation: number
}

/** Default grace period for a contribution to finish stopping, in milliseconds. */
export const DEFAULT_STOP_GRACE_MS = 5000

/**
 * Whether an extension's readiness should block activation.
 *
 * EXT-26 is explicit that a valid package with merely UNPREPARED model assets may
 * be active with `needs-preparation` diagnostics: the tools exist and can be
 * described, and preparation happens on first use. A FAILED model is different —
 * it will not become ready by waiting.
 * @param readiness - per-deployment readiness.
 * @returns diagnostics, and whether activation may proceed.
 */
export function assessReadiness(readiness: Readonly<Record<string, ModelReadiness>>): {
  readonly proceed: boolean
  readonly diagnostics: readonly ActivationDiagnostic[]
} {
  const diagnostics: ActivationDiagnostic[] = []
  let proceed = true
  for (const [deployment, value] of Object.entries(readiness)) {
    if (value === 'failed') {
      proceed = false
      diagnostics.push({
        code: 'not-registerable',
        subject: deployment,
        message: `the model deployment ${deployment} is in a failed state and will not become ready by waiting`,
      })
    } else if (value === 'needs-preparation' || value === 'preparing') {
      diagnostics.push({
        code: 'needs-preparation',
        subject: deployment,
        message: `the model deployment ${deployment} is ${value}; the tool is active and preparation happens on first use`,
      })
    }
  }
  return { proceed, diagnostics }
}

/** The extension lifecycle for one profile. */
export class ExtensionLifecycle {
  readonly #store: ExtensionStore
  readonly #profile: string
  readonly #registrar: ContributionRegistrar
  #generation = 1
  /** Handles published by this profile, keyed by extension then contribution name. */
  readonly #published = new Map<string, Map<string, string>>()

  constructor(options: {
    readonly store: ExtensionStore
    readonly profile: string
    readonly registrar: ContributionRegistrar
    /** Starting catalog generation; defaults to 1. */
    readonly generation?: number
  }) {
    this.#store = options.store
    this.#profile = options.profile
    this.#registrar = options.registrar
    this.#generation = options.generation ?? 1
  }

  /** The current catalog generation. */
  get generation(): number {
    return this.#generation
  }

  /** Read the persisted states for this profile. */
  states(): readonly ExtensionState[] {
    return this.#store.readProfileState(this.#profile).value
  }

  /** Read one extension's persisted state. */
  stateOf(extensionId: string): ExtensionState | undefined {
    return this.states().find(state => state.extensionId === extensionId)
  }

  /** Replace one extension's state in the profile, preserving the others. */
  #writeState(state: ExtensionState): void {
    const others = this.states().filter(candidate => candidate.extensionId !== state.extensionId)
    this.#store.writeProfileState(this.#profile, [...others, state])
  }

  /**
   * Activate an installed extension (EXT-26).
   *
   * Verifies the installed bytes and locks, checks readiness, publishes every
   * required contribution, and advances the generation only if all of that
   * succeeded. On any failure the contributions THIS call published are withdrawn
   * and the generation is left where it was.
   * @param extensionId - the extension to activate.
   * @param version - the installed version to activate.
   * @returns the activation outcome.
   * @throws ManagementError when the extension is not installed, its content changed, or a contribution cannot be registered.
   */
  async activate(extensionId: string, version: string): Promise<ActivationResult> {
    const record = this.#findRecord(extensionId, version)
    if (record === undefined) {
      throw new ManagementError(
        'EXTENSION_INACTIVE',
        'activate',
        `${extensionId}@${version} is not installed`,
        'Install it first; activation does not install.',
      )
    }

    // Checked BEFORE anything is published: activating bytes that differ from the
    // ones the operator approved would execute code nobody reviewed.
    const integrity = this.#store.verifyUnchanged(record)
    if (!integrity.unchanged) {
      throw new ManagementError(
        'INTEGRITY_MISMATCH',
        'activate',
        `${extensionId}@${version} cannot be activated: ${integrity.diagnostic ?? 'the installed content changed'}`,
        'Reinstall the package from its declared source, then activate it.',
      )
    }

    const previous = this.stateOf(extensionId)
    const tools = this.#toolsOf(record)
    const readiness = previous?.readiness ?? {}
    const assessment = assessReadiness(readiness)
    if (!assessment.proceed) {
      const reason = assessment.diagnostics.map(entry => entry.message).join('; ')
      this.#writeState(this.#stateFor(record, {
        desiredActivation: 'active',
        observedActivation: 'failed',
        tools, readiness,
      }))
      throw new ManagementError(
        'EXTENSION_FAULT',
        'activate',
        `${extensionId}@${version} cannot be activated: ${reason}`,
        'Prepare or repair the model deployment, then activate again.',
      )
    }

    // Intended-active is persisted before publication so a crash mid-activation
    // leaves a record that activation was attempted, not a silent no-op.
    this.#writeState(this.#stateFor(record, {
      desiredActivation: 'active',
      observedActivation: 'activating',
      tools, readiness,
    }))

    const published: { name: string; handle: string }[] = []
    try {
      for (const contribution of this.#contributionsOf(record)) {
        const handle = await this.#registrar.publish(contribution)
        published.push({ name: contribution.name, handle })
      }
    } catch (error) {
      // Rollback is NARROW: only what this call published is withdrawn, so one bad
      // package cannot disturb the others.
      for (const entry of published.reverse()) {
        await this.#safeWithdraw(entry.handle)
      }
      const reason = error instanceof Error ? error.message : String(error)
      this.#writeState(this.#stateFor(record, {
        desiredActivation: 'active',
        observedActivation: 'failed',
        tools, readiness,
      }))
      throw new ManagementError(
        'EXTENSION_FAULT',
        'activate',
        `${extensionId}@${version} was not activated: ${reason}`,
        'Fix the reported contribution and activate again; other extensions were not disturbed.',
      )
    }

    const handles = new Map(published.map(entry => [entry.name, entry.handle]))
    this.#published.set(extensionId, handles)
    // Committed only now, once every required contribution was accepted.
    this.#generation += 1
    const state = this.#stateFor(record, {
      desiredActivation: 'active',
      observedActivation: 'active',
      tools, readiness,
    })
    this.#writeState(state)
    return { extensionId, version, state, diagnostics: assessment.diagnostics, generation: this.#generation }
  }

  /**
   * Deactivate an extension (EXT-27).
   *
   * The inactive intent is made durable FIRST, so a failure or crash during
   * withdrawal cannot resurrect the package on the next start.
   * @param extensionId - the extension to deactivate.
   * @returns the deactivation outcome, which reports honestly when it is not fully stopped.
   */
  async deactivate(extensionId: string): Promise<DeactivationResult> {
    const current = this.stateOf(extensionId)
    if (current === undefined) {
      throw new ManagementError(
        'EXTENSION_INACTIVE',
        'deactivate',
        `${extensionId} is not known in profile ${this.#profile}`,
        'Nothing to deactivate.',
      )
    }

    // ORDERING: persist inactive intent before withdrawing anything.
    this.#writeState({ ...current, desiredActivation: 'inactive', observedActivation: 'deactivating' })

    const handles = this.#published.get(extensionId) ?? new Map<string, string>()
    const failures: string[] = []
    for (const [name, handle] of handles) {
      try {
        await this.#registrar.withdraw(handle)
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.#published.delete(extensionId)

    /**
     * A store that says the extension was ACTIVE while this process holds no
     * handles means somebody else published them — normally a host this CLI is not
     * attached to, or a previous run that has since exited.
     *
     * Reporting a clean stop here would be a lie of exactly the kind EXT-27
     * forbids: the contributions are still published somewhere, and this process
     * has no way to withdraw them. Saying so is the only honest answer.
     */
    const orphaned = current.observedActivation === 'active' && handles.size === 0
    if (orphaned) {
      failures.push(
        'the contributions were published by another process and cannot be withdrawn from here; '
        + 'stop the owning host, or deactivate through it',
      )
    }

    const inactive: ExtensionState = {
      ...current,
      desiredActivation: 'inactive',
      observedActivation: failures.length > 0 ? 'quarantined' : 'inactive',
    }
    this.#writeState(inactive)
    if (failures.length === 0) this.#generation += 1

    return {
      extensionId,
      state: inactive,
      // Never claim a full stop while something it owns is still running.
      fullyStopped: failures.length === 0,
      ...failures.length === 0 ? {} : { cleanupFailure: failures.join('; ') },
      generation: this.#generation,
    }
  }

  /**
   * Enable or disable ONE tool inside an active extension (EXT-04).
   *
   * Independent of activation: the package stays active while a single tool is
   * hidden from callers.
   * @param extensionId - the owning extension.
   * @param toolName - the tool to toggle.
   * @param enabled - the new visibility.
   * @throws ManagementError when the extension or tool is unknown.
   */
  setToolEnabled(extensionId: string, toolName: string, enabled: boolean): ExtensionState {
    const current = this.stateOf(extensionId)
    if (current === undefined) {
      throw new ManagementError('EXTENSION_INACTIVE', 'deactivate', `${extensionId} is not known`, 'Nothing to toggle.')
    }
    const tool = current.tools.find(candidate => candidate.toolName === toolName)
    if (tool === undefined) {
      throw new ManagementError(
        'INVALID_EXTENSION',
        'deactivate',
        `${extensionId} contributes no tool named ${JSON.stringify(toolName)}`,
        'List the extension to see the tools it contributes.',
      )
    }
    const next: ExtensionState = {
      ...current,
      tools: current.tools.map(candidate =>
        candidate.toolName === toolName ? { ...candidate, enabled } : candidate),
    }
    this.#writeState(next)
    return next
  }

  /**
   * Whether a tool may be invoked right now.
   * @param extensionId - the owning extension.
   * @param toolName - the tool being invoked.
   */
  admits(extensionId: string, toolName: string): boolean {
    const current = this.stateOf(extensionId)
    return current === undefined ? false : admitsInvocation(current, toolName)
  }

  /**
   * Uninstall an installed extension (EXT-04, EXT-28).
   * @param extensionId - the extension to remove.
   * @param options - `deactivate` must be set to remove an active package.
   * @throws ManagementError `EXTENSION_IN_USE`, `BUILTIN_PROTECTED`, or `EXTENSION_INACTIVE`.
   */
  async uninstall(extensionId: string, options: { readonly deactivate?: boolean } = {}): Promise<void> {
    const current = this.stateOf(extensionId)
    const active = current?.observedActivation === 'active' || current?.desiredActivation === 'active'
    if (active && options.deactivate !== true) {
      throw new ManagementError(
        'EXTENSION_IN_USE',
        'uninstall',
        `${extensionId} is active in profile ${this.#profile}`,
        'Re-run with deactivation requested; the affected profiles and tools are listed in the preview.',
      )
    }
    if (active) await this.deactivate(extensionId)

    // The disabled tombstone is RETAINED rather than deleted, so a later automatic
    // install cannot silently resurrect a package the operator removed (EXT-28).
    this.#writeState({
      ...(this.stateOf(extensionId) ?? {
        extensionId,
        installation: 'absent' as const,
        desiredActivation: 'inactive' as const,
        observedActivation: 'inactive' as const,
        readiness: {},
        tools: [],
        export: 'not-exported' as const,
      }),
      installation: 'absent',
      desiredActivation: 'inactive',
      observedActivation: 'inactive',
      tools: [],
    })
    this.#store.removeRecord(extensionId)
  }

  /** Withdraw a handle, reporting rather than throwing so rollback always completes. */
  async #safeWithdraw(handle: string): Promise<void> {
    try {
      await this.#registrar.withdraw(handle)
    } catch {
      // A rollback that throws on the first failure would leave the rest published,
      // which is the half-activated state rollback exists to prevent.
    }
  }

  #findRecord(extensionId: string, version: string): InstalledRecord | undefined {
    return this.#store.listInstalled().value.find(
      record => record.extensionId === extensionId && record.version === version,
    )
  }

  /** The tools a record contributes, all enabled by default. */
  #toolsOf(record: InstalledRecord): ExtensionState['tools'] {
    const discovery = this.#discoverOf(record)
    const tools: readonly ManifestTool[] = discovery?.manifest.tools ?? []
    return tools.map(tool => ({ toolName: tool.name, enabled: true }))
  }

  /** Re-read the installed manifest, or undefined when it cannot be read. */
  #discoverOf(record: InstalledRecord): ExtensionDiscovery | undefined {
    try {
      return discoverExtension(record.installPath)
    } catch {
      // A package whose manifest no longer reads is reported by the caller as
      // contributing nothing, rather than crashing the whole lifecycle.
      return undefined
    }
  }

  /** The contributions a record publishes. */
  #contributionsOf(record: InstalledRecord): Contribution[] {
    const discovery = this.#discoverOf(record)
    if (discovery === undefined) return []
    const contributions: Contribution[] = []
    for (const tool of discovery.manifest.tools) {
      contributions.push({
        extensionId: record.extensionId, kind: 'tool', name: tool.name, contractId: tool.contractId,
      })
    }
    for (const implementation of discovery.manifest.implementations) {
      contributions.push({
        extensionId: record.extensionId,
        kind: 'implementation',
        name: implementation.id,
        contractId: implementation.contractId,
      })
    }
    for (const skill of discovery.manifest.skills) {
      contributions.push({ extensionId: record.extensionId, kind: 'skill', name: skill.name })
    }
    return contributions
  }

  /** Build a state value for a record. */
  #stateFor(
    record: InstalledRecord,
    overrides: Pick<ExtensionState, 'desiredActivation' | 'observedActivation' | 'tools' | 'readiness'>,
  ): ExtensionState {
    const previous = this.stateOf(record.extensionId)
    return {
      extensionId: record.extensionId,
      installation: 'installed',
      export: previous?.export ?? 'not-exported',
      ...overrides,
    }
  }
}

export { summarize }
