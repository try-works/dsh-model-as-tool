#!/usr/bin/env node
/**
 * The independent conformance probe (MCP-17, MCP-04).
 *
 * MCP-17 requires "a separately authored probe plus the selected SDK to avoid two
 * sides sharing the same erroneous serializer". This file is that probe, and its
 * independence is structural rather than a claim:
 *
 * - It reads FROZEN FIXTURE FILES from disk. It never imports the server, the
 *   dispatch layer or the protocol module, so it cannot inherit a mistake from the
 *   code that produced the fixtures — only observe what was produced.
 * - It validates against the PINNED UPSTREAM SCHEMA with Ajv, so the standard being
 *   applied is the revision's own, not a local restatement of it.
 * - It reports, per fixture, which definition was applied and what failed.
 *
 * The gap this leaves is stated rather than hidden: a fixture is only as good as the
 * capture that produced it, and the capture used this repository's own code. What
 * the probe establishes is that the CAPTURED BYTES satisfy the upstream definitions
 * — not that every possible request would. MCP-17 warns that "a report whose only
 * protocol assertion is a string equality for 2026-07-28 fails this gate"; this
 * report asserts schema conformance of actual message bodies, per fixture.
 *
 * Usage: node scripts/probe-mcp-conformance.mjs [--json]
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'

const FIXTURE_DIR = 'docs/tool-mode/fixtures/mcp-2026-07-28'
const SCHEMA_PATH = 'docs/tool-mode/specs/mcp-2026-07-28/schema.json'

/**
 * Which schema definition each fixture's response must satisfy.
 *
 * Written out explicitly rather than inferred from the payload, because inferring it
 * would let the probe choose a definition its own body happens to satisfy — which is
 * the failure mode an independent probe exists to avoid.
 */
const RESPONSE_DEFINITION = {
  discover: 'DiscoverResultResponse',
  'tools-list': 'ListToolsResultResponse',
  'tools-call-success': 'CallToolResultResponse',
  'tools-call-domain-failure': 'CallToolResultResponse',
  'header-mismatch': 'HeaderMismatchError',
  'header-name-mismatch': 'HeaderMismatchError',
  'unsupported-version': 'JSONRPCErrorResponse',
  'missing-metadata': 'JSONRPCErrorResponse',
  'unknown-tool': 'JSONRPCErrorResponse',
  unauthenticated: 'JSONRPCErrorResponse',
  'remote-address': null,
  'concurrent-calls': 'CallToolResultResponse',
  cancellation: null,
  'unsupported-method': 'JSONRPCErrorResponse',
  'concurrent-discovery': 'ListToolsResultResponse',
}

/** Request definitions, checked as well as responses. */
const REQUEST_DEFINITION = {
  discover: 'DiscoverRequest',
  'tools-list': 'ListToolsRequest',
  'tools-call-success': 'CallToolRequest',
  'tools-call-domain-failure': 'CallToolRequest',
  'unsupported-version': 'ListToolsRequest',
  'unknown-tool': 'CallToolRequest',
  // No definition: the pinned schema has no resources/list request, which is the
  // point of the fixture. Claiming ListToolsRequest here was the probe's own bug.
  'unsupported-method': null,
}

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))
const ajv = new Ajv2020({ strict: false, allErrors: true })
ajv.addSchema(schema, 'mcp')

/** Compile a validator for a named definition. */
function validatorFor(definition) {
  return ajv.compile({ $ref: `mcp#/$defs/${definition}` })
}

/** Render Ajv errors compactly. */
function render(errors) {
  return (errors ?? []).map(error => `${error.instancePath || '(root)'} ${error.message ?? ''}`).join('; ')
}

const results = []
const fixtureFiles = readdirSync(FIXTURE_DIR).filter(name => name.endsWith('.json') && name !== 'MANIFEST.json')

for (const file of fixtureFiles.sort()) {
  const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8'))
  const checks = []

  // The response, against the definition the fixture is declared to exercise.
  const responseDefinition = RESPONSE_DEFINITION[fixture.name]
  if (responseDefinition !== undefined && responseDefinition !== null) {
    const validate = validatorFor(responseDefinition)
    // A concurrency fixture carries an array of responses; each must conform.
    const bodies = Array.isArray(fixture.response) ? fixture.response : [fixture.response]
    const ok = bodies.every(body => validate(body))
    checks.push({
      check: `response satisfies ${responseDefinition}`,
      ok,
      detail: ok ? '' : render(validate.errors),
    })
  } else if (responseDefinition === null) {
    /**
     * Explicitly NOT a protocol message: an HTTP-level refusal or a notification.
     *
     * The accurate claim is that no JSON-RPC ENVELOPE was produced, not that the
     * body is null. A 403 carries a bare transport error object, and asserting
     * `=== null` would have forced the capture to discard the very evidence the
     * fixture exists to record.
     */
    const isProtocolMessage = fixture.response !== null
      && typeof fixture.response === 'object'
      && 'jsonrpc' in fixture.response
    checks.push({
      check: 'no JSON-RPC envelope is expected',
      ok: !isProtocolMessage,
      detail: isProtocolMessage ? 'a JSON-RPC message was captured where a transport-level reply was expected' : '',
    })
  }

  // The request, so the corpus documents what was ACCEPTED as well as what came back.
  const requestDefinition = REQUEST_DEFINITION[fixture.name]
  if (requestDefinition !== undefined && requestDefinition !== null) {
    const validate = validatorFor(requestDefinition)
    const ok = validate(fixture.request)
    checks.push({
      check: `request satisfies ${requestDefinition}`,
      ok,
      detail: ok ? '' : render(validate.errors),
    })
  }

  // Structural facts the definitions cannot express on their own.
  if (fixture.response !== null && typeof fixture.response === 'object' && !Array.isArray(fixture.response)) {
    const hasResult = 'result' in fixture.response
    const hasError = 'error' in fixture.response
    checks.push({
      check: 'a message carries a result or an error, never both',
      ok: hasResult !== hasError,
      detail: hasResult && hasError ? 'both present' : (hasResult || hasError ? '' : 'neither present'),
    })
  }

  results.push({ name: fixture.name, checks })
}

const failures = results.flatMap(result =>
  result.checks.filter(check => !check.ok).map(check => ({ fixture: result.name, ...check })))
const totalChecks = results.reduce((sum, result) => sum + result.checks.length, 0)

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify({ totalChecks, failures, results }, null, 2)}\n`)
} else {
  console.log(`MCP conformance probe against the pinned schema`)
  console.log(`  schema : ${SCHEMA_PATH}`)
  console.log(`  fixtures: ${results.length}, checks: ${totalChecks}`)
  console.log('')
  for (const result of results) {
    const bad = result.checks.filter(check => !check.ok)
    console.log(`  ${bad.length === 0 ? 'PASS' : 'FAIL'}  ${result.name}`)
    for (const check of bad) console.log(`          ${check.check}: ${check.detail}`)
  }
  console.log('')
  if (failures.length === 0) {
    console.log(`probe OK — ${totalChecks} checks against the pinned schema, 0 failures.`)
  } else {
    console.error(`probe FAILED — ${failures.length} of ${totalChecks} checks failed.`)
  }
}

process.exitCode = failures.length === 0 ? 0 : 1
