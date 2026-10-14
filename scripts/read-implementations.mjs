/**
 * Report the manifest schema's `implementations` shape.
 *
 * Run: node scripts/read-implementations.mjs
 */
import { readFileSync } from 'node:fs'

const path = 'packages/tool-mode-extension-sdk/schema/extension-manifest-1.1.0.schema.json'
const schema = JSON.parse(readFileSync(path, 'utf8'))

const impl = schema.properties?.implementations
console.log('implementations:', JSON.stringify(impl, null, 2)?.slice(0, 1600))

// Does ANY property of the manifest name a recipe FILE?
const text = JSON.stringify(schema)
console.log('')
console.log('mentions "recipe":', text.includes('recipe'))
console.log('mentions "recipeVersion":', text.includes('recipeVersion'))
