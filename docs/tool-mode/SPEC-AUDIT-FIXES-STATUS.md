# SPEC-AUDIT Fix Implementation — Status (goal-7a335be8)

Lead-owned close-out record. Goal round 118/120 at time of writing. This file is the authoritative
fix-by-fix evidence ledger for the SPEC-AUDIT remediation goal; board tasks and the per-fix test
suites are the primary evidence, this doc summarizes them.

## FROZEN — implemented, verified green, recorded

| Fix | Board | Evidence (exact counts, direct node paths) |
|---|---|---|
| C1 declarative-manifest vocabulary | task-53 | manifest schema closed oneOf module\|harness-model; harnessModel permissions; 2 feature names (`harness-model-recipes-v1`, `typed-image-input-v1`); declarative+entry refusal. spec-conformance 7/7, SDK 322/322, recipes 206/206 (at freeze) |
| C2 RCP-02 recipe vocabulary | task-54 | canonical vocabulary → one frozen recipe; lossless legacy↔canonical round trip; parity corpus restored. canonical-vocabulary 11/11, recipes 217/217, SDK 322/322 |
| H1 EXT-09 dependency isolation | task-55 | installer-owned dependency graphs: bounded BFS, resolve-once, sha512-verified materialization into the extension's own dir, no lifecycle scripts, depth3/64 caps, locked graph in install record. dependency-graph 9/9, SDK 332/332 |
| H2 harness-text TMX package | task-56 | self-contained declarative package (toolMode.manifest field, tool-mode.extension.json, input/output schemas, files[]). spec-conformance 8/8, SDK 323/323 |
| H3 EmbeddingGemma derived tools | task-57 | semantic_classify/semantic_deduplicate/media_find_moments derived tool contracts + validators + embedAudioSamples. extension suite 121/121, qualification 18/18 |
| H4 fused video embedding | task-58 | REAL reconstruction from the pinned EmbeddingGemma2VideoProcessor (16px patches, pooling 3, 140 soft tokens/frame, 1260 patches, per-frame vision encoder, fused video_features). extension suite 122/122, qualification 19/19 (768-d, finite, norm 1.00000). Honest remainder: media_find_moments still refuses VIDEO media (no fake windows) |
| **H6/H7 MiniLM pair — MEASURED IN SESSION 3** | task-59 | The earlier "HF 401" block was WRONG: HF is publicly reachable and both repos ship prebuilt ONNX. Locks now `measured` with real SHA-256s (embed revision `1110a243…`, rerank `233902d2…`); adapters use a **pure-TS uncased-BERT WordPiece tokenizer** (pinned 8/8 against the HF reference ids; removes the dual-ORT hazard), and `scripts/qualify-minilm.mjs` ran REAL inference through the built extension entries: text_embed 384-d unit vectors (identical cosine 1.000000, unrelated 0.071166), text_rerank relevant 8.5007 > unrelated −11.0249 with `ranking_logit`. Record: `docs/tool-mode/qualification/minilm.json`. Suites 12/12 |
| **H5 Laya decision family — CLOSED (goal-94e81514)** | task-72 | New `packages/extension-laya`: the vendored Apache-2.0 `laya-ts` build (pinned commit `c73908d9…`, LICENSE + attribution), manifest declaring `decision_choose`/`decision_test`/`decision_score` with closed schemas, lock pinning all six split-ONNX artifacts by measured SHA-256, DEC-08 honesty (`calibrated:false` on every answer), suite 5/5, and `scripts/qualify-laya.mjs` verified **6/6 digests + 3 real decision calls** through the built entry. Record: `docs/tool-mode/qualification/laya.json`. SDK `discoverExtension` accepts the package |
| **MOD-13 moments video windows — CLOSED (goal-94e81514)** | task-73 | Real per-window video scoring over the fused path (no image-grid rows): extension suite **124/124**; qualification clause `moments-video-windows` PASSES with real weights — a two-segment AVI's blue half ranked first at **2.00 s, score 1.0000**, honest frame timestamps |
| **Subscription DELIVERY consumer — CLOSED (goal-94e81514)** | task-73 | `deliverCatalogChange` + `MemoryDeliverySink` wired into the host's notify path; ack-first, per-caller filtering, revocation teardown; delivery suite 3/3, subscription suites 26/26. Open-stream HTTP endpoint remains the recorded http.ts remainder |
| **Headless `serve` — CLOSED (goal-94e81514)** | task-74 | `src/headless.ts` composes catalog/contracts/MCP HTTP/auth/store without the DSH CLI; spawn test answers `tools/list` over HTTP and shuts down cleanly; invalid config exits 2 with a named reason; `tool_mode_run` registered but honestly refused (no PtcHostContext headless) |
| **CODE-11 configurable ceilings — CLOSED (goal-94e81514)** | task-74 | `repairAttempts` on the Config surface (flat alias + v3 nested), `repairCeilingOf` refuses out-of-range (never clamps), lineage records the **remaining** budget; 9/9 headless-serve tests incl. ceiling 0/1 cases |
| **voz real-speaker corpus — REAL SPEAKER EVIDENCE (goal-94e81514)** | task-75 | `scripts/qualify-voz-corpus.mjs` downloaded 5 bounded **CC0** Wikimedia Commons spoken-word clips (licence verified via the Commons API), converted to 16k mono WAV with the host ffmpeg, ran them through the REAL voz provider, and recorded the `realCorpus` section in `voz.json`: transcripts + word counts + timings + per-clip judgements (IMF clip judged pass 2/3 content words). Honest partials: the AIDS slices are fuzzy-recorded (no per-clip reference transcript), and Common Voice is recorded BLOCKED (HF datasets-server 401 to anonymous callers, all probed) |
| **Confinement acceptance — RUNNABLE, PARTIAL (goal-94e81514)** | task-75 | `scripts/confinement-acceptance.mjs` (opt-in `verify:confinement`): without the operator marker the gate is CLOSED and the setter refuses in a real child [PASS]; with the marker it opens [PASS]; the packed `ptc-runtime.js` is byte-identical to the built lib [PASS]; the clean packed-install step is recorded BLOCKED with its exact stall (verify-packed-install makes no progress past its npm install stage in this environment). Verdict `accepted-partial`, exit 2 |
| §21.5 verification artifacts | task-67 | scripts/gen-models-index.mjs + verification/models.lock.json, verification/{compatibility.json,quality-gates.json,VERIFY.md,tdd-red-evidence.md} |

