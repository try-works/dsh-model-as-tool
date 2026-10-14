/**
 * Report what the pinned schema allows for a request id.
 *
 * Run: node scripts/read-request-id.mjs
 */
import { readFileSync } from 'node:fs'

const schema = JSON.parse(readFileSync('docs/tool-mode/specs/mcp-2026-07-28/schema.json', 'utf8'))
const defs = schema.$defs ?? schema.definitions ?? {}

console.log('RequestId:', JSON.stringify(defs.RequestId))

const errorResponse = defs.JSONRPCErrorResponse
console.log('JSONRPCErrorResponse required:', JSON.stringify(errorResponse?.required ?? null))
console.log('JSONRPCErrorResponse id:', JSON.stringify(errorResponse?.properties?.id ?? null))
