/**
 * compileSchema on the 2020-12 dialect (task-5 interop).
 *
 * The host compiles extension-declared schemas through `compileSchema`. Before
 * the Ajv2020 upgrade a 2020-12 document — the dialect extension packages
 * actually ship (`$schema`, `$id`, `$defs`) — failed draft-07 compilation at its
 * `#/$defs/...` references, so a real package could not be activated. These
 * tests pin three properties of the upgraded compiler: 2020-12 constructs
 * compile, the REAL shipped extension-needle schema files compile through this
 * exact path (not a fixture), and a broken schema still refuses loudly.
 *
 * Requirement links: P26-13 (schema compile refusal), DECL-01, NDL-02 (the
 * planning surface whose schemas motivated the upgrade).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020'

import { compileSchema, ContractError, assertAgainstSchema } from '../src/index.ts'

const NEEDLE_SCHEMA_DIR = new URL('../../extension-needle/schema/', import.meta.url)

/** The shipped schema files of the real extension-needle package. */
function shippedNeedleSchemas(): Readonly<Record<string, unknown>>[] {
  const out: Readonly<Record<string, unknown>>[] = []
  for (const name of readdirSync(fileURLToPath(NEEDLE_SCHEMA_DIR)).sort()) {
    if (!name.endsWith('.json')) continue
    out.push(JSON.parse(readFileSync(fileURLToPath(new URL(name, NEEDLE_SCHEMA_DIR)), 'utf8')) as Record<string, unknown>)
  }
  return out
}

describe('compileSchema — 2020-12 constructs compile', () => {
  it('compiles a schema with $defs and enforces it', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      required: ['entry'],
      properties: {
        entry: { $ref: '#/$defs/entry' },
      },
      $defs: {
        entry: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: { name: { type: 'string', minLength: 1 } },
        },
      },
    }
    const validate = compileSchema(schema)
    assert.deepEqual([...validate({ entry: { name: 'ok' } })], [])
    const violations = validate({ entry: { name: '' } })
    assert.equal(violations.length, 1)
    assert.match(violations[0] ?? '', /minLength|must NOT have fewer/i)

    assert.throws(() => assertAgainstSchema('2020-12-test', validate, { entry: { name: '' } }))
  })

  it('compiles a schema with a local $ref into $defs', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $defs: { scalar: { type: 'string' } },
      type: 'object',
      additionalProperties: false,
      properties: { value: { $ref: '#/$defs/scalar' } },
    }
    const validate = compileSchema(schema)
    assert.deepEqual([...validate({ value: 'x' })], [])
    assert.equal(validate({ value: 3 }).length, 1)
  })

  it('a broken schema still refuses loudly instead of compiling to a no-op', () => {
    // The upgrade must not turn schema compilation into silent acceptance: an
    // unresolvable reference is a refusal at registration (P26-13).
    const broken = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { value: { $ref: '#/$defs/never-declared' } },
    }
    assert.throws(() => compileSchema(broken), (error: unknown) => {
      assert.ok(error instanceof ContractError)
      assert.match(error.message, /does not compile/)
      return true
    })
  })

  it('recompiling identical $id content is tolerated (re-activation), different content is refused', () => {
    // Ajv registers a compiled schema under its $id and throws on a second
    // compile — which would break re-activating an extension. Identical bytes
    // must reuse the validator; DRIFTED bytes under one id must refuse.
    const first = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://try-works.dev/tool-mode/test/compile-2020-recompile.schema.json',
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string' } },
    }
    const validate = compileSchema(first)
    assert.deepEqual([...validate({ name: 'x' })], [])
    // The same content again — as a re-activation would do.
    const same = JSON.parse(JSON.stringify(first)) as Record<string, unknown>
    assert.doesNotThrow(() => compileSchema(same))
    // Drifted content under the same id is a refusal, never a silent adoption.
    const drifted = { ...(JSON.parse(JSON.stringify(first)) as Record<string, unknown>), properties: { name: { type: 'integer' } } }
    assert.throws(() => compileSchema(drifted), (error: unknown) => {
      assert.ok(error instanceof ContractError)
      assert.match(error.message, /different content/)
      return true
    })
  })
})

describe('the REAL shipped needle schemas compile through the host path', () => {
  it('every shipped extension-needle schema compiles via compileSchema', () => {
    const schemas = shippedNeedleSchemas()
    assert.equal(schemas.length, 4, 'the four shipped files must all be present')
    for (const schema of schemas) {
      assert.equal((schema as { $schema?: unknown }).$schema, 'https://json-schema.org/draft/2020-12/schema')
      assert.doesNotThrow(() => compileSchema(schema), `schema ${String((schema as { title?: unknown }).title)} must compile`)
    }
  })

  it('the shipped files are strict-2020 compliant (strict mode compiles them)', () => {
    // The audit half: under a STRICT Ajv2020 (only allowUnionTypes relaxed, for
    // the nullable-field unions) the shipped files still compile — every shaped
    // object closes additionalProperties, and the exactly-one-source rule is a
    // plain oneOf instead of a not-required pattern.
    const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true })
    for (const schema of shippedNeedleSchemas()) {
      assert.doesNotThrow(
        () => ajv.compile(schema as never),
        `schema ${String((schema as { title?: unknown }).title)} must compile under strict 2020-12`,
      )
    }
  })

  it('a well-formed tools_plan result validates through the shipped output schema', () => {
    const files = new Map<string, Record<string, unknown>>()
    for (const name of readdirSync(fileURLToPath(NEEDLE_SCHEMA_DIR)).sort()) {
      if (name.endsWith('.json')) {
        files.set(name, JSON.parse(readFileSync(fileURLToPath(new URL(name, NEEDLE_SCHEMA_DIR)), 'utf8')) as Record<string, unknown>)
      }
    }
    const output = files.get('tools-plan.output.json')
    assert.ok(output !== undefined)
    const validate = compileSchema(output)
    const plan = {
      proposals: [{
        name: 'get_weather',
        arguments: { city: 'Shanghai' },
        offered: true,
        valid: true,
        issues: [],
      }],
      rejected: [],
      reasoning: 'the query asks for weather',
      confidence: 0.9677,
      grounding: { ungrounded: [], negation: false },
      meta: {
        contract: 'planning.tools',
        contractVersion: '1.0.0',
        implementationId: 'needle3-native-tools-plan',
        extension: '@try-works/extension-needle',
        extensionVersion: '0.1.0',
        activationGeneration: 1,
        executionLocation: 'device',
        receiptId: 'rcpt_compile_2020_1',
        warnings: [],
      },
    }
    assert.deepEqual([...validate(plan)], [], 'the canonical plan result must validate')
    // The envelope is required: an unprovenanced result must not pass.
    const { meta: _dropped, ...bare } = plan
    assert.ok(validate(bare).length > 0, 'a result without the host-stamped meta must be refused')
  })
})