## GATE RE-VERIFICATION

| Gate | Board | Verdict |
|---|---|---|
| gate-10 (C1+C2) | task-61 | **PASS with 3 MEDIUM residuals** (SHA-verified, no drift): (a) verbatim §19.3 manifest two-key wall — FIXED since (see task-66 partial below); (b) canonical binding-rendering leak; (c) repairFeedback parity. (b)+(c) remain open |
| gate-11 (H1+H2+NDL-06) | task-62 | **PASS, no concerns** — SHA-verified; all nine H1 board behaviors re-pinned; harness-text self-contained; NEEDLE_TELEMETRY env probed directly; SDK 333/333, needle 131/125/0/6, recipes 217/217 |
| gate-12 (H3+H4+H6/H7) | task-63 | **PASS, no concerns** — SHA-verified; deduplicate EXACT vs an independent greedy-representative-cosine reference (incl. nontransitive A/B/C → [a,c], no chain merge); H4 REAL fused video, no image-grid substitution, qualification 19/19; MiniLM deterministic-maths pass WITHOUT weights, locks honestly BLOCKED; extension 122/122, embed 5/5, rerank 3/3. Residuals recorded: MiniLM real-inference honest-blocked (HF 401, operator item); moments video-window scoring remains the named MOD-13 remainder; NDL-06 binary-level verification "not independently verified" (posture enforced in host code) |

## IN FLIGHT AT GOAL-BUDGET EXPIRY

