/**
 * Licensing, attribution and permission records (LIC-01..LIC-04).
 *
 * Two rules here exist to stop a technical decision standing in for a legal one.
 *
 * - **A config boolean is not a licence grant** (LIC-03). A person records the
 *   permission basis, the scope it covers, and their name. Turning on a setting
 *   cannot produce that record, so the type has no way to express "someone ticked a
 *   box".
 * - **Do not describe telemetry-bearing software as network-free** (LIC-04). An
 *   implementation that must report usage telemetry is INELIGIBLE for a strict
 *   no-network deployment, and the ineligibility is reported rather than resolved by
 *   quietly suppressing the telemetry — which would breach the licence and misdescribe
 *   the product at the same time.
 *
 * LIC-01's other half is that the layers are tracked INDEPENDENTLY: an adapter's MIT
 * licence says nothing about the weights it loads, and a missing layer is a gap rather
 * than a default.
 *
 * @module @try-works/dsh-model-as-tool/licensing
 */

/** The layers whose licences are tracked separately (LIC-01). */
export type LicenseLayer =
  /** The extension's own source. */
  | 'code'
  /** The inference engine or runtime. */
  | 'engine'
  /** The model weights. */
  | 'weights'
  /** Scripts or tools that converted the weights. */
  | 'conversion-artifacts'
  /** A vendor SDK the extension depends on. */
  | 'sdk'

/** Every layer, so a missing one is detectable rather than absent. */
export const LICENSE_LAYERS: readonly LicenseLayer[] = [
  'code', 'engine', 'weights', 'conversion-artifacts', 'sdk',
]

/**
 * Whether redistribution of a layer is permitted.
 *
 * `unclear` is a first-class value, because treating an unexamined licence as
 * permitted is how a package ships bytes it had no right to.
 */
export type Redistribution = 'permitted' | 'not-permitted' | 'unclear'

/** One layer's licence. */
export interface LayerLicense {
  readonly layer: LicenseLayer
  /** The licence name, e.g. `MIT` or `LicenseRef-DAL-Source-Available-1.0`. */
  readonly name: string
  /** Where the terms live, so a reviewer can read them rather than trust a label. */
  readonly url: string
  /** Whether the licence requires attribution in the product or its notices. */
  readonly attributionRequired: boolean
  /** The exact notice text, when attribution is required. */
  readonly attributionText?: string
  /**
   * Whether the licence is OSI-approved open source.
   *
   * LIC-02 is explicit that Desert Ant's licence is source-available and NOT open
   * source, so this is recorded per layer rather than inferred from the presence of a
   * licence file.
   */
  readonly openSource: boolean
  /** Whether these bytes may be redistributed inside a package. */
  readonly redistribution: Redistribution
  /** Obligations a deployer must meet, stated rather than implied. */
  readonly obligations: readonly string[]
}

/**
 * The Desert Ant Labs licence, as recorded from the vendor's own terms (LIC-02).
 *
 * Named as a constant because getting it wrong in one place is how a wrong belief
 * spreads: this is source-available, NOT open source, and it forbids redistributing
 * the models or SDKs as a standalone product.
 */
export function desertAntLabsLicense(layer: LicenseLayer): LayerLicense {
  return {
    layer,
    name: 'Desert Ant Labs Source-Available License 1.0',
    url: 'https://license.desertant.com/1.0',
    attributionRequired: true,
    attributionText: 'Powered by Desert Ant Labs',
    // LIC-02 says this in as many words.
    openSource: false,
    // No redistribution or re-hosting of the models, SDKs or a hosted service.
    redistribution: 'not-permitted',
    obligations: [
      'display the attribution notice with a link to Desert Ant Labs',
      'a commercial licence is required above the per-platform, per-model active-device threshold',
      'do not redistribute the model, SDK or a hosted service as a standalone product',
      'do not use outputs or logs to train a competing on-device model',
      'do not extract weights or tamper with the usage telemetry',
    ],
  }
}

