/**
 * DECL-02 — the projected output schema is registered AND never stricter than the contract.
 *
 * The registry validates every success against the ADVERTISED output schema, so the
 * projection must be looser than the contract everywhere it differs. Three properties
 * this file pins, each of which was a real defect at some point:
 *
 * - a scalar `enum` must stay an ARRAY (stripItems used to mangle it into an object);
 * - a union `type: ['x','null']` must become `type: 'json'`, not the narrowed member —
 *   narrowing made the advertisement STRICTER than the contract and rejected valid
 *   null results;
 * - a projected property must still register (annotation-only properties are rejected
 *   by the DSL, which is why the union is encoded as `json` rather than dropped).
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { defineTool } from '@deepseek-ai/dsh-tools'
import { projectSchemaToDsh, STANDARD_CONTRACTS } from '@try-works/tool-mode-contracts'
import { cleanup, mountPlugin, tempDir } from './helpers.ts'

after(async () => { await cleanup() })

describe('DECL-02 — the projected output schema is never stricter than the contract', () => {
  it('keeps a scalar enum an array, not a mangled object', () => {
    const contract = STANDARD_CONTRACTS.find(candidate => candidate.contract === 'stt.transcribe')
    assert.ok(contract !== undefined)
    const projection = projectSchemaToDsh(contract.outputSchema)
    const executionLocation = (projection.parameters.meta as { properties?: Record<string, unknown> })
      ?.properties?.executionLocation as { enum?: unknown }
    assert.ok(Array.isArray(executionLocation.enum), `enum must stay an array, saw ${JSON.stringify(executionLocation.enum)}`)
    assert.deepEqual(executionLocation.enum, ['host', 'device', 'team-server', 'remote'])
  })

  it('projects a nullable union as type json, looser than the contract', () => {
    const contract = STANDARD_CONTRACTS.find(candidate => candidate.contract === 'stt.transcribe')
    assert.ok(contract !== undefined)
    const projection = projectSchemaToDsh(contract.outputSchema)
    const language = projection.parameters.language as { type?: unknown }
    assert.equal(language.type, 'json', 'a union type must be advertised as unconstrained json')
  })

  it('registers and accepts a legitimate null-valued union member', async () => {
    void tempDir()
    const contract = STANDARD_CONTRACTS.find(candidate => candidate.contract === 'stt.transcribe')
    assert.ok(contract !== undefined)
    const projection = projectSchemaToDsh(contract.outputSchema)

    const ctx = await mountPlugin({})
    const dispose = ctx.tools.register(defineTool({
      name: 'probe_null_union',
      description: 'probe',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          properties: projection.parameters,
          additionalProperties: false,
        } as never,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute() {
        // A value the CONTRACT admits: every nullable field null when timestamps
        // were not requested and no language signal was found.
        return {
          text: 'hello',
          coverage: { complete: true, transcribedSeconds: 2.5, totalSeconds: null, reason: null },
          words: null,
          language: null,
          meta: {
            contract: 'stt.transcribe', contractVersion: '1.0.0', implementationId: 'probe',
            extension: 'probe', extensionVersion: '0.0.0', activationGeneration: 1,
            executionLocation: 'host', receiptId: 'probe-receipt', warnings: [],
          },
        }
      },
    }))

    const result = await ctx.tools.execute({
      name: 'probe_null_union',
      arguments: {},
      signal: new AbortController().signal,
      callId: `probe-${Date.now()}` as never,
    })
    dispose()
    assert.equal(result.isError, false, `null-valued union member rejected: ${JSON.stringify(result)}`)
  })
})
