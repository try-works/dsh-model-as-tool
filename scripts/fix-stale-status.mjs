/**
 * Correct three stale records in status.json.
 *
 * Each one is now contradicted by evidence this repository produced, and the point of the
 * correction is that a status file is what a reader trusts when they do not re-run anything.
 *
 * Run: node scripts/fix-stale-status.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'

const path = 'docs/tool-mode/status.json'
const status = JSON.parse(readFileSync(path, 'utf8'))
const req = status.requirements ?? status
const before = JSON.stringify(req)

// 1. DEC-01 — the blocker claim is UNSUPPORTED and is corrected, not softened.
req['DEC-01'] = {
  status: 'PARTIAL',
  evidence:
    'CORRECTED. This was recorded as BLOCKED on the reasoning that "npm `laya-ts` returns 404 '
    + 'and no published Node entry point for Laya was found". The 404 is real; the CONCLUSION did '
    + 'not follow from it, and the recovery directive named this as an unsupported blocker claim. '
    + 'The SOURCE exists and was built here: github.com/NandhaKishorM/laya, pinned at '
    + 'c73908d96ff73c0062c340a11bf7c54ec7d8bc4d (tag v0.4.6), Apache-2.0. `npm ci` installs 115 '
    + 'packages with 0 vulnerabilities, `npm run build` exits 0 producing 26 files in dist/, and '
    + '`npm test` passes 886 tests with 0 failures; `npm run test:package` packs and installs into '
    + 'an external ESM TypeScript consumer. The ONNX export RUNS after diagnosing a real defect in '
    + 'the documented command: torch.onnx prints a check-mark glyph that this console (code page '
    + '437, Python stdout mapped to cp1252) cannot encode, so the export aborted inside a print() '
    + 'before writing anything. Re-running the SAME command with only PYTHONIOENCODING=utf-8 '
    + 'exits 0 and writes the artifacts; --no-verify was never used. Parity passed five independent '
    + 'checks, worst torch-vs-ONNX logits 1.0e-06. WHAT REMAINS OPEN IS NOT AVAILABILITY: the '
    + 'export is 1.29 GB across SIX files because encoder/head ship external .data tensors, so '
    + 'packaging only the two .onnx files would not load; the HF checkpoint repo carries no licence '
    + 'file of its own and rests on a model-card line; and DEC-08 (quality) is NOT_RUN and is '
    + 'untouched by any of this work. See docs/tool-mode/LAYA-INTEGRATION-FINDINGS.md.',
}

// 2. P26-07 — DONE, but the evidence described a test that could not fail.
req['P26-07'] = {
  status: 'DONE',
  evidence:
    'No resumability is implemented, and the absence is now FALSIFIABLY asserted. The evidence '
    + 'THIS ENTRY USED TO CITE COULD NOT FAIL: it sent Last-Event-ID and the same request without '
    + 'it, then compared the two bodies, but the handler never reads that header at all, so it was '
    + 'comparing a value WITH ITSELF and deleting the ban entirely would not have turned it red. '
    + 'An adversarial review found this, and the test was rebuilt with three checks, the third of '
    + 'which is the only kind that can prove an ABSENT feature: (1) the header changes no observable '
    + 'byte; (2) the response is application/json and carries no SSE `id:` field, because replay '
    + 'requires an event stream; (3) the header is not consulted ANYWHERE in the transport, '
    + 'asserted against the SOURCE with comment lines excluded, so reading-and-ignoring would fail '
    + 'it. The rewrite was MUTATION-TESTED: adding one line reading the header to src/mcp/http.ts '
    + 'turns it RED (33 pass, 1 fail) and reverting turns it green (34/34), so it now catches '
    + 'precisely the mutation it names. A retry remains a new request with fresh authorization.',
}

// 3. MCP-01 — the v2 finding belongs in the record.
const mcp01 = req['MCP-01'] ?? {}
req['MCP-01'] = {
  ...mcp01,
  status: 'PARTIAL',
  evidence:
    String(mcp01.evidence ?? '').replace(/\s+$/, '')
    + ' ADDED AFTER ADVERSARIAL REVIEW: an earlier note in this repository claimed the published '
    + 'SDK "cannot speak revision 2026-07-28". That was true of the V1 LINE ONLY — '
    + '@modelcontextprotocol/sdk 1.32.1 caps at 2025-11-25 — and it is corrected. The V2 line, '
    + '@modelcontextprotocol/server and @modelcontextprotocol/client 2.3.1, DOES implement the '
    + 'revision: it exports DiscoverRequestSchema, DiscoverResultSchema and '
    + 'PROTOCOL_VERSION_META_KEY, and the server package source serves the 2026-07-28 protocol '
    + 'revision. The official client was then driven against THIS server over a real socket: with '
    + 'versionNegotiation mode "auto" it probes with server/discover, connects, lists tools, and '
    + 'runs REAL inference through tools/call (lang_detect on German returns de) and is refused '
    + 'without a credential — 6 tests, 0 skipped. A default-configured client still negotiates '
    + 'initialize at 2025-11-25 and never probes, which is why the modern era is OPT-IN and why '
    + 'this server answers -32601 to that handshake; both halves are asserted. STILL PARTIAL '
    + 'because the subscription acknowledgement is produced and read by no transport.',
}

if (JSON.stringify(req) === before) {
  console.log('no change — nothing to correct')
} else {
  writeFileSync(path, `${JSON.stringify(status, null, 2)}\n`)
  console.log('corrected DEC-01, P26-07 and MCP-01 in docs/tool-mode/status.json')
}
