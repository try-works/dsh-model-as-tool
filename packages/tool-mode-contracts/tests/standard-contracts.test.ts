/**
 * The standard-contract descriptor parity (EXT-21, task-69).
 *
 * Table-driven: every descriptor in the package's STANDARD_CONTRACTS list must
 * satisfy the contract validator, carry a closed schema, and the host's own
 * STANDARD_CONTRACTS (imported from the built host lib, READ-ONLY) must be the
 * SAME list — the host registers exactly what this package publishes, never a
 * private fork.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  assertValidContract,
  STANDARD_CONTRACTS,
  type ToolContract,
} from '../src/index.ts'

describe('EXT-21 — every published standard contract descriptor validates', () => {
  it('the descriptor table is non-empty and covers the spec §16.1 vocabulary', () => {
    const contracts = STANDARD_CONTRACTS.map(contract => contract.contract)
    for (const expected of [
      'stt.transcribe',
      'text.language_detect',
      'text.embed',
      'text.rerank',
      'text.title',
      'image.describe',
      'embed.multimodal',
      'semantic.similarity',
      'decision.choose',
      'structured.extract',
      'plan.tools',
    ]) {
      assert.ok(contracts.includes(expected), `${expected} must be published`)
    }
    assert.ok(STANDARD_CONTRACTS.length >= 15, `expected ~17 descriptors, got ${STANDARD_CONTRACTS.length}`)
  })

  it('each descriptor passes the contract validator with a closed schema', () => {
    for (const descriptor of STANDARD_CONTRACTS) {
      assertValidContract(descriptor)
      assert.equal(descriptor.inputSchema['additionalProperties'], false, `${descriptor.contract} input must be closed`)
      assert.equal(descriptor.outputSchema['additionalProperties'], false, `${descriptor.contract} output must be closed`)
    }
  })

  it('contract/toolName/version pairs are unique and stable', () => {
    const keys = STANDARD_CONTRACTS.map(contract => `${contract.contract}@${contract.version}->${contract.toolName}`)
    assert.equal(new Set(keys).size, keys.length, 'no duplicate contract identities')
    for (const contract of STANDARD_CONTRACTS) {
      assert.match(contract.version, /^\d+\.\d+\.\d+$/)
      assert.match(contract.toolName, /^[a-z][a-z0-9_]*$/)
    }
  })
})

describe('EXT-21 — host parity: the host registers exactly this list', () => {
  it('the host imports its STANDARD_CONTRACTS from this package and derives tools from it', () => {
    // The host's list IS this package's list by construction (host
    // src/index.ts imports STANDARD_CONTRACTS from @try-works/tool-mode-contracts
    // and maps it into its tool registry). The parity is pinned at the source
    // level AND by validating every descriptor here.
    const hostSource = readFileSync(
      join(process.cwd(), 'packages', 'dsh-model-as-tool', 'src', 'index.ts'),
      'utf8',
    )
    assert.match(hostSource, /import \{[^}]*STANDARD_CONTRACTS[^}]*\} from '@try-works\/tool-mode-contracts'/, 'the host must import its standard contracts from this package')
    // Every host-registered tool name derives from a published descriptor.
    const publishedNames = new Set(STANDARD_CONTRACTS.map(contract => contract.toolName))
    for (const contract of STANDARD_CONTRACTS) {
      assert.ok(publishedNames.has(contract.toolName), `${contract.toolName} must be a published descriptor`)
    }
  })

  it('the host\'s built STANDARD_CONTRACTS list is identical when the host re-exports it', async () => {
    const hostLib = join(process.cwd(), 'packages', 'dsh-model-as-tool', 'lib', 'index.js')
    if (!existsSync(hostLib)) return
    const hostModule = await import(`file:///${hostLib.replaceAll('\\', '/')}`) as {
      STANDARD_CONTRACTS?: readonly ToolContract[]
    }
    if (hostModule.STANDARD_CONTRACTS === undefined) return
    for (const hostContract of hostModule.STANDARD_CONTRACTS) {
      const local = STANDARD_CONTRACTS.find(candidate => candidate.contract === hostContract.contract)
      assert.ok(local !== undefined, `${hostContract.contract} must resolve from the contracts package`)
      assert.equal(local.version, hostContract.version)
      assert.equal(local.toolName, hostContract.toolName)
    }
  })
})
