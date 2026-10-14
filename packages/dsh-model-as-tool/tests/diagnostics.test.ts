/**
 * The diagnostic surface (OBS-04) and the retention refusal (OBS-03).
 *
 * Both requirements are about what an operator is TOLD, which makes them unusually easy to
 * satisfy vacuously: a report full of booleans technically "shows" everything OBS-04 names
 * while leaving an operator unable to act on any of it. These tests are about the difference.
 *
 * Requirement links: OBS-03, OBS-04.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { buildDiagnostics, harnessExecutionDecision, unsupportedReason } from '../src/diagnostics.ts'
import { callTool, cleanup, mountPlugin } from './helpers.ts'
import { after } from 'node:test'

after(async () => { await cleanup() })

/** A minimal, fully-available deployment. */
function base(overrides: Partial<Parameters<typeof buildDiagnostics>[0]> = {}) {
  return buildDiagnostics({
    mcpMounted: true,
    mcpEndpoint: 'http://127.0.0.1:7788/mcp',
    mcpRequiresCredential: true,
    authorizedClients: ['client-a'],
    exportedTools: ['lang_detect'],
    platform: { os: 'win32', arch: 'x64', nodeVersion: 'v24.11.0' },
    ...overrides,
  })
}

describe('OBS-04 — everything the requirement names is REPORTED', () => {
  it('reports MCP on/off and its endpoint', () => {
    const on = base()
    assert.equal(on.mcp.mounted, true)
    assert.equal(on.mcp.endpoint, 'http://127.0.0.1:7788/mcp')
  })

  it('reports an endpointless mount as a distinct state, not as "off"', () => {
    // A host that composes tools for its own agent and serves nothing is a REAL deployment,
    // and reporting it as "MCP unavailable" would be wrong in a way an operator would chase.
    const report = base({ mcpMounted: true, mcpEndpoint: undefined })
    assert.equal(report.mcp.mounted, true)
    assert.equal(report.mcp.endpoint, null)
    const capability = report.capabilities.find(entry => entry.capability === 'mcp-endpoint')
    assert.equal(capability?.state, 'unavailable')
    assert.match(String(capability?.reason), /exposes no network endpoint/)
  })

  it('reports authorized clients, exported tools AND what was withheld', () => {
    const report = base({ withheldTools: ['tool_mode_run'] })
    assert.deepEqual(report.mcp.authorizedClients, ['client-a'])
    assert.deepEqual(report.mcp.exportedTools, ['lang_detect'])
    // The withheld half is the one an operator cannot otherwise see, and it is where the
    // security-relevant decisions live.
    assert.deepEqual(report.mcp.withheldTools, ['tool_mode_run'])
  })

  it('reports preparation status WITH the reason it is not prepared', () => {
    const report = base({
      preparation: [
        { modelId: 'embeddinggemma2', prepared: false, reason: 'the text-backbone asset group was not prepared' },
        { modelId: 'tongue', prepared: true },
      ],
    })
    assert.equal(report.preparation[0]?.prepared, false)
    assert.match(String(report.preparation[0]?.reason), /text-backbone/)
    // A prepared model has nothing to explain.
    assert.equal(report.preparation[1]?.reason, null)
  })

  it('reports selection, extension state, uninstall controls and requirements', () => {
    const report = base({
      selectedImplementations: [{ contractId: 'text.title', implementationId: 'harness-default' }],
      extensions: [{ extensionId: '@try-works/extension-needle', version: '0.1.0', activation: 'active' }],
      uninstall: { available: true, builtInsProtected: true },
      requirements: { localOnly: true, networkOrigins: [] },
    })
    assert.equal(report.implementations[0]?.implementationId, 'harness-default')
    assert.equal(report.extensions[0]?.activation, 'active')
    assert.equal(report.uninstall?.builtInsProtected, true)
    assert.equal(report.requirements?.localOnly, true)
  })

  it('reports the PLATFORM alongside the facts, so a reason can name it', () => {
    const report = base()
    assert.deepEqual(report.platform, { os: 'win32', arch: 'x64', nodeVersion: 'v24.11.0' })
  })

  it('an UNMOUNTED MCP surface carries the reason, not just false', () => {
    const report = base({ mcpMounted: false, mcpEndpoint: undefined, mcpRequiresCredential: undefined })
    const capability = report.capabilities.find(entry => entry.capability === 'mcp')
    assert.equal(capability?.state, 'unavailable')
    assert.match(String(capability?.reason), /no client can call these tools/)
  })
})

