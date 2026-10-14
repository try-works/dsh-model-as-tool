# Adversarial review — the MCP wire layer

**Reviewer role:** adversarial (falsification), not confirmation.
**Date:** 2026-10-14. **Revision under review:** `2026-07-28`.
**Method:** read the pinned upstream schema definition-by-definition, drove the real modules in-process
(`server.ts`, `http.ts`, `subscriptions.ts`, `protocol.ts`) and validated the *actual* bytes against the
pinned `schema.json` with Ajv; ran the MCP suite (147 + 20 tests, all green, 0 skipped); then ran
**23 mutations** against a scratch copy of the repository at `E:\tmp\advrepo` (junction to the real
`node_modules`, no repository file touched). Requirement text was taken from
`docs/tool-mode/specs/Tool_Mode_DSH_Implementation_Spec_v1.2.md` §20 (P26-01…P26-17), MCP-01…MCP-13
(lines 199–229) and the pinned schema, never from this repository's summaries.

## Verdict

The MCP layer's evidence is **trustworthy for three methods and not for the rest**. `server/discover`,
`tools/list` and `tools/call` over the authenticated loopback HTTP transport are genuinely exercised
end-to-end — an official v2 client drives them, real inference returns, and 15 of 23 mutations were
caught by red tests. Everything the repository says *beyond* those three methods is weaker than stated:
**one message the server actually sends is not schema-conformant** (`-32021`), **two error classes return
the wrong HTTP status** where the pinned schema says `MUST be 400`, **the subscription feature is advertised
as implemented while the only production transport answers `-32601`**, and **the single requirement marked
DONE in the P26 family is "verified" by a test that cannot fail**. Confidence: high on every specific claim
below (each is reproduced by a command or a mutation), moderate on how much of the divergence is *known*
versus *unnoticed* — the status file contradicts itself in both directions, which suggests staleness rather
than concealment.

---

## 1. False passes

Each entry: the claim, the test, and a mutation that leaves the suite **green** while deleting or inverting
the behaviour the test names. `GREEN` = the mutation was applied to the scratch copy and the named test
files still exited 0.

### FP-1 — `mcp-v2-interop.test.ts:96-99`: the headline v2 claim is a short-circuit tautology
**Severity: HIGH.** The test named *"the v2 line IMPLEMENTS the 2026-07-28 revision this repository
targets"* asserts:

```ts
assert.ok(
  inClient || required === 'DiscoverRequestSchema' || required === 'DiscoverResultSchema',
  `the v2 client is missing ${required}`,
)
```

