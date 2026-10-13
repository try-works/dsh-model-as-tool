# Tool Mode v1.2 — Implementing-Agent Verification Checklist

**Date:** 2026-10-13  
**Source of truth:** `Tool_Mode_DSH_Implementation_Spec_v1.2.md` (TM-DSH-001).  
**Status:** Required future verification; no application tests or Windows inference were run to create this checklist.

This extraction contains all 90 acceptance tests and the TDD/verification procedure. Requirement IDs and section numbers match the complete specification. The full specification also contains module contracts, runtime semantics, MCP wire requirements and model-specific gates; use it for implementation rather than treating this checklist as the entire specification.

## 14. Acceptance tests — required evidence

Implement a traceable `requirements -> tests -> result` matrix covering AT-01–AT-24 below, AT-25–AT-40 in section 16.9, and AT-41–AT-90 in section 21. All numbered requirements also need direct test links; the acceptance table is not a substitute for unit-level coverage. Unit mocks are necessary but cannot establish that MCP, extension installation/lifecycle, packaging, inference, or confinement works.

| ID | Acceptance test |
|---|---|
| AT-01 | Install the built tarball into a clean compatible DSH installation on Windows without source symlinks, TypeScript loaders or compiler toolchains. |
| AT-02 | Start with no optional weights, no cloud credentials and no browser. Diagnostics work; discovery downloads nothing; unavailable tools are not falsely advertised. |
| AT-03 | The embedded MCP server starts/stops with plugin configuration; port conflict, malformed config and restart behave predictably. |
| AT-04 | A genuine 2026-07-28 reference client and an independent protocol probe/client both discover and invoke tools using the modern wire contract. Record SDK/client versions; a legacy Inspector alone does not prove modern support. |
| AT-05 | Two simultaneous clients share a model pool but cannot read each other's files, credentials, receipts or execution state. |
| AT-06 | A stdio-only reference client reaches the same server through the bridge without starting a second inference host; stdout remains protocol-clean. |
| AT-07 | Authorized Native and MCP calls have equivalent semantic values and contract schemas, excluding call IDs/timing. |
| AT-08 | The unchanged leaf tools work in DSH PTC and return usable structured fields, not prose to be parsed. |
| AT-09 | External `tool_mode_run` performs the local-only transcription/decision composition with real outputs and zero harness-LLM requests; separately performs the title/image harness composition with explicitly counted and authorized auxiliary requests. |
| AT-10 | Generated loops and branching work; independent calls obey both program and cross-client provider limits. |
| AT-11 | An injected invalid output and invalid nested field fail validation through every surface; denied/rewritten canonical results cannot leak through `structuredContent` or PTC. |
| AT-12 | Missing/invalid token, hostile Origin/Host, ungranted tool, excessive body and rate-limit tests fail before inference. |
| AT-13 | Windows traversal, absolute-path escape, junction/symlink escape, device/UNC paths and unauthorized artifact/receipt IDs are refused. Include Unicode and space-containing valid paths. |
| AT-14 | Hosted code cannot read forbidden files/environment, open unapproved network destinations, import prohibited modules, spawn unauthorized processes or access management bindings. Test attempts, not only configured flags. |
| AT-15 | Infinite loops, overlong inference, oversized logs/results, too many nested calls and cancellation terminate or settle within declared bounds and leave no uncontrolled child processes. |
| AT-16 | Disabling a tool or revoking a client stops new and queued admissions; subsequent discovery updates. A captured composition binding does not bypass revocation. |
| AT-17 | Changing an interactive agent to PTC does not break MCP direct calls; parallel clients never toggle a global presentation mode. |
| AT-18 | Existing enable/disable state migrates without losing user choices; a failed durable write cannot be reported as successfully persisted. Compatibility aliases preserve their documented legacy contract. |
| AT-19 | Real inference on clean Windows CPU: qualified STT, Laya decisions, EmbeddingGemma 2 modalities, Needle planning/extraction, and preserved MiniLM tools. Test harness title/image recipes separately through qualified configured DSH providers, recording whether inference is local or remote. |
| AT-20 | Interrupted downloads, corrupted assets, cold starts, concurrent load requests and idle eviction all produce truthful readiness and cleanup. |
| AT-21 | Speech tests cover silence, supported language, unsupported requested language, chunk boundaries, duration/byte caps and missing timestamp support. |
| AT-22 | Text tests cover semantic relevance ordering, embedding shape/finiteness, invalid decision choices, explicit abstention, title faithfulness evaluation and empty/overlength input. |
| AT-23 | Source-available or unqualified providers do not become exportable merely through enable/reset or a config reload. Native, export and distribution decisions remain distinct. |
| AT-24 | Metadata-only local-specialist deployment produces bounded receipts without bodies/secrets. Harness execution with a conflicting no-retention policy is denied; an approved auxiliary-journal profile records required inputs separately without exposing parent history or credentials. Account for other DSH logging hooks. |