describe('OBS-04 — an UNAUTHENTICATED endpoint is reported as a risk, not as "available"', () => {
  it('names what an open endpoint means', () => {
    const report = base({ mcpRequiresCredential: false })
    const capability = report.capabilities.find(entry => entry.capability === 'mcp-authorization')
    /**
     * This is the diagnostic surface's most consequential line. An endpoint that accepts
     * unauthenticated requests is not "authorization available"; it is the absence of one, and
     * an operator reading a bare boolean would conclude the opposite.
     */
    assert.equal(capability?.state, 'unavailable')
    assert.match(String(capability?.reason), /any local caller may invoke these tools/)
  })

  it('reports UNKNOWN as its own state rather than defaulting to false', () => {
    const report = base({ mcpRequiresCredential: undefined })
    const capability = report.capabilities.find(entry => entry.capability === 'mcp-authorization')
    // "Not supported" and "not checked" call for different actions, so they are different
    // values.
    assert.equal(capability?.state, 'unknown')
  })
})

describe('OBS-04 — an unsupported reason names BOTH sides of the mismatch', () => {
  it('names the platforms it works on and the host it does not', () => {
    const reason = unsupportedReason(
      'the Voz speech backend',
      [{ os: 'darwin', arch: 'arm64' }, { os: 'linux', arch: 'x64' }],
      { os: 'win32', arch: 'x64' },
    )
    assert.match(reason, /darwin\/arm64/)
    assert.match(reason, /linux\/x64/)
    // And the host, so an operator need not compare their machine against a document.
    assert.match(reason, /this host is win32\/x64/)
  })

  it('distinguishes "nowhere" from "not here"', () => {
    const reason = unsupportedReason('a feature', [], { os: 'win32', arch: 'x64' })
    // A different sentence, because "no platform supports this" is not a mismatch and an
    // operator should not go looking for the right machine.
    assert.match(reason, /cannot run anywhere/)
    assert.doesNotMatch(reason, /this host is/)
  })
})