For two of the three names in the loop the condition is `something || true`. `DiscoverRequestSchema` and
`DiscoverResultSchema` are therefore **never checked**. Only `PROTOCOL_VERSION_META_KEY` is.
*Mutation not caught:* delete `DiscoverRequestSchema` and `DiscoverResultSchema` from the client (or set
`const exports = []`) — the suite is green. The comment above it ("Asserted from the package itself so it
cannot silently regress") is false for exactly the two exports the test is named after.
*Mutation caught:* replacing the third name breaks it, which is why the test looks meaningful at a glance.

### FP-2 — `mcp-v2-interop.test.ts:106-117`: the "nuance" test asserts nothing about the nuance
**Severity: MEDIUM.** The test is named *"reports the version constants that make the nuance precise"*, and
the nuance is that `LATEST_PROTOCOL_VERSION` is still `2025-11-25`. The assertions are
`typeof latest === 'string'`, `Array.isArray(supported)`, `supported.length > 0`.
*Mutation not caught:* if v2 shipped `LATEST_PROTOCOL_VERSION = '2026-07-28'` (which would falsify the whole
"the modern era is opt-in" narrative the module header and the status file rest on) the test stays green.

### FP-3 — `mcp-subscriptions.test.ts:227-233` asserts the advertisement, nothing asserts reachability
**Severity: HIGH.** The test *"advertises subscriptions/listen only because toolsListChanged is served"*
asserts `ADVERTISED_FEATURES.find(...).implemented === true`.
Reproduced against the real transport (`E:\tmp\adv-probe-1.mts`, case 6):

```
### 6. subscriptions/listen over the REAL HTTP transport (this is what a client gets)
  status: 200 body: {"jsonrpc":"2.0","id":"sub-1","error":{"code":-32601,
        "message":"this server does not offer catalog subscriptions"}}
```

`http.ts:239` calls `dispatch(wire, host, { signal })` — it never passes `subscriptions`, and
`server.ts:201-206` answers `-32601` when it is absent. `grep` for `subscriptions:` across the repository
finds exactly two callers: one test and `scripts/capture-mcp-fixtures.ts`. **No production path ever
constructs a registry.** The feature is `implemented: true` in the matrix and unreachable in the product.
*Mutation not caught:* wiring the registry into the HTTP transport changes no test outcome (it would only
make the suite *more* correct), and no test asserts the `-32601` answer is unreachable.

### FP-4 — `mcp-subscriptions.test.ts:87-93`: the ordering rule is enforced by a constant
**Severity: MEDIUM.** *"the subscription is marked announced before any publish can reach it"* asserts
`publishToolListChanged(2).length === 1`. `subscriptions.ts:131` constructs every subscription with
`announced: true`, so the guard at `subscriptions.ts:169` (`if (!subscription.announced) continue`) is
**dead code — there is no state in which it can be false**.
*Mutation not caught (GREEN):* `if (subscription.announced && false) continue` — the guard removed, 147/147
still pass. The module comment claims the ordering is "enforced rather than remembered"; it is neither,
it is a constant.

### FP-5 — `mcp-http.test.ts:347-356`: "interleaved requests do not interfere" cannot detect interference
**Severity: MEDIUM.** All three requests are `handler(httpRequest())` — byte-identical bodies with the same
`id: 'http-1'` — and the assertion is `assert.deepEqual(ids, ['http-1','http-1','http-1'])`. Any swap,
cache or cross-talk between the three responses is unobservable by construction.
*Mutation not caught:* returning the first response for all three (or keying a cache on nothing) leaves the
test green. The live test at `mcp-live-conformance.test.ts:263-277` does use distinct ids (101/202) and is
the only one of the two that could notice; the pure-function test named for interference adds nothing.

### FP-6 — `mcp-http.test.ts:284-295`: "does not implement resumability" compares a path to itself
**Severity: MEDIUM.** The handler contains no reference to `last-event-id` anywhere (verified by grep over
`src/mcp/**`). The test sends the header, gets byte-identical output, and asserts equality plus
`assert.equal('last-event-id' in withResume.headers, false)` — where `headers` is the object literal built
by `respond()`, which never has that key.
*Mutation not caught:* there is no guard to delete; the test proves only that an unread header is unread.
It is this test that carries **P26-07**, the only requirement the family table marks DONE
(`status.json` P26-07 evidence: *"the absence is asserted rather than assumed"*). The absence is asserted
by a test that cannot fail.

### FP-7 — `mcp-conformance.test.ts:136-146`: the tool-error schema test passes for the wrong branch
**Severity: LOW-MEDIUM.** *"a tool-error response is ALSO a valid CallToolResultResponse"* feeds a host
whose `callTool` returns `isError: true`. Deleting the `outcome.isError === true` branch at
`server.ts:265-268` produces `{content, structuredContent: null, resultType, _meta}` — which **also**
validates (the definition declares no `additionalProperties: false`, as `mcp-conformance.test.ts:187-202`
itself documents). The isError behaviour is genuinely guarded, but by `mcp-server.test.ts:234-241`
(`resultOf(response)?.isError === true`), not by the test whose name claims it.

### FP-8 — `mcp-http.test.ts:318-336` / `338-345`: "two simultaneous authorized clients" is two endpoints
**Severity: MEDIUM (claim, not just test).** MCP-03 requires "at least two simultaneous authorized clients
using the same host". The test builds **two `createHttpHandler` calls with two different configs**, i.e. two
independent endpoints, and the "one client's token is refused by another client's endpoint" case is the same
construction inverted. `StaticTokenAuth` (`http.ts:31-44`) holds exactly one token and one `clientId`, and
`clientId` is never read by any production code. Two clients against *one* endpoint is not implementable with
this type, let alone tested.

### FP-9 — `mcp-stdio.test.ts:176-191`: "forwarded verbatim" is asserted against a body that is already canonical
**Severity: LOW-MEDIUM.** The test asserts `calls[0].body === original`, where `original` was produced by
`JSON.stringify` in the same file. *Mutation not caught (GREEN):* replacing `body: trimmed` with
`body: JSON.stringify(JSON.parse(trimmed))` at `stdio.ts:156` — a re-serialisation — passes 147/147, because
re-serialising canonical JSON returns the same string. A real client's body (`{ "jsonrpc": "2.0", … }`,
`1.0`, `1e2`) would be altered by that mutation and the test could not tell.

