/**
 * Licensing tests (LIC-01..LIC-04).
 *
 * LIC-02's facts are asserted against the VENDOR'S ACTUAL TERMS as researched, not
 * restated from memory: a test that asserts "the licence is source-available" from a
 * value the code itself defines proves only self-consistency. These assert the values a
 * deployer must act on — non-open-source, non-redistributable, attribution required —
 * so a later edit that quietly loosens one fails here.
 *
 * Requirement links: LIC-01, LIC-02, LIC-03, LIC-04.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  describeNetwork,
  desertAntLabsLicense,
  exportDecision,
  isUsablePermissionRecord,
  LICENSE_LAYERS,
  mayPackageWeights,
  missingNotices,
  noNetworkEligibility,
  resolveLicenses,
  type LayerLicense,
  type NetworkBehaviour,
  type PermissionRecord,
} from '../src/licensing.ts'

/** A permissive layer, for contrast with the vendor's. */
const mit = (layer: LayerLicense['layer']): LayerLicense => ({
  layer,
  name: 'MIT',
  url: 'https://opensource.org/license/mit',
  attributionRequired: false,
  openSource: true,
  redistribution: 'permitted',
  obligations: [],
})

describe('LIC-02 — the vendor licence facts a deployer must act on', () => {
  it('records it as source-available, NOT open source', () => {
    // Stated in as many words by the requirement, and the mistake most likely to be
    // made by treating a licence file's presence as open-source status.
    assert.equal(desertAntLabsLicense('weights').openSource, false)
  })

  it('records that redistribution is NOT permitted', () => {
    assert.equal(desertAntLabsLicense('weights').redistribution, 'not-permitted')
    assert.equal(desertAntLabsLicense('sdk').redistribution, 'not-permitted')
  })

  it('requires attribution and carries the notice text', () => {
    const licence = desertAntLabsLicense('weights')
    assert.equal(licence.attributionRequired, true)
    assert.equal(licence.attributionText, 'Powered by Desert Ant Labs')
  })

  it('states the obligations rather than implying them', () => {
    const obligations = desertAntLabsLicense('weights').obligations.join(' | ')
    // Each of these is a researched term of the licence, and each one constrains what
    // this plugin may do.
    assert.match(obligations, /commercial licence is required above the per-platform, per-model/i)
    assert.match(obligations, /do not redistribute the model, SDK or a hosted service/i)
    assert.match(obligations, /train a competing on-device model/i)
    assert.match(obligations, /tamper with the usage telemetry/i)
  })

  it('names the licence so a reviewer can read the terms', () => {
    const licence = desertAntLabsLicense('code')
    assert.match(licence.name, /Source-Available/)
    assert.match(licence.url, /^https:\/\//)
  })
})

describe('LIC-01 — layers are tracked independently', () => {
  it('reports a missing layer as a GAP rather than a default', () => {
    // An adapter's MIT licence says nothing about the weights it loads.
    const { gaps } = resolveLicenses('@acme/x', [mit('code')])
    assert.deepEqual([...gaps], ['engine', 'weights', 'conversion-artifacts', 'sdk'])
  })

  it('reports no gaps when every layer is declared', () => {
    const { gaps } = resolveLicenses('@acme/x', LICENSE_LAYERS.map(layer => mit(layer)))
    assert.deepEqual([...gaps], [])
  })

  it('collects the notices from every layer that requires one', () => {
    const { record } = resolveLicenses('@acme/x', [
      mit('code'),
      desertAntLabsLicense('weights'),
    ])
    // Gathered rather than attached to a layer nobody reads, so a notice cannot be
    // dropped by being filed in the wrong place.
    assert.deepEqual([...record.notices], ['Powered by Desert Ant Labs'])
  })

  it('does NOT treat packaging a model as a redistribution grant', () => {
    const { record } = resolveLicenses('@acme/x', [mit('code'), desertAntLabsLicense('weights')])
    // Technical availability does not imply export or redistribution permission.
    assert.equal(mayPackageWeights(record), false)
  })

  it('treats an UNCLEAR redistribution as not permitted', () => {
    const { record } = resolveLicenses('@acme/x', [{ ...mit('weights'), redistribution: 'unclear' }])
    // Treating an unexamined licence as permitted is how a package ships bytes it had
    // no right to.
    assert.equal(mayPackageWeights(record), false)
  })

  it('permits packaging when the weights licence genuinely allows it', () => {
    const { record } = resolveLicenses('@acme/x', [{ ...mit('weights'), redistribution: 'permitted' }])
    assert.equal(mayPackageWeights(record), true)
  })

  it('reports which required notices are absent from a notice file', () => {
    const { record } = resolveLicenses('@acme/x', [desertAntLabsLicense('weights')])
    assert.deepEqual([...missingNotices(record, 'this file mentions nothing relevant')], ['Powered by Desert Ant Labs'])
    assert.deepEqual([...missingNotices(record, 'Powered by Desert Ant Labs')], [])
  })
})

describe('LIC-03 — a config boolean is not a licence grant', () => {
  it('rejects a boolean as a permission basis', () => {
    // The type has no member for one, and this asserts the runtime guard agrees.
    assert.equal(isUsablePermissionRecord(true), false)
    assert.equal(isUsablePermissionRecord('yes'), false)
    assert.equal(isUsablePermissionRecord({}), false)
  })

  it('requires a RESPONSIBLE HUMAN and a basis', () => {
    const anonymous: Partial<PermissionRecord> = {
      extensionId: '@acme/x',
      scope: 'external-export',
      basis: { kind: 'published-terms', url: 'https://example.invalid/terms' },
      recordedBy: '',
      recordedAt: '2026-01-01T00:00:00Z',
    }
    // An unattributed record cannot be reviewed or revisited.
    assert.equal(isUsablePermissionRecord(anonymous), false)
    assert.equal(isUsablePermissionRecord({ ...anonymous, recordedBy: 'a person' }), true)
  })

  it('accepts each basis kind the requirement names', () => {
    const bases = [
      { kind: 'vendor-clarification' as const, reference: 'email-2026-01-01' },
      { kind: 'qualified-review' as const, reference: 'review-4' },
      { kind: 'published-terms' as const, url: 'https://example.invalid' },
      { kind: 'commercial-agreement' as const, reference: 'contract-9' },
    ]
    for (const basis of bases) {
      assert.equal(isUsablePermissionRecord({
        extensionId: '@acme/x', scope: 'native', basis, recordedBy: 'a person', recordedAt: '2026-01-01T00:00:00Z',
      }), true)
    }
  })

  it('blocks export for a provider with NO recorded external-export permission', () => {
    const decision = exportDecision('@acme/one', [])
    assert.equal(decision.exportable, false)
    // The reason says the block is scoped, because an operator reading it must not
    // think the plugin is disabled.
    assert.match(String(decision.reason), /blocks that provider only, not the other providers/)
  })

  it('blocks ONLY the provider concerned, not the whole plugin', () => {
    const permissions: PermissionRecord[] = [{
      extensionId: '@acme/two',
      scope: 'external-export',
      basis: { kind: 'vendor-clarification', reference: 'r1' },
      recordedBy: 'a person',
      recordedAt: '2026-01-01T00:00:00Z',
    }]
    // One unresolved question must not punish every other provider.
    assert.equal(exportDecision('@acme/one', permissions).exportable, false)
    assert.equal(exportDecision('@acme/two', permissions).exportable, true)
  })

  it('a native-use permission alone does not authorise export', () => {
    const permissions: PermissionRecord[] = [{
      extensionId: '@acme/x',
      scope: 'native',
      basis: { kind: 'published-terms', url: 'https://example.invalid' },
      recordedBy: 'a person',
      recordedAt: '2026-01-01T00:00:00Z',
    }]
    // Export is a separate permission from native use, which is the point of tracking
    // scopes separately.
    assert.equal(exportDecision('@acme/x', permissions).exportable, false)
  })

  it('carries the limits of a permission with it', () => {
    const record: PermissionRecord = {
      extensionId: '@acme/x',
      scope: 'external-export',
      basis: { kind: 'qualified-review', reference: 'review-7' },
      recordedBy: 'a person',
      recordedAt: '2026-01-01T00:00:00Z',
      excludes: ['does not cover redistributing the weights'],
    }
    assert.deepEqual([...record.excludes ?? []], ['does not cover redistributing the weights'])
  })
})

describe('LIC-04 — no-network deployments are honest about telemetry', () => {
  const behaviour = (overrides: Partial<NetworkBehaviour>): NetworkBehaviour => ({
    extensionId: '@acme/x',
    requiredTelemetry: false,
    otherNetworkUse: false,
    ...overrides,
  })

  it('declares a genuinely local implementation eligible', () => {
    assert.equal(noNetworkEligibility(behaviour({})).eligible, true)
    assert.equal(describeNetwork(behaviour({})), 'runs without network access')
  })

  it('declares an implementation with REQUIRED telemetry INELIGIBLE', () => {
    const verdict = noNetworkEligibility(behaviour({ requiredTelemetry: true }))
    assert.equal(verdict.eligible, false)
    // The requirement forbids secretly suppressing required telemetry, so the
    // ineligibility is reported rather than resolved by disabling it.
    assert.match(String(verdict.reason), /must report usage telemetry/)
  })

  it('offers a QUALIFIED ALTERNATIVE rather than a bare refusal', () => {
    const verdict = noNetworkEligibility(behaviour({ requiredTelemetry: true }))
    assert.ok(verdict.alternative, 'the requirement asks for a qualified alternative')
    assert.match(String(verdict.alternative), /implementation whose licence requires no telemetry/)
  })

  it('NEVER describes telemetry-bearing software as network-free', () => {
    const described = describeNetwork(behaviour({ requiredTelemetry: true, telemetryContent: ['a monthly active-device count'] }))
    assert.equal(described.includes('runs without network access'), false)
    assert.match(described, /it is not network-free/)
    // Naming what the telemetry carries is what makes the description accurate rather
    // than merely cautious.
    assert.match(described, /monthly active-device count/)
  })

  it('marks other network use ineligible too, with its own reason', () => {
    const verdict = noNetworkEligibility(behaviour({ otherNetworkUse: true }))
    assert.equal(verdict.eligible, false)
    assert.match(String(verdict.reason), /unrelated to telemetry/)
  })

  it('does not offer suppression as a way to become eligible', () => {
    // A deployer must not be able to make a telemetry-bearing implementation eligible
    // by turning the telemetry off: there is no parameter for it.
    const verdict = noNetworkEligibility(behaviour({ requiredTelemetry: true }))
    assert.equal('suppressTelemetry' in verdict, false)
  })
})
