# Extension packages & verification-pipeline spec audit

**Auditor:** gate-verifier (independent verification lane) · **Date:** 2026-10-17
**Specs audited (read-only):**
- `Tool_Mode_DSH_Implementation_Spec_v1.2.md` (TM-DSH-001, SHA-256 `b98db502…bba4bb`) — §8, §9, §17, §18, §16.9
- `Tool_Mode_Verification_Checklist_v1.2.md` (SHA-256 `2c34decf…be5c089d`) — §14, §16.9, §21.1–21.5

**Method:** every normative clause is judged **CONFORM / DEVIATION / NOT-IMPLEMENTED** against the
SPEC text itself (not against the repo's own `status.json` claims), with file:line evidence from the
extension packages, the host, `package.json` scripts, `scripts/*`, and `verification/*`. Recorded
in-repo remainders are re-judged against what the spec REQUIRES, per the audit mandate.

**Severity legend:** CRITICAL / HIGH / MEDIUM / LOW / INFO.

---

## Part 1 — Extension packages vs spec §8 / §9 / §17 / §18 / §16.9

### 1.1 §8.1 required release tool set vs what actually ships

Spec §8.1 requires a specific package/tool matrix. Judgment per row:

| Spec package | Spec tools | In-repo state | Verdict | Severity |
|---|---|---|---|---|
| `@try-works/tool-mode-embeddinggemma2` | `multimodal_embed`, `semantic_similarity`, `semantic_rank`, `semantic_classify`, `semantic_deduplicate`, `media_find_moments` | `packages/extension-embeddinggemma` declares and implements only the first 3 (`tool-mode.extension.json` tools array; `src/contracts.ts:16-18,109-140`) | **NOT-IMPLEMENTED (3 of 6 tools)** | **HIGH** |
| `@try-works/tool-mode-laya` | `decision_choose`, `decision_test`, `decision_score` | No Laya package exists (`packages/` listing has no laya); no decision contracts anywhere | **NOT-IMPLEMENTED** | **HIGH** |
| `@try-works/tool-mode-jev` | alt `decision_*` | No package | **NOT-IMPLEMENTED** (optional per spec wording) | INFO |
| `@try-works/tool-mode-needle3` | `tools_plan`, `structured_extract` | `packages/extension-needle` declares both (`tool-mode.extension.json`; `src/contracts.ts`; host-side NDL re-checks live in `packages/dsh-model-as-tool/src/planning.ts` etc.) | **CONFORM** (runtime/telemetry caveats in §1.5) | — |
| `@try-works/tool-mode-harness-vision` | `describe_image` | Shipped as a builtin declarative recipe in `packages/tool-mode-recipes/recipes/describe-image.json` (broker-interpreted), not a separately packable TMX package | **DEVIATION** (function present, packaging shape differs) | LOW |
| `@try-works/tool-mode-harness-text` | `text_title` | `packages/tool-mode-harness-text` exists and ships the recipe (`packages/tool-mode-harness-text`; byte-identical to the bundled copy — recipes suite pins this) | **CONFORM** | — |
| `@try-works/tool-mode-voz` | `stt_transcribe` | `packages/extension-desert-ant-voz` serves `stt_transcribe` through the host's standard contract (`implementations[].contractId = tool-mode/stt_transcribe`); real Windows CPU qualification recorded (`docs/tool-mode/qualification/voz.json`) | **CONFORM** (declaration-shape caveat in §1.7) | — |
| `@try-works/tool-mode-whistle` / `-whisper-tiny` | alt `stt_transcribe` | No packages | **NOT-IMPLEMENTED** (optional alternatives) | INFO |
| `@try-works/tool-mode-tongue` | `lang_detect` | `packages/extension-desert-ant-tongue` serves `lang_detect` via the host standard contract; licensing/readiness checks recorded | **CONFORM** | — |
| `@try-works/tool-mode-minilm-embed` | `text_embed` | Absent; only a doc comment mentions MiniLM space identity (`packages/dsh-model-as-tool/src/model-qualification.ts:230`) | **NOT-IMPLEMENTED** (TOOL-04) | **HIGH** |
| `@try-works/tool-mode-minilm-rerank` | `text_rerank` | Absent | **NOT-IMPLEMENTED** (TOOL-05) | **HIGH** |

Naming note (INFO): the spec's own text says the `@try-works/tool-mode-*` names are "required proposed
artifacts, not assertions that those npm packages are already published"; the repo ships
`@try-works/extension-*` names. This is a naming deviation to reconcile at publication time, not a
functional one.

### 1.2 §17 EmbeddingGemma 2 — modality semantics

| Clause | Verdict | Evidence |
|---|---|---|
| MOD-01 pin `google/embeddinggemma-2` + qualified ONNX conversion, plain Node/Windows CPU | **CONFORM** | `packages/extension-embeddinggemma/models.lock.json` pins revision `daa72c51…90c0`; 11 assets, 64-hex digests; real qualification runs recorded (`docs/tool-mode/qualification/embeddinggemma.json`) |
| MOD-02 selective group loading (text/vision/audio) | **CONFORM** | `src/index.ts` `ASSET_GROUPS` (`:118`), per-group encoder creation (`:597-615, :682-690`); cross-group isolation tests pass (extension suite 116/116) |
| MOD-03 `embeddingSpaceId` from canonical content | **CONFORM** | embedding-space descriptor computed, not model-name-derived (index.ts identity code; deterministic-maths tests) |
| MOD-04 768/512/256/128, truncate+renormalize, reject NaN/zero | **CONFORM** | qualification records 768 + reductions 512/256/128 with unit norms (`qualification/embeddinggemma.json` checks) |
| MOD-05 input/role rules, atomic batch | **CONFORM** (for implemented tools) | `src/index.ts:340-366` validators |
| MOD-06 exact task prefixes/processor templates | **CONFORM** | recipe/template machinery + golden fixtures in the extension suite |
| MOD-07 media validation **incl. video decode** | **PARTIAL — video half NOT-IMPLEMENTED** | images/audio decode bounded (`src/media.ts`); a `video` part is REFUSED BY NAME at validation (`src/index.ts:208-223`); the bounded AVI sampler exists (`src/media.ts:159-281`) but the fused video embedding path is refused. Per the SPEC (which requires video as a first-class modality and `MediaPart kind:"video"`), the refusal is a **NOT-IMPLEMENTED half**, regardless of how honestly it is recorded | **HIGH** (recorded remainder, spec-mandated) |
| MOD-08 context/sampling honesty | **CONFORM** | over-context refusals, no silent truncation (`truncated: false` contract) |
| MOD-09..13 derived tools | **PARTIAL** | `semantic_similarity` (MOD-09) and `semantic_rank` (MOD-10) CONFORM; `semantic_classify` (MOD-11), `semantic_deduplicate` (MOD-12), `media_find_moments` (MOD-13) **NOT-IMPLEMENTED** — `src/contracts.ts:16-18` admits only 3 tools are declared | **HIGH** |
| MOD-14 compatibility/caching | **CONFORM** (in-memory bounded execution; no vector-DB dependency introduced) | extension suite |
| MOD-15 tool disabling/sharing | **CONFORM** | lifecycle grants per-tool deactivation; suite coverage |
| MOD-16..19 fixtures/quality/Node-proof | **PARTIAL** | golden fixtures + negative paths + packed Node runs exist (116/116 suite, packed verify); cross-modal quality matrix (MOD-17) is recorded as partial (image/audio qualification only; video absent) | MEDIUM |
| MOD-20 description discipline | **CONFORM** | tool descriptions state the supported inputs; no captioning/transcription claims |

### 1.3 §18.1 Laya decision models

DEC-01..DEC-08, TOOL-02, MODEL-02: **NOT-IMPLEMENTED** — no Laya extension, no `decision_choose` /
`decision_test` / `decision_score` contracts, no `laya-ts` ONNX assets, no held-out decision evaluation.
This is a spec-mandated default (`MODEL-02`: "The local implementation must use Laya's actual trained
decision heads"), so its absence is a **HIGH** spec gap, not an optional extra.

### 1.4 §18.2 Needle 3

| Clause | Verdict | Evidence |
|---|---|---|
| NDL-01 Windows/Node runtime, pinned artifacts, no end-user pip | **CONFORM** | native managed-process route over a pinned `needle.exe` + `.cact` weights (`src/artifacts.ts:69-126`); size+SHA-256 verified before execution (`src/resolve.ts:143`); WASM route declared as an unqualified second route (not silently selected) |
| NDL-02 planning contract (frozen snapshot, host-approved subset) | **CONFORM** | `tools_plan`/`structured_extract` contracts (`src/contracts.ts`); the FROZEN host-side snapshot and execution-time re-checks are host-side (`packages/dsh-model-as-tool/src/planning.ts`) and were adversarially re-verified (tasks 1/7) |
| NDL-03 never auto-execute | **CONFORM** | `src/contracts.ts:11-17` (proposals are data; no executor field); process-per-call CLI invocation, no `--serve` listener, no run loop (`src/process-bridge.ts:91-103`, `src/index.ts:27-29`) |
| NDL-04 constraint/fidelity checks | **CONFORM** (bounded schema preflight, strict parsing) | contracts + validation.ts in the needle package |
| NDL-05 isolation/cancellation (fresh context, argv arrays, shell off, scrub env) | **CONFORM** | process-per-call with argument vectors (never a command string) and abort-before-spawn (`src/process-bridge.ts:332-350, :462-477`) |
| NDL-06 telemetry: `NEEDLE_TELEMETRY=0` / `DO_NOT_TRACK=1` controls + verified network behavior | **DEVIATION** | NO telemetry env handling exists anywhere in the needle package (grep across `src/*.ts` finds zero matches), while the manifest declares `network.requiredTelemetry: false`. The spec's source documents telemetry enabled by default with these opt-outs; the extension neither passes nor verifies the controls | **MEDIUM** |
| NDL-07 optional embeddings (own space, not a drop-in) | **NOT-IMPLEMENTED** (spec marks optional — "not required to make the planning/extraction release pass") | INFO |
| NDL-08 independent TMX lifecycle proof | **CONFORM** | extension installs/activates/updates/rolls back under the SDK lifecycle with no model-name branch in the host (task-37/43 evidence) |

### 1.5 §9 Licensing and availability

| Clause | Verdict | Evidence |
|---|---|---|
| LIC-01 per-layer license tracking (code/engine/weights) | **CONFORM** | all four manifests carry `licenses[]` layers (e.g. needle: MIT code + Apache engine + weights layer; tongue/voz: MIT code + Desert Ant weights layer) |
| LIC-02 Desert Ant source-available, not open source; restrictions respected | **PARTIAL** | the source-available nature is recorded in the tongue/voz manifests' weights layers and the host's evidence; the restrictions (standalone redistribution, competing-model training, telemetry tampering) are recorded but the *permission basis for external MCP export* remains an operator/external item (publication gate decision) | LOW |
| LIC-03 human-recorded permission basis; unresolved export blocks that provider only | **PARTIAL** | the publication-gate machinery exists (host evidence); the recorded permission basis is still an operator-item for voz/needle export | LOW |
| LIC-04 no-network honesty (`requiredTelemetry`) | **CONFORM** | manifests declare it: tongue/voz `requiredTelemetry:true` (with `telemetryContent` named); embeddinggemma/needle `false` — except the NDL-06 caveat above (needle's false claim is unverified in code) | LOW (see NDL-06) |

### 1.6 §16.9 extension acceptance tests (AT-25..AT-40) — judged against the shipped evidence

- **AT-25** separate packable first-party packages, no hidden registration: **CONFORM** (packed verify ×3; every extension ships its own tarball).
- **AT-26/27/28** external-author fixture, pinned installs, no sentinel scripts: **CONFORM** (declarative-recipes fixture, install.test.ts pins no-script execution, AT-28 import counters).
- **AT-29** corrupt hashes/manifests/traversal refusals: **CONFORM** (install.test.ts).
- **AT-30** activate external package without host rebuild: **CONFORM** (packed/orchestration scenarios).
- **AT-31..37** deactivate-mid-call, per-tool disable, uninstall/purge, dependency isolation, name/identity stealing, update rollback, Windows cleanup: **CONFORM** (task-37/43 EXT-30 flow + managed-workers + lifecycle suites; orchestration script stages).
- **AT-38** adversarial callbacks cannot crash the host: **CONFORM** for the managed-worker route (malicious fixture tests); the *trusted-code* exception language is honored by the managedWorkers opt-in default-off design.
- **AT-39** ordinary MCP client cannot install/activate/update/remove: **CONFORM** (model_tools-only mutation actions; MCP export is contract-only — host-binding.ts:182-205).
- **AT-40** full independent-author scenario archived: **PARTIAL** — the e2e-orchestration script runs the scenario; the *archived release artifact* half (protocol/version/Windows evidence bundle) is the Lead's packaging step.

### 1.7 Cross-cutting observations

1. **Tool declaration shape (LOW):** tongue/voz manifests declare `tools: []` and express their tools
   only as `implementations[].contractId` (`tool-mode/lang_detect`, `tool-mode/stt_transcribe`); the
   tool schema/description live in the HOST's `@try-works/tool-mode-contracts` package
   (`tool-mode-contracts/src/index.ts:49` STANDARD_CONTRACTS). §16.5 intends contributions to be
   self-contained in the package manifest. Functionally verified end-to-end (PACKED-OK), so this is a
   declaration-location deviation, not a runtime gap.
2. **Model-name branch in the host (INFO):** the tongue/voz/standard-contract mapping is a
   model-to-contract registry, not a model-name branch — consistent with NDL-08's requirement.

---

## Part 2 — Verification pipeline vs the whole Verification Checklist v1.2

### 2.1 §21.3 required verification commands

| Checklist command | Repo state | Verdict |
|---|---|---|
| `verify:static` | exists (`package.json`) | **MET** |
| `test:unit` | exists (= `npm test`) | **MET** |
| `test:contracts` | exists | **MET** |
| `test:extensions` | exists | **MET** |
| `test:recipes` | exists | **MET** |
| `test:integration:dsh` | exists (full host suite) | **MET** |
| `test:mcp:2026-07-28` | exists (= verify:mcp fixtures+live) | **MET** |
| `test:composition` | exists (PTC + tool-mode-run + recipes) | **MET** |
| `test:models:windows` | exists (tongue/voz/embeddinggemma/needle suites) | **MET** |
| `test:harness:live` | exists → `scripts/report-suite-status.mjs harness-live` (a STATUS reporter, not a live harness suite — see note) | **PARTIAL** |
| `test:security:windows` | exists (authority + ptc-sandbox + install) | **MET** |
| `test:packaged:windows` | exists (build + verify:built + verify:packed) | **MET** |
| `verify:release -- --report <path>` | exists; `--report` flag implemented (`scripts/gen-verification.mjs:23,237-240`) | **MET** |

Note on `test:harness:live` (MEDIUM): the checklist requires live harness tests "with explicit prepared
models/credentials and record consumption". The script is a status reporter over the recorded
harness-live evidence; there is no executable live-vision harness suite (recorded as BLOCKED in the
release gate for the two live vision routes). The command name exists but does not currently RUN live
tests. This is the honest BLOCKED state; the script name should not be mistaken for a live run.

### 2.2 §21.4 implementing-agent checklist — notable rows

| Row | Verdict |
|---|---|
| Starting commit/versions/baseline recorded | **MET** (evidence.json git/command/packages/platform blocks) |
| Full requirement→test map | **MET** (verification/requirements.json: 317 rows = 227 normative + 90 acceptance; key sets identical to evidence.json) |
| Public TMX 1.1/recipe schemas + both author fixtures | **MET** (published schema + declarative/module fixtures) |
| Built-ins independent archives, installs run no scripts | **MET** (verify:packed + install.test.ts) |
| Resolve/approve exact model artifacts; Laya maintainer export | **PARTIAL** — embeddinggemma/voz/tongue/needle locks pinned; **Laya export does not exist** |
| Node media decoding + real modalities + selective loads | **PARTIAL** — text/image/audio CONFORM; **video embedding NOT-IMPLEMENTED** |
| Real Laya decisions + Needle on Windows | **PARTIAL** — Needle native route qualified; **Laya absent** |
| Real DSH capability resolution + two live vision routes | **PARTIAL** — resolution machinery + fake-provider tests exist; **two live routes remain BLOCKED** |
| Exact modern MCP wire | **MET** (live conformance 12/12 + fixtures 39 checks) |
| Local + mixed harness compositions | **MET** (PTC suites + tool-mode-run) |
| New-user recipe author flow through all surfaces | **MET** (CLI authoring + orchestration stages) |
| Adversarial files/workers/archives/cross-client isolation | **MET** (authority, ptc-sandbox, install, managed-workers suites) |
| Release tarballs into clean profile | **MET** (verify:packed ×3 with probe isolation) |
| Receipts vs privacy/retention policy | **MET** (obs02/receipt suites) |
| Machine-readable evidence matrix + failing release gate | **MET** (verification/evidence.json + verify:release exits nonzero while gates are red — by design) |

### 2.3 §21.5 required repository artifacts (TDD-09)

| Required artifact | Repo state | Verdict |
|---|---|---|
| `verification/requirements.json` | exists, 317 rows | **MET** |
| `verification/compatibility.json` | **absent** | **UNMET** |
| `verification/models.lock.json` (qualification index) | **absent** (per-extension locks exist and are canonical; no repo-level index) | **UNMET** |
| `verification/protocol/2026-07-28/` | **absent** — equivalent lives at `docs/tool-mode/specs/mcp-2026-07-28/` (schema + fixtures) | **PARTIAL** (relocated) |
| `verification/fixtures/` | **absent** — equivalents at `docs/tool-mode/fixtures/mcp-2026-07-28/` + package test fixtures | **PARTIAL** (relocated) |
| `verification/quality-gates.json` | **absent** | **UNMET** |
| `verification/results/` | exists (`release.json`) | **MET** |
| `verification/VERIFY.md` | **absent** | **UNMET** |
| TDD-10 release report | `verification/RELEASE-REPORT.md` + `FINAL-REPORT.md` (generated) | **MET** |

**Note (LOW):** the four "absent" artifacts are the checklist's *repository layout* requirements. The
equivalent information largely exists elsewhere (docs/tool-mode/, package locks), but a verifier
following the checklist's §21.5 paths literally would find them missing. Recommend either creating
the canonical paths (possibly as generated indexes) or recording a reviewed deviation in VERIFY.md —
which itself is one of the missing artifacts.

### 2.4 TDD discipline (§21.1) judgments

| TDD item | Verdict |
|---|---|
| TDD-01 requirement inventory | **MET** (317-row inventory, all AT-01..AT-90 present as rows) |
| TDD-02 red runs with retained failure references | **PARTIAL** — red→green discipline is followed per-lane, but failure/commit references are not retained as records in verification/ |
| TDD-03 green without bypassing real boundaries | **MET** (integration suites drive real registries/listeners/packed runtimes; live conformance over real sockets) |
| TDD-04 refactor discipline | **MET** (packed/integration re-runs after moves; verify:packed in the chain) |
| TDD-05 independent verification | **MET** (this audit lane + independent probes across gates 1–9) |
| TDD-06 no false passes (PASS/FAIL/BLOCKED/NOT_RUN; release gate red) | **MET** (12 PASS / 250 FAIL / 4 BLOCKED / 51 NOT_RUN; release gate deliberately nonzero) |
| TDD-07 tests must not mutate user state | **MET** (probe-isolation guard + temp fixtures; suites run against throwaway state) |
| TDD-08 reviewed quality gates (fixtures before thresholds, no hidden labels) | **PARTIAL** — fixture discipline holds, but `verification/quality-gates.json` (the reviewed evaluation configuration) is absent; the two live vision quality routes are BLOCKED |

---

## Part 3 — Summary counts

**Extension-package audit (§8/§9/§17/§18/§16.9):**

| Severity | Count | Findings |
|---|---|---|
| CRITICAL | 0 | — |
| HIGH | 5 | EmbeddingGemma 3-of-6 tools missing (MOD-11/12/13); video embedding half NOT-IMPLEMENTED (MOD-07); Laya decision tools entirely absent (DEC-01..08, MODEL-02, TOOL-02); MiniLM `text_embed` (TOOL-04) and `text_rerank` (TOOL-05) absent |
| MEDIUM | 2 | NDL-06 Needle telemetry opt-out controls unimplemented while manifest claims `requiredTelemetry:false`; `test:harness:live` is a status reporter, not a live suite |
| LOW | 6 | harness-vision as builtin recipe (packaging deviation); LIC-02/03 permission-basis operator items; tongue/voz manifest `tools:[]` declaration shape; `@try-works/extension-*` vs `tool-mode-*` naming; §21.5 artifact relocations; TDD-02 red evidence not retained |
| INFO | 4 | jev/whistle/whisper-tiny optional alternatives absent; NDL-07 optional embeddings absent; model-name-branch observation; checklist §21.4 rows as noted |

**Checklist pipeline audit (§21):** commands 12/13 MET, 1 PARTIAL (`test:harness:live`); §21.5 artifacts 5/9 MET, 2 PARTIAL (relocated), 4 UNMET (compatibility.json, models.lock.json, quality-gates.json, VERIFY.md); TDD items 5 MET, 3 PARTIAL, 0 UNMET.

**Bottom line:** the shipped extension set covers tongue, voz, Needle (native route) and the
EmbeddingGemma 2 text/image/audio core with real Windows CPU qualification; the spec-mandated
Laya decision family, the MiniLM compatibility pair, and the EmbeddingGemma derived-tool/video halves
remain genuinely unimplemented (HIGH), and the Needle telemetry controls need the NDL-06 env
handling before the manifest's `requiredTelemetry:false` claim can be considered verified. The
verification pipeline is substantially checklist-conformant; the named §21.5 artifact gaps and the
quality-gates file are the consolidation items.