---

## 2. Vacuous assertions

| Location | Assertion | Why it is vacuous |
| --- | --- | --- |
| `mcp-protocol.test.ts:352-358` | `deepEqual(implementedCapabilities(), ADVERTISED_FEATURES.filter(e => e.implemented).map(e => e.feature))` | The right-hand side is a verbatim transcription of the function body at `protocol.ts:235-237`. It is a change detector for one function, not a consistency check between the matrix and the advertisement (the advertisement that reaches a client is `serverCapabilities()` at `server.ts:300-308`, which the test never touches). |
| `mcp-protocol.test.ts:166-174` | `assert.ok(isReservedErrorCode(code))` for every `ERROR_CODES` value, and `isReservedErrorCode(-32022) === true` | P26-03 forbids **allocating custom errors in MCP-reserved ranges**. The predicate is `code >= -32768 && code <= -32000`, so the test passes equally for an invented `-32050`. `isReservedErrorCode` is called by nothing in `src/` — the prohibition is enforced by no code and verified by no assertion. |
| `mcp-protocol.test.ts:323-328`, `:316-321` | "emits exactly one frame per message", "each frame is newline-terminated" | Both test `serializeStdioFrame` (`protocol.ts:455-459`), which is **imported by no production module**. The real serializer is `frame()` at `stdio.ts:206-208`, which does *not* append a newline; the newline is added by the executable at `bin/dsh-tool-mode-mcp-stdio.mjs:50,66`. |
| `mcp-server.test.ts:87-93` | "retains nothing between two dispatches" | Two calls of a pure function with the same argument compared with `deepEqual`. A module-level cache would still return equal values. |
| `mcp-subscriptions.test.ts:69-71`, `:154-161` | `deepEqual([...SUPPORTED_FILTERS], ['toolsListChanged'])`; `notEqual(first, second)` + `match(first, /^sub_/)` | Restatements of constants. The second *does* have teeth — it is what makes the schema-conformant behaviour red (see SD-3). "a caller cannot choose" is never tested: no test ever sends a candidate id. |
| `mcp-subscriptions.test.ts:207-213` | `cancelSubscription('sub_1')` shape | `cancelSubscription` (`subscriptions.ts:251-257`) is called by nothing outside the test. It is a client-side helper the product does not use. |
| `mcp-host-binding.test.ts:143` | `assert.ok(outcome.text.length <= 100_100)` | The comment and the assertion are on the same source line (a missing newline), so the stated bound is easy to misread; it is satisfied by construction (`renderBounded` slices at 100 000 + marker). |
| `mcp-live-conformance.test.ts:207` | `console.log('TOOLSLIST-BODY:', …)` | Left-over debug output in a "live conformance" test. Cosmetic, but it is the kind of line that makes a transcript look like evidence. |

---

## 3. Claims not supported by the code

### C-1 — "every message the server sends is now validated against the pinned definitions by Ajv"
`docs/tool-mode/status.json` (MCP-01 entry, line 188) *and* the same claim flows into the P26-13
conformance suite's intent. The parenthetical list that follows names five definitions. Measured: the
`-32021` and `-32022` error bodies are **not** among them, and the `-32021` body is not conformant (SD-1).
The sentence is false as written; the honest version is "the five definitions listed".

### C-2 — "server/discover returns … the full feature matrix including what is NOT implemented, so a client can distinguish absent from unmentioned"
`status.json` MCP-05 evidence. `discoverResult()` (`server.ts:281-290`) returns exactly
`{supportedVersions, capabilities, cacheScope, ttlMs, resultType, _meta}` — `capabilities` is
`serverCapabilities()`, which emits only `{tools: {}}`. `ADVERTISED_FEATURES` never reaches the wire.
A client **cannot** distinguish "not implemented" from "not mentioned" — and `mcp-server.test.ts:175-177`
asserts that `features` is absent from the result, i.e. the suite proves the opposite of the claim.

