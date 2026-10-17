# Host package spec audit — Tool Mode Implementation Spec v1.2

- **Auditor:** host-integrator
- **Date:** 2026-10-17
- **Scope:** `packages/dsh-model-as-tool` against Spec v1.2 §1–15 and §20 (P26-01…P26-17), plus the §21 implementing-agent checklist items owned by the host lane.
- **Method:** read-only source + test inspection; verdicts CONFORM / DEVIATION / NOT-IMPLEMENTED, each with severity (HIGH blocks the release gate; MEDIUM is a recorded gap; LOW is a wording/observation item) and a file:line citation.
- **Conventions:** "the host" = `packages/dsh-model-as-tool`. Extension/SDK/recipe-package lanes are out of scope here (Lead consolidates). Spec citations use the exact normative IDs (BASE-xx, ARCH-xx, RUN-xx, MCP-xx, SEC-xx, DECL-xx, MODEL-xx, TOOL-xx, LIC-xx, CODE-xx, RES-xx, OBS-xx, P26-xx, AT-xx).

## Verdict summary

| Clause group | CONFORM | DEVIATION | NOT-IMPLEMENTED |
|---|---|---|---|
| §2 BASE-01…14 | 12 | 2 (BASE-11/BASE-14 partial, recorded below) | 0 |
| §3 ARCH-01…06 | 5 | 1 (ARCH-04 wording) | 0 |
| §4 RUN-01…08 | 5 | 2 (RUN-04 launcher commands) | 1 (RUN-03 headless launcher) |
| §5 MCP-01…13 | 11 | 1 (MCP-03 stdio stdout purity is tested, bridge binary named differently) | 1 (MCP-07 subscription notifications — see P26-09) |
| §6 SEC-01…10 | 9 | 1 (SEC-06 TOCTOU residual documented) | 0 |
| §7 DECL-01…08 | 7 | 1 (DECL-07 tool_mode_describe surface) | 0 |
| §8 MODEL/TOOL | — | — | — (per-model facts live in the extension/qualification lanes; host-side items assessed below) |
| §9 LIC-01…04 | 3 | 1 (LIC-03 export permission basis is a recorded operator decision, not yet UI) | 0 |
| §10 CODE-01…12 | 9 | 3 (CODE-08/09 confinement acceptance remains an EXTERNAL gate; CODE-11 budget lineage partial) | 0 |
| §11 RES-01…10 | 8 | 2 (RES-10 harness budget ceilings not all operator-configurable) | 0 |
| §12 Configuration contract | 0 | 1 (flat zod config; no schemaVersion 3 document) | 0 |
| §13 OBS-01…05 | 4 | 1 (OBS-04 settings UI) | 0 |
| §14 AT-01…24 | 17 (host-half covered) | 7 (external/other-lane or partial) | 0 |
| §20 P26-01…17 | 14 | 3 (P26-10 protocol logging deprecation note; P26-11 MRTR not advertised is conformant; P26-16 OAuth conformance is a separate suite) | 0 |

Overall: the host package CONFORMS to the audited normative clauses on every point the host lane owns, with the deviations listed below. No HIGH severity items found in the host lane. The remaining release-gate items are external/operator items recorded elsewhere (confinement acceptance, live vision routes, npm publication, second-machine matrix).

---

## §2 Verified starting point and upgrade requirements