For nondeterministic quality, maintain fixed evaluation fixtures separate from adapter/schema tests. Report dataset, prompts/recipes, metrics, failures and results before/after changes. Do not call a schema-valid response correct by definition. Set workload-specific quality gates in a reviewed evaluation configuration; do not tune hidden expected answers into adapters.

A gated Jev live test requires operator-provided credentials. Without them, report native API fixture coverage separately from live verification; do not invent a successful endpoint test. Likewise, an unavailable Windows runner is a reported missing release gate, not a Linux pass relabeled Windows.

### 16.9 Extension-specific acceptance tests

These supplement AT-01–AT-24; include every ID in the requirements traceability matrix.

| ID | Required evidence |
|---|---|
| AT-25 | The core host installs/starts without model packages or weights. All first-party model implementations are separate buildable/packable packages using TMX; none require a hidden built-in registration path. |
| AT-26 | A clean external author fixture builds using only published SDK/contracts and its declared libraries, without the Tool Mode host or DSH source in its dependency graph. |
| AT-27 | npm exact version, HTTPS archive with pinned integrity and local `.tgz` each install the fixture into inactive inventory. Tags resolve once and remain pinned after restart. |
| AT-28 | Root and transitive install/prepare/postinstall sentinel scripts never execute. Static inspection/import counters prove that installation and listing do not load extension code or fetch weights. |
| AT-29 | Reject corrupt hashes, malformed manifests, remote schema references, incompatible APIs, undeclared dependencies, unsafe source redirects and archive traversal/symlink/Windows-case collisions. Failed installs leave existing tools usable. |
| AT-30 | Activate the external package without editing/rebuilding the host. Its typed tools and applicable skills appear coherently in DSH, MCP and Code Mode; live calls perform real implementation work. |
| AT-31 | Deactivate built-in and third-party packages during queued/active calls. Subsequent calls and captured bindings are denied, skills/types update, resources settle, and unrelated clients/extensions remain usable. |
| AT-32 | Disable one tool in a multi-tool extension without disabling the others or breaking their shared model worker. Preferences survive host/package updates and restart. |
| AT-33 | Uninstall a third-party extension, including explicit deactivate-and-uninstall. Verify code/dependency cleanup, retained-data disclosure and safe asset purging; built-in uninstall returns `BUILTIN_PROTECTED` but deactivate/purge works. |
| AT-34 | Two extension packages with incompatible versions of the same library run without dependency leakage. Two implementations of one standard tool do not create duplicate tools or silently change the selected provider. |
| AT-35 | A package cannot steal a tool/skill name, self-mark as built-in, inherit another publisher's grants or gain access by reusing a URL/name/version. Permission/identity changes require approval. |
| AT-36 | Failed activation and failed updates roll back catalog publication. Successful side-by-side updates preserve old callers' semantics or fail them explicitly; rollback preserves revocations/disabled state. |
| AT-37 | Windows native-worker/file locks, interrupted transactions and crash recovery produce truthful cleanup-pending state and eventual owned cleanup. Shared assets/profiles are not deleted or killed by another owner's uninstall. |
| AT-38 | Throwing/hung extension callbacks and malformed worker messages cannot crash the DSH host. Adversarial fixtures test actual confinement guarantees; an explicitly approved trusted-code exception must not claim protection from malicious unconstrained native code or bypass generated-Code-Mode confinement. |
| AT-39 | An ordinary MCP client/program cannot install, activate, update, remove packages or change exports. Cross-client metadata, secrets and grants remain isolated after catalog changes. |
| AT-40 | Run the complete independent-author scenario through Native, MCP and hosted composition. Archive the built package, protocol/schema version, Windows/runtime evidence and lifecycle results as release artifacts. |

