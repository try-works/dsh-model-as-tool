/**
 * Spec §19.3/§19.5 manifest-shape conformance (task-53, fix C1).
 *
 * Pins that the SDK accepts the SPEC's declarative shapes end-to-end: the
 * harness-model implementation binding (kind + recipe), the permissions.
 * harnessModel capability request, and the spec feature names — while the
 * existing module/declarative fixtures keep validating and the §19.5 refusals
 * hold.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { discoverExtension, ManagementError, validateManifest, KNOWN_FEATURES } from '../src/index.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmx-spec-'))
  dirs.push(dir)
  return dir
}

/** The §19.3 image-review manifest, adapted only to a matching package identity. */
function specImageReviewManifest(): Record<string, unknown> {
  return {
    protocolVersion: '1.1.0',
    id: '@acme/tool-mode-image-review',
    version: '1.0.0',
    displayName: 'Image Review Tools',
    description: 'Describes visible UI content through an authorized DSH model.',
    // SPEC-VERBATIM: the §19.3 example omits `activation` and `runtimeApi`
    // entirely, and the SDK defaults them at validation (zero adaptations).
    compatibility: {
      hostApi: '^1.1.0',
      requiredFeatures: ['harness-model-recipes-v1', 'typed-image-input-v1'],
    },
    execution: { kind: 'declarative' },
    configurationSchema: './schemas/config.json',
    permissions: {
      networkOrigins: [],
      inputFiles: true,
      storage: 'extension-private',
      secrets: [],
      nativeCode: false,
      harnessModel: { inputModalities: ['text', 'image'], outputModalities: ['text'] },
    },
    models: [],
    tools: [
      {
        id: 'review',
        name: 'acme_describe_ui_image',
        contractId: '@acme/tool-mode-image-review/review',
        contractVersion: '1.0.0',
        description: 'Describe visible interface content in an approved image.',
        inputSchema: './schemas/review.input.json',
        outputSchema: './schemas/review.output.json',
      },
    ],
    implementations: [
      {
        id: 'review-harness',
        kind: 'harness-model',
        contractId: '@acme/tool-mode-image-review/review',
        contractVersion: '1.0.0',
        recipeVersion: '1.0.0',
        recipe: './recipes/review.json',
      },
    ],
    skills: [
      {
        id: 'review',
        name: 'acme-image-review',
        description: 'Use the image review tool directly or inside a composition.',
        path: './skills/review/SKILL.md',
        requiresTools: ['review'],
      },
    ],
  }
}

/** Materialize the §19.3 package on disk with every referenced file. */
function materializeSpecPackage(dir: string): void {
  mkdirSync(join(dir, 'schemas'), { recursive: true })
  mkdirSync(join(dir, 'recipes'), { recursive: true })
  mkdirSync(join(dir, 'skills', 'review'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: '@acme/tool-mode-image-review', version: '1.0.0', type: 'module',
    toolMode: { manifest: './tool-mode.extension.json' },
  }, null, 2)}\n`)
  writeFileSync(join(dir, 'tool-mode.extension.json'), `${JSON.stringify(specImageReviewManifest(), null, 2)}\n`)
  writeFileSync(join(dir, 'schemas', 'config.json'), `${JSON.stringify({ type: 'object' })}\n`)
  writeFileSync(join(dir, 'schemas', 'review.input.json'), `${JSON.stringify({ type: 'object', required: ['image_path'], properties: { image_path: { type: 'string' }, focus: { type: 'string' } } })}\n`)
  writeFileSync(join(dir, 'schemas', 'review.output.json'), `${JSON.stringify({ type: 'object', required: ['description'], properties: { description: { type: 'string' } } })}\n`)
  writeFileSync(join(dir, 'recipes', 'review.json'), `${JSON.stringify({ id: 'review' })}\n`)
  writeFileSync(join(dir, 'skills', 'review', 'SKILL.md'), '# Image review\n')
}

/** The recipes-pack shaped manifest (the pre-spec module form, no kind/recipe). */
function moduleShapeManifest(): Record<string, unknown> {
  return {
    protocolVersion: '1.1.0',
    id: '@acme/plain-tools',
    version: '1.0.0',
    displayName: 'Plain Tools',
    description: 'A module-shaped extension with the classic implementation form.',
    activation: { policy: 'operator', deactivatable: true },
    runtimeApi: 1,
    compatibility: { hostApi: '^1.1.0', requiredFeatures: [] },
    execution: { kind: 'module', entry: './index.js' },
    permissions: { networkOrigins: [], inputFiles: false, storage: 'none', secrets: [], nativeCode: false },
    models: [],
    tools: [
      {
        id: 'alpha', name: 'plain_alpha', contractId: '@acme/plain-tools/alpha', contractVersion: '1.0.0',
        description: 'A plain alpha tool.', inputSchema: './schemas/in.json', outputSchema: './schemas/out.json',
      },
    ],
    implementations: [{ id: 'binding-alpha', contractId: '@acme/plain-tools/alpha', contractVersion: '1.0.0', recipeVersion: '1.0.0' }],
    skills: [],
  }
}

describe('§19.3 — the SPEC declarative shape validates end-to-end', () => {
  it('the spec image-review package discovers with the harness-model binding intact', () => {
    const dir = scratch()
    materializeSpecPackage(dir)
    const discovery = discoverExtension(dir)
    assert.equal(discovery.packageName, '@acme/tool-mode-image-review')
    assert.equal(discovery.manifest.execution.kind, 'declarative')
    const implementation = discovery.manifest.implementations[0]
    assert.ok(implementation !== undefined)
    assert.equal(implementation.kind, 'harness-model')
    assert.equal(implementation.recipe, './recipes/review.json')
    assert.equal(discovery.manifest.permissions.harnessModel?.inputModalities.includes('image'), true)
  })

  it('the spec feature names are known to this host surface', () => {
    assert.ok(KNOWN_FEATURES.includes('harness-model-recipes-v1'))
    assert.ok(KNOWN_FEATURES.includes('typed-image-input-v1'))
  })

  it('the elided activation/runtimeApi are DEFAULTED at validation, bytes untouched', () => {
    const dir = scratch()
    materializeSpecPackage(dir)
    const discovery = discoverExtension(dir)
    assert.equal(discovery.manifest.activation.policy, 'operator', 'the operator default fills the elided field')
    assert.equal(discovery.manifest.runtimeApi, 1, 'runtime API 1 fills the elided field')
    const raw = JSON.parse(readFileSync(join(dir, 'tool-mode.extension.json'), 'utf8')) as Record<string, unknown>
    assert.equal('activation' in raw, false, 'the shipped bytes are untouched: defaults live in the validated form only')
    assert.equal('runtimeApi' in raw, false)
  })

  it('the pre-spec module implementation shape still validates (closed oneOf, both forms)', () => {
    const dir = scratch()
    mkdirSync(join(dir, 'schemas'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
      name: '@acme/plain-tools', version: '1.0.0', type: 'module',
      exports: { './tool-mode': './index.js', './tool-mode.extension.json': './tool-mode.extension.json', './package.json': './package.json' },
      toolMode: { manifest: './tool-mode.extension.json' },
    })}\n`)
    writeFileSync(join(dir, 'tool-mode.extension.json'), `${JSON.stringify(moduleShapeManifest(), null, 2)}\n`)
    writeFileSync(join(dir, 'index.js'), 'export const ok = true\n')
    writeFileSync(join(dir, 'schemas', 'in.json'), '{"type":"object"}\n')
    writeFileSync(join(dir, 'schemas', 'out.json'), '{"type":"object"}\n')
    const discovery = discoverExtension(dir)
    assert.equal(discovery.manifest.implementations[0]?.kind, undefined, 'the module form carries no kind')
  })
})

