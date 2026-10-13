/**
 * Validation tests (DECL-02, DECL-03, MOD-20).
 *
 * The interesting failure this file exists to prevent is NOT a crash. It is a schema keyword
 * the engine's grammar silently drops: the call still succeeds, the result is still
 * well-formed, and the returned object violates the caller's contract in a way neither side
 * can see. So the central test below is that an unsupported keyword is REFUSED BY NAME
 * rather than ignored, and the negative controls around it make sure the refusal is not
 * simply "everything is refused".
 *
 * Requirement links: DECL-02, DECL-03, MOD-20.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertInput,
  assertToolName,
  checkArguments,
  extractionTool,
  inputValidator,
  prepareExtractionSchema,
  renderErrors,
  SchemaRefusal,
} from '../src/validation.ts'
import { CALL_LIMITS, EXTRACTION_FUNCTION_NAME } from '../src/contracts.ts'

/** A schema a caller might reasonably write for an invoice. */
const INVOICE_SCHEMA = {
  type: 'object',
  description: 'one invoice',
  properties: {
    invoice_number: { type: 'string', description: 'the identifier printed on the invoice' },
    total_amount: { type: 'number' },
    currency: { type: 'string', enum: ['USD', 'EUR', 'GBP', 'CNY'] },
    due_date: { type: ['string', 'null'], description: 'ISO-8601, or null when absent' },
    line_items: { type: 'array', items: { type: 'string' } },
    issuer: {
      type: 'object',
      properties: { name: { type: 'string' }, country: { type: 'string', const: 'DE' } },
    },
  },
  required: ['invoice_number', 'total_amount', 'currency', 'due_date', 'line_items', 'issuer'],
}