- **task-59 (H6/H7 MiniLM text_embed/text_rerank)**: **FROZEN** — packages/extension-minilm-embed
  (tsc/build 0, suite 5/5: meanPool, L2-normalize + zero-vector refusal, 384≠768 space-identity pin,
  manifest declaring the standard text.embed contract with empty tools, BLOCKED-lock honesty) +
  packages/extension-minilm-rerank (tsc/build 0, suite 3/3: rankByLogit with exact ties by input
  order, standard text.rerank contract, BLOCKED-lock honesty); standard descriptors added to
  tool-mode-contracts (§8.2 shapes). WEIGHT PINNING: honest-blocked — HF resolve/API 401 (no
  token); both models.lock.json records carry pinning.state "blocked" + acquisition instructions;
  assets arrays EMPTY (asserted). Adapters are the real paths and run once the host acquires the
  verified group. **Root-script wiring DONE (Lead, session 2)**: `typecheck`, `build`, `test`,
  `test:extensions` and `test:models:windows` now include both packages; new `build:ext-minilm-*`,
  `test:ext-minilm`, `typecheck:ext-minilm` scripts. Verified: both typecheck 0, both builds 0,
  suites 8/8, architecture check OK.
- **task-60 (NDL-06 needle telemetry)**: **FROZEN** — needle tsc 0; suite 131/125/0/6 (6
  pre-existing artifact-absent platform skips); NEEDLE_TELEMETRY_ENV {NEEDLE_TELEMETRY:'0',
  DO_NOT_TRACK:'1'} exported and ALWAYS passed as the child env on every engine spawn (parent env
  never spread); manifest network.requiredTelemetry stays false, honest gap recorded in
  network.telemetryContent; test pins the env shape and the manifest/code agreement.
- **task-66 (MEDIUM SDK cluster + gate-10 residuals)**: **COMPLETE + FROZEN (session 2)** — all
  six remaining sub-fixes landed: (6b) canonical binding rendering (per-RCP-03 rendered block for
  unbound inputs; the verbatim §19.3 instructions now parse and bound values reach the provider),
  (6c) repairFeedback parity (create draft carries the TOOL-06 repair input + a parity pin
  deep-equalling the shipped text-title), EXT-08 install preview (before promote; refusing preview →
  PERMISSION_REQUIRED, nothing materialized), EXT-31 CLI (extensions update/rollback/purge-assets +
  `--json` across every extension command and the recipes namespace), EXT-12 provenance recorded
  verbatim AS DATA never as trust, EXT-29 tombstone retry (bounded 5, truthful CLEANUP_PENDING),
  EXT-36 author template + docs/author-guide.md. Counts: medium-cluster 10/10, canonical-vocabulary
  12/12, FULL SDK 343/343, recipes 218/218, tscs 0. So **all three gate-10 residuals are now fixed**.
- **task-64 (host MEDIUM cluster)**: **COMPLETE + FROZEN (session 2)** — bin/dsh-tool-mode.mjs wired
  (doctor --json no secrets; prepare --tool real digest-verified acquisition; mcp-stdio fail-fast;
  serve honest recorded seam exit 2), tool_mode_list/tool_mode_describe registered under spec names
  with model_tools aliases, LIC-03 extensions-license-basis durable record with principal, §12 config
  v3 nested shape with fixed-false REJECTION + v1/v2 deprecated aliases. Counts: host-cluster 8/8
  (independently re-run by Lead: 8/8), host tsc 0, FULL host suite 953/948/0/5.
- **task-69 (SDK LOW: EXT-06/EXT-21/EXT-35)**: **COMPLETE + FROZEN (session 2)** — EXT-06
  source-directory dev mode (operator gate, reparse-point checks, copy-not-link, 10k/512MiB bounds,
  no-script refusal, inactive-until-activated, recorded source; 4/4), EXT-21 13 new standard
  contract descriptors (STANDARD_CONTRACTS now 17) with closed schemas + host-parity test
  (contracts 42/42, independently re-run by Lead: 42/42), EXT-35 split-by-design note. FULL SDK
  347/347.