/** A resolved licence record for one extension (LIC-01). */
export interface ResolvedLicenseRecord {
  readonly extensionId: string
  /** One entry per layer. A missing layer is a GAP, not a default. */
  readonly layers: readonly LayerLicense[]
  /** Where the notices must appear, kept with the record rather than looked up. */
  readonly notices: readonly string[]
}

/**
 * Build a licence record, reporting missing layers (LIC-01).
 *
 * @param extensionId - the extension.
 * @param layers - the declared licences.
 * @returns the record and the layers that were not declared.
 */
export function resolveLicenses(
  extensionId: string,
  layers: readonly LayerLicense[],
): { readonly record: ResolvedLicenseRecord; readonly gaps: readonly LicenseLayer[] } {
  const declared = new Set(layers.map(layer => layer.layer))
  // An undeclared layer is reported rather than assumed permissive: an adapter's MIT
  // licence says nothing about the weights it loads.
  const gaps = LICENSE_LAYERS.filter(layer => !declared.has(layer))
  return {
    record: {
      extensionId,
      layers,
      // Collected from every layer that requires one, so a notice is never dropped by
      // being attached to a layer nobody reads.
      notices: layers
        .filter(layer => layer.attributionRequired && layer.attributionText !== undefined)
        .map(layer => layer.attributionText as string),
    },
    gaps,
  }
}

/** The uses a permission basis can cover (LIC-03). */
export type PermissionScope = 'native' | 'external-export' | 'distribution' | 'telemetry'

/**
 * How a permission was established (LIC-03).
 *
 * There is deliberately no `config-boolean` member: the requirement says a config
 * boolean is not a licence grant, and a type that cannot express one is a stronger
 * guarantee than a comment saying not to use one.
 */
export type PermissionBasis =
  /** The vendor answered the question in writing. */
  | { readonly kind: 'vendor-clarification'; readonly reference: string }
  /** Qualified review, e.g. counsel, decided the boundary. */
  | { readonly kind: 'qualified-review'; readonly reference: string }
  /** The vendor's own published terms address it directly. */
  | { readonly kind: 'published-terms'; readonly url: string }
  /** A commercial agreement covers it. */
  | { readonly kind: 'commercial-agreement'; readonly reference: string }

/** A human's record of one permission (LIC-03). */
export interface PermissionRecord {
  readonly extensionId: string
  readonly scope: PermissionScope
  readonly basis: PermissionBasis
  /**
   * The responsible human.
   *
   * Required: an unattributed permission record cannot be reviewed or revisited, and
   * the requirement says a RESPONSIBLE HUMAN must record it.
   */
  readonly recordedBy: string
  readonly recordedAt: string
  /** What the permission does NOT cover, so its limits travel with it. */
  readonly excludes?: readonly string[]
}

/**
 * Reject a permission claim that is not a human record (LIC-03).
 *
 * A boolean, a string or an empty object would all be "someone said yes" without a
 * person or a reference, which is what the requirement forbids.
 * @param value - the purported record.
 * @returns whether it is a usable record.
 */
export function isUsablePermissionRecord(value: unknown): value is PermissionRecord {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<PermissionRecord>
  return typeof candidate.extensionId === 'string'
    && typeof candidate.scope === 'string'
    && typeof candidate.recordedBy === 'string' && candidate.recordedBy.length > 0
    && typeof candidate.recordedAt === 'string'
    && typeof candidate.basis === 'object' && candidate.basis !== null
}

/**
 * Whether a provider may be exposed over MCP (LIC-03).
 *
 * An unresolved EXTERNAL-EXPORT permission blocks THAT PROVIDER's export and nothing
 * else. Blocking the whole plugin would punish every other provider for one
 * unresolved question, which the requirement explicitly rules out.
 * @param extensionId - the provider.
 * @param permissions - every recorded permission.
 * @returns the decision.
 */
