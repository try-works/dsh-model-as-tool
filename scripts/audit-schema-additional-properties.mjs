/**
 * Schema audit helper (task-124/125): walk every schema file under the
 * extension packages and report every SCHEMA OBJECT node whose
 * `additionalProperties` is not an explicit boolean. The host's schema
 * compiler requires explicitness on every schema object node, nested `items`
 * included.
 *
 * Property-maps (the VALUE of a `properties` keyword) are NOT schema nodes:
 * their keys are property names, so the closedness flag belongs on the
 * enclosing schema object — the walker visits the map's entries as schemas
 * but never checks the map itself (task-125/B).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(process.cwd(), 'packages')
const extensions = readdirSync(ROOT).filter(name => name.startsWith('extension-'))

function walkObject(node, path, schemaFile, out, isPropertyMap) {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return
  if (!isPropertyMap && node.type === 'object' && typeof node.additionalProperties !== 'boolean') {
    out.push(`${schemaFile}:${path} type=object additionalProperties=${String(node.additionalProperties)}`)
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'additionalProperties') continue
    if (typeof value === 'object' && value !== null) {
      walkObject(value, `${path}.${key}`, schemaFile, out, key === 'properties')
    }
  }
}

const findings = []
for (const extension of extensions) {
  for (const dir of ['schema', 'schemas']) {
    const base = join(ROOT, extension, dir)
    if (!statSync(base, { throwIfNoEntry: false })?.isDirectory()) continue
    for (const file of readdirSync(base).filter(name => name.endsWith('.json'))) {
      const full = join(base, file)
      const parsed = JSON.parse(readFileSync(full, 'utf8'))
      walkObject(parsed, '$', `${extension}/${dir}/${file}`, findings, false)
    }
  }
}

if (findings.length === 0) {
  console.log('AUDIT-CLEAN: every schema object node carries an explicit additionalProperties boolean')
} else {
  for (const finding of findings) console.log(finding)
  console.log(`TOTAL: ${findings.length} nodes to fix`)
  process.exit(1)
}
