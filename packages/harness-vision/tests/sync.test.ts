/**
 * The harness-vision packable-package sync (task-70).
 *
 * The shipped recipe must stay BYTE-IDENTICAL to the host's builtin declarative
 * recipe, and the package must satisfy the SDK manifest validator end-to-end —
 * exactly like any third-party declarative package.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { discoverExtension } from '@try-works/tool-mode-extension-sdk'

describe('harness-vision — packable declarative TMX package', () => {
  it('the shipped recipe is byte-identical to the host builtin recipe', () => {
    const builtin = readFileSync(
      join(process.cwd(), 'packages', 'extension-declarative-recipes', 'recipes', 'describe-image.json'),
      'utf8',
    )
    const shipped = readFileSync(
      join(process.cwd(), 'packages', 'harness-vision', 'recipes', 'describe-image.json'),
      'utf8',
    )
    assert.equal(shipped, builtin, 'the harness-vision recipe must not drift from the builtin')
  })

  it('the manifest validates through the SDK validator with the harness-model binding', () => {
    const discovery = discoverExtension(join(process.cwd(), 'packages', 'harness-vision'))
    assert.equal(discovery.packageName, '@try-works/harness-vision')
    assert.equal(discovery.manifest.execution.kind, 'declarative')
    assert.ok(discovery.manifest.compatibility.requiredFeatures.includes('harness-model-recipes-v1'))
    assert.ok(discovery.manifest.compatibility.requiredFeatures.includes('typed-image-input-v1'))
    const implementation = discovery.manifest.implementations[0]
    assert.ok(implementation !== undefined)
    assert.equal(implementation.kind, 'harness-model')
    assert.equal(implementation.recipe, './recipes/describe-image.json')
    const tool = discovery.manifest.tools[0]
    assert.ok(tool !== undefined)
    assert.equal(tool.name, 'describe_image')
    assert.equal(tool.contractId, 'image.describe')
  })
})