- **task-65 (subscription notifications)**: **COMPLETE + FROZEN** — SubscriptionRegistry constructed
  in the plugin; notifyCatalogChange() on install/uninstall/commit/rollback; honest delivery-seam
  record (HTTP listen refused = pinned posture) + OBS-04 note; affected suites 39/39.
- **task-68 (host LOW)**: **COMPLETE + FROZEN** — bridge architecture page (ARCH-04), stdio naming
  mapping (MCP-03), SEC-06 TOCTOU residual documented, CODE-11 repair-budget lineage recorder +
  repair-lineage.test.ts 1/1; **final full host suite 955/950/0/5**.
- **task-69 (SDK LOW: EXT-06/EXT-21/EXT-35)**: **COMPLETE + FROZEN** — EXT-06
  source-directory dev mode (4/4), EXT-21 13 new standard contract descriptors (STANDARD_CONTRACTS
  now 17; contracts 42/42, Lead-reverified), EXT-35 split-by-design note; FULL SDK 347/347.
- **task-70 (extensions LOW)**: **COMPLETE + FROZEN** — packages/harness-vision self-contained
  declarative package with byte-sync test (2/2); tongue + voz tools[] declared with shipped schemas
  and implementation bindings preserved (25/25, 10/10); naming-deviation README notes; licensing/
  telemetry honesty verified (no false claims).
- **task-71 (close-out)**: DONE — see VERIFY STATUS FINAL below.

## REMAINING WORK — CLOSED (goal-94e81514)

All previously-recorded remainders were implemented and independently re-verified by gate-76
(PASS per item, SHA-frozen, honest partials confirmed):

| Item | Evidence |
|---|---|
| H5 Laya decision family | `packages/extension-laya`: vendored Apache-2.0 `laya-ts` (pinned `c73908d9…`), six split-ONNX artifacts pinned by SHA-256, `decision_choose/test/score` closed schemas, `calibrated:false`, suite 5/5, qualification 6/6 digests + 3 real calls |
| MOD-13 video windows | Real per-window video scoring; qualification `moments-video-windows` PASS with real weights (top 2.00 s, 1.0000); extension 124/124 |
| Subscription delivery | `deliverCatalogChange` + `MemoryDeliverySink` ack-first, per-caller filtering, revocation teardown; delivery 3/3, subscriptions 23/23 |
| Headless `serve` | `src/headless.ts` real composition; spawn test `tools/list` over HTTP, invalid config exit 2, clean SIGTERM; suite 9/9 |
| CODE-11 ceilings | `repairAttempts` config (flat + v3), `repairCeilingOf` refuses out-of-range, lineage remaining budget |
| voz real-speaker corpus | 5 CC0 Wikimedia clips transcribed through the real provider (IMF clip judged pass); Common Voice 401 recorded blocked; `real-speaker-partial` |
| Confinement acceptance | `confinement-acceptance.mjs` 3/4 steps (marker gates + packed byte identity), step 4 blocked with the exact env stall; `accepted-partial` |

**Requirement reconciliation**: 11 rows updated — DEC-01/DEC-02/MOD-13/RUN-04/TOOL-04/TOOL-05 →
DONE; DEC-03/DEC-04/DEC-06/RUN-03 → PARTIAL with precise remainders. Release gate now **18 PASS**
(was 12), FAIL 252, BLOCKED 3, NOT_RUN 44. The remaining RED is external/operator (two live vision
routes, second-machine matrix, operator signatures) plus the recorded partial remainders.

**Final full `npm run verify` exit 0**: 1890 tests / 1879 pass / 0 fail / 11 skips, PACKED-OK ×3,
architecture OK, MCP fixtures 39 + live 12/12, verification current (317 reqs / 18 PASS),
traceability current (227 / 90).

## RECORDED EXTERNAL BLOCKERS (never relabeled as passing)

Session 3 corrected two entries: **MiniLM pinning is no longer blocked** (HF is publicly reachable
and both repos ship prebuilt ONNX — the locks are now `measured`, see the H6/H7 row), and **H5
Laya is implementable** (its export exists, the source is Apache-2.0, and the remaining gap is a
packaging/licensing decision, not an external gate). The genuine externals left are:

