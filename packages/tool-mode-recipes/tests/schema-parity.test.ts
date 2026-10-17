/**
 * Schema/code parity tests (RCP-02's published-schema gap, RCP-12's packaging clause).
 *
 * The published schema `schema/harness-model-recipe.schema.json` and the code
 * validator `src/recipe-format.ts` are TWO descriptions of ONE vocabulary. The
 * failure mode RCP-02 names is the two drifting apart: a document the code
 * accepts must be schema-valid, and every refusal the schema can represent must
 * also fail the code — so these tests run BOTH against the same fixtures, in
 * both directions where the vocabulary allows it.
 *
 * The fixtures themselves live in ./corpus.ts so the CLI tests refuse the same
 * documents.
 *
 * Requirement links: RCP-02, RCP-12, RCP-06.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'

import { parseRecipe, validateRecipeInputs } from '../src/recipe-format.ts'
import { DAMAGE_CASES, REPRESENTATIVE, baseDocument, damage } from './corpus.ts'

const SCHEMA_URL = new URL('../schema/harness-model-recipe.schema.json', import.meta.url)
const RECIPE_DIR = new URL('../recipes/', import.meta.url)
const HARNESS_TEXT_RECIPE = new URL('../../tool-mode-harness-text/recipes/text-title.json', import.meta.url)

const readJson = (url: URL): unknown => JSON.parse(readFileSync(fileURLToPath(url), 'utf8'))

/** The shipped schema, compiled once for the whole file. */
const schema = readJson(SCHEMA_URL) as Record<string, unknown>
const ajv = new Ajv2020({ strict: true })
const validateRecipe = ajv.compile(schema)

/** Whether the published schema admits a document. */
function schemaAdmits(document: unknown): boolean {
  return validateRecipe(document) === true
}

/** Whether the code validator admits a document. */
function codeAdmits(document: unknown): boolean {
  return parseRecipe(document).ok
}

describe('RCP-02 — the published schema exists and is compiled', () => {
  it('ships at the published path with the repository schema identity', () => {
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
    assert.equal(schema.$id, 'https://try-works.dev/tool-mode/harness-model-recipe.schema.json')
    assert.equal(schema.title, 'harness-model-recipe')
  })

  it('the shipped recipes validate against the published schema', () => {
    for (const name of ['describe-image.json', 'text-title.json']) {
      const document = readJson(new URL(name, RECIPE_DIR))
      assert.equal(codeAdmits(document), true, `${name} must parse in code`)
      assert.equal(schemaAdmits(document), true, `${name} must validate against the published schema`)
    }
  })

  it('a representative instance built from the TS types validates against both authorities', () => {
    assert.equal(codeAdmits(REPRESENTATIVE), true, 'the representative must be a valid recipe')
    assert.equal(schemaAdmits(REPRESENTATIVE), true, 'the representative must satisfy the published schema')
  })

  it('the full-coverage instance round-trips through JSON and still validates', () => {
    // The schema applies to JSON data; a TS object that cannot survive JSON
    // serialization is not a recipe document.
    const roundTripped = JSON.parse(JSON.stringify(REPRESENTATIVE)) as unknown
    assert.equal(codeAdmits(roundTripped), true)
    assert.equal(schemaAdmits(roundTripped), true)
  })
})

describe('RCP-02 — code and schema refuse the same damaged documents', () => {
  for (const [label, mutator] of Object.entries(DAMAGE_CASES)) {
    if (label === 'an input named like a reserved prototype key') continue // text-built case below
    it(`refuses ${label}`, () => {
      const document = damage(mutator)
      const code = parseRecipe(document)
      assert.equal(code.ok, false, `the code validator must refuse ${label}`)
      assert.equal(schemaAdmits(document), false, `the published schema must refuse ${label}`)
    })
  }

  it('refuses an input named like a reserved prototype key', () => {
    // Assignment cannot create an OWN __proto__ property (it sets the object's
    // prototype), so this case rebuilds the document from text; JSON.parse
    // treats the key as data, which is exactly what the code refuses (RCP-03).
    const text = JSON.stringify(baseDocument()).replace(
      '"inputs":{',
      '"inputs":{"__proto__":{"type":"string","required":false},',
    )
    const document = JSON.parse(text) as unknown
    assert.equal(parseRecipe(document).ok, false, 'the code validator must refuse the reserved key')
    assert.equal(schemaAdmits(document), false, 'the published schema must refuse the reserved key')
  })
})

describe('RCP-12 — the recipe and examples live in tool-mode-harness-text', () => {
  it('ships the text-title recipe in tool-mode-harness-text, byte-identical to the bundled copy', () => {
    const bundled = readFileSync(fileURLToPath(new URL('text-title.json', RECIPE_DIR)), 'utf8')
    const shipped = readFileSync(fileURLToPath(HARNESS_TEXT_RECIPE), 'utf8')
    // The copies must not drift: the harness-text package is the canonical home
    // RCP-12 names, and the broker's bundled copy is what runs. Equality is
    // pinned here rather than left to a reviewer's eyes.
    assert.equal(shipped, bundled, 'the tool-mode-harness-text copy must equal the bundled copy')
    assert.equal(schemaAdmits(readJson(HARNESS_TEXT_RECIPE)), true, 'the harness-text copy must validate')
  })

  it('ships a worked request whose arguments satisfy the recipe inputs', () => {
    const request = readJson(new URL('../../tool-mode-harness-text/examples/text-title-request.json', import.meta.url)) as {
      toolName: string
      arguments: Record<string, unknown>
    }
    assert.equal(request.toolName, 'text_title')
    const recipe = parseRecipe(readJson(new URL('text-title.json', RECIPE_DIR)))
    assert.ok(recipe.ok)
    const bound = validateRecipeInputs(recipe.recipe, request.arguments)
    assert.ok(bound.ok, 'the worked example arguments must bind')
  })

  it('ships a worked response within the 80/240 character bounds', () => {
    const response = readJson(new URL('../../tool-mode-harness-text/examples/text-title-response.json', import.meta.url)) as {
      title: string
      description: string
    }
    assert.ok(response.title.length > 0 && response.title.length <= 80, 'title within the TOOL-06 bound')
    assert.ok(response.description.length > 0 && response.description.length <= 240, 'description within the TOOL-06 bound')
  })
})
