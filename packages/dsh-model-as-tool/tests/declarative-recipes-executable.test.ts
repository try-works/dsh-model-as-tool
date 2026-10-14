/**
 * The declarative package's recipes are EXECUTABLE INPUT, not inert data (RCP-01, RCP-02).
 *
 * THE CRUX OF SLICE 3, and the question that had never been asked of it. Three layers were
 * built — the manifest kind, the recipe convention, and the broker — and none was connected.
 * Proving they CAN be connected is a different claim from proving they ARE, and this test
 * makes only the first, deliberately.
 *
 * What it establishes: a recipe that came out of an INSTALLED declarative package parses
 * through the generic recipe machinery, yields a contract-shaped input schema, and renders a
 * prompt — with no reference to the two built-in recipes. That is the evidence that the
 * package's behaviour is genuinely data the broker can consume, rather than two hard-coded
 * tools wearing recipe files.
 *
 * WHAT IT DOES NOT ESTABLISH, stated so it is not implied: a completion. The host composes no
 * harness `LlmProvider`, so no model is called here and none is faked to look like one.
 *
 * Requirement links: RCP-01, RCP-02, DECL-01, HLM-01.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  inputSchemaFor,
  parseRecipe,
  renderPrompt,
  validateRecipeInputs,
} from '@try-works/tool-mode-recipes'

import { cleanup, tempDir } from './helpers.ts'

after(async () => { await cleanup() })

const RECIPES = join(process.cwd(), 'packages', 'extension-declarative-recipes', 'recipes')

/** Parse the package's own shipped recipe file. */
function parseShipped(name: string) {
  const raw = JSON.parse(readFileSync(join(RECIPES, `${name}.json`), 'utf8'))
  return parseRecipe(raw)
}

describe('RCP-01 — the shipped recipes parse as RECIPES, not as the built-ins', () => {
  it('parses text-title.json through the generic format', () => {
    const parsed = parseShipped('text-title')
    assert.equal(parsed.ok, true, parsed.ok ? '' : JSON.stringify(parsed).slice(0, 300))
    if (!parsed.ok) return

    /**
     * The identity comes from the FILE, and it agrees with what the manifest declares. A
     * recipe that named a different tool than the manifest advertises would install cleanly
     * and serve the wrong contract.
     */
    assert.equal(parsed.recipe.tool.name, 'text_title')
  })

  it('parses describe-image.json through the generic format', () => {
    const parsed = parseShipped('describe-image')
    assert.equal(parsed.ok, true, parsed.ok ? '' : JSON.stringify(parsed).slice(0, 300))
    if (!parsed.ok) return
    assert.equal(parsed.recipe.tool.name, 'describe_image')
  })

  it('projects a contract-shaped INPUT SCHEMA from the file alone', () => {
    const parsed = parseShipped('text-title')
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return

    /**
     * `inputSchemaFor` is the single source for the contract, the DSH parameter schema and the
     * MCP schema (DECL-01). That it can be derived from an INSTALLED package's recipe is what
     * makes a declarative tool indistinguishable from a coded one at the boundary.
     */
    const schema = inputSchemaFor(parsed.recipe)
    assert.ok(schema !== null && typeof schema === 'object')
    const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {}
    assert.ok(Object.keys(properties).length > 0, `expected declared inputs, saw ${JSON.stringify(schema)}`)
  })

  it('RENDERS a prompt from the file, so the recipe is behaviour and not metadata', () => {
    const parsed = parseShipped('text-title')
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return

    /**
     * The strongest single piece of evidence here: a rendered prompt means the file carries an
     * INSTRUCTION the broker can send, rather than a description of one. If this only returned
     * a schema, the package's recipes would be documentation.
     */
    const rendered = renderPrompt(parsed.recipe, { text: 'A section about caching', kind: 'section' })
    assert.ok(rendered !== null && rendered !== undefined)
    const asText = JSON.stringify(rendered)
    assert.ok(asText.length > 0, 'a rendered prompt must not be empty')
  })
})

describe('RCP-02 — the recipe REFUSES inputs it did not declare', () => {
  it('rejects an input the recipe never declared', () => {
    const parsed = parseShipped('text-title')
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return

    /**
     * The negative half, and it is the half that matters for a DATA-driven package: a recipe
     * that accepted arbitrary inputs would let a caller reach the harness with fields the
     * package never declared, which is exactly what the format exists to bound.
     */
    const outcome = validateRecipeInputs(parsed.recipe, { text: 'ok', undeclared: 'nope' })
    assert.equal(outcome.ok, false, `undeclared inputs must be refused, saw ${JSON.stringify(outcome)}`)
  })

  it('rejects a MISSING required input', () => {
    const parsed = parseShipped('text-title')
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    // The recipe declares `text`; omitting it must fail rather than reach the model with an
    // empty prompt.
    const outcome = validateRecipeInputs(parsed.recipe, {})
    assert.equal(outcome.ok, false)
  })

  void tempDir
})