| Blocker | Why external |
|---|---|
| Two live vision routes | No vision-capable model route is configured on this host (the only DSH route is text-only) |
| Second-machine matrix | Requires a second machine (AT-19/OBS-05) |

Tracked as IMPLEMENTABLE, not external (see the session-3 re-audit):

| Item | What it needs |
|---|---|
| H5 Laya decision family | Vendor the built Apache-2.0 `laya-ts`, pin the 1.29 GB split ONNX export by SHA-256, decision contracts, DEC-08 honesty gate |
| voz real-speaker corpus | A public CC0 corpus download |
| Confinement acceptance (CODE-08/09) | A runnable acceptance on this host |
| moments video-window scoring | Per-window scoring over the fused video path |
| subscription delivery transport | A streaming transport consumer |
| launcher `serve` headless composition | Ship a headless entry |
| CODE-11 configurable ceilings | Implement the remaining budget-ceiling half |
| Release-gate reconciliation | Flip the requirement rows the fixes now satisfy |

## VERIFY STATUS — FINAL

**Full `npm run verify` exit 0** (2026-10-17, close-out): typecheck 8 packages → build → **1867
tests / 1856 pass / 0 fail / 11 platform skips** → verify:built OK → verify:packed **PACKED-OK ×3**
→ verify:architecture OK → verify:mcp **fixtures 39/39 + live 12/12** → verify:verification current
(317 requirements, 12 PASS) → verify:traceability current (227 requirements, 90 acceptance tests).

Note (environment drift fixed): the DSH checkout moved to `@deepseek-ai/*@0.2.1-rc.2`, which the
host's `>=0.2.0-rc.2` peer ranges do not admit under strict prerelease semver (npm ERESOLVE in the
packed probe). Widened the four peer ranges to `>=0.2.0-rc.2 || >=0.2.1-rc.1`; the packed probe is
green again. Evidence ledger also recorded in `docs/tool-mode/status.json` §`specAuditFixes` (the
release-gate posture there is unchanged: external/operator items are NOT relabeled).

## FINAL ITEM STATUS

| Scope | Status |
|---|---|
| C1, C2 (CRITICAL) | FROZEN + gate-10 PASS (residuals all fixed) |
| H1, H2, H3, H4, H6, H7 (HIGH) | FROZEN + gates 11/12 PASS |
| H5 Laya (HIGH) | BLOCKED — upstream npm publication + ONNX export |
| 13 MEDIUM (launcher, subscriptions, tool_mode_list/describe, LIC-03, config v3, EXT-08/12/29/31/36, RCP-05, RCP-04 disclosure, NDL-06, §21.5, TDD-02) | ALL CLOSED (task-64/65/66/67 + extras) |
| 16 LOW (host 4, SDK 6, extensions 6) | ALL CLOSED or recorded (task-68/69/70; operator-only items recorded) |
| Close-out (full verify + regen + status.json) | DONE — exit 0 |

## CONTINUATION ORDER (board already carries the scopes)

0. **Phase-1 CLOSED**: every CRITICAL + HIGH finding (C1, C2, H1–H4, H6, H7) and NDL-06 is
   implemented AND independently re-verified by gates 10/11/12. H5 Laya stays external-blocked.
1. Finish task-66 remaining sub-fixes (sdk-store): (6b) canonical binding-rendering, (6c)
   repairFeedback parity, EXT-08 install preview, EXT-31 CLI + --json, EXT-12 provenance, EXT-29
   tombstones, EXT-36 author kit.
2. Wire the two MiniLM packages into root scripts (Lead; keep the verify chain green).
3. Task-64 (host MEDIUM cluster: launcher family, tool_mode_list/describe, LIC-03, config v3) +
   task-65 (subscription notifications) with host-integrator.
4. LOW items.
5. Full `npm run verify` + regenerate verification/traceability + status.json evidence ledger.
