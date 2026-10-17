# Tool Mode — Specification Conformance Audit

**Date:** 2026-10-17 · **Auditor:** Lead (consolidating three Agent Teams audit lanes) · **Status:** READ-ONLY audit; no source changes were made for this report.

## 1. What was audited

| Authority (read-only attachments) | SHA-256 | Coverage |
|---|---|---|
| `Tool_Mode_DSH_Implementation_Spec_v1.2.md` (TM-DSH-001) | `b98db502…bba4bb` | §1–15, §16, §17, §18, §19, §20, §21, §22 |
| `Tool_Mode_Extension_Protocol_v1.1.md` (TMX 1.1) | `016e6f57…b3f386f9` | full document (shared metadata, §16, commands, §19) |
| `Tool_Mode_Verification_Checklist_v1.2.md` | `2c34decf…be5c089d` | §14, §16.9, §21.1–21.5 (AT-01…AT-90, TDD-01…10) |

**Lanes** (disjoint scopes, independent auditors, per-clause judgments with file:line evidence):

- [audit/host.md](audit/host.md) — `packages/dsh-model-as-tool` vs spec §1–15 + §20 + §21 host items (host-integrator)
- [audit/sdk.md](audit/sdk.md) — SDK + contracts + recipes + harness-text vs TMX 1.1 + spec §16/§19 (sdk-store-integrator)
- [audit/extensions-and-checklist.md](audit/extensions-and-checklist.md) — needle/tongue/voz/embeddinggemma vs §8/§9/§17/§18/§16.9 + the verification pipeline vs the whole checklist (gate-verifier)

**Verdicts:** CONFORM / DEVIATION / NOT-IMPLEMENTED per normative clause, judged against the SPEC text, not against the repo's own `status.json` claims. **Severity:** CRITICAL / HIGH / MEDIUM / LOW / INFO. The Lead re-verified every CRITICAL and every HIGH claim plus a sample of the MEDIUM claims against the tree before consolidation.

## 2. Executive summary

The implementation is **functionally complete and fully green against its own vocabulary** (full `npm run verify` exit 0, 1792 tests / 1781 pass / 0 fail / 11 platform skips) — but **spec-fidelity is the release-relevant gap class**. The audit found 2 CRITICAL, 7 HIGH, 13 MEDIUM, and 16 LOW findings, plus 5 unmet verification-checklist artifacts.

| Severity | Count | Where |
|---|---|---|
| CRITICAL | 2 | SDK lane (declarative manifest schema; recipe vocabulary) |
| HIGH | 7 | SDK lane 2 (dependency isolation; harness-text packaging) · Extension lane 5 (Laya absent; EmbeddingGemma derived tools 3/6 + video half; MiniLM embed/rerank absent) |
| MEDIUM | 13 | Host lane 6 · SDK lane 5 · Extension/pipeline lane 2 |
| LOW | 16 | Host 4 · SDK 6 · Extension 6 |
| NOT-IMPLEMENTED (standalone) | 1 | Host lane (RUN-03 headless launcher) — the other NOT-IMPLEMENTED clauses are counted inside their HIGH rows |

External release gates were **not relabeled**: Laya npm publication, the two live vision routes, the voz real-speaker corpus, the Windows confinement acceptance (CODE-08/09, AT-14), and the second-machine matrix remain external/operator items.

## 3. CRITICAL findings

### C1 — Spec-shaped declarative manifests are rejected end-to-end (EXT-14 / RCP-01)
- **Lane:** SDK ([audit/sdk.md](audit/sdk.md) headline 1). **Verdict:** DEVIATION — the spec's own §19.3 example cannot be installed.
- The SDK's manifest schema closes `implementations[]` over `{id, contractId, contractVersion, modelId, recipeVersion}` only — no `kind:"harness-model"`, no `recipe` field (`packages/tool-mode-extension-sdk/schema/extension-manifest-1.1.0.schema.json:171-186`).
- `KNOWN_FEATURES` = `provider-worker-v1, verified-assets-v1, declarative-recipes-v1, harness-executors-v1` (`packages/tool-mode-extension-sdk/src/manifest.ts:28-33`); the spec's required features `harness-model-recipes-v1` and `typed-image-input-v1` are unknown → `INCOMPATIBLE_PROTOCOL`.
- `permissions.harnessModel {inputModalities, outputModalities}` is likewise unrepresentable.
- **Lead verification:** `KNOWN_FEATURES` grep-confirmed at manifest.ts:28-33. **Impact:** a third party following §19.3 verbatim cannot install their package — this gates the §16 opening MUST ("A third party MUST be able to author, build, pack, install … without modifying or rebuilding Tool Mode or DSH").