describe('prepareExtractionSchema — a keyword the grammar would drop is REFUSED', () => {
  it('keeps the vocabulary the engine honours', () => {
    const { schema, propertyPaths } = prepareExtractionSchema(INVOICE_SCHEMA)
    assert.equal(schema.type, 'object')
    assert.equal(schema.description, 'one invoice')
    const properties = schema.properties as Record<string, Record<string, unknown>>
    assert.equal(properties.invoice_number?.type, 'string')
    assert.deepEqual(properties.currency?.enum, ['USD', 'EUR', 'GBP', 'CNY'])
    assert.deepEqual(properties.due_date?.type, ['string', 'null'])
    assert.deepEqual(properties.line_items?.items, { type: 'string' })
    assert.equal(properties.issuer?.additionalProperties, false)
    // Every declared path is reported, so a caller can see what the grammar was told about.
    assert.ok(propertyPaths.includes('(root).invoice_number'))
    assert.ok(propertyPaths.includes('(root).issuer.name'))
  })

  it('REFUSES a constraint the engine cannot enforce, by name', () => {
    // The failure this prevents: `minimum: 0` dropped by the grammar, the engine returns
    // -12.5, and the caller has no way to know the constraint never applied.
    for (const [keyword, value] of [
      ['minimum', 0],
      ['maximum', 100],
      ['pattern', '^AC-'],
      ['minLength', 3],
      ['format', 'date'],
      ['uniqueItems', true],
      ['oneOf', [{ type: 'string' }]],
      ['$ref', '#/$defs/x'],
      ['allOf', [{ type: 'string' }]],
    ] as const) {
      assert.throws(
        () => prepareExtractionSchema({
          type: 'object',
          properties: { field: { type: 'string', [keyword]: value } },
        }),
        (error: unknown) => {
          assert.ok(error instanceof SchemaRefusal, `${keyword} must produce a SchemaRefusal`)
          // `$` is a regex metacharacter, so the keyword is escaped rather than interpolated raw.
          const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          assert.match(error.message, new RegExp(`"${escaped}" is not part of the engine's grammar`))
          assert.match(error.path, /field/)
          return true
        },
        `${keyword} must be refused rather than dropped`,
      )
    }
  })

  it('closes every object, so an unrequested field is a grammar violation', () => {
    const { schema } = prepareExtractionSchema(INVOICE_SCHEMA)
    assert.equal(schema.additionalProperties, false)
    const nested = (schema.properties as Record<string, Record<string, unknown>>).issuer
    assert.equal(nested?.additionalProperties, false)
  })

  it('defaults `required` to every declared property, matching what the engine does', () => {
    // The grammar emits every property it was told about, so the honest contract is "all of
    // them are required" rather than an empty list that reads as "none".
    const { schema } = prepareExtractionSchema({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
    })
    assert.deepEqual([...(schema.required as string[])].sort(), ['a', 'b'])
  })

  it('refuses `required` naming a property that is not declared', () => {
    assert.throws(
      () => prepareExtractionSchema({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a', 'ghost'],
      }),
      /"required" names "ghost"/,
    )
  })

  it('requires an object root, because one call returns one record', () => {
    assert.throws(() => prepareExtractionSchema({ type: 'string' }), /must have "type": "object" at its root/)
    assert.throws(() => prepareExtractionSchema('not a schema'), /must be a JSON object/)
    assert.throws(() => prepareExtractionSchema([{ type: 'object' }]), /must be a JSON object/)
    assert.throws(() => prepareExtractionSchema(null), /must be a JSON object/)
  })

  it('admits only the nullable union form', () => {
    // `["string","null"]` is expressible; `["string","number"]` is not, and approximating it
    // to one branch would silently narrow the caller's contract.
    assert.doesNotThrow(() => prepareExtractionSchema({
      type: 'object',
      properties: { a: { type: ['number', 'null'] } },
    }))
    assert.throws(
      () => prepareExtractionSchema({ type: 'object', properties: { a: { type: ['string', 'number'] } } }),
      /type union \["string","number"\] is not expressible/,
    )
    assert.throws(
      () => prepareExtractionSchema({ type: 'object', properties: { a: { type: 'objectId' } } }),
      /type "objectId" is not admitted/,
    )
  })

  it('refuses `items` without an array and `properties` without an object', () => {
    assert.throws(
      () => prepareExtractionSchema({ type: 'object', properties: { a: { type: 'string', items: { type: 'string' } } } }),
      /"items" is only admitted where "type" is "array"/,
    )
    assert.throws(
      () => prepareExtractionSchema({ type: 'object', properties: { a: { type: 'string', properties: {} } } }),
      /"properties" is only admitted where "type" is "object"/,
    )
  })

  it('enforces the declared depth limit', () => {
    let node: Record<string, unknown> = { type: 'string' }
    for (let depth = CALL_LIMITS.maxSchemaDepth + 2; depth > 0; depth -= 1) {
      node = { type: 'object', properties: { level: node } }
    }
    assert.throws(
      () => prepareExtractionSchema(node),
      /nests deeper than the \d+-level limit/,
    )
  })

  it('enforces the declared property-count limit', () => {
    const properties: Record<string, unknown> = {}
    for (let index = 0; index <= CALL_LIMITS.maxSchemaProperties; index += 1) {
      properties[`field_${index}`] = { type: 'string' }
    }
    assert.throws(
      () => prepareExtractionSchema({ type: 'object', properties }),
      /more than the \d+-property limit/,
    )
  })

  it('preserves const and description, which are the two useful annotations', () => {
    const { schema } = prepareExtractionSchema({
      type: 'object',
      properties: { currency: { type: 'string', const: 'EUR', description: 'always euro here' } },
    })
    const currency = (schema.properties as Record<string, Record<string, unknown>>).currency
    assert.equal(currency?.const, 'EUR')
    assert.equal(currency?.description, 'always euro here')
  })
})

describe('extractionTool — the extraction function is fixed and inert', () => {
  it('uses the fixed function name and the caller\'s schema as its parameters', () => {
    const prepared = prepareExtractionSchema(INVOICE_SCHEMA)
    const tool = extractionTool(prepared, 'record every invoice field you can ground')
    // The name is NOT caller-supplied: otherwise a caller could name a real tool here and the
    // engine's proposal would be an invocation of that tool.
    assert.equal(tool.name, EXTRACTION_FUNCTION_NAME)
    assert.equal(tool.description, 'record every invoice field you can ground')
    assert.equal(tool.parameters, prepared.schema)
  })

  it('offers no field beyond name, description and parameters', () => {
    const tool = extractionTool(prepareExtractionSchema(INVOICE_SCHEMA), 'x')
    assert.deepEqual(Object.keys(tool).sort(), ['description', 'name', 'parameters'])
  })
})