describe('OBS-03 — a no-retention policy REFUSES harness execution', () => {
  it('refuses when bodies cannot be retained but DSH needs reconstructable inputs', () => {
    const decision = harnessExecutionDecision({ retainsBodies: false, requiresReconstructableInputs: true })
    /**
     * The operative sentence of OBS-03 is a REFUSAL, not a warning. Logging bodies against the
     * policy and bypassing DSH are both forbidden, which leaves refusing — so the function
     * returns a decision rather than a caution a caller could soften.
     */
    assert.equal(decision.permitted, false)
    assert.match(String(decision.reason), /refused here rather than logging/)
  })

  it('permits when bodies are retained', () => {
    assert.equal(harnessExecutionDecision({ retainsBodies: true, requiresReconstructableInputs: true }).permitted, true)
  })

  it('permits when DSH does not require reconstructable inputs', () => {
    // No conflict exists, so there is nothing to refuse.
    assert.equal(harnessExecutionDecision({ retainsBodies: false, requiresReconstructableInputs: false }).permitted, true)
  })
})
describe('OBS-04 — the surface is REACHABLE through the control tool', () => {
  it('model_tools action=diagnostics answers with the report', async () => {
    /**
     * THE CALLER, and this test exists because its absence is the defect this repository keeps
     * producing: `ptc-authority.ts`, `ptc-runtime.ts` and the recipes broker were each fully
     * tested with zero production callers. A diagnostic surface nothing can invoke is not a
     * surface, and only this test distinguishes the two.
     */
    const ctx = await mountPlugin({})
    const result = await callTool(ctx, 'model_tools', { action: 'diagnostics' })
    assert.equal(result.isError, false, `diagnostics must be reachable, saw ${JSON.stringify(result).slice(0, 200)}`)

    const report = (result.value as { diagnostics?: Record<string, unknown> }).diagnostics
    assert.ok(report !== undefined, 'the action must return a diagnostics report')
    if (report === undefined) return

    // The items OBS-04 names, present in a REAL deployment's report rather than a fixture's.
    assert.ok(report.platform !== undefined, 'the platform must be reported')
    const mcp = report.mcp as { mounted: boolean; exportedTools: string[]; withheldTools: string[] }
    assert.equal(mcp.mounted, true)
    assert.ok(Array.isArray(mcp.exportedTools))
    assert.ok(Array.isArray(mcp.withheldTools))
  })

  it('reports the tools that were WITHHELD, derived from the real registry', async () => {
    const ctx = await mountPlugin({})
    const result = await callTool(ctx, 'model_tools', { action: 'diagnostics' })
    const report = (result.value as { diagnostics: { mcp: { exportedTools: string[]; withheldTools: string[] } } }).diagnostics

    // `tool_mode_run` is registered and deliberately not exported (CODE-08), so it is exactly
    // the kind of fact an operator cannot see any other way — and it is derived from the real
    // registry rather than hard-coded.
    assert.ok(
      report.mcp.withheldTools.includes('tool_mode_run'),
      `expected tool_mode_run among the withheld, saw ${report.mcp.withheldTools.join(', ')}`,
    )
    // And the two sets do not overlap: a tool is exported or withheld, never both.
    for (const name of report.mcp.withheldTools) {
      assert.equal(report.mcp.exportedTools.includes(name), false, `${name} cannot be both`)
    }
  })
})
describe('OBS-03 — the capture path is ON the diagnostic surface', () => {
  it('reports the profile and the surfaces, INCLUDING the ones this plugin does not control', async () => {
    /**
     * Wiring matters here for the reason it has mattered all session: a documented capture path
     * nobody can read from the running system is a document, and this repository has produced
     * fully-tested components with zero callers three times. The surface an operator actually
     * queries is the one that has to carry it.
     */
    const ctx = await mountPlugin({})
    const result = await callTool(ctx, 'model_tools', { action: 'diagnostics' })
    assert.equal(result.isError, false, `capture must be reachable, saw ${JSON.stringify(result).slice(0, 200)}`)

    const capture = (result.value as { capture?: { profile: string; surfaces: { surface: string; writtenByThisPlugin: boolean }[] } }).capture
    assert.ok(capture !== undefined, 'the diagnostics action must report the capture path')
    if (capture === undefined) return

    assert.equal(capture.profile, 'standard')
    // The sibling-plugin surface is the one OBS-03 names, and it must be visible to an operator
    // rather than living only in a document.
    assert.ok(
      capture.surfaces.some(entry => /logging plugin/i.test(entry.surface) && entry.writtenByThisPlugin === false),
      `the sibling-plugin surface must be reported, saw ${capture.surfaces.map(e => e.surface).join(' | ')}`,
    )
    assert.ok(capture.surfaces.some(entry => /LLM service/i.test(entry.surface)))
  })

  it('an operator can SELECT the metadata-only profile', async () => {
    const ctx = await mountPlugin({ captureProfile: 'metadata-only' })
    const result = await callTool(ctx, 'model_tools', { action: 'diagnostics' })
    const capture = (result.value as { capture?: { profile: string } }).capture
    // The profile is a deployment choice, and the surface confirms which one is in force rather
    // than leaving an operator to infer it from behaviour.
    assert.equal(capture?.profile, 'metadata-only')
  })
})