### C2 — The shipped recipe vocabulary diverges from RCP-02's normative shape
- **Lane:** SDK (headline 2). **Verdict:** DEVIATION — spec-shaped recipes fail validation; `approved-profile` (RCP-05) is inexpressible.
- Shipped `harness-model-recipe.schema.json` required keys: `{id, version, description, tool, inputs, promptTemplate, maxOutputTokens, imageInputs, policy}` (`packages/tool-mode-recipes/schema/harness-model-recipe.schema.json:8`).
- RCP-02's normative vocabulary: `{schemaVersion, kind, modelSelection{strategy, requires{inputModalities,outputModalities}}, instructions, inputBindings, response{mode,field}, limits{…}, context{inheritConversation, includeTools}}`.
- **Lead verification:** required-key list grep-confirmed at schema line 8; none of `modelSelection/inputBindings/response/limits/context` exist in the shipped schema.
- **Root cause (shared with C1):** the shipped vocabulary predates §19.3's normative examples. Closing both is one bounded vocabulary-alignment slice (accept the spec field names as aliases or migrate; register the two feature names; publish the recipe schema in the RCP-02 shape).

## 4. HIGH findings

### SDK lane

**H1 — EXT-09 dependency isolation: no installer-owned dependency graphs.** The installer materializes package bytes plus an injected runtime-SDK link (`src/install/runtime-link.ts`); there is no dependency resolution/locking. Extensions must bundle every ordinary npm runtime dependency or they cannot run. Spec: "Each extension version has an installer-owned dependency graph and immutable installation directory."

**H2 — `tool-mode-harness-text` is not a self-contained TMX package.** It ships only `recipes/text-title.json` + examples (no `tool-mode.extension.json`, no `toolMode` discovery field, no schemas/skills). The built-in manifest is assembled host-side, which undercuts the EXT-03/RCP-12 "protected built-in declarative TMX extension" proof. The recipe content itself conforms (no `text_title` special case).

### Extension lane (vs §8.1/§17/§18)

**H3 — EmbeddingGemma 2 ships 3 of the 6 required tools.** `multimodal_embed`, `semantic_similarity`, `semantic_rank` are declared and implemented (`packages/extension-embeddinggemma/src/contracts.ts:109-140`); `semantic_classify` (MOD-11), `semantic_deduplicate` (MOD-12) and `media_find_moments` (MOD-13) are NOT-IMPLEMENTED (the file itself says so at :16-18).

**H4 — The video embedding half is NOT-IMPLEMENTED (MOD-07).** Video parts are refused by name at validation (`src/index.ts:208-223`). The bounded uncompressed-AVI sampler exists and is re-verified, and the honest refusal is correctly recorded — but the spec requires video as a first-class modality (`MediaPart kind:"video"` + fused sampling), so this is a spec gap regardless of how honestly it is recorded.

**H5 — The Laya decision family is entirely absent.** No Laya package exists (packages list: only `LAYA-INTEGRATION-FINDINGS.md` documents the upstream work). `decision_choose`/`decision_test`/`decision_score`, DEC-01…08, MODEL-02 and TOOL-02 are NOT-IMPLEMENTED. This is a spec-mandated default ("The local implementation must use Laya's actual trained decision heads"), so it is a HIGH spec gap, not an optional extra.

**H6 — MiniLM `text_embed` is absent (TOOL-04).** The required preserved compatibility tool/contract (`text_embed`, 384-d space, "do not silently replace") has no package and no contract.

**H7 — MiniLM `text_rerank` is absent (TOOL-05).** Same — the cross-encoder reranker with `ranking_logit` score kind has no package.

## 5. MEDIUM findings