### C-3 — "Catalog subscriptions are implemented and each rule the requirement states has a test"
`status.json` P26-09 evidence. Three problems, each reproduced: (a) over the only production transport the
method answers `-32601` (FP-3); (b) the acknowledgement that the same paragraph says "is returned WITH the
result" is a `followUp` member that `http.ts` **never reads** (`dispatch` produces `followUp` at
`server.ts:211`; the option is consumed only by `mcp-subscriptions.test.ts:106` and
`scripts/capture-mcp-fixtures.ts:323`) — no client ever receives `notifications/subscriptions/acknowledged`;
(c) "no event can precede it" is enforced by the constant `announced: true` (FP-4).

### C-4 — "Thirty-four checks", "Fifteen sanitized fixtures", "subscription and SSE fixtures are absent"
`status.json` P26-17 evidence. Measured on disk: `node scripts/probe-mcp-conformance.mjs` prints
**39 checks**, the fixture directory holds **17 fixtures** including `subscriptions-listen.json` and
`subscriptions-acknowledged.json` — both of which the probe validates and PASSes. `verification/FINAL-REPORT.md:21`
correctly says 39 while `status.json` says 34; the two generated artifacts disagree.

### C-5 — "the official SDK cannot speak 2026-07-28" / `officialSdkSupportsRevision: false`
`docs/tool-mode/fixtures/mcp-2026-07-28/MANIFEST.json:6-8` (`officialSdkVersion: "not-installed"`) and the
P26-17 status evidence. Contradicted by the repository's own suite: `@modelcontextprotocol/client@2.3.1` **is**
installed (`packages/dsh-model-as-tool/package.json` devDependencies) and
`mcp-v2-interop.test.ts` connects, lists tools and runs a real inference through it — 6/6 pass, **0 skipped**
(I ran it). The MANIFEST and the status evidence predate that work.

### C-6 — "Live conformance against the running server is not yet demonstrated"
`README.md:126` and `verification/FINAL-REPORT.md:21`. Understated to the point of being wrong:
`mcp-live-conformance.test.ts` starts a real server on an OS-chosen port and drives it over TCP with raw
`fetch`. Both public-facing documents understate the live evidence while the internal status file
overstates the subscription evidence — the three artifacts are not consistent with each other or with HEAD.

### C-7 — `docs/tool-mode/TRACEABILITY.md:359-375` maps P26-01…P26-05 and P26-11…P26-13 to `NOT_RUN` with `—`
Directly contradicted by the code and the suite: live tests cover P26-01/P26-02/P26-05, unit and
schema-validation tests cover P26-03/P26-04, and `mcp-conformance.test.ts` covers P26-13. In
`verification/requirements.json` every MCP/P26 item additionally carries `owningModule: "unmapped"` and
`evidence: null`, so TDD-01's "owning modules, test IDs" mapping does not exist for this family in either
direction.

### C-8 — "the pinned revision schema types `RequestId` as `string | integer` and does not admit null … Omitting it is therefore the conformant way"
`protocol.ts:320-333`. True, and Ajv confirms it (`/id must be string,integer`) — but the transport violates
its own rule at `http.ts:163-167`, which hand-writes `id: null` into the 413 body (SD-2).

### C-9 — the live tests' transport config does not match the type they claim to construct
`mcp-live-conformance.test.ts:41`, `mcp-v2-interop.test.ts:78`, `slice1-lifecycle.test.ts:250` all pass
`auth: { kind: 'static-token', token }`, while `StaticTokenAuth` (`http.ts:39-43`) declares
`{ scheme, token, clientId }`. Both live files silence the mismatch with `as HttpTransportConfig`. It happens
to work because only `auth.token` is read — but the tests are constructing the object against an imagined
type, and `npm run typecheck` cannot see it.

---

## 4. Spec divergences

All line numbers: spec text from `docs/tool-mode/specs/Tool_Mode_DSH_Implementation_Spec_v1.2.md` §20;
schema text from `docs/tool-mode/specs/mcp-2026-07-28/schema.json`.

