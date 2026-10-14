/**
 * The full capture path, and the metadata-only profile (OBS-03).
 *
 * THE PREMISE OBS-03 STARTS FROM, and it is the uncomfortable one: **this plugin's defaults
 * cannot guarantee privacy.** A body that is never written by us may still be captured by
 * ANOTHER DSH logging plugin, because DSH's LLM service requires model-visible inputs to be
 * reconstructable — so a harness call's prompt necessarily passes through a surface a sibling
 * plugin can observe. Nothing this plugin does can close that.
 *
 * What this plugin CAN do is be honest about it, which is what the requirement asks for in three
 * parts:
 *
 *  1. **Document the full capture path** — every place a body can come to rest, including the
 *     ones outside this plugin's control. A privacy claim that names only our own writes is
 *     misleading precisely because the reader will assume it is complete.
 *  2. **Provide and TEST a metadata-only profile** for the headless local-specialist case, where
 *     an operator wants the tools without any body retention.
 *  3. **REFUSE rather than silently log** where a no-retention policy cannot be honoured
 *     alongside DSH's reconstructability contract. `harnessExecutionDecision` in
 *     `diagnostics.ts` makes that decision; this module says which profile it applies to.
 *
 * @module @try-works/dsh-model-as-tool/capture-path
 */

/** Where a request or response body can come to rest. */
export interface CaptureSurface {
  /** A stable name for the surface. */
  readonly surface: string
  /**
   * Whether THIS plugin writes bodies there.
   *
   * `false` does not mean the surface is safe — it means this plugin is not the author. That
   * distinction is the whole reason the field exists: a reader must not mistake "we do not
   * write here" for "nothing is written here".
   */
  readonly writtenByThisPlugin: boolean
  /** What actually lands there. */
  readonly contents: string
  /** What an operator can do about it. */
  readonly control: string
}

/**
 * The FULL capture path, including surfaces outside this plugin's control.
 *
 * Ordered from what this plugin owns to what it does not, so a reader sees the boundary
 * explicitly rather than inferring it from a list of our own writes.
 */
export const CAPTURE_PATH: readonly CaptureSurface[] = [
  {
    surface: 'tool invocation arguments',
    writtenByThisPlugin: false,
    contents:
      'The arguments a caller passes to a tool. They reach the implementation, and for a '
      + 'harness-backed tool they become part of the rendered prompt.',
    control:
      'The caller decides what to pass. This plugin adds nothing to the arguments and copies '
      + 'them nowhere.',
  },
  {
    surface: 'managed-worker stdout/stderr',
    writtenByThisPlugin: false,
    contents:
      'Whatever an extension process prints. An extension that logs its own inputs puts bodies '
      + 'into a stream this plugin does not author or read.',
    control:
      'Extension authors control their own logging. The isolation mode is declared in the '
      + 'manifest, and the diagnostics surface reports it.',
  },
  {
    surface: 'DSH LLM service',
    writtenByThisPlugin: false,
    contents:
      'THE SURFACE THIS PLUGIN CANNOT CLOSE. DSH requires model-visible inputs to be '
      + 'reconstructable, so a harness call\'s prompt passes through the LLM service by design.',
    control:
      'An operator-level policy, not a plugin setting. Where no-retention conflicts with '
      + 'reconstructability, the correct response is to REFUSE harness-backed execution — which '
      + 'this plugin does rather than logging bodies or bypassing DSH.',
  },
  {
    surface: 'another DSH logging plugin',
    writtenByThisPlugin: false,
    contents:
      'Any body a sibling plugin observes through a DSH hook. This plugin neither knows what '
      + 'they capture nor can it prevent them.',
    control:
      'Operator configuration of the OTHER plugin. This is the specific case OBS-03 names, and '
      + 'it is why the plugin defaults cannot be presented as a privacy guarantee.',
  },
  {
    surface: 'the auxiliary-call journal (section 19)',
    writtenByThisPlugin: true,
    contents:
      'Harness-backed auxiliary calls, recorded under a SEPARATE authorization from ordinary '
      + 'tool receipts. The broker refuses to construct without a journal sink, so a '
      + 'harness-backed run that records nothing cannot exist.',
    control:
      'A deployment composes the sink or the broker refuses. The journal is the mechanism that '
      + 'makes a harness call auditable without putting its body in an ordinary log.',
  },
  {
    surface: 'invocation accounting',
    writtenByThisPlugin: true,
    contents:
      'Timings, outcome class and byte SIZES. The record has no field that can hold a payload, '
      + 'which is asserted structurally rather than promised.',
    control:
      'Always on. There is nothing to configure because there is nothing sensitive in it.',
  },
  {
    surface: 'tool receipts',
    writtenByThisPlugin: true,
    contents:
      'Identity and provenance — contract, implementation, extension version, content digest, '
      + 'activation generation, caller scope. No credentials and no bodies.',
    control:
      'Disabled by an explicit configuration flag, which is visible on the diagnostics surface.',
  },
]

