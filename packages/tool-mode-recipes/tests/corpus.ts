/**
 * The shared recipe corpus for schema-vs-code parity and CLI tests.
 *
 * ONE source of truth for the representative full-coverage recipe and the 21
 * damage cases, so the published-schema test, the code-validator test and the
 * authoring CLI test all refuse the SAME documents (RCP-02's no-drift rule
 * applied to the tests themselves).
 *
 * Requirement links: RCP-02, RCP-08 (the CLI validates the same corpus).
 */

import type { RecipeManifest } from '../src/recipe-format.ts'

/**
 * A full-coverage recipe: every input kind, every keyword the vocabulary has,
 * built as a `RecipeManifest` literal so the instance is generated FROM THE TS
 * TYPES and then validated by every authority.
 */
export const REPRESENTATIVE: RecipeManifest = {
  id: 'full-coverage-sample',
  version: '1.0.0',
  description: 'Exercises every input kind and keyword the recipe vocabulary admits.',
  tool: { name: 'full_coverage', contractId: 'sample.full' },
  inputs: {
    text: { type: 'string', required: true, description: 'A bounded string.', minLength: 1, maxLength: 100 },
    kind: { type: 'string', required: false, enum: ['a', 'b'], default: 'a', description: 'One of two kinds.' },
    count: { type: 'integer', required: false, minimum: 0, maximum: 10, description: 'A bounded count.' },
    score: { type: 'number', required: false, minimum: 0, maximum: 1, description: 'A bounded score.' },
    flagged: { type: 'boolean', required: false, enum: [true, false], default: false, description: 'A flag.' },
    picture: {
      type: 'image',
      required: false,
      mediaTypes: ['image/png'],
      maxBytes: 1024,
      description: 'One small picture.',
    },
  },
  promptTemplate: 'Consider {{text}} of kind {{kind}}, count {{count}}, score {{score}}, flagged {{flagged}}, picture {{picture}}.',
  maxOutputTokens: 256,
  imageInputs: { max: 1 },
  policy: { record: true, allowRemote: false },
}

/** A valid base document for damage tests, held as parsed JSON (no prototypes). */
export function baseDocument(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(REPRESENTATIVE)) as Record<string, unknown>
}

/** Damage one parsed copy of the base document in exactly one way. */
export function damage(mutator: (document: Record<string, unknown>) => void): Record<string, unknown> {
  const document = baseDocument()
  mutator(document)
  return document
}

/** The 21 damage cases: one label per refusal the vocabulary must produce. */
export const DAMAGE_CASES: Readonly<Record<string, (document: Record<string, unknown>) => void>> = {
  'an unknown top-level key': document => { document['extra'] = true },
  'an unknown input key': document => {
    (document['inputs'] as Record<string, Record<string, unknown>>)['text']!['extra'] = 1
  },
  'a forbidden context key nested inside tool': document => {
    (document['tool'] as Record<string, unknown>)['history'] = []
  },
  'a forbidden context key at the top level': document => { document['tools'] = [] },
  'an input named like a forbidden context key': document => {
    const inputs = document['inputs'] as Record<string, Record<string, unknown>>
    inputs['memory'] = { type: 'string', required: false }
  },
  'a default on an image binding': document => {
    (document['inputs'] as Record<string, Record<string, unknown>>)['picture']!['default'] = 'x'
  },
  'a string-only keyword on an image binding': document => {
    (document['inputs'] as Record<string, Record<string, unknown>>)['picture']!['minLength'] = 3
  },
  'maxOutputTokens above the RES-10 ceiling': document => { document['maxOutputTokens'] = 2048 },
  'imageInputs.max above the RES-10 ceiling': document => {
    (document['imageInputs'] as Record<string, unknown>)['max'] = 3
  },
  'an empty inputs map': document => { document['inputs'] = {} },
  'a policy missing allowRemote': document => {
    delete (document['policy'] as Record<string, unknown>)['allowRemote']
  },
  'executable template syntax in the prompt': document => {
    document['promptTemplate'] = 'Run ${evil()} on {{text}}'
  },
  'a non-snake-case tool name': document => {
    (document['tool'] as Record<string, unknown>)['name'] = 'Bad_Name'
  },
  'a non-semantic version': document => { document['version'] = '1.0' },
  'an uppercase contract identity': document => {
    (document['tool'] as Record<string, unknown>)['contractId'] = 'Text.Title'
  },
  'an empty enum': document => {
    (document['inputs'] as Record<string, Record<string, unknown>>)['kind']!['enum'] = []
  },
  'a non-image media type': document => {
    (document['inputs'] as Record<string, Record<string, unknown>>)['picture']!['mediaTypes'] = ['text/plain']
  },
  'a zero maxBytes': document => {
    (document['inputs'] as Record<string, Record<string, unknown>>)['picture']!['maxBytes'] = 0
  },
  'a placeholder-like description': document => { document['description'] = 'short' },
  'a non-boolean required flag': document => {
    (document['inputs'] as Record<string, Record<string, unknown>>)['text']!['required'] = 'yes'
  },
  'an input named like a reserved prototype key': _document => {
    // Assignment cannot create an OWN __proto__ property (it sets the object's
    // prototype), so this case is built from JSON text below, where JSON.parse
    // treats the key as data — exactly what the code refuses (RCP-03).
    throw new Error('built from text; see damagedJson')
  },
}

/** The damage cases as serialized JSON documents, for file-based consumers. */
export function damagedJson(): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [label, mutator] of Object.entries(DAMAGE_CASES)) {
    if (label === 'an input named like a reserved prototype key') {
      const text = JSON.stringify(baseDocument()).replace(
        '"inputs":{',
        '"inputs":{"__proto__":{"type":"string","required":false},',
      )
      out[label] = text
      continue
    }
    out[label] = JSON.stringify(damage(mutator))
  }
  return out
}
