/**
 * A DECLARATIVE package validates and carries no code (EXT-13, RCP-01, slice 3).
 *
 * The directive's third delivery slice is "declarative harness tools". The pinned manifest
 * schema allows `execution.kind: ["module","declarative"]` and the recipes README says a
 * declarative package needs `execution.kind: "declarative"` — but EVERY manifest in this
 * repository was `module`, so whether the validator accepted a declarative one had never been
 * established. It does, and these tests are what establishes it.
 *
 * Requirement links: EXT-13, RCP-01, RCP-02, DECL-01.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { validateManifest } from '@try-works/tool-mode-extension-sdk'

const DIR = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/** The package's own identity, which the manifest must match exactly. */
function identity() {
  return JSON.parse(readFileSync(join(DIR, 'package.json'), 'utf8')) as { name: string; version: string }
}

describe('EXT-13 — a declarative package is accepted', () => {
  it('validates against the pinned manifest schema', () => {
    const { name, version } = identity()
    const raw = JSON.parse(readFileSync(join(DIR, 'tool-mode.extension.json'), 'utf8'))
    const manifest = validateManifest(raw, {
      packageName: name,
      packageVersion: version,
      packageDir: DIR,
    }) as unknown as {
      execution: { kind: string; entry?: string }
      implementations: readonly { id: string; contractId: string; recipeVersion: string }[]
      compatibility: { requiredFeatures: readonly string[] }
    }

    // The kind is the whole point of the package.
    assert.equal(manifest.execution.kind, 'declarative')
    /**
     * And there is NO module entry. A declarative package that also declared `entry` would be
     * claiming a module it does not ship, which is the distinction the kind exists to draw.
     */
    assert.equal(manifest.execution.entry, undefined)
    assert.equal(manifest.implementations.length, 2)
  })

  it('SHIPS NO CODE — the property that makes it auditable as data', () => {
    /**
     * Asserted against the FILESYSTEM, because "ships no code" is a claim about what is in
     * the package rather than about what the manifest says. A `.js`, `.ts` or `lib/` here
     * would make the package executable and the declaration false.
     */
    const entries = readdirSync(DIR, { withFileTypes: true }).map(entry => entry.name)
    for (const forbidden of ['lib', 'dist', 'src', 'index.js', 'index.ts']) {
      assert.equal(entries.includes(forbidden), false, `a declarative package must not ship ${forbidden}`)
    }
    assert.equal(existsSync(join(DIR, 'lib')), false)
  })

  it('points at recipes that EXIST and parse', () => {
    /**
     * The manifest cannot name its recipe files — `implementations` items permit only
     * `id`, `contractId`, `contractVersion`, `modelId` and `recipeVersion`, with
     * `additionalProperties: false`, so the artefact is located by the host's own
     * convention rather than by a path in the manifest. What CAN be checked is that the
     * recipes this package ships are present and well formed, which is what makes the
     * version it declares meaningful.
     */
    const recipes = readdirSync(join(DIR, 'recipes')).filter(name => name.endsWith('.json'))
    assert.ok(recipes.length >= 2, `expected the declared recipes, saw: ${recipes.join(', ')}`)
    for (const recipe of recipes) {
      const parsed = JSON.parse(readFileSync(join(DIR, 'recipes', recipe), 'utf8')) as Record<string, unknown>
      assert.ok(Object.keys(parsed).length > 0, `${recipe} must not be empty`)
    }
  })

  it('a MODULE package is still distinguishable from a declarative one', () => {
    /**
     * The negative half: the kind is not merely accepted, it DISCRIMINATES. A module package
     * in this repository declares an entry point, and this one must not — otherwise the two
     * would be indistinguishable and the kind would carry no information.
     */
    const moduleManifest = JSON.parse(readFileSync(
      join(DIR, '..', 'extension-desert-ant-tongue', 'tool-mode.extension.json'),
      'utf8',
    )) as { execution: { kind: string; entry?: string } }
    assert.equal(moduleManifest.execution.kind, 'module')
    assert.equal(typeof moduleManifest.execution.entry, 'string')
  })
})