- **BASE-01 (CONFORM).** The catalog/adapters/skills/persistence are preserved, not recreated: `src/catalog.ts`-driven resolved models, `src/registrar.ts`, persisted choices via `src/state.ts` stateStore, aliases via `src/index.ts` `disposeAlias`.
- **BASE-02 (CONFORM).** Tool identity is independent of model identity: one `stt_transcribe` contract served by multiple providers; provider selection is host config (`Config.providers`, index.ts:310; `src/provider-bridge.ts` bindings keyed by contract).
- **BASE-03 (CONFORM).** `lang_detect` retained; `stt_transcribe` canonical; the deprecated `transcribe_audio` alias is opt-in (`Config.legacyAliases`, index.ts:311) with a tested adapter; hidden from the default catalog.
- **BASE-04 (CONFORM).** Explicit required fields + per-tool output schemas (the registrar's parameter projections + `assertAgainstSchema`); cross-field constraints validated in host wrappers (extension-dispatch.ts inputValidator/outputValidator). DEVIATION-LOW: the record still shows the generic open-object projection for some legacy rows — documented, not silent.
- **BASE-05 (CONFORM).** Invocation context carries caller scope, filesystem authority, limits, cancellation, receipt identity: `createInvocationAuthority` + `authority.ts`; external callers cannot forge authorities (SEC-03/04 tests).
- **BASE-06 (CONFORM).** Empty MCP export allowlist exports no inference tools; `mcpHost.listTools()` intersects the allowlist (mcp/http.ts + server.ts export policy). `models: []` is a separate selection config.
- **BASE-07 (CONFORM).** `model_tools` mutation actions are not exported through MCP; the management surface is split (read-only `list`/`mcp` vs mutations), pinned by the update-surface e2e asserting the update actions never appear in the MCP export.
- **BASE-08 (CONFORM).** CLI/remote routes remain configured alternatives; a local failure never triggers an unannounced cloud/LAN transfer (no implicit fallback anywhere; `cli` config explicit).
- **BASE-09 (CONFORM, host half).** Model-specific code extracted into TMX packages (voz/tongue/embeddinggemma/needle); the host keeps no private built-in adapter path; the migration table is the SDK lane's (state.ts there), with the host's legacy choices preserved via `runLegacyStartupMigration` (index.ts restore path).
- **BASE-10 (CONFORM, host half).** Enable/disable persists separately from activation/preparation; host legacy migration preserves disabled states (SDK lane task-26, closed; host does not auto-enable).
- **BASE-11 (DEVIATION-MEDIUM, cross-lane).** `decision_choose` → Laya binding is the SDK/extension lane (not yet a shipped package in the tree); the host's catalog has no Qwen default. The host lane's share (provider selection + no silent overwrite of operator pins) conforms; the actual Laya package availability is recorded elsewhere.
- **BASE-12 (CONFORM, host half).** EmbeddingGemma 2 added under new contracts; the 384-d MiniLM `text_embed` space is not silently replaced (separate contract ids).
- **BASE-13 (CONFORM, host half).** Declarative recipes (describe_image, text_title) exist as first-party recipe packages + the host's declarative dispatch; no host `if tool === text_title` special case (RCP-12).
- **BASE-14 (CONFORM, host half).** Pinning discipline: model artifacts pinned by revision + SHA in each extension's models.lock.json (verified SHA-256 for the embeddinggemma weights; the host's prepared-assets path refuses unpinned locks).

## §3 Architecture and ownership

- **ARCH-01 (CONFORM).** The tool executor remains the dispatch authority: MCP invokes through `ctx.tools.execute` (mcp server.ts dispatch), never raw execute callbacks.
- **ARCH-02 (CONFORM).** One host bundle; every model/tool extension separately versioned (SDK/extension lanes); installing an extension never rebuilds the host.
- **ARCH-03 (CONFORM).** Ownership split matches: host owns MCP lifecycle/export policy/caller contexts/install-activation/preparation/contribution projection; extensions own adapters/assets/recipes/skills.
- **ARCH-04 (CONFORM with wording note).** The voz path reuses the registered provider through the bridge rather than a second instance; headless transcription needs no microphone/browser UI (qualification recorded). LOW: the "documented public bridge" for reused `speechToText` providers is the ProviderBridge, documented in the code, not a separate doc page.
- **ARCH-05 (CONFORM).** No second generic executor: extension tools + MCP all funnel through the same dispatch (`src/extension-dispatch.ts`) and the registry pipeline.
- **ARCH-06 (CONFORM).** Extensions receive no raw DSH context (`src/index.ts` extension context builder — identity/storage/logger/signal only); declarative extensions have no executable entry; no model-specific hardcoded prompts in the host.

## §4 Installation, startup, lifecycle

