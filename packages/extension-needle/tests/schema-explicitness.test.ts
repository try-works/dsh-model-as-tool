/**
 * TASK-124: every object node in every shipped schema must carry an EXPLICIT
 * `additionalProperties: true|false` — the host's schema compiler refuses any
 * node without one (the live embeddinggemma/laya activation refusals). This
 * offline recursion is the regression that would have caught both.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const SCHEMA_DIR = join(process.cwd(), 'packages', 'extension-needle', 'schema')

function walk(node: unknown, path: string, violations: string[], isPropertyMap = false): void {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return
  const record = node as Record<string, unknown>
  if (!isPropertyMap && record['type'] === 'object' && typeof record['additionalProperties'] !== 'boolean') {
    violations.push(`${path}: additionalProperties must be explicitly true or false`)
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === 'additionalProperties') continue
    walk(value, `${path}.${key}`, violations, key === 'properties')
  }
}

test('every object node in every shipped schema has an explicit additionalProperties', () => {
  const violations: string[] = []
  for (const file of readdirSync(SCHEMA_DIR).filter(name => name.endsWith('.json'))) {
    const parsed = JSON.parse(readFileSync(join(SCHEMA_DIR, file), 'utf8')) as unknown
    walk(parsed, file, violations)
  }
  assert.deepEqual(violations, [])
})
