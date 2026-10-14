/**
 * Report the manifest schema's supported `execution` kinds.
 *
 * The question for slice 3: is a DECLARATIVE execution kind expressible, or does the schema
 * admit only a module entry point?
 *
 * Run: node scripts/read-execution-kinds.mjs
 */
import { readFileSync } from 'node:fs'

const path = 'packages/tool-mode-extension-sdk/schema/extension-manifest-1.1.0.schema.json'
const schema = JSON.parse(readFileSync(path, 'utf8'))
const defs = schema.$defs ?? schema.definitions ?? {}

const execution = schema.properties?.execution ?? defs.execution
console.log('execution:', JSON.stringify(execution, null, 2)?.slice(0, 1400))

// Any nested oneOf variant naming a kind.
const text = JSON.stringify(schema)
for (const kind of ['declarative', 'module', 'builtin', 'recipe']) {
  console.log(`mentions "${kind}":`, text.includes(`"${kind}"`))
}