export function exportDecision(
  extensionId: string,
  permissions: readonly PermissionRecord[],
): { readonly exportable: boolean; readonly reason?: string } {
  const relevant = permissions.find(
    record => record.extensionId === extensionId && record.scope === 'external-export',
  )
  if (relevant === undefined) {
    return {
      exportable: false,
      reason: `no external-export permission is recorded for ${extensionId}; `
        + 'this blocks that provider only, not the other providers',
    }
  }
  if (!isUsablePermissionRecord(relevant)) {
    return { exportable: false, reason: `the external-export record for ${extensionId} is not a usable record` }
  }
  return { exportable: true }
}

/** An implementation's network behaviour, as DECLARED rather than assumed (LIC-04). */
export interface NetworkBehaviour {
  readonly extensionId: string
  /**
   * Whether the software reports usage telemetry the licence REQUIRES.
   *
   * When true, suppressing it to appear network-free would breach the licence, so the
   * implementation is ineligible for a no-network deployment instead.
   */
  readonly requiredTelemetry: boolean
  /** Whether it makes any other network call. */
  readonly otherNetworkUse: boolean
  /** What the telemetry carries, so a description can be accurate. */
  readonly telemetryContent?: readonly string[]
}

/** The verdict for a strict no-network deployment (LIC-04). */
export interface NoNetworkVerdict {
  readonly eligible: boolean
  /** Why not, when it is not. */
  readonly reason?: string
  /** What a deployer should choose instead, rather than a bare refusal. */
  readonly alternative?: string
}

/**
 * Decide whether an implementation is eligible for a strict no-network deployment
 * (LIC-04).
 *
 * @param behaviour - the implementation's declared network behaviour.
 * @returns the verdict, with an alternative when it is ineligible.
 */
export function noNetworkEligibility(behaviour: NetworkBehaviour): NoNetworkVerdict {
  if (behaviour.requiredTelemetry) {
    // The honest outcome. Suppressing the telemetry would breach the licence AND
    // misdescribe the software, so neither is offered.
    return {
      eligible: false,
      reason: 'this implementation must report usage telemetry, so it cannot be described or deployed as network-free',
      alternative: 'choose an implementation whose licence requires no telemetry, or run a profile that permits its telemetry',
    }
  }
  if (behaviour.otherNetworkUse) {
    return {
      eligible: false,
      reason: 'this implementation makes network calls unrelated to telemetry',
      alternative: 'choose a local-only implementation, or run a profile that permits those destinations',
    }
  }
  return { eligible: true }
}

/**
 * How a deployment may DESCRIBE itself (LIC-04).
 *
 * The requirement forbids describing telemetry-bearing software as entirely
 * network-free, so a description is derived from the declared behaviour rather than
 * chosen by the deployer.
 * @param behaviour - the implementation's network behaviour.
 * @returns a description that is true of the implementation.
 */
export function describeNetwork(behaviour: NetworkBehaviour): string {
  if (behaviour.requiredTelemetry) {
    const content = behaviour.telemetryContent ?? []
    return 'reports usage telemetry'
      + (content.length > 0 ? ` (${content.join(', ')})` : '')
      + '; it is not network-free'
  }
  return behaviour.otherNetworkUse ? 'makes network calls' : 'runs without network access'
}

/**
 * Whether packaging a model grants the right to redistribute its weights (LIC-01).
 *
 * It does not. Packaging means an adapter plus licensed assets or ACQUISITION
 * INSTRUCTIONS; technical availability does not imply export or redistribution
 * permission.
 * @param record - the licence record.
 * @returns whether the weights may be shipped inside the package.
 */
export function mayPackageWeights(record: ResolvedLicenseRecord): boolean {
  const weights = record.layers.find(layer => layer.layer === 'weights')
  // `unclear` is not permission: treating an unexamined licence as permitted is how a
  // package ships bytes it had no right to.
  return weights?.redistribution === 'permitted'
}

/**
 * Whether the notices required by a record are present in a shipped notice file.
 * @param record - the licence record.
 * @param noticeText - the notice file's contents.
 * @returns the notices that are missing.
 */
export function missingNotices(record: ResolvedLicenseRecord, noticeText: string): readonly string[] {
  return record.notices.filter(notice => !noticeText.includes(notice))
}