**Extension completion gate:** the feature is not complete until an independently built npm/URL-installable package can add real tools and skills without modifying Tool Mode; all packages including built-ins can be deactivated; and third-party packages can be removed without breaking the host or other extensions.

## 21. Test-driven development and verification handoff

### 21.1 TDD is required, not a retrospective checklist

**TDD-01. Requirement inventory.** Before production changes, create `verification/requirements.json` mapping every normative ID in this specification to owning modules, test IDs, test layer, required platform, and evidence. Include all AT-01–AT-90. An agent must not edit a requirement or expected outcome to make a failing implementation pass without recording an explicit proposed spec change for review.

**TDD-02. Red.** For each vertical behavior, add a test that asserts observable input/output, authorization, lifecycle or wire behavior. Run it against the current implementation and retain the failure/commit reference. A failure due only to a missing test dependency, wrong import path, broken fixture or no assertions does not establish behavioral red. Regression tests for already implemented behavior may start green and must be identified honestly.

**TDD-03. Green.** Implement the smallest complete behavior that passes the new tests without bypassing the real boundary. Unit tests may fake a clock, network, model output or host broker, but integration tests must call the actual DSH registry, MCP listener, extension manager or packed runtime. Do not substitute a toy runner for the production executor in a purported end-to-end test.

**TDD-04. Refactor.** Refactor only while the requirement tests and relevant regression suite stay green. Keep protocol/schema identities, cancellation, authority and immutable package boundaries intact. Re-run affected packaged/integration tests after moving code across module boundaries; source-only tests do not prove tarball correctness.

**TDD-05. Verification is independent.** A verifier must inspect code paths and run the production artifact. It may be another agent/process or a separate reproducible verification command with independent fixtures. Keep mocked transport tests, reference-model parity, measured inference quality and Windows runtime evidence distinct. A model accepting JSON is not proof of decision quality; a worker process existing is not proof of sandbox confinement.

**TDD-06. No false passes.** Mandatory test statuses are PASS, FAIL, BLOCKED or NOT_RUN. An optional truly inapplicable feature may use NOT_APPLICABLE with a reviewed reason. A required platform/model/API test skipped for missing hardware, credentials or SDK support is BLOCKED/NOT_RUN, never PASS. The release summary exits nonzero while any mandatory gate is not PASS. Deliver useful partial implementation without claiming acceptance.

**TDD-07. Tests must not mutate user state.** Isolate DSH home, grants, caches, packages, extension state, ports and fixtures. Deny ambient production credentials. Explicit live-test secret injection occurs only in its gated suite. Do not run uninstall/preparation against a developer's real package store or scan their personal files.

**TDD-08. Reviewed quality gates.** Create versioned evaluation fixtures before changing adapters/recipes. Distinguish deterministic fixture correctness from statistical quality and report both. No hardcoded expected labels in adapters, thresholds tuned on the held-out answer set, copied vendor latencies, or fabricated measurements. Declare confidence intervals/sample limits where appropriate and keep model artifacts fixed during comparisons.

### 21.2 Additional acceptance tests: AT-41–AT-90

These extend the original 40 tests without removing them. Every row is a release requirement unless explicitly designated optional in its text.