describe('checkArguments — the model\'s answer is re-validated, not trusted', () => {
  const tool = {
    name: 'get_weather',
    description: 'Get the weather.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['city'],
      properties: { city: { type: 'string', minLength: 1 }, units: { enum: ['C', 'F'] } },
    },
  }

  it('accepts arguments that satisfy the offered schema', () => {
    assert.deepEqual(checkArguments(tool, { city: 'Shanghai' }), { valid: true, issues: [] })
    assert.deepEqual(checkArguments(tool, { city: 'Berlin', units: 'C' }), { valid: true, issues: [] })
  })

  it('reports EVERY violation rather than the first one', () => {
    // A caller fixing one problem at a time learns about the next call later, which is a
    // worse experience than a complete report.
    const report = checkArguments(tool, { units: 'K', extra: true })
    assert.equal(report.valid, false)
    assert.ok(report.issues.length >= 3, `expected several issues, saw ${JSON.stringify(report.issues)}`)
    assert.ok(report.issues.some(issue => /city/.test(issue)))
    assert.ok(report.issues.some(issue => /units/.test(issue)))
    assert.ok(report.issues.some(issue => /extra/.test(issue)))
  })

  it('reports an uncompilable offered schema as an issue instead of throwing', () => {
    // The tool list is CALLER-supplied, so a malformed entry is the caller's bug and must not
    // take the call down.
    const report = checkArguments(
      { name: 'broken', description: 'x', parameters: { type: 'not-a-type' } },
      {},
    )
    assert.equal(report.valid, false)
    assert.match(report.issues[0] ?? '', /does not compile/)
  })
})

describe('assertInput — the shipped schemas are the ones that decide', () => {
  it('accepts a well-formed tools_plan input', () => {
    assert.doesNotThrow(() => assertInput('tools-plan.input.json', {
      request: 'what is the weather in Shanghai?',
      tools: [{ name: 'get_weather', description: 'Get the weather.', parameters: { type: 'object' } }],
    }))
  })

  it('refuses a tools_plan input with no tools, naming the violation', () => {
    assert.throws(
      () => assertInput('tools-plan.input.json', { request: 'x', tools: [] }),
      /tools-plan\.input\.json.*tools/,
    )
  })

  it('refuses a tools_plan input with an unknown field', () => {
    assert.throws(
      () => assertInput('tools-plan.input.json', {
        request: 'x',
        tools: [{ name: 'a', description: 'b', parameters: {} }],
        exec: true,
      }),
      /additional properties|must NOT have additional properties/,
    )
  })

  it('caches compiled validators, so a repeated call does not recompile', () => {
    // Compilation is the expensive part of Ajv; a per-call compile would make validation the
    // slowest part of a fast tool.
    assert.equal(inputValidator('tools-plan.input.json'), inputValidator('tools-plan.input.json'))
  })

  it('renders Ajv errors as path-qualified strings', () => {
    const validate = inputValidator('tools-plan.input.json')
    validate({ request: '', tools: [] })
    const rendered = renderErrors(validate.errors)
    assert.ok(rendered.length > 0)
    assert.ok(rendered.every(line => typeof line === 'string' && line.length > 0))
    assert.equal(new Set(rendered).size, rendered.length, 'duplicate lines must be collapsed')
  })
})

describe('assertToolName — a name becomes a line in a file this package writes', () => {
  it('admits plain identifiers and refuses everything else', () => {
    assert.doesNotThrow(() => assertToolName('get_weather', 'x'))
    assert.doesNotThrow(() => assertToolName('ns.tool-1', 'x'))
    assert.throws(() => assertToolName('', 'x'), /must be 1\.\./)
    assert.throws(() => assertToolName('has space', 'x'), /not a plain identifier/)
    assert.throws(() => assertToolName('quote"name', 'x'), /not a plain identifier/)
    assert.throws(() => assertToolName('a'.repeat(CALL_LIMITS.maxToolNameCharacters + 1), 'x'), /must be 1\.\./)
    // A newline in a name is the one that would corrupt the document if the name were
    // interpolated rather than serialised.
    assert.throws(() => assertToolName('a\nb', 'x'), /not a plain identifier/)
  })
})
