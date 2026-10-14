/**
 * Reconcile the MCP/P26 records with the evidence.
 *
 * Two defects, both found by adversarial review and both about a reader being misled:
 *
 *  1. MCP-01 contradicts MCP-02 and MCP-03 INSIDE THE SAME FILE. MCP-01 says the HTTP
 *     transport and the stdio bridge "do not exist"; MCP-02 says the endpoint "is proven to
 *     bind and serve a real request over a real socket"; MCP-03 says the bridge "exists as a
 *     library and an executable".
 *  2. P26-01..05 and P26-11..13 have NO entry at all. A traceability generator renders an
 *     absent requirement as NOT_RUN, so six requirements with live coverage read as untouched.
 *
 * Run: node scripts/reconcile-mcp-records.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'

const path = 'docs/tool-mode/status.json'
const status = JSON.parse(readFileSync(path, 'utf8'))
const requirements = status.requirements ?? status

// --- 1. The contradiction -------------------------------------------------------------
const mcp01 = requirements['MCP-01']
if (mcp01 !== undefined) {
  const stale = 'Remaining: the HTTP transport, SSE response channel, subscriptions/listen, '
    + 'normalised cancellation and the stdio bridge executable do not exist; the protocol/client '
    + 'compatibility matrix is not yet recorded as a released artifact.'
  const corrected = 'CORRECTED AFTER ADVERSARIAL REVIEW — this sentence contradicted MCP-02 and '
    + 'MCP-03 in the same file. It claimed the HTTP transport and the stdio bridge "do not exist" '
    + 'while MCP-02 says the endpoint "is proven to bind and serve a real request over a real '
    + 'socket" and MCP-03 says the bridge "exists as a library and an executable". Both exist. '
    + 'What is genuinely still outstanding is narrower and is now stated exactly: the SSE '
    + 'response channel is not implemented, so a request that would need one is REFUSED rather '
    + 'than served with the message dropped; `subscriptions/listen` is implemented but composed '
    + 'into no transport, and is therefore NOT advertised, with its acknowledgement undeliverable '
    + 'over HTTP; normalised cancellation is implemented for the HTTP transport and not for the '
    + 'stdio bridge; and the protocol/client compatibility matrix is not yet recorded as a '
    + 'released artifact.'
  if (String(mcp01.evidence ?? '').includes(stale)) {
    mcp01.evidence = String(mcp01.evidence).replace(stale, corrected)
    console.log('MCP-01: contradiction replaced')
  } else {
    console.log('MCP-01: stale sentence not found verbatim — left alone')
  }
}

// --- 2. The six absent requirements ---------------------------------------------------
const LIVE = 'packages/dsh-model-as-tool/tests/mcp-live-conformance.test.ts'
const UNIT = 'packages/dsh-model-as-tool/tests/mcp-protocol.test.ts'
const V2 = 'packages/dsh-model-as-tool/tests/mcp-v2-interop.test.ts'
const PINNED = 'docs/tool-mode/specs/mcp-2026-07-28/schema.json'

const additions = {
  'P26-01': {
    status: 'PARTIAL',
    evidence:
      'The modern endpoint processes authorized requests independently of the handshake: it '
      + `requires no initialize, no notifications/initialized, no prior discovery and no session id. Asserted LIVE over a real socket (${LIVE}), including the NEGATIVE half — initialize at the old revision is answered -32601, so its absence is enforced rather than merely unexercised. The official @modelcontextprotocol/client 2.3.1 also drives this endpoint (${V2}), which is the strongest available evidence that an independent implementation agrees. PARTIAL because the endpoint is proven over loopback HTTP only; no other transport is served.`,
  },
  'P26-02': {
    status: 'DONE',
    evidence:
      'Every modern request carries its protocol version and client capabilities under the official keys in params._meta, and a request missing required metadata is invalid params (-32602) rather than a defaulted value. The reserved key names come from the pinned schema rather than from a reading of the prose (io.modelcontextprotocol/protocolVersion, .../clientCapabilities, .../clientInfo), and the live suite asserts both the accepted and the refused shape.',
  },
  'P26-03': {
    status: 'PARTIAL',
    evidence:
      'An unsupported version returns -32022 carrying the official `supported` and `requested` data; an unsupported REQUIRED client capability returns -32021. THE DATA SHAPE WAS WRONG AND IS FIXED: -32021 sent data.unsupported where the pinned MissingRequiredClientCapabilityError REQUIRES data.requiredCapabilities, reproduced with Ajv against the pinned schema — it survived because the GENERIC JSONRPCErrorResponse accepts any data and no fixture covered -32021. Both codes now return HTTP 400 as the schema states in three definitions verbatim ("For HTTP, the response status code MUST be 400 Bad Request"), asserted in BOTH directions including that a successful request still returns 200. PARTIAL because the version-error data shape is asserted against the pinned definitions only by the unit suite, not yet by a live fixture.',
  },
  'P26-04': {
    status: 'DONE',
    evidence:
      'Every modern result envelope carries the correct resultType and ordinary tool completion uses `complete`. A tool-domain failure is a tool-error RESULT and not a JSON-RPC error, and a malformed protocol request is a JSON-RPC error and not a result — the distinction the requirement is about. Asserted in the unit suite and live over the socket, and the official v2 client reads the envelopes without complaint.',
  },
  'P26-05': {
    status: 'PARTIAL',
    evidence:
      'POST only, with the revision\'s version/method/name headers checked against the body fields; a missing or mismatched required header returns HTTP 400 with HeaderMismatch (-32020). The stdio bridge is an HTTP CLIENT that generates these headers rather than a second protocol implementation, so the two paths cannot drift. LIVE-asserted, including that a header disagreeing with the body is refused. PARTIAL because the Base64 sentinel encoding is unit-tested rather than exercised live, and no third-party non-v2 client has been driven against the endpoint.',
  },
  'P26-11': {
    status: 'NOT_RUN',
    evidence:
      'MRTR (multi-round-trip) rather than server-originated RPC. NOT_RUN AND DELIBERATELY SO: this server issues no server-to-client input requests, so there is nothing to carry over the revision\'s multi-round-trip result pattern. It is recorded rather than omitted because an absent entry renders as untouched, and the honest statement is that the requirement has no surface here yet — not that it was forgotten. If sampling or elicitation is ever enabled, this becomes the mechanism and must be implemented before either is advertised.',
  },
  'P26-12': {
    status: 'DONE',
    evidence:
      'Optional extensions are not conflated with ordinary tools: the advertised-feature matrix declares tasks, sampling and elicitation as NOT implemented, and P26-12\'s rule is enforced by a test that reads the matrix. THE MATRIX WAS ALSO CORRECTED: subscriptions/listen was declared implemented unconditionally while the only production transport received no registry and answered -32601, so a client could plan around a feature it could never obtain. The feature is now re-decided from the WIRING and defaults to false, and a client REQUIRING it receives -32021 rather than a capability it cannot use.',
  },
  'P26-13': {
    status: 'PARTIAL',
    evidence:
      'The JSON Schema 2020-12 baseline is supported, and published contracts plus actual inputs and outputs are validated against it; unsupported dialects and constraints are REJECTED rather than silently accepted. The pinned schema is the authority (`' + PINNED + '`) and the saved-fixture probe validates 39 recorded messages against it. PARTIAL for a reason worth stating plainly: the live server\'s own messages are validated by the unit and live suites, but the probe that checks recorded fixtures NEVER STARTS THE SERVER, and no live response is currently Ajv-validated against the pinned definitions end to end — the gap that let the -32021 data shape through.',
  },
}

let added = 0
for (const [id, entry] of Object.entries(additions)) {
  if (requirements[id] === undefined) {
    requirements[id] = entry
    added += 1
  }
}

writeFileSync(path, `${JSON.stringify(status, null, 2)}\n`)
console.log(`added ${added} P26 entr(ies); total requirements now ${Object.keys(requirements).length}`)
