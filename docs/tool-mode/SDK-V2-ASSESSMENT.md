# MCP TypeScript SDK v2 — adoption audit and corrective work

## User requirement and current verdict

The user requested the official TypeScript SDK **v2** from the upstream `main` line,
using `@modelcontextprotocol/server` and `@modelcontextprotocol/client`, implementing
MCP **2026-07-28**, and an assessment of the Node HTTP wrapper.

**Production adoption landed, including the native HTTP boundary.** The HTTP path
imports `serveSdkV2Request` and uses the official `createMcpHandler` with a fresh
`McpServer` per request (capabilities `tools.listChanged:false`, `legacy:'reject'`,
`responseMode:'auto'`, protocol `2026-07-28` only). Accepted business calls use the
host's existing `callTool` boundary under the transport-verified caller's grant. The
combined focused run is 102/102 (official client over a real socket invoking the
official server's registered callback and real `lang_detect`, authentication, rate
limiting, verified per-client grants, pinned error envelopes, strict required
`Mcp-Method`, sentinel headers, empty-caller catalog, finite SSE preservation), and a
dedicated native-transport suite is 7/7 (live progress frames before final completion,
client disconnect cancels host work before headers and mid-SSE, guards refuse before
the SDK callback, endpoint close aborts outstanding work). Remaining, separately
tracked: the two result-bound fixes (tool-error text clamp on the accepted-failure
branch; arbitrary-JSON `structuredContent`) are in flight; managed-worker host
integration (task-27) is in flight; the release gate stays RED until the full
`npm run verify` passes. Focused passes are not release approval.

The earlier version of this document unilaterally declared server migration outside
the goal. That was not an approved deviation from the user's instruction and is
superseded by this correction. No release approval follows from client interoperability.

## Immutable upstream evidence

Upstream `main` was resolved through the GitHub commit API to:

- Repository: https://github.com/modelcontextprotocol/typescript-sdk
- Commit: `9bc40e903fde15534ec06ff4c1347d47000dbe16`
- Commit date: `2026-10-13T12:11:15Z`
- Commit API: https://api.github.com/repos/modelcontextprotocol/typescript-sdk/commits/9bc40e903fde15534ec06ff4c1347d47000dbe16
- Version in the pinned server source manifest: **2.3.1**
- Manifest: https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/9bc40e903fde15534ec06ff4c1347d47000dbe16/packages/server/package.json
- HTTP guide: https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/9bc40e903fde15534ec06ff4c1347d47000dbe16/docs/serving/http.md
- v2 documentation: https://ts.sdk.modelcontextprotocol.io/v2/
- Target specification: https://modelcontextprotocol.io/specification/2026-07-28

The installed packages are npm release artifacts, pinned to `2.3.1`; their version
matches the pinned upstream source manifest. **Version equality alone is not proof
of byte-for-byte equivalence with a build of that commit.** Release/source integrity
and provenance must be recorded separately; the implementation must not describe an
npm install as a source build from `main` without that evidence.

## Serving API and the Node adapter

The official HTTP guide specifies:

1. `createMcpHandler(factory)` builds a fresh `McpServer` per HTTP request.
2. `handler.fetch(Request, { authInfo })` accepts already-verified identity; the SDK
   handler does not itself verify bearer tokens, Host or Origin.
3. `@modelcontextprotocol/node` provides `toNodeHandler(handler)` for plain
   `node:http` `IncomingMessage` / `ServerResponse` consumers.
4. Header validation, authentication, size limits, rate limiting, grants and
   accounting remain required at the host boundary around the official handler.
5. `handler.close()` is the shutdown hook for in-flight per-request instances.

**Decision:** use the official stateless handler as the production protocol engine,
and consume `@modelcontextprotocol/node` **as `toWebRequest`** (declared as a host
production dependency at `2.1.1`, the version in the pinned upstream source manifest;
registry integrity recorded in the host package lock). Raw `toNodeHandler` is **not**
wired: its own error fallback emits `id: null` / code `-32000`, which the pinned
`2026-07-28` schema forbids (`RequestId` is `string | integer`, no null), it only
watches `res.close`, and it swallows stream errors. The host instead runs the official
`toWebRequest` conversion after its unchanged acceptance gate (Host/Origin, bearer,
grant, rate, size, header/metadata checks) and pumps the streaming `Response.body`
itself: write-backpressure raced against disconnect, `res.close`/incoming-abort linked
into the request `AbortSignal` so a real socket drop cancels business execution, and
the per-request SDK handler is closed on drain/cancel/abort/error — never while SSE
frames are still pending. The pinned 413/error envelopes are preserved because the
host pump, not the adapter's fallback, renders transport refusals.

The prior argument that statelessness rules out the official Node adapter was wrong:
the official per-request factory is explicitly stateless. Compatibility of the
low-level sessionful transport is a separate question and is not the recommended
modern serving route.

## Acceptance evidence required

- [x] Production code imports and uses the official v2 server, not only a test fixture
      (`sdk-v2.ts` `createMcpHandler`, fresh `McpServer` per request).
- [x] Official v2 client requests at revision 2026-07-28 list and execute a real host tool
      (real socket `lang_detect` in the combined 102-test run and the interop suite).
- [x] Every request still passes Host/Origin, authentication, body-size and rate-limit
      guards before business execution (streaming suite pins refusals before the SDK
      callback; wire-adaptation suite pins the guards).
- [x] Verified per-client grants and composed subcall authority remain intact
      (client-grant + SEC-04 suites green in the combined run).
- [x] Unauthorized requests are refused without inference; no v1 session/replay state
      is introduced into the modern path (`legacy:'reject'`, no session).
- [x] Cancellation, notification delivery and shutdown pass against the adopted server:
      disconnect-cancels-host-work (pre-headers and mid-SSE), progress frames stream
      live, handler closes on drain/cancel/abort, endpoint close aborts outstanding
      work. **Packed-install tests against the adopted server remain pending until the
      full `npm run verify` passes.**
- [x] Actual upstream commit, installed release versions and artifact provenance are
      recorded (this file; host package lock integrity values from registry metadata).
- [x] The two result-bound corrections are landed and independently verified: the
      accepted-failure branch returns `toolErrorResult` (2,000-char clamp + '…',
      sdk-v2.ts:53-61, pinned by a 1 MiB error over the REAL bound socket — exactly
      2001 chars), and arbitrary JSON `structuredContent` (array/string/number/
      boolean/null, sdk-v2.ts:62-70) reaches the wire per SEP-2106/schema.ts:1815-1821
      (parameterized wire tests + empty-outputSchema non-registration rationale).

## Current residual gaps (not adoption blockers, recorded honestly)

- Open subscriptions remain deliberately unavailable and unadvertised
  (`subscriptions/listen` → 404 MethodNotFound).
- The 202-no-body notification acceptance path is not implemented because the host
  accepts no core client-to-server HTTP notifications per the pinned normative
  transport.
- Managed-worker host integration (task-27) is still in flight; release gate stays RED
  until the complete `npm run verify` (typecheck, build, all suites, packed install,
  orchestration, architecture, MCP, verification, traceability) passes.