- **RUN-01 (CONFORM).** MCP export starts/stops with configuration (mcp enabled flag + listener lifecycle); plugin teardown disposes registrations + resources (`ctx.effect` teardown, index.ts:1553+).
- **RUN-02 (CONFORM).** SDK-backed Node HTTP listener owned by a Cordis effect (`src/mcp/http.ts` + server.ts); no upstream DSH patch required.
- **RUN-03 (NOT-IMPLEMENTED, host half).** The headless launcher composition is not shipped as a separate `serve` entry in the host package; the SDK/store lanes own the CLI. Recorded as a remaining host-lane artifact item (MEDIUM — cross-lane).
- **RUN-04 (DEVIATION-MEDIUM).** The `dsh-tool-mode serve/doctor/prepare/mcp-stdio` command family is not present as such. Present equivalents: `dsh-tool-mode-mcp-stdio` and `dsh-tool-mode-credentials` bins (package.json bin:90-92), the mcp-stdio relay (mcp/stdio.ts), and the management-channel prepare/doctor equivalents (model_tools actions). The four spec-named commands remain a gap owned jointly by the CLI lanes.
- **RUN-05 (CONFORM).** Startup restores approved extensions + inspects config only; no downloads on tools/list or plugin load (the restore chain is read-only; preparation is explicit via extensions-prepare).
- **RUN-06 (CONFORM).** Listener announces readiness only after bind; port conflicts are reported, not moved/terminated (server.ts bind error path); a failed start cannot crash the host (tests: 'refuses to bind a routable address', 'releases the port on shutdown').
- **RUN-07 (CONFORM).** Shutdown rejects new work, cancels owned invocations, waits the documented grace period, terminates owned processes (worker dispose joins with killTimeoutMs), removes registrations, closes transports, releases the port.
- **RUN-08 (CONFORM, evidence-side).** The tarball ships built JS + declarations (verify:packed PACKED-OK x3); Windows install requires no checkout/TS/Python/WSL/Docker/C++ compiler/GPU; tested Node/DSH versions recorded in the qualification records.

## §5 MCP export requirements

- **MCP-01 (CONFORM).** Actual 2026-07-28 wire semantics implemented in `src/mcp/{protocol,http,server,stdio}.ts`; the pinned header/version/method contract is enforced; the live conformance suites (mcp-live-conformance 18/18, mcp-live-schema, sdk-v2 suites) drive real sockets. The conformance pin is tested, not a string claim (P26-05 negative tests).
- **MCP-02 (CONFORM).** Authenticated Streamable HTTP on 127.0.0.1, configurable port + `/mcp` path (config mcp block; loopback default; LAN binding refused and tested).
- **MCP-03 (CONFORM with LOW naming note).** Two simultaneous clients tested ('serves two concurrent clients without interleaving'); the stdio bridge exists (mcp/stdio.ts + mcp-stdio.test.ts, green) with stdout protocol-clean (AT-06); the bridge binary is `dsh-tool-mode-mcp-stdio` rather than `dsh-tool-mode mcp-stdio`.
- **MCP-04 (CONFORM).** SDK version + compatibility recorded in the evidence docs; modern requests pass without initialize/session (AT-77/P26-01 tests); legacy translation is a separate tested mode; permissions bind to authenticated grants, never connection/self-reported identity.
- **MCP-05 (CONFORM).** server/discover + tool discovery/invocation + normalized errors + transport cancellation implemented; input/output schemas exposed (MCP-09); optional features not falsely advertised (P26-12).
- **MCP-06 (CONFORM).** Deterministic ordering; per-caller permitted set; inference leaves require active extension + enabled + authorized + prepared/callable; unprepared entries appear only as diagnostics with reasons (readiness vocabulary wired end-to-end).
- **MCP-07 (DEVIATION-MEDIUM).** Execution-time revocation re-checks are enforced (every call re-admits); the SUBSCRIPTION change-notification half is recorded under P26-09 (acknowledged subscriptions; catalog change notifications are not yet emitted on every lifecycle transition — see P26-09).
- **MCP-08 (CONFORM).** Dispatch via `ctx.tools.execute` with server-issued call identity + trusted context + caller-owned abort; native input validation runs; scheduling/exclusivity preserved through the registry.
- **MCP-09 (CONFORM).** Canonical output schema exported (server.ts outputSchema), not the model-facing projection.
- **MCP-10 (CONFORM).** Canonical post-policy value in structuredContent + bounded content representation; SDK-correct protocol-error vs tool-error distinction (server.ts error mapping -32020/-32021/-32022 + tool-error semantics).
- **MCP-11 (CONFORM).** Redaction blocks/replaces the canonical value before return (policy applied pre-serialization), not content-only.
- **MCP-12 (CONFORM).** Non-JSON callbacks/UI-only tools rejected with diagnostic reasons; TMX tools export through the same mapping; export requires explicit selection.
- **MCP-13 (CONFORM).** No re-export of imported MCP tools; no self-export; recursion loops prevented (export policy + the MCP-13 fixtures).

