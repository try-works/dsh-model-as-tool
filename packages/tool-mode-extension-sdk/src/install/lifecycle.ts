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
import { ExtensionStore, isProcessAlive, type InstalledRecord } from './store.ts'
import { summarize, type ExtensionState, type ModelReadiness } from './../state.ts'

const CALLABLE_READINESS: ReadonlySet<ModelReadiness> = new Set<ModelReadiness>([
  'prepared-cold',
  'loading',
  'ready',
  'busy',
])
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
  /**
   * The onWithdrawal hook's own failure, when it threw or rejected. The hook is
   * a TEARDOWN observer: its error is surfaced here, never thrown — the
   * deactivation's state write has already committed and must not be lost to a
   * disposal callback that failed.
   */
  readonly hookFailure?: string
  readonly generation: number
}

/**
 * A teardown observer, invoked exactly once per withdrawn extension.
 *
 * `onWithdrawal` runs AFTER the lifecycle has finished withdrawing the
 * extension's contribution handles and BEFORE the deactivation's final state
 * write settles. A host uses it to dispose out-of-process resources (managed
 * workers, native handles) at the one moment where the durable answer is
 * already "inactive" and the registry surface is gone.
 */
export type OnWithdrawal = (extensionId: string) => void | Promise<void>

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
        message: `the model deployment ${deployment} is ${value}; working inference tools are withheld until preparation is complete`,
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
  readonly #onWithdrawal: OnWithdrawal | undefined
  #generation = 1
  readonly #operations = new Set<string>()

  #assertIdle(extensionId: string): void {
    if (this.#operations.has(extensionId)) {
      throw new ManagementError('EXTENSION_IN_USE', 'activate',
        `${extensionId} has a lifecycle operation in progress`, 'Wait for the current operation to settle, then retry.')
    }
  }

  async #exclusive<T>(extensionId: string, work: () => Promise<T>): Promise<T> {
    this.#assertIdle(extensionId)
    this.#operations.add(extensionId)
    try { return await work() } finally { this.#operations.delete(extensionId) }
  }
  /** Handles published by this profile, keyed by extension then contribution name. */
  readonly #published = new Map<string, Map<string, string>>()
  readonly #callableTools = new Map<string, ReadonlySet<string>>()
  /**
   * Extensions whose published surface THIS instance owns.
   *
   * Distinct from `#published`, which is empty once every handle has been
   * withdrawn. Reconciliation must not republish a surface another process owns:
   * a CLI attached to no host holds no handles and cannot manage one.
   */
  readonly #owned = new Set<string>()

  constructor(options: {
    readonly store: ExtensionStore
    readonly profile: string
    readonly registrar: ContributionRegistrar
    /** Starting catalog generation; defaults to 1. */
    readonly generation?: number
    /**
     * A teardown observer for host-managed out-of-process resources, invoked
     * once per withdrawn extension AFTER handle teardown and BEFORE the final
     * deactivation state write settles (see {@link OnWithdrawal}).
     */
    readonly onWithdrawal?: OnWithdrawal
  }) {
    this.#store = options.store
    this.#profile = options.profile
    this.#registrar = options.registrar
    this.#onWithdrawal = options.onWithdrawal
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
    // The EXT-30 update pointers (activeVersions/previousVersions) live in the
    // SAME profile document and are PRESERVED on every lifecycle write: the
    // commit flow writes the pointer, and the rebind's own activate/deactivate
    // must not erase it (the host's quiesce/rebind hooks call exactly these
    // lifecycle writes). A corrupt pointer read fails closed like any other
    // unreadable state — the write then proceeds WITHOUT inventing pointers.
    const pointers = this.#store.readProfilePointers(this.#profile)
    if (pointers.corrupt) {
      this.#store.writeProfileState(this.#profile, [...others, state])
      return
    }
    const { activeVersions, previousVersions } = pointers.value
    this.#store.writeProfileState(
      this.#profile,
      [...others, state],
      undefined,
      activeVersions,
      previousVersions,
    )
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
    // The store lock wraps the WHOLE operation: activation writes state, and an
    // offline CLI editing the same store must not interleave its read-modify-write
    // between this one's read and write (EXT-31).
    return this.#store.exclusive(() => this.#exclusive(extensionId, () => this.#activate(extensionId, version)))
  }

  async #activate(extensionId: string, version: string): Promise<ActivationResult> {
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
    /**
     * An extension THIS instance already has active is not a competing publication:
     * re-activating it is how a caller picks up newly recorded readiness. Refusing
     * here made preparation a dead end — every model-backed package publishes
     * `implementation` metadata handles, so the guard fired even when nothing was
     * actually serving a tool. Reconcile the surface instead.
     */
    if (previous?.observedActivation === 'active' && this.#owned.has(extensionId)) {
      const refresher = this.#store.listInstalled().value.find(candidate => candidate.extensionId === extensionId)
      const refreshedTools = this.#toolsOf(record)
      const refreshedReadiness = this.#readinessOf(record, previous.readiness)
      const refreshedDiagnostics = [...assessReadiness(refreshedReadiness).diagnostics]
      this.#writeState(this.#stateFor(record, {
        desiredActivation: 'active',
        observedActivation: 'active',
        tools: refreshedTools,
        readiness: refreshedReadiness,
      }))
      if (refresher !== undefined) await this.#reconcileSurface(extensionId, refreshedDiagnostics)
      return {
        extensionId,
        version,
        state: this.stateOf(extensionId) ?? this.#stateFor(record, {
          desiredActivation: 'active', observedActivation: 'active',
          tools: refreshedTools, readiness: refreshedReadiness,
        }),
        diagnostics: refreshedDiagnostics,
        generation: this.#generation,
      }
    }
    /**
     * ADOPTION IS NOT ACTIVATION. State saying `active` means SOMEBODY published this
     * surface. If this instance holds no handles for it, the question is whether that
     * owner is GONE (a restart: restoring is the whole point of RUN-05) or ALIVE
     * (another host: republishing would create a second owner serving the same names).
     * The recorded owner PID is the only durable way to tell them apart, because
     * handles are in-memory.
     *
     * The cases that must REFUSE are: a live foreign PID, and OUR OWN PID without
     * local ownership (another instance of this process published it). A dead or
     * absent PID is a restart of a legacy owner and may be restored.
     */
    if (previous?.observedActivation === 'active' && !this.#owned.has(extensionId)) {
      const pid = previous.ownerPid
      const foreignLive = pid !== undefined && pid !== process.pid && isProcessAlive(pid)
      const sameProcessStranger = pid === process.pid
      if (foreignLive || sameProcessStranger) {
        throw new ManagementError('EXTENSION_IN_USE', 'activate',
          `${extensionId} is already active under ${foreignLive ? `live process ${pid}` : 'another owner in this process'}`,
          'Deactivate it through the owning host before activating it here.')
      }
    }
    if ((this.#published.get(extensionId)?.size ?? 0) > 0
      || previous?.observedActivation === 'quarantined'
      || previous?.observedActivation === 'deactivating'
      || previous?.observedActivation === 'activating') {
      throw new ManagementError('EXTENSION_IN_USE', 'activate',
        `${extensionId} is already published or requires cleanup before activation`,
        'Deactivate through the owning host and confirm cleanup before activating again.')
    }
    const tools = this.#toolsOf(record)
    const readiness = this.#readinessOf(record, previous?.readiness)
    const assessment = assessReadiness(readiness)
    const diagnostics = [...assessment.diagnostics]
    if (!assessment.proceed) {
      const reason = diagnostics.map(entry => entry.message).join('; ')
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

    const published: { kind: Contribution['kind']; name: string; handle: string }[] = []
    const callableTools = new Set<string>()
    try {
      for (const contribution of this.#contributionsOf(record, readiness, diagnostics)) {
        if (contribution.kind === 'tool') callableTools.add(contribution.name)
        const handle = await this.#registrar.publish(contribution)
        published.push({ kind: contribution.kind, name: contribution.name, handle })
      }
    } catch (error) {
      // Rollback is NARROW: only what this call published is withdrawn, so one bad
      // package cannot disturb the others.
      const remaining = new Map<string, string>()
      for (const entry of published.reverse()) {
        try {
          await this.#registrar.withdraw(entry.handle)
        } catch {
          remaining.set(entry.kind ? `${entry.kind}:${entry.name}` : `unknown:${entry.name}`, entry.handle)
        }
      }
      if (remaining.size > 0) this.#published.set(extensionId, remaining)
      const reason = error instanceof Error ? error.message : String(error)
      this.#writeState(this.#stateFor(record, {
        desiredActivation: 'active',
        observedActivation: remaining.size > 0 ? 'quarantined' : 'failed',
        tools, readiness,
      }))
      throw new ManagementError(
        'EXTENSION_FAULT',
        'activate',
        `${extensionId}@${version} was not activated: ${reason}`,
        'Fix the reported contribution and activate again; other extensions were not disturbed.',
      )
    }

    const handles = new Map(published.map(entry => [`${entry.kind}:${entry.name}`, entry.handle]))
    this.#published.set(extensionId, handles)
    this.#callableTools.set(extensionId, callableTools)
    this.#owned.add(extensionId)
    // Committed only now, once every required contribution was accepted.
    this.#generation += 1
    const state = this.#stateFor(record, {
      desiredActivation: 'active',
      observedActivation: 'active',
      tools, readiness,
    })
    this.#writeState(state)
    return { extensionId, version, state, diagnostics, generation: this.#generation }
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
    return this.#store.exclusive(() => this.#exclusive(extensionId, () => this.#deactivate(extensionId)))
  }

  async #deactivate(extensionId: string): Promise<DeactivationResult> {
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
    const hadHandles = handles.size > 0
    const failures: string[] = []
    for (const [name, handle] of handles) {
      try {
        await this.#registrar.withdraw(handle)
        handles.delete(name)
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (handles.size === 0) {
      this.#published.delete(extensionId)
      this.#callableTools.delete(extensionId)
    }

    /**
     * A store that says the extension was ACTIVE while this process holds no
     * handles means somebody else published them — normally a host this CLI is not
     * attached to, or a previous run that has since exited.
     *
     * Reporting a clean stop here would be a lie of exactly the kind EXT-27
     * forbids: the contributions are still published somewhere, and this process
     * has no way to withdraw them. Saying so is the only honest answer.
     */
    const orphaned = (current.observedActivation === 'active' || current.observedActivation === 'quarantined'
      || current.observedActivation === 'deactivating' || current.observedActivation === 'activating') && !hadHandles
    if (orphaned) {
      failures.push(
        'the contributions were published by another process and cannot be withdrawn from here; '
        + 'stop the owning host, or deactivate through it',
      )
    }

    const stopped = failures.length === 0

    /**
     * onWithdrawal — a TEARDOWN OBSERVER, exactly once per withdrawn extension.
     *
     * It runs AFTER every registrar handle withdrawal has settled (successes
     * and failures alike: a host must dispose its worker in both cases) and
     * BEFORE the final state write, inside the existing store + operation
     * locks. Its failure is RECORDED, never thrown: the state write below must
     * commit even when a disposal callback misbehaves — losing the durable
     * "inactive" answer to a hook error would let a restart resurrect the
     * package the operator switched off. The error surfaces on the result.
     */
    let hookFailure: string | undefined
    if (this.#onWithdrawal !== undefined) {
      try {
        await this.#onWithdrawal(extensionId)
      } catch (error) {
        hookFailure = error instanceof Error ? error.message : String(error)
      }
    }

    const { ownerPid: _previousOwner, ...withoutOwner } = current
    const inactive: ExtensionState = {
      ...(stopped ? withoutOwner : current),
      desiredActivation: 'inactive',
      observedActivation: stopped ? 'inactive' : 'quarantined',
    }
    this.#writeState(inactive)
    // Ownership ends only with a CONFIRMED stop; a quarantined extension still has
    // live handlers this instance must be able to retry withdrawing.
    if (failures.length === 0) {
      this.#generation += 1
      this.#owned.delete(extensionId)
    }

    return {
      extensionId,
      state: inactive,
      // Never claim a full stop while something it owns is still running.
      fullyStopped: failures.length === 0,
      ...failures.length === 0 ? {} : { cleanupFailure: failures.join('; ') },
      ...hookFailure === undefined ? {} : { hookFailure },
      generation: this.#generation,
    }
  }

  /**
   * Enable or disable ONE tool inside an active extension (EXT-04).
   *
   * Independent of activation: the package stays active while a single tool is
   * hidden from callers.
   *
   * ASYNC because the toggle also reconciles the PUBLISHED surface: a disabled
   * tool is withdrawn from the registrar rather than merely remembered as off,
   * and a re-enabled one is published again. When this instance does not own the
   * surface — a CLI with no host attached — only the durable choice is recorded,
   * because it cannot manage a registry another process owns.
   * @param extensionId - the owning extension.
   * @param toolName - the tool to toggle.
   * @param enabled - the new visibility.
   * @throws ManagementError when the extension or tool is unknown.
   * @returns the state after the change.
   */
  async setToolEnabled(extensionId: string, toolName: string, enabled: boolean): Promise<ExtensionState> {
    return this.#store.exclusive(() => this.#exclusive(extensionId, () => this.#setToolEnabled(extensionId, toolName, enabled)))
  }

  async #setToolEnabled(extensionId: string, toolName: string, enabled: boolean): Promise<ExtensionState> {
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
    /**
     * INTENT IS PERSISTED BEFORE THE SURFACE MOVES. Disabling a tool that stays
     * REGISTERED would keep answering callers, which is the defect this ordering
     * exists to close; writing the choice first means a crash mid-reconcile
     * leaves the durable answer as "off" rather than silently "on".
     */
    this.#writeState(next)
    if (next.observedActivation === 'active' && this.#owned.has(extensionId)) {
      await this.#reconcileSurface(extensionId)
    }
    return this.stateOf(extensionId) ?? next
  }

  /**
   * Bring the PUBLISHED surface back in line with the current state (EXT-04).
   *
   * A tool toggle is not only a state edit: the registrar still holds the handles
   * from activation. This recomputes the desired contribution set — which already
   * encodes disabled tools, readiness gates and dependent usage skills — and then
   * withdraws what is no longer wanted and publishes what is newly wanted.
   *
   * Nothing is recomputed for an extension that is not active: a deactivated
   * package has no visible surface to reconcile, so this is a no-op there.
   * @param extensionId - the extension whose surface to reconcile.
   */
  async #reconcileSurface(extensionId: string, diagnostics: ActivationDiagnostic[] = []): Promise<void> {
    const record = this.#store.listInstalled().value.find(candidate => candidate.extensionId === extensionId)
    if (record === undefined) return

    /**
     * THE SAME INTEGRITY GATE ACTIVATION USES. Activation refuses to publish bytes
     * that changed after installation; reconcile publishes and withdraws through the
     * SAME registry, so skipping the check here would make "edit the installed
     * package, then toggle an unrelated tool" a way to run code nobody reviewed.
     */
    const integrity = this.#store.verifyUnchanged(record)
    if (!integrity.unchanged) {
      throw new ManagementError(
        'INTEGRITY_MISMATCH',
        'activate',
        `${extensionId} surface cannot be reconciled: ${integrity.diagnostic ?? 'the installed content changed'}`,
        'Reinstall the package from its declared source, then toggle the tool.',
      )
    }

    /**
     * AN UNKNOWN DESIRED SET IS NOT AN EMPTY ONE. `#contributionsOf` returns [] when
     * the manifest cannot be read, and treating that as "nothing is wanted" would
     * withdraw the ENTIRE surface — a transient AV-scanner lock or concurrent writer
     * would silently unregister every tool while the durable state still said active.
     * Refuse instead, leaving the surface exactly as it was.
     */
    const discovery = this.#discoverOf(record)
    if (discovery === undefined) {
      throw new ManagementError(
        'INVALID_EXTENSION',
        'activate',
        `${extensionId} manifest could not be read, so the published surface was left untouched`,
        'Ensure the installed package is readable, then retry.',
      )
    }

    const state = this.stateOf(extensionId)
    const previous = this.#published.get(extensionId) ?? new Map<string, string>()
    const desired = this.#contributionsOf(record, state?.readiness ?? {}, diagnostics)
    /**
     * Keyed by KIND AND NAME. A manifest may legally declare a tool named `shared`
     * and an implementation whose id is also `shared` (uniqueness is per-label), so
     * name-only keying would let one kind's survival mask the other's withdrawal.
     */
    const keyOf = (contribution: { readonly kind: string; readonly name: string }): string =>
      `${contribution.kind}:${contribution.name}`
    const desiredKeys = new Set(desired.map(keyOf))

    /**
     * A REDUNDANT TOGGLE IS A NO-OP. When the published keys already equal the
     * desired keys, there is nothing to withdraw or publish, and bumping the
     * generation would invalidate consumer caches for a surface that did not move.
     * This check ALSO makes a retry cheap: after a failed withdrawal the surviving
     * key is still present, so a retry that now succeeds is a real change and does
     * move the generation.
     */
    const existingKeys = new Set(previous.keys())
    if (existingKeys.size === desiredKeys.size && [...existingKeys].every(key => desiredKeys.has(key))) {
      return
    }

    /**
     * `live` and `visible` record what ACTUALLY exists after this pass, and they are
     * committed in the `finally` below. Mutating the stored map in place and only then
     * updating `#callableTools` would let a mid-pass failure leave admission asserting
     * a surface the registry no longer has — the exact divergence this reconcile
     * exists to remove.
     */
    const live = new Map<string, string>()
    const visible = new Set<string>()
    const failures: string[] = []

    for (const [key, handle] of [...previous]) {
      // Keys are `kind:name`, so the KIND participates in the match rather than
      // only the name: a tool and an implementation may legally share a name.
      const name = key.slice(key.indexOf(':') + 1)
      if (desiredKeys.has(key)) {
        live.set(key, handle)
        visible.add(name)
        continue
      }
      try {
        await this.#registrar.withdraw(handle)
      } catch (error) {
        // A handle that would not withdraw is STILL PUBLISHED, so it stays tracked
        // and stays visible; forgetting it would be the lie.
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
        live.set(key, handle)
        visible.add(name)
      }
    }

    for (const contribution of desired) {
      const key = keyOf(contribution)
      if (live.has(key)) continue
      try {
        const handle = await this.#registrar.publish(contribution)
        live.set(key, handle)
        visible.add(contribution.name)
      } catch (error) {
        failures.push(`${contribution.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (live.size === 0) this.#published.delete(extensionId)
    else this.#published.set(extensionId, live)
    this.#callableTools.set(extensionId, new Set(
      desired.filter(contribution => contribution.kind === 'tool' && visible.has(contribution.name))
        .map(contribution => contribution.name),
    ))
    /**
     * The surface moved (fully or partly), so consumers must see a new generation.
     * This advances BEFORE the failure is raised, because a partly-reconciled
     * surface is still a different surface and must not be served under the old
     * generation.
     */
    this.#generation += 1

    if (failures.length > 0) {
      throw new ManagementError(
        'EXTENSION_FAULT',
        'deactivate',
        `${extensionId} surface was only partly reconciled: ${failures.join('; ')}`,
        'Retry the toggle once the reported contribution can be managed; what remains published is still tracked.',
      )
    }
  }

  /**
   * Whether a tool may be invoked right now.
   * @param extensionId - the owning extension.
   * @param toolName - the tool being invoked.
   */
  admits(extensionId: string, toolName: string): boolean {
    const current = this.stateOf(extensionId)
    if (current === undefined) return false
    /**
     * ADMISSION MUST AGREE WITH PUBLICATION. The surface is exactly the tool
     * contributions this instance committed, so a tool withheld for a missing,
     * mismatched or unprepared binding is not admitted merely because its
     * enablement flag survives in state. Readiness is already folded into that
     * committed set, which also stops an UNRELATED deployment's preparation from
     * rejecting a tool whose own binding is callable.
     */
    if (!(this.#callableTools.get(extensionId)?.has(toolName) ?? false)) return false
    /**
     * Enablement and lifecycle are checked HERE rather than through
     * `admitsInvocation`, because that helper also requires EVERY declared
     * deployment to be callable. This tool's binding was already evaluated when its
     * contribution was published, so an unrelated unprepared deployment must not
     * make a callable tool inadmissible.
     */
    if (current.installation !== 'installed') return false
    if (current.desiredActivation !== 'active' || current.observedActivation !== 'active') return false
    return current.tools.find(tool => tool.toolName === toolName)?.enabled === true
  }

  /**
   * Uninstall an installed extension (EXT-04, EXT-28).
   * @param extensionId - the extension to remove.
   * @param options - `deactivate` must be set to remove an active package.
   * @throws ManagementError `EXTENSION_IN_USE`, `BUILTIN_PROTECTED`, or `EXTENSION_INACTIVE`.
   */
  async uninstall(extensionId: string, options: { readonly deactivate?: boolean } = {}): Promise<void> {
    return this.#store.exclusive(() => this.#exclusive(extensionId, () => this.#uninstall(extensionId, options)))
  }

  async #uninstall(extensionId: string, options: { readonly deactivate?: boolean }): Promise<void> {
    const current = this.stateOf(extensionId)
    const active = current?.observedActivation === 'active' || current?.desiredActivation === 'active'
      || current?.observedActivation === 'quarantined' || current?.observedActivation === 'deactivating'
      || (this.#published.get(extensionId)?.size ?? 0) > 0
    if (active && options.deactivate !== true) {
      throw new ManagementError(
        'EXTENSION_IN_USE',
        'uninstall',
        `${extensionId} is active in profile ${this.#profile}`,
        'Re-run with deactivation requested; the affected profiles and tools are listed in the preview.',
      )
    }
    if (active) {
      const stopped = await this.#deactivate(extensionId)
      if (!stopped.fullyStopped) {
        throw new ManagementError(
          'EXTENSION_IN_USE', 'uninstall',
          `${extensionId} cleanup is incomplete: ${stopped.cleanupFailure ?? 'owned resources are not confirmed stopped'}`,
          'Retry cleanup through the owning host; installed bytes and quarantine are retained.',
        )
      }
    }

    // The disabled tombstone is RETAINED rather than deleted, so a later automatic
    // install cannot silently resurrect a package the operator removed (EXT-28).
    const previous = this.stateOf(extensionId)
    const { ownerPid: _staleOwner, ...withoutOwner } = previous ?? {
      extensionId,
      installation: 'absent' as const,
      desiredActivation: 'inactive' as const,
      observedActivation: 'inactive' as const,
      readiness: {},
      tools: [],
      export: 'not-exported' as const,
    }
    this.#writeState({
      ...withoutOwner,
      installation: 'absent',
      desiredActivation: 'inactive',
      observedActivation: 'inactive',
      tools: [],
    })
    this.#callableTools.delete(extensionId)
    this.#owned.delete(extensionId)
    this.#store.removeRecord(extensionId)
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
    const previous = this.stateOf(record.extensionId)?.tools ?? []
    return tools.map(tool => {
      const previousTool = previous.find(candidate => candidate.toolName === tool.name)
      return {
        toolName: tool.name,
        enabled: previousTool?.enabled ?? true,
        // A preserved provider pick must survive re-activation too: rebuilding
        // the selection from the manifest drops it otherwise, which would undo
        // the BASE-09 migration's provider preservation on the next refresh.
        ...previousTool?.selectedImplementation === undefined ? {} : { selectedImplementation: previousTool.selectedImplementation },
      }
    })
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

  /** Default declared model deployments to needs-preparation until a host records a stronger fact. */
  #readinessOf(
    record: InstalledRecord,
    previous: Readonly<Record<string, ModelReadiness>> | undefined,
  ): Readonly<Record<string, ModelReadiness>> {
    const discovery = this.#discoverOf(record)
    const readiness: Record<string, ModelReadiness> = {}
    for (const model of discovery?.manifest.models ?? []) {
      readiness[model.id] = previous?.[model.id] ?? 'needs-preparation'
    }
    return readiness
  }

  /**
   * Record host-inspected readiness for an extension's declared deployments.
   *
   * This is the production writer `#readinessOf` reads: without it, every declared
   * model stays `needs-preparation` forever and a model-backed package can never
   * publish a callable tool. Inspection is the host's read-only EXT-18 surface, so
   * recording it here is how "prepared" becomes a durable fact rather than a guess.
   *
   * Only values for deployments the CURRENT manifest declares are kept, matching the
   * projection `#readinessOf` already applies, and `failed` is recorded so a failed
   * deployment refuses activation instead of staying silent.
   *
   * ASYNC because a readiness CHANGE also moves the surface: a deployment that just
   * became `failed` must have its tool withdrawn, and one that just became callable
   * must be published. Recording without reconciling would leave the published
   * snapshot stale, which is exactly the divergence admission exists to prevent.
   * @param extensionId - the extension whose deployments were inspected.
   * @param inspected - readiness keyed by deployment id.
   * @returns the state after recording.
   * @throws ManagementError when the extension is not installed.
   */
  async recordReadiness(extensionId: string, inspected: Readonly<Record<string, ModelReadiness>>): Promise<ExtensionState> {
    return this.#store.exclusive(() => this.#exclusive(extensionId, () => this.#recordReadiness(extensionId, inspected)))
  }

  async #recordReadiness(extensionId: string, inspected: Readonly<Record<string, ModelReadiness>>): Promise<ExtensionState> {
    const current = this.stateOf(extensionId)
    if (current === undefined) {
      throw new ManagementError('EXTENSION_INACTIVE', 'activate', `${extensionId} is not known`, 'Nothing to record for it.')
    }
    const record = this.#store.listInstalled().value.find(candidate => candidate.extensionId === extensionId)
    if (record === undefined) {
      throw new ManagementError('EXTENSION_INACTIVE', 'activate', `${extensionId} is not installed`, 'Install it before recording readiness.')
    }
    const discovery = this.#discoverOf(record)
    if (discovery === undefined) {
      // An UNREADABLE manifest cannot say which deployments are declared, so recording
      // against it would write junk into the durable state. Refuse rather than guess.
      throw new ManagementError('INVALID_EXTENSION', 'activate',
        `${extensionId} manifest could not be read, so readiness was not recorded`,
        'Ensure the installed package is readable, then retry.')
    }
    const declared = new Set(discovery.manifest.models.map(model => model.id))
    const readiness: Record<string, ModelReadiness> = { ...current.readiness }
    for (const [id, value] of Object.entries(inspected)) {
      // Unknown deployments are DROPPED, mirroring the projection activation applies:
      // a removed deployment's stale readiness must not poison the current manifest.
      if (declared.has(id)) readiness[id] = value
    }
    const changed = Object.entries(readiness).some(([id, value]) => current.readiness[id] !== value)
    const next: ExtensionState = { ...current, readiness }
    this.#writeState(next)
    // The surface must agree with the new facts: a tool whose deployment just failed
    // is withdrawn, and one that just became callable is published.
    if (changed && next.observedActivation === 'active' && this.#owned.has(extensionId)) {
      await this.#reconcileSurface(extensionId)
    }
    return this.stateOf(extensionId) ?? next
  }

  /** The contributions a record publishes. */
  #contributionsOf(
    record: InstalledRecord,
    readiness: Readonly<Record<string, ModelReadiness>>,
    diagnostics: ActivationDiagnostic[],
  ): Contribution[] {
    const discovery = this.#discoverOf(record)
    if (discovery === undefined) return []
    const contributions: Contribution[] = []
    const disabled = new Set(this.stateOf(record.extensionId)?.tools
      .filter(tool => !tool.enabled).map(tool => tool.toolName) ?? [])
    for (const tool of discovery.manifest.tools) {
      if (disabled.has(tool.name)) continue
      const candidates = discovery.manifest.implementations.filter(
        implementation => implementation.contractId === tool.contractId,
      )
      const implementations = candidates.filter(implementation => implementation.contractVersion === tool.contractVersion)
      if (implementations.length === 0) {
        diagnostics.push({
          code: 'not-registerable',
          subject: tool.name,
          message: `${tool.name} is withheld because no implementation serves ${tool.contractId}@${tool.contractVersion}`,
        })
        continue
      }
      // Dispatch currently selects the FIRST exact contract binding. Do not let
      // a later ready alternative justify visibility for that unprepared target.
      const selected = implementations[0]
      const callable = selected?.modelId === undefined
        || CALLABLE_READINESS.has(readiness[selected.modelId] ?? 'needs-preparation')
      if (!callable) {
        diagnostics.push({
          code: 'needs-preparation',
          subject: tool.name,
          message: `${tool.name} is withheld because no implementation for ${tool.contractId} is prepared and callable`,
        })
        continue
      }
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
    const visibleTools = new Set(contributions.filter(entry => entry.kind === 'tool').map(entry => entry.name))
    for (const skill of discovery.manifest.skills) {
      // Setup guidance has no required tools; usage guidance must not advertise
      // leaves withheld by readiness. Keep both projections in the same decision.
      if (skill.requiresTools?.some(id => {
        const tool = discovery.manifest.tools.find(candidate => candidate.id === id)
        return !visibleTools.has(tool?.name ?? id)
      })) continue
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
      /**
       * The PID is stamped while THIS process publishes or is about to publish the
       * surface, and dropped on any confirmed stop. That is what lets a restarted
       * process restore an `active` record whose owner died, while still refusing a
       * LIVE second owner.
       */
      ...overrides.observedActivation === 'active' || overrides.observedActivation === 'activating'
        ? { ownerPid: process.pid }
        : {},
      ...overrides,
    }
  }
}

export { summarize }