describe('§19.5 — validation refusals', () => {
  it('the shipped tool-mode-harness-text package is a self-contained declarative TMX package', () => {
    // The built-in text_title package must satisfy the SAME discovery path any
    // third-party declarative package does (EXT-03, RCP-12, task-56).
    const discovery = discoverExtension(join(process.cwd(), 'packages', 'tool-mode-harness-text'))
    assert.equal(discovery.packageName, '@try-works/tool-mode-harness-text')
    assert.equal(discovery.manifest.execution.kind, 'declarative')
    assert.ok(discovery.manifest.compatibility.requiredFeatures.includes('harness-model-recipes-v1'))
    const tool = discovery.manifest.tools[0]
    assert.ok(tool !== undefined)
    assert.equal(tool.name, 'text_title')
    assert.equal(tool.contractId, 'text.title')
    const implementation = discovery.manifest.implementations[0]
    assert.ok(implementation !== undefined)
    assert.equal(implementation.kind, 'harness-model')
    assert.equal(implementation.recipe, './recipes/text-title.json')
    assert.equal(discovery.manifest.permissions.harnessModel?.inputModalities.includes('text'), true)
  })

  it('a declarative package WITH an executable entry is refused', () => {
    const dir = scratch()
    materializeSpecPackage(dir)
    const manifest = specImageReviewManifest()
    ;(manifest.execution as Record<string, unknown>).entry = './index.js'
    writeFileSync(join(dir, 'tool-mode.extension.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    try {
      discoverExtension(dir)
      assert.fail('a declarative package with an entry must refuse')
    } catch (error) {
      assert.ok(error instanceof ManagementError)
      assert.equal(error.code, 'INVALID_EXTENSION')
      assert.match(error.message, /declarative package declares an executable entry/)
    }
  })

  it('an unknown required feature still refuses with INCOMPATIBLE_PROTOCOL', () => {
    const dir = scratch()
    materializeSpecPackage(dir)
    const manifest = specImageReviewManifest()
    ;(manifest.compatibility as Record<string, unknown>).requiredFeatures = ['teleportation-v1']
    writeFileSync(join(dir, 'tool-mode.extension.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    try {
      discoverExtension(dir)
      assert.fail('an unknown required feature must refuse')
    } catch (error) {
      assert.ok(error instanceof ManagementError)
      assert.equal(error.code, 'INCOMPATIBLE_PROTOCOL')
      assert.match(error.message, /teleportation-v1/)
    }
  })

  it('a harness-model binding whose recipe file is missing is refused (referenced-files check)', () => {
    const dir = scratch()
    materializeSpecPackage(dir)
    rmSync(join(dir, 'recipes', 'review.json'))
    try {
      discoverExtension(dir)
      assert.fail('a missing recipe file must refuse discovery')
    } catch (error) {
      assert.ok(error instanceof ManagementError)
      assert.equal(error.code, 'INVALID_EXTENSION')
    }
  })

  it('validateManifest accepts the spec manifest directly (shape-level conformance)', () => {
    const validated = validateManifest(specImageReviewManifest(), {
      packageName: '@acme/tool-mode-image-review',
      packageVersion: '1.0.0',
    })
    assert.equal(validated.execution.kind, 'declarative')
    assert.equal(validated.implementations[0]?.kind, 'harness-model')
    assert.equal(validated.permissions.harnessModel?.outputModalities[0], 'text')
  })
})
