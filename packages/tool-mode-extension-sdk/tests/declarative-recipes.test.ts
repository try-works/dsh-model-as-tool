/**
 * The declarative recipe convention (EXT-13, RCP-01, slice 3).
 *
 * These tests exist because the convention had no implementation to test: every package in
 * this repository was `kind: "module"`, so the declarative path was documented and unused. A
 * convention that only exists in a README is a convention every implementer gets to invent
 * differently.
 *
 * Requirement links: EXT-13, RCP-01, RCP-02, RCP-06.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  declaredRecipeNames,
  RECIPE_DIRECTORY,
  resolveDeclarativeImplementations,
  resolveDeclarativeRecipe,
} from '../src/declarative-recipes.ts'

const dirs: string[] = []
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

/** A package directory with the given recipes written into it. */
function packageWith(recipes: Record<string, unknown>, raw?: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'decl-'))
  dirs.push(dir)
  mkdirSync(join(dir, RECIPE_DIRECTORY), { recursive: true })
  for (const [name, body] of Object.entries(recipes)) {
    writeFileSync(join(dir, RECIPE_DIRECTORY, `${name}.json`), JSON.stringify(body))
  }
  for (const [name, body] of Object.entries(raw ?? {})) {
    writeFileSync(join(dir, RECIPE_DIRECTORY, `${name}.json`), body)
  }
  return dir
}

describe('RCP-01 — the convention is recipes/<implementation-id>.json', () => {
  it('names the directory in one exported constant', () => {
    // Stated once so a caller cannot invent a second spelling.
    assert.equal(RECIPE_DIRECTORY, 'recipes')
  })

  it('resolves a recipe by the implementation id', () => {
    const dir = packageWith({ 'text-title': { steps: [] } })
    const outcome = resolveDeclarativeRecipe(dir, 'text-title')
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.deepEqual(outcome.recipe, { steps: [] })
    assert.match(outcome.path, /recipes[\\/]text-title\.json$/)
  })

  it('names the convention IN the failure, so an author can fix it', () => {
    const dir = packageWith({})
    const outcome = resolveDeclarativeRecipe(dir, 'absent')
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.reason, 'missing')
    // A package author who put the file elsewhere can only act on a message that says WHERE
    // it was looked for.
    assert.match(outcome.detail, /recipes\/absent\.json/)
  })

  it('reports malformed JSON as invalid rather than as absent', () => {
    const dir = packageWith({}, { broken: '{ not json' })
    const outcome = resolveDeclarativeRecipe(dir, 'broken')
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    // The two are different problems with different fixes: one is a bad file, the other a
    // missing one.
    assert.equal(outcome.reason, 'invalid-json')
  })
})

describe('SEC-03 — the resolver builds a path, so it re-checks the id', () => {
  it('refuses an id that is not a legal recipe name', () => {
    const dir = packageWith({ ok: { a: 1 } })
    /**
     * The manifest schema constrains ids to `^[a-z][a-z0-9-]*$`, but this function turns an
     * id into a PATH, and a path built from an unvalidated string is a traversal. The
     * resolver does not trust that the schema ran.
     */
    for (const hostile of ['../escape', '..', 'a/b', 'A-UPPER', 'under_score', '', '.hidden', 'a\\b']) {
      const outcome = resolveDeclarativeRecipe(dir, hostile)
      assert.equal(outcome.ok, false, `${JSON.stringify(hostile)} must not resolve`)
    }
  })

  it('refuses traversal even when a file would exist at the resolved path', () => {
    const dir = packageWith({ ok: { a: 1 } })
    // A sibling file the traversal would reach if the id were trusted.
    writeFileSync(join(dir, 'secret.json'), JSON.stringify({ secret: true }))
    const outcome = resolveDeclarativeRecipe(dir, '../secret')
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.match(outcome.detail, /not a legal recipe name/)
  })
})

describe('RCP-02 — resolution is ALL-OR-NOTHING', () => {
  it('resolves every declared implementation', () => {
    const dir = packageWith({ one: { n: 1 }, two: { n: 2 } })
    const outcome = resolveDeclarativeImplementations(dir, [
      { id: 'one', contractId: 'tool-mode/a', recipeVersion: '1.0.0' },
      { id: 'two', contractId: 'tool-mode/b', recipeVersion: '1.0.0' },
    ])
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return
    assert.equal(outcome.resolved.length, 2)
    assert.equal(outcome.resolved[1]?.contractId, 'tool-mode/b')
  })

  it('refuses the WHOLE package when one recipe is missing', () => {
    const dir = packageWith({ one: { n: 1 } })
    const outcome = resolveDeclarativeImplementations(dir, [
      { id: 'one', contractId: 'tool-mode/a', recipeVersion: '1.0.0' },
      { id: 'two', contractId: 'tool-mode/b', recipeVersion: '1.0.0' },
    ])
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    /**
     * A package that satisfied HALF its declarations would be activated in a state its
     * manifest does not describe, and a caller would have no way to learn which half.
     */
    assert.equal(outcome.id, 'two')
    assert.match(outcome.detail, /recipes\/two\.json/)
  })

  it('a package declaring nothing resolves to nothing, successfully', () => {
    const dir = packageWith({})
    const outcome = resolveDeclarativeImplementations(dir, [])
    // Vacuously true, and asserted so the empty case is a decision rather than an accident.
    assert.equal(outcome.ok, true)
  })
})

describe('RCP-06 — the recipes present are enumerable', () => {
  it('lists the recipe names a package ships', () => {
    const dir = packageWith({ zeta: {}, alpha: {} })
    // Sorted, so a comparison is stable rather than filesystem-ordered.
    assert.deepEqual(declaredRecipeNames(dir), ['alpha', 'zeta'])
  })

  it('returns undefined for a package with no recipes at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'decl-none-'))
    dirs.push(dir)
    // Undefined is "not declarative", which is different from "declared nothing".
    assert.equal(declaredRecipeNames(dir), undefined)
  })

  it('ignores non-JSON files rather than treating them as recipes', () => {
    const dir = packageWith({ real: { a: 1 } })
    writeFileSync(join(dir, RECIPE_DIRECTORY, 'README.md'), 'not a recipe')
    assert.deepEqual(declaredRecipeNames(dir), ['real'])
  })
})