### SD-1 — **P26-03, `-32021` carries the wrong `data`; the body is not schema-conformant.**
Spec: *"unsupported required client capability uses `-32021` and the schema-defined data."*
Schema (`MissingRequiredClientCapabilityError`): `error.data` **requires** `requiredCapabilities`
(a `ClientCapabilities` object). Code (`server.ts:159-163`) sends `data: { unsupported: ['sampling'] }`.
Reproduced:

```
body : {"jsonrpc":"2.0","id":"cap-1","error":{"code":-32021,
        "message":"the client requires unsupported capability: sampling","data":{"unsupported":["sampling"]}}}
MissingRequiredClientCapabilityError: INVALID -> /error/data must have required property 'requiredCapabilities'
JSONRPCErrorResponse (generic):        VALID
```

The generic definition passes, which is why the conformance suite (which only compiles
`JSONRPCErrorResponse` for error cases) never noticed. No fixture covers `-32021`. **This is the single most
serious finding**: a normative requirement names the data shape, the code has a different one, and the
repository claims in writing that every message the server sends is validated against the pinned schema.

### SD-2 — **P26-03 / schema: `-32022` and `-32021` must be HTTP 400; both return 200.**
Schema (`UnsupportedProtocolVersionError`, `MissingRequiredClientCapabilityError`): *"For HTTP, the response
status code MUST be `400 Bad Request`."* Code (`server.ts:228`) returns 400 only for `headerMismatch` and
`invalidParams`. Reproduced: `dispatch` for an unsupported version reports `httpStatus: 200`.
*Untested in both directions:* mutating the line so that `-32022` (M-F2) or `-32021` (M-N) becomes 400 leaves
147/147 green, so nothing pins the status either way. `docs/tool-mode/fixtures/mcp-2026-07-28/unsupported-version.json`
records no `http` block at all, and `scripts/probe-mcp-conformance.mjs` never reads `fixture.http`, so the
probe cannot see this class of defect (it also means the recorded expectation `HTTP 403` on
`remote-address.json` is unverified by the probe).

