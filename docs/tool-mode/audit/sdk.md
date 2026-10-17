# SDK lane spec audit — TMX 1.1 + master spec §16/§19

**Date:** 2026-10-17 · **Status:** READ-ONLY audit (no source edits; this file is the only write)
**Packages audited:** `packages/tool-mode-extension-sdk` (SDK), `packages/tool-mode-contracts` (contracts), `packages/tool-mode-recipes` (recipes), `packages/tool-mode-harness-text` (harness-text)
**Authorities:**
- Tool Mode Extension Protocol v1.1 (`Tool_Mode_Extension_Protocol_v1.1.md`, attachments …/016e6f57…)
- Master spec v1.2 §16 (lines 721–1093) + §19 (lines 1366–1539) (`Tool_Mode_DSH_Implementation_Spec_v1.2.md`, attachments …/b98db502…)

**Verdict vocabulary:** CONFORM · DEVIATION (partially implemented or a materially different shape) · NOT-IMPLEMENTED · HOST-OWNED (the clause's duty belongs to the host package `dsh-model-as-tool`; judged whether the SDK still provides the needed seam).
**Severity:** CRITICAL (MUST gating release/security) · HIGH · MEDIUM · LOW · INFO.

---

## Headline findings (top 5)

1. **CRITICAL — spec-shaped declarative manifests are rejected (RCP-01 vs the shipped schema).** The spec's own declarative example declares `implementations[].{kind:"harness-model", recipe:"./recipes/…"}`, `permissions.harnessModel{inputModalities,outputModalities}` and `requiredFeatures:["harness-model-recipes-v1","typed-image-input-v1"]`. The SDK rejects all three: `schema/extension-manifest-1.1.0.schema.json:171–186` closes implementations over `{id, contractId, contractVersion, modelId, recipeVersion}` only (no `kind`, no `recipe`), and `src/manifest.ts:28` `KNOWN_FEATURES` is `['provider-worker-v1','verified-assets-v1','declarative-recipes-v1','harness-executors-v1']` — `harness-model-recipes-v1`/`typed-image-input-v1` are unknown required features → `INCOMPATIBLE_PROTOCOL`. A third party following §19.3's example verbatim cannot install their package, which gates the §16 opening requirement ("A third party MUST be able to author, build, pack, install … without modifying or rebuilding Tool Mode or DSH").
2. **CRITICAL — the shipped recipe vocabulary diverges from RCP-02's normative shape.** `packages/tool-mode-recipes/schema/harness-model-recipe.schema.json` top-level keys are `{id, version, description, tool, inputs, promptTemplate, maxOutputTokens, imageInputs, policy}`. RCP-02's vocabulary is `{schemaVersion, kind, modelSelection{strategy, requires{inputModalities,outputModalities}}, instructions, inputBindings, response{mode,field}, limits{timeoutMs, maxInputTextBytes, maxImages, maxOutputTokens, maxAttempts, repairAttempts}, context{inheritConversation, includeTools}}`. Same semantics, different names: `modelSelection`, `inputBindings`, `response`, `limits` and `context` are unrepresentable, so a spec-shaped recipe fails validation and the authoring tools cannot express `approved-profile` selection or the limits/context objects.
3. **HIGH — no installer-owned dependency graphs (EXT-09).** The installer materializes the package bytes plus an injected runtime-SDK link (`src/install/runtime-link.ts`); there is no dependency resolution/locking at all — an extension with ordinary npm runtime dependencies must bundle them or it cannot run. "Each extension version has an installer-owned dependency graph and immutable installation directory" is unmet.
4. **HIGH — `tool-mode-harness-text` is not a self-contained TMX package (EXT-13/RCP-01/RCP-12).** It ships only `recipes/text-title.json` + examples: no `tool-mode.extension.json`, no `toolMode` discovery field, no schemas/skills, no declarative manifest. The recipe itself conforms, but the "protected built-in declarative TMX extension" artifact is assembled host-side instead of being an independently installable package, which undercuts the RCP-12/EXT-03 proof claim.
5. **MEDIUM — EXT-31 command family incomplete.** The SDK CLI covers `extensions list|inspect|install|activate|prepare|deactivate|uninstall` and `tools enable|disable` (plus the recipes namespace), but `extensions update`, `extensions rollback` and `extensions purge-assets` have no subcommands although the APIs exist (`update-flow.ts`); `--json` structured output is wired for `inspect` only (`src/cli.ts:318`).

---

## SDK — tool-mode-extension-sdk

| Clause | Verdict | Sev | Evidence (file:line) | Citation |
|---|---|---|---|---|
| EXT-01 host/package separation | HOST-OWNED | INFO | package deps = `{ajv}` only (package.json); no host import anywhere in src/ | "The host owns installation, lifecycle, policy… It MUST NOT contain a special-case import" — SDK is the host-free half; the host package owns registration |
| EXT-02 public contract, no private imports | CONFORM | INFO | `package.json` dependencies: `ajv` only | "The public SDK MUST NOT depend on the Tool Mode host" |
| EXT-03 built-ins identical protocol | HOST-OWNED | INFO | SDK ships the one validator used by every package (`manifest.ts`); `builtins.lock.json` is host-side | built-ins "use the same manifest, validator, loader" — SDK provides the shared surface |
| EXT-04 deactivation + per-tool toggles | CONFORM | INFO | `lifecycle.ts` deactivate/`setToolEnabled`; `BUILTIN_PROTECTED` in `errors.ts:25` | "Every extension… MUST support persistent activation/deactivation… independent enable/disable" |
| EXT-05 one model, several tools | CONFORM | INFO | `manifest.ts` tools/implementations arrays; multi-tool manifests validated | "A package may contain several models, tools, or implementations" |
| EXT-06 required sources | DEVIATION | LOW | `staged.ts:32` `InstallSource {kind:'registry'\|'url'\|'local'}` + injected `ArchiveSource`; no local source DIRECTORY dev mode | "Local source directory — Optional developer mode only" (the optional form is absent) |
| EXT-07 install is not activate | CONFORM | INFO | `staged.ts:99` `activation:'inactive'` returned explicitly | "installation makes an extension available… in the inactive state" |
| EXT-08 staged installation | DEVIATION | MEDIUM | quarantine/limits/integrity/discovery/compat/promote/record in `staged.ts:122–264`; the permissions/licences/platform/download-implications operator PREVIEW exists only in the update deltas (`update-flow.ts` report), not on install | "show permissions/licenses/platform/download implications; obtain the required operator approvals" |
| EXT-09 dependency isolation | NOT-IMPLEMENTED | HIGH | only the runtime SDK link is injected (`runtime-link.ts`); no dependency resolution/locking exists | "Each extension version has an installer-owned dependency graph" |
| EXT-10 no installation scripts | CONFORM | INFO | no npm/npx/spawn anywhere in `src/install/`; pack writes directly | "Disable lifecycle scripts… do not call npx, npm run, prepare, preinstall, postinstall" |
| EXT-11 archive/source defenses | CONFORM | INFO | `archive.ts:122` `validateArchiveEntries` (traversal, drive paths, symlink/hardlink, case collisions, expansion bounds) + bounded manifest (`MAX_MANIFEST_BYTES`) | "Reject path traversal, drive/device paths, archive symlinks/hardlinks, duplicate or Windows-case-colliding entries… expansion bombs" |
| EXT-12 integrity is not trust | DEVIATION | LOW | `.tool-mode-install.json` + `InstalledRecord` record source/archiveDigest/contentDigest; `stagedInstall` REQUIRES `expectedSha512` (no hashless TOFU path); provenance/signature checks absent | "Record registry origin… SHA-512… available provenance/signature checks" |
| EXT-13 static discovery | CONFORM | INFO | `discovery.ts:155` reads package.json name/version/type/toolMode + manifest; declarative needs no entry (`manifest.ts` execution.kind) | "Require package.json with name, version, type:'module', the toolMode discovery field… The manifest MUST be available as ./tool-mode.extension.json" |
| EXT-14 manifest fields | DEVIATION | **CRITICAL** | schema closes implementations over `{id,contractId,contractVersion,modelId,recipeVersion}` (`schema/extension-manifest-1.1.0.schema.json:171–186`) and `KNOWN_FEATURES` (`manifest.ts:28–33`) omits `harness-model-recipes-v1`/`typed-image-input-v1` | §19.3's example: `implementations[].{kind:"harness-model", recipe}` + `requiredFeatures:["harness-model-recipes-v1","typed-image-input-v1"]` + `permissions.harnessModel` — all rejected today |
| EXT-15 model asset locks | CONFORM | INFO | `manifest.ts` `validateLockQualifications`; lock shape {id, platform, assets…} with digest requirements | "Every asset declares an ID… byte length, SHA-256 or SHA-512 digest and role"; "Real lock files MUST NOT contain placeholder hashes" |
| EXT-16 versioning | CONFORM | INFO | `manifest.ts` `normalizedFrom` (1.0→module without byte changes); five identities kept separate in records/state | "A 1.0 manifest is normalized to module execution without modifying its installed bytes/digest" |
| EXT-17 publish SDK + reference host | CONFORM | INFO | runtime API exported (`index.ts:135–146`: `ToolModeExtensionV1`, `ExtensionContextV1`, `ModelProviderV1`, …); SDK works with no DSH import | "Publish @try-works/tool-mode-extension-sdk… It MUST work without importing DSH" |
| EXT-18 context contracts | CONFORM | INFO | types in `runtime.ts`/`load.ts`/`worker.ts` (`ExtensionContextV1`, `ProviderInspectionV1`, `PreparedAssetMapV1`, `InvocationContextV1`, `JsonObject`) | "The SDK MUST define the complete types behind the names above" |
| EXT-19 import/lifecycle discipline | CONFORM | INFO | `load.ts` ordering (inspect→load→invoke→unload→dispose); worker suite pins lifecycle ordering | "Module import and create() must be lightweight… dispose() is idempotent" |
| EXT-20 managed worker execution | CONFORM | INFO | `worker.ts` + `worker/worker-child.ts` (scrubbed env, private root, bounded framing, cancellation ids); worker.test.ts | "Load extension executable entries… in managed processes, with a private dependency root and scrubbed startup environment" |
| EXT-21 two contribution modes | CONFORM | INFO | `manifest.ts` tools vs implementations; implementations reference contracts | "The tools array declares new contracts… the implementations array declares the model/recipe binding" |
| EXT-22 collision/provider selection | CONFORM | INFO | `manifest.ts:284–312` rejects duplicate tool/skill names (`TOOL_NAME_CONFLICT`); candidate-list selection is host-side | "Reject duplicate custom tool/skill names… A second implementation… joins the candidate list" |
| EXT-23 identity-bound permissions | HOST-OWNED | INFO | SDK exposes the registrar/lifecycle seam the host evaluates grants through | "Evaluate host export policy, caller scope… for every call" — host duty |
| EXT-24 coherent publication | HOST-OWNED | INFO | lifecycle generation counters (`lifecycle.ts` #generation) feed the host's catalog | "the host updates DSH tool declarations… from one versioned catalog generation" |
| EXT-25 persist orthogonal state | CONFORM | INFO | `state.ts` `ExtensionState` separate dims (installation/desired/observed/tools/readiness) | "Do not use one enabled boolean for installation, activation, readiness…" |
| EXT-26 activate | CONFORM | INFO | `lifecycle.ts` #activate: verifyUnchanged → readiness → publish-all-then-commit → narrow rollback; `needs-preparation` diagnostic | "Validate installed static files and locks… Commit the catalog generation only after the activation steps succeed" |
| EXT-27 deactivate | CONFORM | INFO | intent-first write (`lifecycle.ts:432`), quarantine on withdrawal failure, `onWithdrawal` teardown hook (task-29) | "First persist inactive intent and revoke admissions… Never report fully stopped while its uncontrolled worker continues" |
| EXT-28 uninstall third-party | CONFORM | INFO | `EXTENSION_IN_USE` unless `--deactivate`; retained disabled preference (`removeRecord` keeps the profile state) | "An installed active package returns EXTENSION_IN_USE unless the operator explicitly requests --deactivate" |
| EXT-29 Windows cleanup/shared ownership | DEVIATION | LOW | `CLEANUP_PENDING` code + quarantine exist; the restart tombstone-retry deletion loop is not implemented | "Use tombstones/cleanup-pending state and retry owned deletion on restart if Windows still holds a file" |
| EXT-30 updates and rollback | CONFORM | INFO | `update-flow.ts` full two-phase flow: side-by-side stage → delta gates → approval records → pointer commit → auto/manual rollback (tasks 37/42/46) | "Install updates side-by-side… Retain the last working version… Rollback does not undo security revocations" |
| EXT-31 operator experience | DEVIATION | MEDIUM | CLI (`cli.ts:164–187`) lacks `extensions update|rollback|purge-assets`; `--json` wired for inspect only (`cli.ts:318`) | "dsh-tool-mode extensions update… extensions rollback… purge-assets" + "Commands must have structured --json output" |
| EXT-32 discovery/management permissions | HOST-OWNED | INFO | `tool_mode_list`/`tool_mode_describe` live in the host package | host duty |
| EXT-33 store layout + immutable lock | CONFORM | INFO | `store.ts`: `extensions.lock.json`, `profiles/<p>/state.json`, `staging/`, `approvals/`, `store.lock`, fail-closed corruption reads | "Use an operator-owned extension store… Store extensions.lock.json… A corrupted state file must fail closed" |
| EXT-34 errors | CONFORM | INFO | `errors.ts:14–28` — all 15 required codes present verbatim | "Publish machine-readable management errors including INVALID_EXTENSION… CLEANUP_PENDING" |
| EXT-35 provenance and telemetry | DEVIATION | LOW | SDK records id/version/contentDigest/source (`store.ts` `InstalledRecord`); invocation-generation on receipts is host-side | "Record extension ID, package version/content digest… activation generation on invocation receipts" |
| EXT-36 author kit + independent proof | DEVIATION | LOW | SDK + manifest/recipe schemas + recipe templates + fixture test broker ship; a full MODULE template + complete author guide and the independent-author fixture are host/README-level, not a shipped SDK artifact | "Ship the SDK, manifest and recipe JSON Schemas… both module and declarative templates, a reference test host… and an author guide" |

---

## Contracts — tool-mode-contracts

| Clause | Verdict | Sev | Evidence (file:line) | Citation |
|---|---|---|---|---|
| EXT-17 standard contract descriptors | CONFORM | INFO | `src/contracts/stt-transcribe.ts`, `src/contracts/lang-detect.ts` (schemas + semantics, no implementations) | "Publish standard tool contract descriptors separately… they contain schemas and semantics, not model implementations" |
| §7 / EXT-17 ToolMeta schema | CONFORM | INFO | `src/meta.ts:29` `ToolMeta`, `:51` `TOOL_META_SCHEMA`, `:82` `withMeta` (payload + reserved `meta` derivation) | "The SDK must provide a reusable ToolMeta schema"; "the SDK derives a payload schema by removing only the reserved meta property" |
| EXT-18 context contracts shared types | CONFORM | INFO | `JsonObject`/context types shared with the SDK (`src/dsh.ts`, `src/index.ts`) | "the shared JsonValue vocabulary" |
| EXT-21 standard-contract coverage | DEVIATION | LOW | only `stt_transcribe` + `lang_detect` descriptors ship; the §16.1 table's ~12 standard contracts (`multimodal_embed`, `semantic_*`, `decision_*`, `text_embed`, `text_rerank`, `tools_plan`, `structured_extract`, `image.describe`, `text.title`) are not published here | §16.1 first-party package split table |
| EXT-02 independence | CONFORM | INFO | contracts deps are type/schema-only; no host import | "The public SDK MUST NOT depend on the Tool Mode host" |

---

## Recipes — tool-mode-recipes

| Clause | Verdict | Sev | Evidence (file:line) | Citation |
|---|---|---|---|---|
| RCP-01 declarative package shape | DEVIATION | **CRITICAL** | pack emits implementations `{id, contractId, contractVersion, recipeVersion}` (`src/cli.ts:722–726`) — no `kind:"harness-model"`, no `recipe` path; and the SDK rejects the spec shape (see EXT-14) | §19.3 example: `implementations:[{kind:"harness-model", …, recipe:"./recipes/review.json"}]`, `permissions.harnessModel`, required feature `harness-model-recipes-v1` |
| RCP-02 safe recipe schema | DEVIATION | **CRITICAL** | shipped schema keys `{id, version, description, tool, inputs, promptTemplate, maxOutputTokens, imageInputs, policy}` vs the normative `{schemaVersion, kind, modelSelection, instructions, inputBindings, response, limits, context}` vocabulary | "Publish and validate the following recipe vocabulary as harness-model-recipe.schema.json" + the §19.3 JSON example |
| RCP-03 binding interpretation | CONFORM | INFO | `recipe-format.ts` binding validation: type/mismatch/required refusals, prototype-key abuse refused, image values must be typed `{mediaType, bytes:Uint8Array}` | "Reject invalid pointers, type mismatch, path traversal and reserved prototype/member abuse" |
| RCP-04 response modes | DEVIATION | LOW | text mode ✓ (broker completed text); `json` mode is prompt-enforced + locally validated (`titles.ts` `acceptTitle`), no provider structured-output negotiation; the difference is not surfaced to operators | "Use the selected provider's verified structured-output feature where available; otherwise require a strict single JSON document… disclose the difference" |
| RCP-05 static vs per-call authority | DEVIATION | MEDIUM | `caller-model` semantics via broker grants ✓ (`broker.ts` authorize/grantFor); `approved-profile` strategy is unrepresentable (no `modelSelection` in the format) | "approved-profile may reference a logical profile name that the operator explicitly binds" |
| RCP-06 recipe updates/contract identity | CONFORM | INFO | `contentDigest` over the installed package covers recipes/schemas (`store.ts` `digestInstalledContent`); pack pins recipe versions | "Hash recipe content, schemas, skills and package metadata into the approved extension content identity" |
| RCP-07 full lifecycle | CONFORM | INFO | recipe packages install/activate through the same staged path (`SDK tests/declarative-recipes.test.ts`) | "Install recipe packages inactive… Allow per-tool disabling, package deactivation, update/rollback and third-party uninstall exactly as for executable packages" |
| RCP-08 authoring tools | DEVIATION | MEDIUM | create/edit-draft/test/validate/describe/pack ✓ (task-28 + task-35 hardening); `test --live --executor-profile` is an honest refusal, not implemented (recorded remainder) | "dsh-tool-mode recipes test ./image-review --live --executor-profile my-vision… --live is an explicit billable/data-transfer action" |
| RCP-09 agent-assisted creation | HOST-OWNED | INFO | the CLI is the driveable tool an authoring-granted agent uses; the grant itself is host policy | "A DSH agent with an explicit authoring grant may generate… It cannot approve its own permissions" |
| RCP-10 skill/discovery parity | DEVIATION | LOW | `describe` prints effective bounds ✓; `tool_mode_describe` projection + catalog notifications are host-side | "Register native skills and expose their relevant instructions through tool_mode_describe" |
| RCP-11 error vocabulary | CONFORM | INFO | `broker.ts:152–186` `BrokerErrorCode` = the full RCP-11 set + three named local additions (CANCELLED, PROVIDER_FAILED, RECORDING_FAILED) | "Add INVALID_RECIPE… MODEL_BUDGET_EXCEEDED to the host/management error vocabulary" |
| RCP-12 default text recipe | CONFORM | INFO | `text_title` is a shipped recipe (recipes/text-title.json), no `if tool === text_title` branch in the broker (broker is generic) | "Implement text_title through this same declarative mechanism… Do not leave a hardcoded if tool === text_title path" |
| HLM-01 generic host broker | CONFORM | INFO | `broker.ts` `HarnessBroker` is provider-neutral; no env/credential reads; provider injected via `LlmProvider` | "Implement one provider-neutral harness executor… must not import DSH private code, construct vendor HTTP requests, read API-key environment variables" |
| HLM-02/03 selection | HOST-OWNED | INFO | broker's `authorize`/`grantFor` seam + `EXECUTOR_NOT_CONFIGURED`; actual provider resolution is host duty | "capture the provider, model… of the actual invoking DSH agent" |
| HLM-04 capability qualification | CONFORM | INFO | `capabilities()` + `EXECUTOR_CAPABILITY_UNKNOWN`; unknown never qualifies | "Select based on actual inputModalities… Unknown is not supported" |
| HLM-05 minimal isolated request | CONFORM | INFO | `broker.ts:446` `buildIsolatedRequest` — prompt + typed images + ceiling; `system` absent BY ASSERTION | "Build only the recipe's immutable instruction and validated bound inputs… Do not inherit the parent conversation… system prompt" |
| HLM-06 no recursive tools | CONFORM | INFO | tool-call completion → `UNEXPECTED_MODEL_TOOL_CALL`, never executed (`broker.ts:865–871`) | "If a provider nevertheless emits a tool call, fail with UNEXPECTED_MODEL_TOOL_CALL" |
| HLM-07 budgets and attempts | CONFORM | INFO | output/image ceilings enforced (`INITIAL_HOST_POLICY`), one attempt default, single permitted repair via `repairFeedback` (text-title), distinct failure codes | "Default one attempt, no repair. An optional single repair… Refusals, output truncation… are distinct failures" |
| HLM-11 real image input | HOST-OWNED | INFO | recipe binding requires a typed image value (`bytes instanceof Uint8Array`, recipe-format.ts:1041); approved-file resolution is host-side | "Resolve an approved image file… pass the actual image… Do not pass only image_path as text" |

---

## Harness-text — tool-mode-harness-text

| Clause | Verdict | Sev | Evidence (file:line) | Citation |
|---|---|---|---|---|
| EXT-13 / RCP-01 package artifact | DEVIATION | HIGH | package ships only `recipes/text-title.json` + `examples/` (package.json files: recipes, examples, README); NO `tool-mode.extension.json`, no `toolMode` field, no schemas/skills | "The manifest MUST be available as ./tool-mode.extension.json… A declarative extension instead exports its static recipe files" — the built-in manifest is assembled host-side |
| RCP-12 text recipe + examples | CONFORM | INFO | `recipes/text-title.json` (text input, JSON `title`/`description` output) + `examples/text-title-request|response.json`; validates under the shipped schema | "Its recipe and examples live in tool-mode-harness-text" |
| HLM-12 honest description | CONFORM | INFO | recipe prompt encodes: only what the text supports, no invented facts, uncertainty when unreadable, treat text as content not instructions; provider refusals preserved via the broker outcome | "The default recipe asks for visible content… must not invent hidden facts… Preserve provider refusals through the error/outcome contract" |
| EXT-03 built-in status | HOST-OWNED | INFO | protected-built-in designation is the host's `builtins.lock.json`; this package follows the declarative recipe mechanism | "Built-in models are first-party extension packages… A host release's trusted builtins.lock.json identifies protected built-in installations" |

---

## Counts and summary

- **Judged:** 58 clause-rows across the four packages (EXT-01…EXT-36, HLM-01…HLM-14 where owned, RCP-01…RCP-12, §7 ToolMeta).
- **CONFORM:** 34 · **HOST-OWNED:** 11 · **DEVIATION:** 11 · **NOT-IMPLEMENTED:** 1 (EXT-09) + 1 bundled deviation row.
- **Severity:** 2 CRITICAL · 2 HIGH · 5 MEDIUM · 6 LOW · rest INFO.

**Honest overall:** the implementation is functionally complete against its own vocabulary and its own tests are green — but SPEC-FIDELITY is the release-relevant gap class. The two CRITICALs are the same root cause seen twice: the recipe/declarative shapes shipped today predate §19.3's normative JSON examples, so a third-party author who follows the spec's examples verbatim cannot install their package (`harness-model-recipes-v1` unknown feature + `recipe`/`kind` rejected in implementations + recipe JSON rejected by the shipped schema). Closing them is a bounded vocabulary-alignment slice: add the spec field names as accepted aliases (or migrate the shipped vocabulary), register the two feature names, and publish the recipe schema in the RCP-02 shape — plus the EXT-31 CLI subcommands and a decision on EXT-09's dependency-graph scope.