/** Which capture policy a deployment runs under (OBS-03). */
export type CaptureProfile =
  /** Ordinary operation: receipts and accounting, bodies owned by the surfaces above. */
  | 'standard'
  /**
   * Headless local-specialist: METADATA ONLY.
   *
   * Composed by an operator who wants the tools without any body retention at all. Everything
   * this plugin writes is metadata; the profile additionally forbids the one path where this
   * plugin could be the author of a body, and refuses harness-backed execution when the
   * deployment's policy cannot satisfy DSH's reconstructability contract.
   */
  | 'metadata-only'

/** What a profile permits. */
export interface ProfilePolicy {
  readonly profile: CaptureProfile
  /** Whether this profile may serve harness-backed (model-calling) tools at all. */
  readonly permitsHarnessExecution: boolean
  /** Whether this plugin writes any request or response BODY. */
  readonly writesBodies: boolean
  /** Surfaces this profile does not close, so a reader sees the residual risk. */
  readonly residualSurfaces: readonly string[]
}

/**
 * Describe a profile's policy.
 *
 * @param profile - the profile to describe.
 * @param policy - the deployment's retention facts.
 * @returns what the profile permits, and what it does not close.
 */
export function profilePolicy(
  profile: CaptureProfile,
  policy: { readonly retainsBodies: boolean; readonly requiresReconstructableInputs: boolean },
): ProfilePolicy {
  /**
   * The surfaces no profile can close, listed for BOTH profiles because the difference between
   * them is what THIS plugin writes — not what a sibling plugin does.
   */
  const residualSurfaces = CAPTURE_PATH
    .filter(surface => !surface.writtenByThisPlugin)
    .map(surface => surface.surface)

  if (profile === 'standard') {
    return {
      profile,
      permitsHarnessExecution: true,
      writesBodies: false,
      residualSurfaces,
    }
  }

  /**
   * METADATA ONLY. The plugin still writes no bodies — it never did — and the profile adds the
   * REFUSAL: where a no-retention policy conflicts with DSH's reconstructability requirement,
   * harness-backed execution is not served at all. Logging bodies against the policy and
   * bypassing DSH are both forbidden, which leaves refusing.
   */
  const conflict = !policy.retainsBodies && policy.requiresReconstructableInputs
  return {
    profile,
    permitsHarnessExecution: !conflict,
    writesBodies: false,
    residualSurfaces,
  }
}

/**
 * Whether a profile may serve one tool.
 *
 * @param profile - the active profile.
 * @param policy - the deployment's retention facts.
 * @param harnessBacked - whether the tool calls a model.
 * @returns the decision, with the reason when it refuses.
 */
export function admitsTool(
  profile: CaptureProfile,
  policy: { readonly retainsBodies: boolean; readonly requiresReconstructableInputs: boolean },
  harnessBacked: boolean,
): { readonly admitted: boolean; readonly reason?: string } {
  const described = profilePolicy(profile, policy)
  /**
   * A NON-harness tool is admitted under every profile: it calls no model, so there is no body
   * for the reconstructability contract to be about, and refusing it would remove working
   * functionality for no privacy gain.
   */
  if (!harnessBacked) return { admitted: true }
  if (described.permitsHarnessExecution) return { admitted: true }
  return {
    admitted: false,
    reason:
      'the metadata-only profile refuses harness-backed execution because the deployment does '
      + 'not retain bodies while DSH requires model-visible inputs to be reconstructable. '
      + 'Logging bodies against the policy and bypassing DSH are both forbidden, so the tool is '
      + 'not served.',
  }
}