### SD-3 — **P26-09: `subscriptionId` must BE the `subscriptions/listen` request id; the code invents one.**
Schema (`SubscriptionsListenResultMetaObject`): *"The value is the JSON-RPC ID of the `subscriptions/listen`
request that opened the stream (and equals this response's `id`)."* Code (`subscriptions.ts:129`) issues
`sub_<base36 time>_<counter>`. Reproduced: request id `sub-1` → `subscriptionId "sub_mv7d983m_1"`; the saved
fixture records `"sub_mv7d983m_1"` against request `"sub-1"`, and the probe PASSes it because `RequestId` is
only `string | integer` — the requirement is semantic and the schema cannot express it.
**The suite locks the divergence in:** M-C (make `subscriptionId` the request id, i.e. make the code
conformant) is **RED** — `mcp-subscriptions.test.ts:160` (`match(first, /^sub_/`) fails.

### SD-4 — **P26-09 / schema: the result is the teardown message, not the acknowledgement.**
Schema (`SubscriptionsListenResult`): *"signalling that the subscription has ended gracefully … Because the
listen stream is long-lived, this result is sent only when the server tears the subscription down."*
Code returns it immediately as the HTTP 200 response to `subscriptions/listen` (`server.ts:207-212`), and has
no stream at all: the transport drops the acknowledgement (C-3b). P26-09's *"First send
`notifications/subscriptions/acknowledged` for that subscription"* is therefore not satisfied on the wire by
any transport, and P26-06's *"Support JSON and request-scoped SSE responses"* is not implemented anywhere
(`src/mcp/**` contains no `text/event-stream`; the handler always returns `application/json`).

### SD-5 — **P26-02: a required `notifications` member is defaulted, contrary to the module's own stated rule.**
Schema (`SubscriptionsListenRequestParams`): `notifications` is **required**. Code (`subscriptions.ts:125`)
does `(request.params?.notifications ?? {})` and returns a successful acknowledgement. Reproduced:

```
accepted by the server; result: {…"io.modelcontextprotocol/subscriptionId":"sub_mv7d983x_1"…}
the same request against the schema: INVALID -> /params must have required property 'notifications'
```

`protocol.ts:112-127` states the opposite principle for `_meta` ("Missing required metadata is `invalid
params`, not a defaulted value"). Two parsers, two rules.

### SD-6 — **P26-05: the request id is dropped from the header-mismatch error.**
`http.ts:235` builds it as `errorResponse(wire.id ?? null, …)`, but the body is only reachable through
`createHttpHandler`, where `wire` is parsed *before* `assertHeadersMatch`. Dropping the id entirely (M-O) is
**not caught** by any of the 147 tests, including the live header tests — while `protocol.ts:320-333` presents
the id handling as the thing "the independent probe caught".

### SD-7 — **P26-05: `Mcp-Method` is never required.**
Spec: *"Use POST and the revision's required version/method/name headers, checked against body fields. A
missing/mismatched required header returns HTTP 400 and `HeaderMismatch`"*, with the fixture listing
`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`. `assertHeadersMatch` (`protocol.ts:392-418`) requires the
version header, requires `Mcp-Name` only for `tools/call`, and treats `Mcp-Method` as optional. Reproduced:
a POST with no `Mcp-Method` at all returns **200** with a full tool list. Caveat: the pinned `schema.json`
mentions only `MCP-Protocol-Version` (one occurrence) and never `Mcp-Method`/`Mcp-Name`, so the stronger
reading rests on the spec prose alone — recorded as a divergence against the prose, with the caveat stated.

### SD-8 — **P26-16: the "qualification" list is not implemented.**
*"Test origin rejection, invalid/expired/wrong-audience tokens, insufficient scopes, token leakage, mixed
clients, bridge credential protection and preapproved headless operation."* Origin rejection, invalid tokens,
leakage and (single-token) mixed clients are tested. Expiry, audience and scopes cannot exist in a static-token
scheme; the bridge-credential path is untested (and `status.json` P26-16 justifies that by saying "the bridge
does not exist" while MCP-03 says it does — see C-7/§6). The code has no revocation surface at all: `http.ts`
compares one static string per config; `authProfile().perClientRevocable: true` (`http.ts:281`) is an assertion
with nothing behind it.

---

## 5. Falsification attempts that FAILED (evidence for the code)

23 mutations were applied to a scratch copy; **15 went red**. One of them (M-F, batch 1) went red for a
reason unrelated to what it probed — it removed the `invalidParams`/`headerMismatch` 400 conditions as
collateral — and was superseded by the surgical M-F2/M-N pair, which stayed green and is the real result.
The mutations that were **caught** are the strongest positive evidence in this review, because each names
the behaviour and the test that holds it:

| Mutation | Result |
| --- | --- |
| M-A: stop refusing to invoke a tool with `importedFromMcp` (MCP-13) | RED — `refuses to invoke a tool imported from MCP` (+ `calls.length === 0`) |
| M-B: accept `_meta` without `clientCapabilities` (P26-02) | RED — `requires clientCapabilities but ADMITS a request without clientInfo` |
| M-G: stop requiring `Mcp-Name` for `tools/call` (P26-05) | RED — both the unit and the live test |
| M-H: drop `resultType` from every success envelope (P26-04) | RED — 9 failures across schema validation and dispatch |
| M-J: skip the loopback check (SEC-02/MCP-02) | RED — `refuses a request from a remote address`, incl. the spoofed-Host case |
| M-K: skip authentication (P26-15) | RED — 4 failures, including the over-a-real-socket case |
| M-L: break deterministic tool ordering (MCP-06) | RED |
| M-P: let `successResult` overwrite a method-specific `_meta` | RED — the subscription test the source comment credits; **the comment is accurate** |
| M-Q: acknowledge filters the client did not request (P26-09) | RED — 3 failures |
| M-R: stop negotiating the version (P26-03) | RED — 3 failures, incl. schema validation |
| M-S: turn an infrastructure failure into a method-not-found error (MCP-10) | RED |
| M-U: route a diagnostic to the protocol sink (P26-08) | RED |
| M-V: export a tool with `notExportableReason` (MCP-12) | RED — including "refuses to call a withheld tool by name" |
| M-W: stop stripping the reserved `meta` from the payload schema (MCP-09) | RED — 2 failures |
| Live + v2 interop, end to end | 20/20 PASS, **0 skipped** — an official `@modelcontextprotocol/client` connects, lists tools and returns `de` through real inference. The parent briefing's "SKIPPED tests naming an era-selection gap" is **stale**: the era is selected with `versionNegotiation: { mode: 'auto' }` and the tests run. |
| `-32022` body against `UnsupportedProtocolVersionError` (Ajv) | VALID — `data.supported`/`data.requested` are exactly the schema's shape |
| `401` and `405` bodies against `JSONRPCErrorResponse` (Ajv) | VALID — the id is correctly *omitted*, not null, on those paths |
| Probe against the pinned schema | 39 checks, 0 failures, and its success line states its own scope ("SAVED FIXTURES … NOT live server conformance") — the honesty is real |

The complementary list — the **8 mutations that stayed GREEN**, i.e. the gaps that carry findings — is:

| Mutation | Result | Finding |
| --- | --- | --- |
| M-C: make `subscriptionId` the listen request id (the schema-correct behaviour) | GREEN-expected but RED — the suite *rejects* conformance | SD-3 |
| M-D: omit the null `id` from the 413 body | GREEN — untested in either direction | SD-2/C-8 |
| M-E: drop the non-schema `data.unsupported` member from `-32021` | GREEN — the data shape is unasserted | SD-1 |
| M-F2: answer `-32022` with HTTP 400 as the schema demands | GREEN — the status is unasserted | SD-2 |
| M-N: answer `-32021` with HTTP 400 as the schema demands | GREEN — the status is unasserted | SD-2 |
| M-I: delete the always-true `announced` guard | GREEN — dead branch | FP-4 |
| M-O: drop the request id from the header-mismatch error | GREEN — untested | SD-6 |
| M-T: re-serialise the stdio body instead of forwarding it verbatim | GREEN — the "verbatim" fixture is already canonical | FP-9 |

---

## 6. What I could not determine

- **Whether `Mcp-Method` is normatively required on every request.** The pinned `schema.json` never mentions
  it; only the spec prose and its illustrative fixture do. I could not obtain the revision's prose from the
  pinned artifacts, so SD-7 is stated against the prose, not proven.
- **Whether the `-32022`/`-32021` HTTP-200 behaviour was knowingly accepted.** The 400 rule is in the pinned
  schema's own description text, but nothing in the repo records a decision either way; the fixtures simply
  omit the status. I cannot distinguish "deferred" from "unnoticed".
- **Which of `status.json`, `MANIFEST.json`, `README.md` and `FINAL-REPORT.md` is authoritative.**
  `status.json` says 34 checks / 15 fixtures / "the bridge does not exist"; the probe prints 39, disk has 17,
  and `bin/dsh-tool-mode-mcp-stdio.mjs` exists. `MCP-01` (line 188) lists the HTTP transport, SSE channel,
  `subscriptions/listen`, cancellation and the bridge executable as "do not exist" **while MCP-02, MCP-03,
  P26-09 and P26-15 all describe them as implemented and tested** — the status file contradicts itself
  within the same family.
- **Whether any production caller ever starts the stdio bridge.** The executable exists and is statically
  checked; nothing in the repository spawns it, so "MCP-03, two clients" is not exercised as a system.
- **Whether the real `subscriptions/listen` stream is meant to be implemented at all.** P26-09's status
  admits "there is no SSE response stream", while `ADVERTISED_FEATURES` marks the feature `implemented: true`.
  The two cannot both be the intent.
- **Whether the `/mcp` endpoint is reachable outside tests.** Nothing in `src/index.ts` or the plugin starts
  `startHttpServer`; I did not audit the plugin's full startup path, so I state only what I measured: the
  *layer* is live-tested, and I found no production wiring for the subscriptions registry.

---

## Appendix — reproducing the measurements

```
# the whole MCP suite (green, 0 skipped)
npx tsx --test packages/dsh-model-as-tool/tests/mcp-*.test.ts

# the probe, and its self-declared scope
node scripts/probe-mcp-conformance.mjs

# the four schema divergences, reproduced in-process against the pinned schema
node node_modules/tsx/dist/cli.mjs E:\tmp\adv-probe-1.mts

# 23 mutations against a scratch copy (E:\tmp\advrepo), repository untouched
node E:\tmp\mutate.mjs
node E:\tmp\mutate2.mjs
```

Scratch artifacts live in `E:\tmp` only (`advrepo\`, `adv-probe-1.mts`, `mutate.mjs`, `mutate2.mjs`,
`dump-defs.cjs`). No file in the repository was modified, and `npm run verify` was not run.