### Host lane (6)
1. **RUN-03/RUN-04 — launcher command family.** `dsh-tool-mode serve/doctor/prepare/mcp-stdio` do not exist as such; shipped bins are `dsh-tool-mode-mcp-stdio` and `dsh-tool-mode-credentials` (package.json bin); prepare/doctor equivalents live behind `model_tools` actions. The headless `serve` composition (RUN-03) is NOT-IMPLEMENTED in the host package.
2. **MCP-07 / P26-09 — subscription change notifications.** `subscriptions/listen` with ack-first and caller filtering conforms; catalog-change notifications are not emitted on every lifecycle transition.
3. **DECL-07 — `tool_mode_list` / `tool_mode_describe` naming.** The spec-named read-only pair is served via `model_tools` actions and MCP `tools/list` instead of under those exact names.
4. **LIC-03 — human permission-basis recording surface.** The native/export/distribution permission basis is a recorded operator decision; no UI/management surface records it (a config boolean is correctly NOT treated as a grant).
5. **§12 — configuration contract.** The flat per-field zod config (Config, index.ts:304-341) does not implement the proposed schemaVersion-3 nested shape (extensions/mcp/composition/harnessExecutor/recipes/clients/capture). Fixed-false flags are fixed-false by omission (no code path can set them true), which is the honest half of "reject unsupported values" but not the full contract.
6. **OBS-04 — settings UI.** Diagnostics/receipts/mcp management actions cover the required surface; a settings UI proper is not built (generic tool cards, which the spec permits "initially").

### SDK lane (5)
7. **EXT-08 — install-time operator preview.** The permissions/licenses/platform/download-implications preview exists only in the update deltas, not on install.
8. **EXT-31 — CLI family incomplete.** No `extensions update|rollback|purge-assets` subcommands (the APIs exist in `update-flow.ts`); `--json` is wired for `inspect` only.
9. **RCP-05 — `approved-profile` selection.** Unrepresentable in the shipped recipe format (follows C2).
10. **RCP-08 — `test --live --executor-profile`.** Implemented as an honest refusal (recorded remainder), not a live run.
11. **RCP-04 — json response mode.** Prompt-enforced + locally validated; the "provider structured output vs local enforcement" difference is not surfaced to operators.

### Extension/pipeline lane (2)
12. **NDL-06 — Needle telemetry controls unimplemented.** Zero matches for `NEEDLE_TELEMETRY`/`DO_NOT_TRACK` in `packages/extension-needle/src/*` (Lead grep-confirmed), while the manifest declares `network.requiredTelemetry: false`. The spec's opt-out controls and network verification are absent.
13. **`test:harness:live`** is `node scripts/report-suite-status.mjs harness-live` — a status reporter, not a live harness suite (Lead-confirmed at package.json:31). The two live vision routes remain honestly BLOCKED.

## 6. LOW findings (grouped)