| ID | Required observable evidence |
|---|---|
| AT-41 | EmbeddingGemma 2 is a separate built-in TMX package and the default multimodal selection, not an old EmbeddingGemma or a hidden host adapter. Its six tools share qualified resources and can be toggled independently. |
| AT-42 | Plain built Node code on Windows CPU performs real text, image, audio and video embedding without DOM, browser audio/video APIs, Python, WSL or a compiler. |
| AT-43 | Actual golden embeddings have finite values and correct unit norm/shape at 768/512/256/128; the reduced-dimensional route renormalizes after truncation. |
| AT-44 | Query/document/task templates, ordered interleaved media and exact processor inputs match pinned reference fixtures. No silent flattening or transcription/captioning substitution occurs. |
| AT-45 | Text-only preparation/loading does not download/open unused vision/audio weights. Concurrent text/audio calls share only eligible backbone resources and do not cross-cancel. |
| AT-46 | Real cross-modal positive/distractor fixtures exercise text→image/audio/video and image→text ranking, recording failures as well as successes. |
| AT-47 | Semantic similarity/ranking preserve IDs, stable ties, roles and score kind; incompatible spaces/dimensions are rejected rather than silently compared. |
| AT-48 | Semantic classification returns raw cosine scores and explicit abstention behavior, never fake calibrated probabilities or a mislabeled Laya decision. |
| AT-49 | Deduplication uses the declared representative algorithm, including a nontransitive A/B/C fixture, and does not delete/move source files. |
| AT-50 | Moment finding returns actual clipped source windows/timestamps and bounded window counts; overlapping/final windows, video sampling and missing audio inclusion are represented honestly. |
| AT-51 | Corrupt media, decompression bombs, over-context multimodal input, invalid ranges, excessive frames/windows and decoder cancellation fail safely without hidden downloads. |
| AT-52 | Legacy MiniLM vectors/selected indexes retain their embedding space through upgrade; no automatic 384→768 change or incompatible reuse. |
| AT-53 | Default `decision_choose` uses a real dedicated Laya checkpoint/head through laya-ts ONNX on Windows CPU, with no Qwen/model-chat fallback. |
| AT-54 | Maintainer-export evidence binds Laya source checkpoint, encoder/head/tokenizer/config hashes and numerical parity. The packed consumer requires no Python/export step. |
| AT-55 | Choice mapping, probabilities, abstention, boolean questions and ordinal scores preserve their actual model semantics and original IDs. |
| AT-56 | Reported truncated state and collapsed options are rejected; empty/too-long choices and order permutations have dedicated regression fixtures. |
| AT-57 | Held-out Laya decision metrics and calibration/coverage reports are reproducible, separated from parser/schema tests; optional Jev live status is reported independently. |
| AT-58 | Needle 3 performs real Windows/Node planning and extraction using a pinned WASM or executable artifact, without consumer pip/compile requirements. |
| AT-59 | A multi-intent Needle request returns validated proposals; instrumented target tools prove zero actual execution until a separate approved dispatch. Off-topic/no-match behavior is tested. |
| AT-60 | Needle receives only the authorized frozen schema subset; malicious names, arguments, unavailable tools and returned management/self-recursive calls are rejected. |
| AT-61 | Extraction schema bounds and unsupported grammar constraints are checked; valid JSON with wrong field facts fails the separate quality tests instead of being called correct. |
| AT-62 | Needle requests do not retain another caller's prompt/state; native cancellation, overflow and supported telemetry opt-out are checked with process/network observation. |
| AT-63 | Built-in `describe_image` is an ordinary declarative extension tool callable through DSH Native, MCP and hosted Code Mode, not special host prompt code. |
| AT-64 | A recording fake provider proves real image content/reference reaches the image request path; passing only filename/FileBlock/text placeholder fails the test. |
| AT-65 | Text-only, unknown-capability, inaccessible/offloaded image and unsupported MIME routes fail before a provider request; no silent vision fallback. |
| AT-66 | Native caller-model selection captures the actual calling agent's model generation, not the last global model; concurrent model changes cannot alter an in-flight call's destination. |
| AT-67 | MCP harness execution requires its explicit approved profile. No-profile and cross-client profile access fail without using UI conversation/credentials. |
| AT-68 | Auxiliary requests contain only recipe instructions and supplied bindings, no parent history/system prompt/tools/skills/secrets; side-call results do not mutate the parent dialogue. |
| AT-69 | A model-emitted tool call fails; no nested agent loop or recursive image/composition/management call runs. |
| AT-70 | Refusal, truncation, invalid JSON, missing terminal result, timeout and cancellation remain distinct; approved repair counts against the original attempt/token/deadline budget. |
| AT-71 | Actual usage and model/location appear in bounded receipts; unknown usage is not zero cost. Remote vision/data-transfer grants are checked before upload. |
| AT-72 | Two independently configured live DSH vision routes can execute the same unchanged recipe; evidence identifies adapters/models and compares known image facts. Missing live access remains BLOCKED. |
| AT-73 | A new external author uses the CLI/template to create a typed harness recipe with schemas/skill/tests, pack it and install it without DSH/host source or custom inference code. |
| AT-74 | Recipe npm/HTTPS/local archive paths all remain install-inactive; activation publishes identical tools to DSH/MCP/Code Mode. Disable/deactivate/update/uninstall obey TMX and preserve unrelated packages. |
| AT-75 | Malicious executable templates, unbound pointers, hidden prompt/network code, undeclared profiles, schema violations and recipe-generation identity changes fail validation/approval. |
| AT-76 | `text_title` uses the same generic recipe interpreter; no tool-name special case exists. Mixed semantic-rank→describe-image and STT→decision→title programs execute with accurate subcall accounting. |
| AT-77 | A modern `tools/list`/`tools/call` succeeds as the first request without initialize/session; `server/discover` accurately reports the supported revision/features. |
| AT-78 | Each request independently validates required metadata and unsupported versions/capabilities; a previous valid call does not authorize malformed following requests. |
| AT-79 | Required HTTP headers/body fields and Base64 sentinel names are matched correctly; missing/mismatch/injection cases return the specified error before inference. |
| AT-80 | Every modern result has the correct resultType, valid structured content/output schema and final authorized canonical value; JSON-RPC errors and tool failures remain distinct. |
| AT-81 | `subscriptions/listen` acknowledges first, filters requested authorized events and attaches the right subscription ID; interleaved callers/subscriptions do not leak catalog state. |
| AT-82 | HTTP stream closure and stdio cancellation abort only the corresponding request, including nested model work. The bridge stays alive for other calls. |
| AT-83 | No legacy GET stream, protocol session dependency, standalone server RPC, Last-Event-ID replay, or falsely advertised optional sampling/tasks path is used by the modern implementation. |
| AT-84 | JSON Schema 2020-12, offline refs, bounded dynamic schema validation and private catalog-cache behavior pass independent fixtures. |
| AT-85 | OAuth resource-server metadata, challenges, audience/scopes, token expiry/revocation and protected bridge credentials are tested; a custom static-token profile is not counted as OAuth conformance. |
| AT-86 | A modern SDK client and independent raw/schema probe test the packed server, with sanitized wire traces. Legacy compatibility tests, if offered, are separately labeled. |
| AT-87 | Module TMX 1.0 packages still normalize/run; TMX 1.1 declarative packages require negotiated features and never import an executable entry during install/discovery. |
| AT-88 | Model/recipe/processor and protocol locks are checked for drift; updates use versioned contracts and immutable generations, preserving revocations, old choices and borrowed assets. |
| AT-89 | Required quality/runtime/security test skips produce a nonpassing release summary; red→green→refactor evidence and every numbered requirement have direct test links. |
| AT-90 | Run the full clean-user scenario from published/packed artifacts: prepare defaults, two modern MCP clients, direct and composed tools, custom recipe creation, lifecycle changes, cancellation and complete reproducible evidence. |