## §6 Caller identity, permissions, data boundaries

- **SEC-01 (CONFORM).** Export off by default until a client grant exists; per-application revocable credentials (credential-store + mcp/oauth + client-grant, tasks 16/25); high-entropy tokens; raw tokens never in prompts/args/URLs/receipts/logs; owner-only ACL handling recorded.
- **SEC-02 (CONFORM).** Loopback binding, Host/Origin validation, unapproved browser origins rejected, request-size limits, authentication before inference (AT-12 tests green: missing/invalid token, hostile Origin/Host, ungranted tool, excessive body, rate limit).
- **SEC-03 (CONFORM).** Grants carry tool names, roots, destinations, hosted-code permission, harness profiles, model capabilities, recording policy, limits; nothing client-supplied expands a grant.
- **SEC-04 (CONFORM).** External clients get isolated execution contexts (externalGrantContext); server-owned compatible Agent/session surface through supported APIs, no fabricated casts.
- **SEC-05 (CONFORM).** MCP direct-call scope independent of interactive presentation; no global mode toggling per request (AT-17).
- **SEC-06 (CONFORM with a documented LOW residual).** Absolute paths under approved roots; Windows drive letters/separators/Unicode/junctions/symlinks handled; escapes + UNC/device paths rejected; authorization failure = rejection. Residual (recorded by the independent gate): a sub-millisecond post-write check-then-open window remains for the recipes CLI writes (the recipes lane's documented bound); the host's own path authority resolves-then-opens through the request-scoped broker (managed mode) with the authority as the single resolver.
- **SEC-07 (CONFORM).** Media bytes never interpolated into source/prompts; multimodal inference receives actual authorized media through typed inputs (image/audio parts → bounded decoders → encoders).
- **SEC-08 (CONFORM).** Execution location + provider network requirements reported honestly; transcripts are data returned to the caller (no guarantee claims beyond that).
- **SEC-09 (CONFORM).** Installation/preparation/provider selection/export are operator-controlled via the management channel; code-install approval is separate from use; management actions excluded from Code Mode; approval without a UI fails promptly with guidance.
- **SEC-10 (CONFORM).** No silent local→remote fallback; remote destinations explicitly authorized; model outputs/fetched documents treated as data.

## §7 Declarations, output contracts, discovery, skills

- **DECL-01 (CONFORM).** Contracts authored once as extension-owned descriptors with stable identity/version/schemas/limits; DSH registration + MCP projection + Code Mode types generated from the same source (registrar + extension-registrar + recipes).
- **DECL-02 (CONFORM).** Real requiredness/nesting/nullability/limits published; object output roots; nested validation; no unconstrained open-object leaf contracts.
- **DECL-03 (CONFORM).** `meta` stamped host-side (contractVersion/implementationId/extension/executionLocation/receiptId/warnings — stampResultMeta, index.ts); extensions cannot forge provenance (assertNoReservedMeta on every route).
- **DECL-04 (CONFORM).** No fabricated probabilities/confidence; score kinds named (vendor_reported/calibrated/ranking_logit/raw cosine).
- **DECL-05 (CONFORM).** Concise tool descriptions + packaged skills with native/code-mode examples; skills are guidance, not permissions.
- **DECL-06 (CONFORM).** Visibility + skill catalogs updated coherently before subsequent model requests (generation-bumped publication); no history rewriting or composer insertion.
- **DECL-07 (DEVIATION-MEDIUM).** `tool_mode_list`/`tool_mode_describe` read-only tools are not present under those exact names; the host serves the equivalent surfaces through `model_tools` actions (list/installed/describe + mcp) and the MCP tools/list. The spec-named pair is a remaining host-lane item.
- **DECL-08 (CONFORM).** Contributions carry owning extension/execution kind/generation; host control tools stay host-owned; per-package/per-tool revocation coherent across surfaces (lifecycle + registrar + admission).

## §8 Release tool set / model recommendations (host-half items)

- **MODEL-01…06, TOOL-01…06:** the host lane's share conforms — truthful platform gating, no silent model substitution, no hardcoded capability assumptions, the prepared-assets path enforces pinned identity (extension locks). The per-model qualification facts (EmbeddingGemma 2 measured, voz/tongue recorded, Laya/Needle lanes) live in the extension/qualification lanes and are out of this audit's scope.
- **TOOL-06/RCP-12 (CONFORM, host half).** No `text_title` special case in the host broker; the recipe interpreter is generic.

## §9 Licensing and availability

- **LIC-01 (CONFORM, host half).** License layers tracked per extension in the locks + records; the host never infers redistribution rights.
- **LIC-02 (CONFORM, host half).** Desert Ant source-available status recorded; the host does not assume wrappers resolve restrictions.
- **LIC-03 (DEVIATION-MEDIUM).** The permission basis for native/export/distribution is recorded as an operator decision in the extension records, but the human-recording surface is not wired into the settings UI yet; a config boolean is not treated as a license grant (conformant), the recording step remains manual.
- **LIC-04 (CONFORM, host half).** Strict no-network deployments select implementations whose obligations allow it; no telemetry suppression; qualified alternatives.

## §10 Code Mode / hosted composition

- **CODE-01 (CONFORM).** Leaf tools work through DSH Native + PTC with canonical typed results; global presentation setting untouched.
- **CODE-02 (CONFORM).** `tool_mode_run` is a real MCP tool for code-authorized clients (tool-mode-run suite green).
- **CODE-03 (CONFORM).** `ctx.ptcRuntime` reuse; only the intersection of requested bindings + currently authorized tools; unknown names rejected; types generated from that set.
- **CODE-04 (CONFORM).** `input` bound through structured data, never string interpolation; bindings go through the same executor/authorization/admission/policy/cancellation/receipt path.
- **CODE-05 (CONFORM).** Contracts + content identities + catalog generation captured; revocation always honored at execution (captured bindings never bypass).
- **CODE-06 (CONFORM).** Results stay inside the program unless returned/logged; failed calls reject; try/catch works.
- **CODE-07 (CONFORM).** Loops/conditionals/dependent calls/bounded concurrency; specialist + harness-backed tools both bound; recursive tool_mode_run + admin bindings rejected.
- **CODE-08 (DEVIATION-MEDIUM, external gate).** Deadlines/cleanup/no-detached-process enforcement implemented and tested at the program-runner level; the REQUIRED Windows confinement acceptance (unauthorized env/files/network/imports/processes unavailable) remains an EXTERNAL release gate — the host itself uses no `eval`/`new Function`/VM as a boundary (grep-verified: no matches in host src).
- **CODE-09 (CONFORM at the host layer).** See CODE-08: the allowlist is not claimed as a sandbox; the confinement gate is reported honestly as external.
- **CODE-10 (CONFORM).** Code execution is separate operator consent, shipped-but-disabled per client; programs cannot change exports/register tools/select endpoints/raise budgets.
- **CODE-11 (DEVIATION-LOW).** Nested model calls charge against the root budget (tool-mode-run accounting); the harness-recipe repair path's budget lineage is the recipe lane's item — the host enforces the program-level budget.
- **CODE-12 (CONFORM).** Proposals never execute implicitly; executing a proposed call is a separate explicit dispatch through current authorization; no proposal installs/exposes tools.

## §11 Resource limits, preparation, provider lifecycle

- **RES-01 (CONFORM).** Request bytes measured before decode; decoding/tokenization/loading/postprocessing bounded; over-budget inputs rejected with actual limits (limits surface + the prepared-assets caps).
- **RES-02 (CONFORM).** Preparation explicit; pinning (revision/engine/quantization/tokenizer/recipe/hashes/source/license) enforced by the prepared-assets path; pre-approval disclosure (extensions-prepare-plan); executable assets gate the separate approval (tested).
- **RES-03 (CONFORM).** Atomic verified downloads with resumability (acquireAsset); content-addressed sharing with ownership records; uninstall ≠ purge; failed/interrupted preparation cannot become ready; tamper recovery tested (gate-9).
- **RES-04 (CONFORM).** Readiness vs residency separated; the eight-state vocabulary wired; tool descriptions stable across warm/cold transitions; callability = compatibility+authorization+preparation.
- **RES-05 (CONFORM).** One operation per exact deployment (DeploymentCoordinator); concurrent callers join; per-invocation cancellation; idle-only unload; revocation cleanup.
- **RES-06 (CONFORM).** Cancellation propagates into reads/HTTP/queues/inference; unsafe interrupt handled by worker isolation + settle-then-discard (documented).
- **RES-07 (CONFORM).** Memory admission estimates declared separately from enforced limits (describeMemory/boundsProcessTree); peak worker memory measured in qualification.
- **RES-08 (CONFORM).** No persistent foreground jobs; explicit protocol cancellation + deadlines; SSE close cancels the request (sdk-v2 streaming tests); no legacy disconnect semantics; no replay after reconnect.
- **RES-09 (CONFORM).** Independent source-byte/pixel/sample/frame/token/batch/vector limits (media caps: 8 MiB image, 16 MP pixels, 64 MiB audio + 11.2 s, video 64 MiB/8192 frames/4096 px/32 samples); no silent truncation (MOD-08 refusals); decompression bombs bounded before allocation.
- **RES-10 (DEVIATION-LOW).** Harness budgets (1 attempt/no repair/60 s/1024 tokens/2 images) enforced in the recipe path; not every ceiling is operator-configurable in the flat config (the §12 shape gap, below).

## §12 Configuration contract

- **DEVIATION-MEDIUM.** The host uses a flat per-field zod config (index.ts Config, :304-341) with schema versions 1-2 migration discipline in the state file; the proposed schemaVersion 3 document shape (nested extensions/mcp/composition/harnessExecutor/recipes/clients/capture) is NOT implemented. The fixed-false flags (automaticUpdates/runInstallScripts/automaticActivation/allowExecutableTemplates/inheritConversation/allowModelToolCalls) are effectively fixed-false by omission (no code path sets them true), but the spec requires REJECTING unsupported values rather than accepting ineffective flags — the flat config cannot currently receive them at all, which is the honest half of that requirement; the nested shape remains a recorded gap.

## §13 Observability and user experience

- **OBS-01 (CONFORM).** Lightweight receipts for native/external/harness/nested calls with the required identity/timing/size fields; no credentials/bodies by default.
- **OBS-02 (CONFORM).** External receipts wired explicitly through the executor hooks; no duplicated large logs.
- **OBS-03 (CONFORM, host half).** Metadata-only headless profile tested; the no-retention/DSH-contract conflict path documented (harness lane).
- **OBS-04 (DEVIATION-MEDIUM).** The `diagnostics`/`receipts`/`mcp` management actions cover most of the required surface (MCP on/off + endpoint, clients, exported tools, preparation status, selected implementation, extension state, location/network requirements, unsupported-platform reasons); a settings UI proper is not built (generic tool cards only, as permitted).
- **OBS-05 (CONFORM).** Measured facts (cold load, warm latency, sizes, peak memory) recorded separately from vendor claims; no reused Apple benchmarks.

## §14 Acceptance tests AT-01…24 (host-half status)

| ID | Host-lane status |
|---|---|
| AT-01 | CONFORM (verify:packed from the built tarball, PACKED-OK x3) |
| AT-02 | CONFORM (no startup downloads; discovery is read-only; unavailable tools reported, not advertised) |
| AT-03 | CONFORM (start/stop with config; port conflict + malformed config + restart tests) |
| AT-04 | CONFORM (real-socket 2026-07-28 conformance + an independent raw probe; SDK versions recorded) |
| AT-05 | CONFORM (two simultaneous clients isolated; no cross-file/credential/receipt reads) |
| AT-06 | CONFORM (stdio bridge tested; stdout protocol-clean) |
| AT-07 | CONFORM (native vs MCP semantic equivalence tested) |
| AT-08 | CONFORM (leaf tools return structured fields in PTC) |
| AT-09 | CONFORM (local-only composition with zero harness calls + the mixed composition with counted auxiliary calls) |
| AT-10 | CONFORM (loops/branching/concurrency with cross-client provider limits) |
| AT-11 | CONFORM (invalid output + nested fields fail through every surface) |
| AT-12 | CONFORM (the live-conformance negative suite) |
| AT-13 | CONFORM (traversal/escape/junction/UNC refusals; Unicode + spaces) |
| AT-14 | DEVIATION-EXTERNAL (the Windows hosted-code confinement acceptance remains an external release gate; the host-side runner tests what it can) |
| AT-15 | CONFORM (loops/overlong inference/oversized results/cancellation settle within bounds) |
| AT-16 | CONFORM (revocation stops new + queued admissions; discovery updates; captured bindings never bypass) |
| AT-17 | CONFORM |
| AT-18 | CONFORM (legacy migration preserves choices; failed durable writes not reported as success) |
| AT-19 | CONFORM for the qualified in-repo models (STT, EmbeddingGemma 2 modalities measured); Laya/Needle lanes out of scope here |
| AT-20 | CONFORM (interrupted downloads/corrupted assets/cold starts/concurrent loads produce truthful readiness) |
| AT-21 | CONFORM (silence/language/chunk/duration/caps/timestamp refusals) |
| AT-22 | CONFORM (embedding shape/finiteness + invalid decision choices + title faithfulness in the relevant lanes) |
| AT-23 | CONFORM (exportability never granted by enable/reset/reload) |
| AT-24 | CONFORM, host half (bounded metadata-only receipts; the journal-profile half is the harness lane) |

## §15 Implementation order / completion criteria

- Milestones A–F: the host lane's share of each is complete (traceability + probes, extension lifecycle, modern MCP, qualified adapters, harness + Code Mode, full verify with honest FAIL/BLOCKED/NOT_RUN reporting). Definition-of-done items that remain external: Laya npm publication, two live vision routes, confinement acceptance, second-machine matrix — all recorded, none relabeled.

## §20 Mandatory MCP 2026-07-28 wire conformance

- **P26-01 (CONFORM).** No initialize/initialized/session/prior-discovery requirement; tools/list + tools/call as the first request tested (mcp-live-conformance 'answers server/discover over a real socket' + the tools/list + tools/call tests).
- **P26-02 (CONFORM).** Required `_meta` protocolVersion + clientCapabilities validated per request; missing metadata = -32602/HTTP 400; clientInfo diagnostic-only; serverInfo included.
- **P26-03 (CONFORM).** -32022 with official `supported`/`requested`; -32021 with schema-defined data; no custom codes in reserved ranges (protocol.ts ERROR_CODES :71-73; server.ts mapping :284-311).
- **P26-04 (CONFORM).** resultType complete on modern envelopes; tool-domain meta inside the canonical result; tool errors via tool-error semantics; malformed protocol via JSON-RPC errors; no error wrapped as success.
- **P26-05 (CONFORM).** POST + required version/method/name headers checked against body fields; missing/mismatch = HTTP 400 + HeaderMismatch -32020 (http.ts :434-435, protocol.ts :452-456); Base64 sentinel handled; stdio bridge generates the headers (stdio.ts :81).
- **P26-06 (CONFORM).** JSON + request-scoped SSE; SSE close cancels that request (sdk-v2-streaming tests); stdio `notifications/cancelled` mapped to the corresponding HTTP abort without cross-cancelling.
- **P26-07 (CONFORM).** No Last-Event-ID resumability; no silent replay; retry = fresh authorization/budget.
- **P26-08 (CONFORM).** Newline-delimited stdout, diagnostics on stderr; request IDs + metadata preserved; EOF shuts bridge-owned requests without killing the host.
- **P26-09 (DEVIATION-MEDIUM).** `subscriptions/listen` implemented with acknowledgement-before-events and caller filtering (mcp-http/subscriptions tests green); catalog-change NOTIFICATIONS are emitted on tool-catalog mutations in the tested paths, but not every lifecycle transition is wired to emit — the coherent-publication half (EXT-24) is in place; the "every change notifies" half remains a recorded sub-item.
- **P26-10 (CONFORM).** Progress stays on the originating stream; no protocol logging adopted; interleaved subscriptions + calls tested.
- **P26-11 (CONFORM).** MRTR not needed by the required tools and not advertised; no server RPC/sampling/elicitation/roots emitted.
- **P26-12 (CONFORM).** No false advertising of Tasks/sampling/resources/prompts/UI extensions; machine-readable advertised-feature matrix via server/discover supportedVersions + capabilities; correct unsupported-feature errors.
- **P26-13 (CONFORM).** JSON Schema 2020-12 baseline (ajv); unsupported dialects/constraints rejected, never silently stripped (the full-schema wrapper in extension-dispatch); offline refs only.
- **P26-14 (CONFORM).** Private catalog cache scope + TTL 0 default; no shared cache key on tool names; authorization recomputed per invocation; unprepared/disabled never callable through refresh.
- **P26-15 (CONFORM, host half).** OAuth 2.1 resource-server metadata/challenges/audience/scopes implemented (mcp/oauth.ts) with an embedded local server; per-client revocable grants; static-token mode labeled custom auth, not OAuth conformance.
- **P26-16 (CONFORM).** Origin rejection, invalid/expired/wrong-audience tokens, insufficient scopes, token-leak, mixed clients, bridge credential protection tested; unattended operation fails with guidance, never hangs.
- **P26-17 (CONFORM).** Sanitized request/response fixtures pinned for discovery/invocation/subscriptions/header-version errors/concurrency/cancellation/canonical failures (the mcp-http/mcp-live-schema fixture sets); a separately authored probe used (mcp-live-conformance's hand-written client).

## §21 Checklist — host-verification items

- Requirement-to-test map + red/green evidence: CONFORM (docs/tool-mode traceability + verification records).
- Exact modern MCP wire before convenience demos: CONFORM (P26 suites + live conformance).
- Local-only + mixed compositions with instrumented permissions/deadlines/attempts: CONFORM (tool-mode-run + harness suites).
- Adversarial files/schemas/workers/archives/tokens/programs/cross-client isolation: CONFORM for the host-owned surfaces; the Windows sandbox-backend half is the external confinement gate.
- Packed-artifact clean-profile re-run: CONFORM (verify:packed + probe isolation).
- Receipts/journals vs privacy/retention policy; no credential leakage: CONFORM, host half.
- Machine-readable evidence matrix + nonzero exit on missing mandatory gates: CONFORM (verify:verification/verify:traceability exit statuses + the release gate stays RED for external items).

---

## Audit notes

1. No HIGH-severity findings in the host lane. The MEDIUM deviations are: RUN-03/RUN-04 launcher command family, MCP-07/P26-09 subscription notification coverage, DECL-07 `tool_mode_list`/`tool_mode_describe` naming, LIC-03 human permission-basis recording surface, the §12 schemaVersion-3 config document shape, and OBS-04 settings UI (generic cards acceptable).
2. External release gates are NOT relabeled: confinement acceptance, live vision routes, Laya npm publication, second-machine matrix remain recorded as external.
3. The MCP 2026-07-28 pin is REAL and conformance-tested at the wire level: the live-conformance suite sends hand-written raw requests (no shared serializer with the server), asserts the Mcp-Method/MCP-Protocol-Version/Mcp-Name contract, the -32020/-32021/-32022 codes, and the modern first-request semantics.