- **Host:** ARCH-04 bridge doc page; MCP-03 stdio binary naming; SEC-06 documented sub-millisecond TOCTOU residual (recipes lane's bound); CODE-11 harness repair budget lineage half.
- **SDK:** EXT-06 no local source-directory dev mode; EXT-12 no provenance/signature checks; EXT-29 no restart tombstone-retry deletion loop; EXT-35 invocation-generation on receipts is host-side; EXT-36 module template + author guide not shipped in the SDK package; EXT-21 contracts package publishes only `stt_transcribe` + `lang_detect` standard descriptors (the other ~10 standard contracts are not published there).
- **Extensions/pipeline:** harness-vision shipped as a builtin recipe, not a separately packable package; LIC-02/03 permission basis remains operator items; tongue/voz manifests declare `tools: []` with tools expressed only via `implementations[].contractId` against host-owned STANDARD_CONTRACTS; `@try-works/extension-*` vs the spec's proposed `@try-works/tool-mode-*` naming; §21.5 artifacts relocated (protocol/fixtures under `docs/tool-mode/`); TDD-02 red-run references not retained in `verification/`.

## 7. Verification-pipeline results (checklist v1.2)

- **§21.3 commands:** 12/13 MET (`verify:static`, `test:unit`, `test:contracts`, `test:extensions`, `test:recipes`, `test:integration:dsh`, `test:mcp:2026-07-28`, `test:composition`, `test:models:windows`, `test:security:windows`, `test:packaged:windows`, `verify:release --report` — the flag is implemented at gen-verification.mjs:23,237-240); 1 PARTIAL (`test:harness:live`, MEDIUM-13 above).
- **§21.5 required artifacts:** MET `requirements.json` (317 rows), `results/`, `RELEASE-REPORT.md`/`FINAL-REPORT.md`. PARTIAL (relocated): `protocol/2026-07-28/` → `docs/tool-mode/specs/mcp-2026-07-28/`; `fixtures/` → `docs/tool-mode/fixtures/` + package fixtures. UNMET: `verification/compatibility.json`, repo-level `verification/models.lock.json` index, `verification/quality-gates.json`, `verification/VERIFY.md`.
- **§21.4 rows:** 10/15 MET; 5 PARTIAL (Laya export, video modality, two live vision routes, red-evidence retention, quality gates).
- **TDD-01…09:** TDD-01, TDD-03, TDD-04, TDD-05, TDD-06, TDD-07 MET; TDD-02 PARTIAL (red-run evidence not retained); TDD-08 PARTIAL (`quality-gates.json` absent).

## 8. What conforms (worth keeping)

- **MCP 2026-07-28 wire (§20 P26-01…17):** real and conformance-tested — hand-written raw-request live suites (no shared serializer), `-32020/-32021/-32022` + the `Mcp-Method`/`MCP-Protocol-Version`/`Mcp-Name` header contract, modern first-request semantics, SSE-close cancellation, OAuth 2.1 resource-server + honest static-token labeling (14/17 clauses fully CONFORM, per the host lane).
- **TMX core lifecycle (EXT-04/07/10/11/13/15/16/19/20/25-30/33/34):** staged install (inactive, no scripts, archive defenses), orthogonal state dimensions, activation rollback, two-phase update/rollback with pointer preservation, the full 15-code error vocabulary, managed workers with scrubbed env and generation-bound processes.
- **Prepared assets (RES-01…10):** digest-verified acquisition into an isolated content-addressed cache, re-check on every prepare, prepared-cold readiness flip, asset map into both provider routes (gates 8–9).
- **EmbeddingGemma 2 text/image/audio core (MOD-01…06, 08, 14, 15, 20):** pinned artifacts with real Windows CPU qualification, selective group loading, 768/512/256/128 truncate+renormalize, honest refusals.
- **Needle native route (NDL-01…05, 08):** pinned executable + weights, frozen host-side schema snapshot, never-autoexecute, process-per-call isolation.
- **Security/identity (SEC-01…10, AT-12/13/16/17):** secret-free model surface, once-only CLI credential output, per-client grants, path/junction defenses, no silent local→remote fallback.

## 9. External / operator items (unchanged, honestly recorded)

Laya npm publication · two live vision provider routes (AT-72/HLM-14) · voz real-speaker corpus · Windows hosted-code confinement acceptance (CODE-08/09, AT-14) · second-machine matrix (AT-19/OBS-05). None were relabeled as passing.

## 10. Consolidation notes

- **Cross-lane overlap (counted once):** the `dsh-tool-mode` command family gap appears in three lanes (host RUN-03/04, SDK EXT-31, recipes RCP-08 naming) — one root cause: no single `dsh-tool-mode` CLI binary with the spec's subcommand layout.
- **Same root, two CRITICALs:** C1 and C2 both stem from the pre-§19.3 declarative/recipe vocabulary; a single vocabulary-alignment slice closes both.
- **No contradictions between lanes.** Where duties are shared (e.g. `tool_mode_list/describe`), the lanes agree and cite the same root.
- **Honesty discipline held:** every lane re-judged the repo's recorded remainders against the spec text (e.g. the video refusal is recorded honestly in-repo but is still a spec-mandated NOT-IMPLEMENTED half) — no lane treated a recorded remainder as conformance.

## 11. Suggested fix order (proposal only — nothing changed in this audit)

1. **C1+C2** vocabulary alignment (manifest schema `kind`/`recipe`/`harnessModel` + the two feature names + the RCP-02 recipe schema shape) — unblocks third-party authors following the spec verbatim.
2. **H3+H4** EmbeddingGemma derived tools (`semantic_classify`, `semantic_deduplicate`, `media_find_moments`) and the fused video embedding half.
3. **H5** Laya package (maintainer ONNX export + decision contracts) — already partially blocked on the upstream npm publication.
4. **H1** installer-owned dependency graphs; **H2** harness-text package completion.
5. **H6/H7** MiniLM `text_embed`/`text_rerank` compatibility packages.
6. MEDIUMs in priority order: NDL-06 telemetry controls · §12 config v3 shape · launcher command family · subscription notification coverage · §21.5 artifact paths (`compatibility.json`, `quality-gates.json`, `VERIFY.md`, repo-level lock index).

---

*Lane reports: [audit/host.md](audit/host.md) · [audit/sdk.md](audit/sdk.md) · [audit/extensions-and-checklist.md](audit/extensions-and-checklist.md). This audit made no implementation changes.*