### 21.3 Required verification commands

Implement stable package scripts with the following behaviors. Names are requirements for the new implementation; these commands were not executed while writing this document. Equivalent wrappers may be added, but `verify:release` must orchestrate the same gates and use machine-readable exit status.

```sh
npm run verify:static
npm run test:unit
npm run test:contracts
npm run test:extensions
npm run test:recipes
npm run test:integration:dsh
npm run test:mcp:2026-07-28
npm run test:composition
npm run test:models:windows
npm run test:harness:live
npm run test:security:windows
npm run test:packaged:windows
npm run verify:release -- --report ./verification/results/release.json
```

`verify:static` checks types/build/lint, manifest/recipe/tool schemas, requirement references and lock integrity. `test:contracts` tests canonical values and cross-field constraints, not just generated types. Extension tests use registry/HTTPS fixtures and packed archives. DSH tests use the real services. Protocol tests use actual sockets and official message schemas. Windows suites run on Windows, not Linux with `process.platform` mocked. Live tests require explicit prepared models/credentials and record consumption.

### 21.4 Implementing-agent verification checklist

Each checkbox must be backed by evidence; checking it in a Markdown file is not the verification itself.

- [ ] Record starting commit, active DSH/Node versions, OS/CPU/RAM, required dependencies and existing test baseline. Read current upstream APIs before using them.
- [ ] Create the full requirement-to-test map. Add behavioral failing tests for each new feature and retain red-run evidence.
- [ ] Build public TMX 1.1/recipe schemas and test both module and declarative author fixtures without private imports.
- [ ] Verify all built-ins are independent archives; installing/listing them runs no scripts, inference or model downloads.
- [ ] Resolve and approve exact model/engine/tokenizer/processor/license artifacts. Export Laya assets in maintainer CI with parity evidence, not on the consumer.
- [ ] Test Node-native media decoding and real EmbeddingGemma 2 modalities/dimensions on Windows CPU, including selective encoder loads and negative paths.
- [ ] Test real Laya decisions and Needle planning/extraction on Windows CPU; publish separate quality and runtime results.
- [ ] Test real DSH model capability resolution, image input, isolated auxiliary calls and recording policy. Verify the recipe against two qualified vision routes.
- [ ] Test the exact modern MCP wire protocol before running convenience-client demonstrations. Validate headers, metadata, result types, subscriptions and cancellations.
- [ ] Run both local-only and mixed harness-model compositions with instrumented permissions, deadlines, attempts and data destinations.
- [ ] Create a new user recipe from the author template, validate/test/pack/install/activate it, call it through all surfaces, then disable/deactivate/uninstall it safely.
- [ ] Test adversarial files, schemas, workers, source archives, tokens, generated programs and cross-client isolation on the actual Windows sandbox backend.
- [ ] Rebuild and install the exact release tarballs into a clean DSH profile with isolated caches. Repeat end-to-end tests without source symlinks or TypeScript loaders.
- [ ] Compare final receipts and journals with privacy/retention policy. Verify no credentials or unintended parent conversation data leaked.
- [ ] Generate the final machine-readable evidence matrix and fail the release gate for missing/failed mandatory coverage. List unresolved blockers prominently.

### 21.5 Evidence format and handoff artifacts

**TDD-09. Evidence records.** Each result records requirement/test IDs, status, git/package identities, runtime/platform, execution command, fixture/artifact hashes, timestamp, actual observations, and a path to bounded sanitized logs. Red and green runs link to distinct source states where appropriate. Do not store secrets, private user media, or full irrelevant model output. A signed CI artifact may strengthen provenance but does not replace the test itself.

Required repository artifacts:

```text
verification/
  requirements.json                  # all normative IDs -> real tests
  compatibility.json                 # DSH/Node/MCP/OS/provider qualification
  models.lock.json                   # qualification index; extension locks remain canonical
  protocol/2026-07-28/                # pinned source/schema + independent fixtures
  fixtures/                          # licensed, checksum-pinned small test data
  quality-gates.json                 # reviewed before held-out evaluation
  results/                           # generated, sanitized evidence
  VERIFY.md                          # runnable checklist and prerequisites
```

**TDD-10. Release report.** Deliver a summary with installed package identities, model and modality support matrix, MCP conformance matrix, custom-author demonstration, migration effects, measurements, known limitations and unresolved gates. A separate evaluator should be able to reproduce it from a clean checkout plus explicit permitted assets/credentials. Do not present this specification, a compilation pass, or generated example output as evidence that implementation, live inference or Windows verification has occurred.
