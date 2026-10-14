# Adversarial review — slice 3, the OBS work, the live schema validation, the link map

**Reviewer role:** adversarial. The job was to falsify, not to confirm. Every claim below was
attacked first; the mutations were run, in `$env:TEMP`, against copies — no repository file was
modified by the review except this one, and nothing was committed.

## Verdict

**The suite passes, and the newest claim does not survive contact.**

The single most consequential result: **commit `f89e74d`'s headline — "the HOST serves a
declarative package" — is false for every path that exists.** `prepareDeclarative` is correct in
isolation and well tested in isolation, and there is no route from the running host to it:
the shipped declarative package declares `tools: []`, so activating it publishes zero tool
contributions; and if a tool *were* declared, `createDispatch` would type-error before reaching
the recipe, because the object the declarative `providerFor` returns is not a `DispatchProvider`.
Both halves were reproduced (E4, E5 below). No test in the repository passes `harnessProvider`
or drives that branch — the test that used to notice ("the branch is WRITTEN but not REACHED")
was deleted, and the comment justifying the deletion asserts coverage that does not exist.

Secondary but of the same class: **OBS-03's operative refusal is dead code** (no production
caller of `harnessExecutionDecision`, `admitsTool` or `profilePolicy`), **OBS-01's accounting is
built and thrown away** (no production caller of `onAccounted`), and **31 spec requirements with
real implementations are recorded as `NOT_RUN`** (`OBS-*`, `RCP-*`, `HLM-*` have no entry in
`status.json`, and `TRACEABILITY.md`/`FINAL-REPORT.md` are generated from it).

Three of the strongest defects are **false passes proven by mutation**: an empty-string prompt
renderer still passes the test whose comment calls itself "the strongest single piece of evidence
here"; a package containing executable code still passes the "ships no code" install test; and
authorizing every recipe under the first recipe's tool name still passes the whole
`harness-serving` file.

**Finding counts:** false passes **4** · vacuous assertions **6** · claims not supported by code
**8** · spec divergences **8** · attacks that failed (code held) **9**.

**Revision reviewed.** Started at `f89e74d`; the repository advanced *during* the review
(`886dfa6`, `a2a949f`, `929082c`, `ef5a295`) and the subject files were edited under it. Every
finding was re-verified at `ef5a295` and every mutation re-run there. Basis hashes (SHA-256,
first 16): `index.ts 845BC443E23B62AC` · `harness-serving.ts C4C68320E1AB921D` ·
`broker.ts EA263CE099822DDA` · `recipe-format.ts 9B46EF4250CED8A1` ·
`tool-mode.extension.json C3C183375C68B55D` · `gen-final-report.mjs C251728B88FA779B` ·
`status.json 273CDF46A41028BF`. `ef5a295` independently fixed one thing this review had flagged
(a cancellation thrown as an indistinguishable `Error`); that finding is reported as closed.

---

## 1. False passes

Each entry: the claim the test makes, the mutation applied to a copy **outside** the repository,
and what happened when the relevant file was run with `npx tsx --test`.

### F1 — the empty renderer (HIGH)

* `packages/dsh-model-as-tool/tests/declarative-recipes-executable.test.ts:82-96`.

The test is called *"RENDERS a prompt from the file, so the recipe is behaviour and not
metadata"* and its comment says it is *"The strongest single piece of evidence here"*. Its
assertions are:

```ts
const rendered = renderPrompt(parsed.recipe, { text: 'A section about caching', kind: 'section' })
assert.ok(rendered !== null && rendered !== undefined)          // :93  a string is never null
const asText = JSON.stringify(rendered)
assert.ok(asText.length > 0, 'a rendered prompt must not be empty')   // :95
```

**Mutation:** in a copy of the resolved module (`packages/tool-mode-recipes/lib/recipe-format.js`,
`return rendered.join('\n')` → `return ''`; source `src/recipe-format.ts:1117`), make
`renderPrompt` return the empty string.

**Result:** `tests 6 · pass 6 · fail 0`. The mutated module was confirmed live before the run
(`import.meta.resolve` → the mutated copy; `rendered length = 0`). `JSON.stringify('')` is `'""'`,
length **2** > 0 — the assertion named "must not be empty" cannot detect emptiness.

**Not caught:** a broker that sends the model an empty instruction. The recipe would still parse,
still project a schema, still validate inputs; only the behaviour would be gone.

### F2 — one recipe's authorization covers both (MEDIUM)

* `packages/dsh-model-as-tool/tests/harness-serving.test.ts` (whole file; invocations at `:79`,
  `:91`, `:138`, `:181`).

`prepareDeclarative` authorizes **per recipe** (`harness-serving.ts:126-128`) and the module says
so: *"AUTHORIZATION IS PER TOOL NAME … A recipe whose name was never authorized must not become
callable."* The file serves **two** recipes (`text_title`, `describe_image`) and invokes **only
`text_title`** — by name (`:77-79`) and as `served[0]` (`:91`, `:138`, `:181`).

**Mutation:** authorize every entry under the **first** recipe's tool name
(`broker.authorize((resolved[0]?.recipe as RecipeManifest).tool.name, composition.provider)`).
`describe_image` then has no grant and its `invoke` fails `EXECUTOR_NOT_CONFIGURED`.

**Result:** `tests 7 · pass 7 · fail 0`.

**Not caught:** the second served recipe being uncallable, mis-authorized, or wired to the wrong
provider generation. A package's *second* tool is not covered by any test in the repository.

### F3 — "ships no code" cannot see `src/` (MEDIUM)

* `packages/dsh-model-as-tool/tests/declarative-install.test.ts:97-107`, with the helper at
  `:43-52`.

The test asserts `shipped.includes('src/index.ts') === false` (`:104-106`), but `shipped` is built
by `filesUnder()`, which **skips `src` and `tests` before archiving**:

```ts
for (const entry of readdirSync(current)) {
  if (entry === 'node_modules' || entry === 'src' || entry === 'tests') continue
```

**Mutation:** add a real `src/index.ts` to a copy of the package and point the test at it.

**Result:** `tests 4 · pass 4 · fail 0`. The `src/index.ts` clause is unreachable by
construction — the test builds the archive with a filter that removes the very entry it then
asserts is absent. (`lib/index.js` and `dist/index.js` *are* catchable; only the `src` clause is
inert.)

### F4 — "an operator can SELECT the metadata-only profile" asserts a string (HIGH)

* `packages/dsh-model-as-tool/tests/diagnostics.test.ts:232-239`.

```ts
const ctx = await mountPlugin({ captureProfile: 'metadata-only' })
const capture = (result.value as { capture?: { profile: string } }).capture
assert.equal(capture?.profile, 'metadata-only')
```

**Mutation:** delete the enforcement — `harnessExecutionDecision`, `profilePolicy` and
`admitsTool` are already called by nothing but tests (§3, C5), so there is nothing to delete at
integration level. The test still passes, because it asserts the **echo** of a configuration
string.

**Not caught:** the profile being a label with no effect on what the deployment will serve. The
test's own comment claims the surface "confirms which one is in force rather than leaving an
operator to infer it from behaviour" — there is no behaviour to infer it from.

---

## 2. Vacuous assertions

| # | Location | Assertion | Why it cannot fail |
| --- | --- | --- | --- |
| V1 | `declarative-recipes-executable.test.ts:77`, `:93` | `assert.ok(schema !== null && typeof schema === 'object')`, `assert.ok(rendered !== null && rendered !== undefined)` | `inputSchemaFor` returns an object literal (`recipe-format.ts:1139-1167`); `renderPrompt` returns `rendered.join('\n')`, always a string. Neither can be null/undefined. |
| V2 | `declarative-recipe-runs.test.ts:122-126` | `void provider` … `assert.equal(seen.length, 0, 'and the provider must never be reached')` | `provider` is never given to the broker (no `authorize` call in that test), so `seen` cannot be appended to. The assertion is guaranteed by construction, and the `void provider` local is the tell. |
| V3 | `diagnostics.test.ts:181`, `:184-185` | `assert.ok(report.platform !== undefined)`, `assert.ok(Array.isArray(mcp.exportedTools))`, `assert.ok(Array.isArray(mcp.withheldTools))` | `buildDiagnostics` returns `inputs.platform` and spreads the two arrays (`diagnostics.ts:137-145`); the builder cannot produce anything else. |
| V4 | `packages/extension-declarative-recipes/tests/manifest.test.ts:68-83` | *"points at recipes that EXIST and parse"* — `assert.ok(Object.keys(parsed).length > 0)` | Satisfied by any non-empty JSON (`{"junk":1}` passes). It also iterates the **directory**, not the manifest's declared implementations. The substance is covered by the DECL-01 test at `:199-232`, so this one is merely decorative — but it is named as evidence. |
| V5 | `declarative-install.test.ts:132` | `assert.ok(entry.recipe !== null && typeof entry.recipe === 'object')` | `JSON.parse` of any JSON object or array satisfies it. |
| V6 | `capture-path.test.ts:68-80` | *"every surface this plugin DOES write is metadata"*, asserted by `assert.doesNotMatch(surface.contents, /request or response (body\|bodies)\|the prompt\|the arguments/i)` | It is a regex over **prose**. The auxiliary-call journal's own record carries `prompt: string` — "The EXACT prepared prompt" (`broker.ts:287`) — so the claim the test names is false while the assertion passes, because the description does not happen to contain the phrase "the prompt". |

---

## 3. Claims the code does not support

### C1 — "the HOST serves a declarative package" (HIGH) — reproduced twice

Sources of the claim: `src/harness-serving.ts` module doc ("THE LAST LINK OF SLICE 3 … this is
where a resolved RECIPE becomes a callable TOOL"), commit `f89e74d`, and
`tests/extension-dispatch.test.ts:189-208`.

**(a) The package declares no tools, so nothing is ever served.** Driving the **real** installer
and the **real** lifecycle on the shipped package:

```
installed: @try-works/extension-declarative-recipes inactive
activation state: active generation 2
diagnostics: []
contributions PUBLISHED: ["…:implementation:text-title","…:implementation:describe-image"]
manifest.tools = []
recipes resolved = true text-title,describe-image
dispatch for text_title:   not-declared — text_title is not declared by this extension's manifest
dispatch for describe_image: not-declared — describe_image is not declared by this extension's manifest
```

The lifecycle publishes contributions from `manifest.tools` / `implementations` / `skills`
(`lifecycle.ts:463-479`). The shipped manifest has `"tools": []`
(`tool-mode.extension.json:30`). `extension-registrar.ts:154-159` maps an `implementation`
contribution to `dispose = () => {}` — deliberately, with the comment "An `implementation` is not
a caller-facing tool". So activation registers **zero** tools. `providerFor` — the only caller of
`prepareDeclarative` — is reached only from `createDispatch.execute` (`index.ts:1384`), which is
created only for a registered tool name, and `resolveImplementation` refuses with `not-declared`
first (`extension-dispatch.ts:83-93`).

**(b) If a tool were declared, the first call would type-error.** `index.ts:1332-1340` returns:

```ts
return { async createProvider() { return { async invoke(args) { return served.served[0]?.invoke(args) } } } } as never
```

but `providerFor` must resolve to a `DispatchProvider`, and `createDispatch.execute` calls
`await provider.load({…})` (`extension-dispatch.ts:149`). Reproducing that exact shape against the
real `createDispatch`:

```
dispatch.ok = true
THREW: TypeError: provider.load is not a function
```

The module branch two lines below returns `instance.createProvider({ modelId, configuration: {} })`
(`index.ts:1352`) — the correct shape. The declarative branch returns an *instance*, not a
*provider*.

**And no test can notice:** `harnessProvider` appears only in `index.ts:200/1322` and in no test;
`prepareDeclarative` appears only in `harness-serving.test.ts`, which calls it directly. The
coverage claim in `extension-dispatch.test.ts:189-208` — that the branch "is DRIVEN by six tests in
`harness-serving.test.ts`" and that "the declarative chain is DRIVEN end to end in
`declarative-install.test.ts` … and `declarative-recipe-runs.test.ts`" — is wrong on all three
counts: those six tests never enter the host; `declarative-install.test.ts:9-11` says of itself
"The remaining link — the host's `providerFor` reaching a composed broker — is not driven here and
is not claimed to be"; and `declarative-recipe-runs.test.ts` assembles the broker itself. The
deleted test was the only thing that measured "written but not reached", and the code is back in
exactly that state.

### C2 — the first recipe answers for all of them (HIGH)

`index.ts:1336`: `return served.served[0]?.invoke(args)`. The `implementationId` the dispatch layer
carefully resolved (`extension-dispatch.ts:151`) is discarded. For a declarative package with more
than one implementation — the array exists precisely to allow that (RCP-01, EXT-05) — every tool
executes the **first** recipe, and for this package `describe_image` would be served by the
`text_title` recipe (which also declares `imageInputs.max: 0`). No test covers it (F2).

### C3 — OBS-01 accounting is computed and discarded (MEDIUM-HIGH)

`accountInvocation` is called at `mcp/host-binding.ts:192` and `:203` — through
`options.onAccounted?.()`. `onAccounted` is optional (`:124`) and **no production caller supplies
it**: the only occurrences in the repository are those two call sites. The host's composition,
`index.ts:420-451`, passes `serverInfo`, `surface` and `onWithheld` — no `onAccounted`, no
`engineVersion` (so every record would say `engineVersion: 'unknown'`). OBS-01 asks to "Record
lightweight receipts … queue/load/inference/total time, cancellation/failure class, and sizes".
The record is built for every external call and dropped. No test asserts that a record reaches
anything.

### C4 — OBS-03's refusal has no caller (HIGH)

`docs/tool-mode/specs/Tool_Mode_DSH_Implementation_Spec_v1.2.md:650` (OBS-03): *"If an operator's
no-retention policy cannot be honored together with that DSH contract, **refuse harness-backed
execution in that profile** rather than silently logging bodies or bypassing DSH."*

`diagnostics.ts:198-211` (`harnessExecutionDecision`), `capture-path.ts:154-188` (`profilePolicy`)
and `capture-path.ts:198-219` (`admitsTool`) implement exactly that decision — and each is called
**only from tests**. `config.captureProfile` is read in exactly one place in the host,
`index.ts:1016`, where its value is copied into the diagnostics report as a string. There is no
branch on it anywhere. A deployment configured `metadata-only` will serve harness-backed tools.

`capture-path.ts:19` states the arrangement as fact: *"`harnessExecutionDecision` in
`diagnostics.ts` makes that decision; this module says which profile it applies to."* That is a
description of intent, not of wiring.

### C5 — `FINAL-REPORT.md` contradicts `npm run verify:mcp:live` (MEDIUM)

`verification/FINAL-REPORT.md:21`: *"**This is not live server conformance**: the probe reads
frozen files from disk and never starts the server … Live conformance against the running server
is not yet demonstrated."*

At the reviewed revision `npm run verify:mcp:live` starts a real HTTP server on a real socket,
makes real requests and validates every response body with Ajv against the pinned schema:
`tests 12 · pass 12 · fail 0`, including `server/discover`, `tools/list`, a real `tools/call`,
`-32020`, `-32021`, `-32022`, `-32601`, `-32602`, `-32700`, the 413 body, a tool-error result and
a 202 notification. It is wired into `verify:mcp` (`package.json`).

The sentence is **hardcoded** in the generator (`scripts/gen-final-report.mjs:114`), so
regenerating the report cannot correct it, and no gate checks `FINAL-REPORT.md`
(`verify:verification` checks `verification/requirements.json`). This is an understatement, not an
over-claim — but it is a false statement in a document whose whole purpose is to be trusted.

### C6 — 31 requirements with implementations are recorded `NOT_RUN` (HIGH)

`docs/tool-mode/status.json` has **117** entries and **zero** in `OBS`, `RCP` or `HLM`:

```
families: ARCH 6, BASE 6, DEC 2, DECL 8, EXT 21, LIC 4, MCP 11, MODEL 6, NDL 1,
          P26 17, RES 10, RUN 8, SEC 4, TDD 4, TOOL 6, AT 3
OBS=0  RCP=0  HLM=0
```

The file's own rule: *"Anything absent here is reported as NOT_RUN."* Consequently
`TRACEABILITY.md:206-210` and `:257-270` and `:276-287` render **all five OBS, all fourteen HLM
and all twelve RCP requirements as `NOT_RUN`, evidence "—"**, and `FINAL-REPORT.md:100` states
*"provider-neutral LLM broker and recipe interpreter (HLM, RCP) — 26 unstarted requirements"* —
while `packages/tool-mode-recipes` (broker, recipe format, two shipped recipes), `capture-path.ts`,
`diagnostics.ts`, `invocation-accounting.ts` and `harness-serving.ts` all exist with tests.

The reconciliation two rounds ago (`a6b79fe`, *"six invisible requirements"*) fixed exactly this
defect for `P26` and left it in place for the three families that are the recent work. The
mechanism it named — "a traceability generator renders an absent requirement as NOT_RUN, so six
requirements with live coverage read as untouched" — still applies to 31 requirements.

Two further record defects inside the same file:

* **`P26-13` is stale and self-contradicting.** Its evidence says *"no live response is currently
  Ajv-validated against the pinned definitions end to end — the gap that let the `-32021` data
  shape through."* `mcp-live-schema.test.ts` closes precisely that gap and passes 12/12. The same
  file's `MCP-01` says *"every message the server sends is now validated against the pinned
  definitions by Ajv"*. The two sentences cannot both be read as the current state.
* **`P26-03`'s PARTIAL reason** ("the version-error data shape is asserted against the pinned
  definitions only by the unit suite, not yet by a live fixture") is at best imprecise:
  `mcp-live-schema.test.ts:289-310` validates the live version-error body against
  `UnsupportedProtocolVersionError`/`HeaderMismatchError`. (The test accepts either code, so if the
  server answers `-32020` the `-32022` *data* shape is indeed not live-covered — see §6.)

### C7 — "Everything this plugin writes is metadata" (MEDIUM)

`capture-path.ts:129-134` and `writesBodies: false` (`:145`, returned for both profiles) assert
that no body is written by this plugin. The auxiliary-call journal it lists as its own surface
(`:91-101`) holds `prompt: string`, documented in `broker.ts:286-287` as *"The EXACT prepared
prompt (HLM-09: the model-visible input must be reconstructable)"*. A model-visible input is a
body. The claim survives only because the test that would check it reads prose (V6).

### C8 — the host's journal is a debug log line (MEDIUM)

`index.ts:1323`: `journal: record => ctx.logger?.debug?.('harness invocation', record as never)`.
The record — including the exact prepared prompt — goes to the host's general debug logger, with
no receipt association, no isolation and no access control. `harness-serving.ts:40-45` and
`capture-path.ts:96-100` present this sink as the thing that makes a harness run auditable
("a harness-backed run that records nothing cannot exist"). A sink exists; nothing about HLM-09's
*"isolated, access-controlled auxiliary-call journal **associated with the receipt**"* is
implemented (see §6 for what I could not determine about DSH's logger).

---

## 4. Spec divergences

Specification text is quoted from `docs/tool-mode/specs/Tool_Mode_DSH_Implementation_Spec_v1.2.md`
and `…/Tool_Mode_Extension_Protocol_v1.1.md`. Each probe was run against the real validator.

### S1 — the required-feature id is invented, and the spec's is refused (HIGH)

* **RCP-01** (DSH spec `:1419`, repeated in the protocol spec `:460`): *"Extend TMX with
  `execution.kind: "declarative"`, required feature **`harness-model-recipes-v1`**, and static
  recipe implementations."* The spec's own example manifest uses it (`:1432`).
* **Code:** `KNOWN_FEATURES` is `['provider-worker-v1','verified-assets-v1','declarative-recipes-v1','harness-executors-v1']`
  (`manifest.ts:28-33`); the shipped package declares `["declarative-recipes-v1"]`
  (`tool-mode.extension.json:16`).
* **Probe, against the real `validateManifest`:**

  ```
  A. base with requiredFeatures ["harness-model-recipes-v1"]      : REFUSED — the host does not provide required feature(s): harness-model-recipes-v1
  E. base with requiredFeatures ["declarative-recipes-v1"]        : ACCEPTED
  ```

  A package written to RCP-01's text cannot activate on this host; a package written to this
  repository's invented name can. `EXT-16` says unknown required features remain errors — which is
  why the wrong name is not cosmetic.

### S2 — "a manifest cannot name its recipe files" is a property of this repository's own schema (HIGH)

* `src/declarative-recipes.ts:3-24` builds the entire recipe-location convention on this premise:
  *"The pinned manifest schema's `implementations` items permit only `id`, `contractId`,
  `contractVersion`, `modelId` and `recipeVersion`, with `additionalProperties: false` — so **a
  manifest cannot name its recipe files**. There is no path field to read."* The same claim is
  repeated at `manifest.test.ts:68-76`. "Pinned" reads as "given".
* **The spec's own declarative manifest** (DSH spec `:1456-1465`) contains exactly that path
  field, plus an execution kind:

  ```json
  "implementations": [
    { "id": "review-harness", "kind": "harness-model", "contractId": "…",
      "contractVersion": "1.0.0", "recipeVersion": "1.0.0",
      "recipe": "./recipes/review.json" }
  ]
  ```

  and the spec states of the package: *"The package exports `./tool-mode.extension.json`,
  `./recipes/review.json`, and `./package.json`"* (`:1478`).
* The schema that forbids it is authored in this repository
  (`packages/tool-mode-extension-sdk/schema/extension-manifest-1.1.0.schema.json:171-185`).
* **Probe:**

  ```
  B. + implementations[0].recipe (spec line 1463)        : REFUSED — /implementations/0 must NOT have additional properties
  C. + implementations[0].kind: "harness-model" (:1459)  : REFUSED — /implementations/0 must NOT have additional properties
  D. + permissions.harnessModel (spec line 1442)         : REFUSED — /permissions must NOT have additional properties
  ```

So a spec-conformant declarative package is refused on three independent grounds, and the
by-convention resolver exists to work around a restriction this repository imposed on itself.
(The convention is defensible engineering; presenting it as a spec constraint is not.)

### S3 — `policy.allowRemote` is inert (HIGH)

* **RCP-05** (`:1512`): *"Authors choose required capabilities and a selection strategy, not
  credentials or global provider access … An ordinary tool caller cannot … widen profiles."*
* **RCP-10** (`:1534`): *"Describe supported executor capabilities, **actual local/remote
  possibilities**…"*
* **Code:** `RepoPolicy.allowRemote` is parsed and frozen (`recipe-format.ts:194-199`, `:796-797`)
  and then consulted in exactly one place — a **string** in `describeRecipe`
  (`recipe-format.ts:1199`). `broker.ts` contains no reference to it; the destination check reads
  the **host** policy only (`broker.ts:716`).
* **Probe** (a real recipe with `policy.allowRemote: false`, through the real broker, with a remote
  provider and the default host policy):

  ```
  recipe.policy = {"record":true,"allowRemote":false}
  outcome = completed | provider calls = 1
  journal destinations = "remote"
  ```

  and the description handed to callers says:

  ```
  Destinations: local only, by the recipe.
  ```

  **The declaration is inert and the description states the opposite of what happened.** A recipe
  author's egress restriction is not enforced, and a caller deciding whether to send sensitive text
  is told "local only" while the text goes remote. HLM-08 requires the data destination policy to
  be checked *before media bytes leave the host*, and RCP-11's vocabulary has no distinct error for
  "the recipe forbade this destination" — so there is no code path that could refuse.

### S4 — RCP-02's validation is never applied to a served recipe, and the refusal branch is dead (HIGH)

* **RCP-02** (`:1480`): *"Publish **and validate** the following recipe vocabulary as
  `harness-model-recipe.schema.json`."* No such file exists in the repository.
* **`parseRecipe` has no production caller**: in `packages/dsh-model-as-tool` it is imported only by
  three test files. `prepareDeclarative` casts `entry.recipe as RecipeManifest` and reads
  `recipe.tool.name` (`harness-serving.ts:126`). `resolveDeclarativeRecipe` accepts any
  `JSON.parse`-able file (`declarative-recipes.ts:80-89`).
* **Probe** (`prepareDeclarative` with malformed recipes, real code):

  ```
  recipe = {} (no tool)      : THREW TypeError: Cannot read properties of undefined (reading 'name')
  recipe = null              : THREW TypeError: Cannot read properties of null (reading 'tool')
  recipe = a string          : THREW TypeError: Cannot read properties of undefined (reading 'name')
  recipe.tool = {} (no name) : returned {"ok":true,"served":[{"implementationId":"x","contractId":"text.title"}]}
  ```

  Three findings in one probe: (a) the function throws raw `TypeError`s instead of returning its
  declared `ServeOutcome`; (b) a recipe with **no tool name** is reported as successfully served
  (`toolName === undefined`); (c) the `recipe-rejected` outcome (`harness-serving.ts:87`, `:132`) is
  **unreachable** — `HarnessBroker.authorize` cannot throw (`broker.ts:527-531` is a `Map.set`), so
  the `try/catch` around it is dead, and authorization is self-issued from whatever name the recipe
  claims. `prepareDeclarative` cannot refuse a recipe for any reason except the absence of a
  provider.

### S5 — the recipe format is not the spec's recipe format (MEDIUM)

* **RCP-03** (`:1508`): *"Input pointers are validated JSON Pointers into the detached,
  schema-validated argument object."* The implementation uses a **name-keyed map** and documents
  the substitution (`recipe-format.ts:31-35`). A recipe written to the spec's vocabulary
  (`inputBindings: [{kind:'image', pointer:'/image_path', …}]`, `instructions`, `modelSelection`,
  `limits`, `context` — DSH spec `:1482-1506`) is refused here as unknown keys: `RECIPE_TOP_LEVEL_KEYS`
  (`recipe-format.ts:54-64`) admits nine different names and `additionalProperties` is closed.
* **RCP-04** (`:1510`) requires response modes (`text` mapped to a named payload field; `json`
  mapped to a declared payload schema). No response-mode field exists in the format; the broker
  returns the completion's raw text (`broker.ts:872-891`), so `text_title`'s "reply with ONE JSON
  object" instruction is **not** validated as JSON anywhere, and no payload schema is declared or
  enforced.
* **RCP-01** says a recipe-only package "must still have tools, schemas, skills, permissions,
  version/digest and independent lifecycle". The shipped package declares `"tools": []` and
  `"skills": []` and ships no schemas.
* **RCP-12** (`:1538`) says `text_title`'s "recipe and examples live in `tool-mode-harness-text`".
  The repository's recipes live in `@try-works/extension-declarative-recipes`, a package the spec
  does not name; the spec's package (`Tool_Mode_Extension_Protocol_v1.1.md:68`, DSH spec `:295`)
  is absent. The broker itself is generic — the `if tool === text_title` prohibition is honoured.

### S6 — EXT-13's exports requirement was dropped rather than satisfied (LOW-MEDIUM)

**EXT-13** (protocol spec `:107`): *"Require `package.json` with `name`, `version`,
`type: "module"`, the `toolMode` discovery field below, **and explicit public exports** … A
**declarative** extension instead **exports its static recipe files** and MUST NOT require an
executable entry or install-time code."*

The repository removed the exports requirement for declarative packages
(`manifest.test.ts:130-149`, whose comment says such a package "has no entry points to export"),
and the shipped package declares no `exports` field (`package.json`). The spec's sentence says a
declarative package *does* export its static recipe files; and its own example package "exports
`./tool-mode.extension.json`, `./recipes/review.json`, and `./package.json`" (`:1478`). The change
is defensible as a fix for a false blocker, but it widens acceptance beyond what EXT-13 asks for
rather than implementing it.

### S7 — the manifest schema requires fields the spec's core shape omits (LOW; reported as observed)

`extension-manifest-1.1.0.schema.json:8` requires `activation` and `runtimeApi`; the protocol
spec's `EXT-14` "core required shape" example (`:136`ff) contains neither, and neither identifier
appears anywhere in that spec file. I did **not** establish whether some other part of the spec
mandates them, so this is recorded as an observation rather than a divergence.

---

## 5. Attacks that failed (the code held)

Reported because a review that finds only problems is not evidence of effort.

1. **Obtain an unauthorized served recipe** — `prepareDeclarative` cannot be made to serve a
   recipe it refuses: with no provider it returns `no-provider` (`harness-serving.ts:105-112`),
   and the refusal is at preparation, not at the first call (asserted by two tests).
2. **Bypass the journal** — `new HarnessBroker({})` **throws**: *"the host policy requires
   recording (HLM-09) but no journal sink was provided."* A `composition` without a journal does
   not reach the broker through the type either. The structural half of HLM-09 holds.
3. **Journal failure after billing** — a sink that throws produced
   `failed RECORDING_FAILED` with **0 provider calls**: the refusal happens before dispatch, as
   claimed.
4. **Get a non-completed outcome back as a value** — empty text, a tool call and a truncation each
   **throw** through `prepareDeclarative`, with distinct codes (`INVALID_MODEL_OUTPUT`,
   `UNEXPECTED_MODEL_TOOL_CALL`, `MODEL_OUTPUT_TRUNCATED`). Cancellation is now its own
   `HarnessCancelledError` (`ef5a295`) — an earlier version threw it as an indistinguishable
   `Error`, which this review had flagged; that is closed.
5. **Escape the recipe path** — `resolveDeclarativeRecipe` re-checks the id against
   `^[a-z][a-z0-9-]*$` before building the path (`declarative-recipes.ts:56-63`), so `../`,
   absolute paths and separator injection are refused. The traversal attack did not get through.
   (The *content* of the file is unvalidated — that is S4, not an escape.)
6. **`-32021`'s value type** — checked against the pinned schema, not the prose:
   `MissingRequiredClientCapabilityError.error.data.requiredCapabilities` is `required` and is a
   `$ref` to `ClientCapabilities`, an **object**. The old `data.unsupported` shape fails Ajv, so
   `mcp-live-schema.test.ts:267-283` is a genuine regression guard, and the assertion on the object
   (not an array) is correct.
7. **The non-uniform error definitions** — the live test derives bare-error-object vs envelope
   from the schema (`mcp-live-schema.test.ts:80-87`); the split is correct
   (`MethodNotFoundError` has no `jsonrpc`; the three `-320xx` definitions do), and the
   `-32020`/`-32021`/`-32022` bodies are validated against their **specific** definitions rather
   than the generic `JSONRPCErrorResponse`. This is real work and it is right.
8. **The live MCP suite is not live** — it is: real `startHttpServer`, real `fetch`, real socket,
   Ajv against the pinned schema, 12/12 passing, including the 413 body (status 413, `id` absent,
   conforms to `InvalidRequestError`) and a 202 notification.
9. **The host's journal sink is a silent no-op** — `ctx.logger.debug` **exists** on a mounted DSH
   context (`typeof logger.debug === 'function'`), so `ctx.logger?.debug?.(…)` does dispatch. The
   attack failed; the record does reach a logger (see C8 for what that logger is).
10. **The workspace link map is incomplete** — `WORKSPACE` lists all 8 publishable packages under
    `packages/` (the 9th directory is the host itself, excluded deliberately with a stated reason
    at `link-dsh.mjs:136-140`), `PEERS` has 22 entries, and the 8 `@try-works/*` junctions and 22
    peer junctions exist in `node_modules`. The map is complete. The remaining defect is small and
    is a finding rather than a breach: `link()` warns and skips a missing target, and the
    fail-fast check covers **only** the peer half (`link-dsh.mjs:142-145`), so
    `npm run link:dsh` exits 0 with 7/8 workspace links — the same silent omission that produced
    the original defect, from which the suite then fails with a misleading
    `ERR_MODULE_NOT_FOUND`.

---

## 6. What I could not determine

* **Whether DSH's `logger.debug` output is retained, isolated and access-controlled.** I confirmed
  the sink dispatches and that the record carries the exact prompt. I could not determine whether
  DSH's debug log is a supported recording API with retention guarantees, so I report C8 as "no
  receipt association and no isolation attempted by this plugin" rather than "HLM-09 is
  unimplemented".
* **Whether `harnessProvider` can be supplied by a real deployment.** It is a function-valued
  option. Schemastery preserved an undeclared string key (`captureProfile`) in the mounted config,
  which suggests unknown keys survive, but I did not exercise a YAML/JSON config load, and a
  function cannot come from a config file. The option may therefore be reachable only from
  programmatic composition; I did not establish which the design intends.
* **Whether the server answers `-32022` or `-32020` to a bad protocol version.** The live test
  accepts either, so I cannot say whether P26-03's "version-error data shape is not live-asserted"
  is false or merely fragile.
* **Whether some spec section mandates `activation`/`runtimeApi`** (S7). I searched the two spec
  files for the identifiers and found none in either; that is not proof of absence from the
  checklist document.
* **The full suite.** I ran the in-scope test files, `verify:mcp:live`, and every mutation listed
  above; I did not run `npm test` or `npm run verify` end to end, so I make no claim about total
  counts, and I did not exercise the recipe package's own tests beyond what the mutations touched.
* **Impact of F2 in practice.** Because of C1 no tool is registered for the declarative package at
  all, so the second-recipe authorization gap is currently unreachable in production. It becomes
  live the moment C1 is fixed, which is why it is reported now.

## 7. Suggested repair order

1. **C1** — decide what "the host serves a declarative package" means: either declare the package's
   tools in its manifest (with the schema/tool fields RCP-01 requires) and fix the
   `providerFor` return shape, or withdraw the claim. Until then, delete the coverage comment at
   `extension-dispatch.test.ts:189-208`, which is the reason the regression is invisible.
2. **S1/S2/S3** — reconcile the schema and the feature id with the spec text, or record the
   deviations as deviations in `status.json` where a reader will see them.
3. **S4** — call `parseRecipe` on the serving path and make `recipe-rejected` reachable; add a
   recipe schema file if RCP-02's name is to be honoured.
4. **C4/C3** — wire `profilePolicy`/`admitsTool` into serving and pass `onAccounted`/`engineVersion`
   from `index.ts:420`, or record both as not-implemented.
5. **C6** — add `OBS-*`, `RCP-*` and `HLM-*` entries (the generators already map them), and correct
   `P26-13`; regenerate `FINAL-REPORT.md` and fix the hardcoded sentence at
   `scripts/gen-final-report.mjs:114`.
6. **F1/F3/F4/V1/V2/V6** — the mutations above are the acceptance tests: each must go red before the
   corresponding test can be called evidence.

---

# APPENDIX — independent narrow re-review of `harness-serving.ts` + its test

*Appended by a second adversarial reviewer whose brief was the two files only. It did not overwrite
the review above; it is a separate pass over the same revision (`harness-serving.ts`
sha256 `C4C68320E1AB921D…`, `tests/harness-serving.test.ts` sha256 `6FD69228…38C7`), run blind to
the sections above, with throwaway probes in `E:\tmp` and real mutations against a frozen copy.
Where it agrees with §1–§5 that is independent corroboration; IDs are prefixed `S3-` because the
peer's `F1..F4` are different findings. Both files were **edited under both reviews**: an earlier
revision threw a generic `Error` for `failed` and `cancelled` and named `LlmCompletion` variants in a
comment. Every result below is from the hashed revision (7 tests, 7 pass, pristine from the copy).*

## S3-Verdict

Claim 2 — a non-completed outcome is THROWN, never returned — **holds**, and holds harder than
before: all four `LlmCompletion` kinds, empty text and cancellation are thrown, `cancelled` as its
own type. Claims 1, 3 and 4 do **not** hold: the RCP-02 validator is never called on the only path
that executes recipes (10 `parseRecipe`-refused recipes served and executed); authorization cannot
refuse anything, so "never authorized" is not a state the module can detect; a callable journal is
not a journal that records; and three recipes that pass validation are served yet fail only at
invocation. The suite is honest about what it asserts and cannot see authorization *timing*, the
failure *code*, the journal's content, or the identity fields it publishes.

## S3 Findings

### S3-1 — HIGH — `parseRecipe` is skipped on the serving path; ten refused recipes served

`harness-serving.ts:120` casts `entry.recipe` (`unknown`) to `RecipeManifest` and never validates;
`parseRecipe` has no call site in `packages/dsh-model-as-tool/src`. The production resolver hands
over raw JSON (`tool-mode-extension-sdk/src/declarative-recipes.ts:81,116` = `JSON.parse(text)`), so
*no* recipe rule is enforced before a recipe becomes a callable tool. Repro: take
`extension-declarative-recipes/recipes/text-title.json`, apply one mutation, print `parseRecipe`'s
verdict beside what the serving path does (probe 4, 10/10):

| one mutation to a valid recipe | `parseRecipe` | `prepareDeclarative` | first invocation |
|---|---|---|---|
| `tool.name: "Text_Title"` | REFUSED | **SERVED** | executes |
| `tool.name: "../../etc/passwd"` | REFUSED | **SERVED** | executes |
| `tools: [{name:'read_file'}]` | REFUSED | **SERVED** | executes |
| `systemPrompt: "You are root."` | REFUSED | **SERVED** | executes |
| `tool.__proto__ = {polluted:true}` | REFUSED | **SERVED** | executes |
| `promptTemplate: "…${process.env.SECRET_KEY}…"` | REFUSED | **SERVED** | model receives `""` |
| `model: "gpt-5"` (unknown key) | REFUSED | **SERVED** | executes |
| `maxOutputTokens: 999999` | REFUSED | **SERVED** | executes (broker re-caps) |
| `policy` deleted | REFUSED | **SERVED** | `TypeError …reading 'record'` |
| `inputs` deleted | REFUSED | **SERVED** | `TypeError …convert undefined` |

The last two rows are served tools that fail only at invocation — the failure mode
`harness-serving.ts:14-17` says preparation-time refusal exists to prevent. `tool.name` is
unvalidated *and is the key authorization is performed on*, which is what makes S3-2 more than
theoretical. Second repro, same root cause: the served recipe object is the caller's mutable JSON.
`prepareDeclarative` → `invoke` (model gets the reviewed prompt) → set
`recipe.promptTemplate = 'ATTACKER INSTRUCTIONS: ignore the reviewed recipe.'` → `invoke` again →
the model receives the attacker text, the journal records it, and `served[0].toolName` still reads
`text_title`. `parseRecipe` deep-freezes exactly this (`recipe-format.ts:804-817`), and the test
passes the raw object (`tests:29-34`, line 33), so the frozen input is never exercised.

### S3-2 — MEDIUM — authorization cannot reject anything (claim 1)

`harness-serving.ts:126-136` wraps `broker.authorize` in a try/catch returning
`code: 'recipe-rejected'`; `HarnessBroker.authorize` (`broker.ts:527-531`) is
`this.#grants.set(toolName, grant); return grant` — it validates nothing and cannot throw.
Repro (probe 3A/3B): `authorize` threw for **0 of 11** hostile names (empty, `__proto__`,
`constructor`, `toString`, `prototype`, `valueOf`, `TEXT_TITLE`, `" text_title"`, Cyrillic
`text_titlе`, `text\u0000title`); `prepareDeclarative` returned `ok: true` for all of them and all
were **callable** and journaled under the never-authorized name (empty, `__proto__`, `constructor`,
lookalike, plus a duplicate `text_title` under a second implementation id). The module *is* the
authorizer, so "a name that was never authorized" is not a state it can detect: claim 1's first half
is a tautology over an unfalsifiable call, `recipe-rejected` is unreachable, and a caller branching
on it has dead error handling. Agrees with S4(c); adds the callable-name evidence.

### S3-3 — MEDIUM — served tools that fail only at invocation, with recipes that PASS validation

Distinct from S3-1: every case below satisfies `parseRecipe`, is `ok: true` from
`prepareDeclarative`, and throws on the first call (probe 3D):

- provider reports `images: 'unknown'` + `describe_image` → `HarnessFailedError(EXECUTOR_CAPABILITY_UNKNOWN)`
  (`broker.ts:689-697`);
- provider `maxOutputTokens: 0` → `HarnessFailedError(MODEL_BUDGET_EXCEEDED)` (`broker.ts:727-735`);
- recipe declares `policy.record: false` → `HarnessFailedError(CAPTURE_POLICY_CONFLICT)`
  (`broker.ts:744-752`).

The third is decidable at preparation from `broker.policy.requireRecording`, and the module already
holds the broker. The test named "refuses at PREPARATION, not at the first call" (`tests:111-116`)
covers only the no-provider case, so its name claims more than its evidence. This is where §5.1's
"obtain an unauthorized served recipe — the code held" needs qualifying: the code holds for the
*no-provider* route, not for these.

### S3-4 — MEDIUM — a journal *function* is required, not a journal that records (claim 3)

`HarnessComposition.journal` is a callable (`harness-serving.ts:45`) and the broker's check
(`broker.ts:505-510`) requires only that the sink is not `undefined`. `journal: () => {}` → serve ok,
invoke returns `"A served title"`, sink called once, **zero durable bytes** (probe 3E). A path that
records nothing therefore exists and works. Agrees with C8 on the only composition in the tree
(`index.ts:1323`, a debug log line). Also in scope: a non-function journal (`{}`, `null`) serves fine
and fails only at invocation with `RECORDING_FAILED`; `journal: undefined` at runtime throws out of
`prepareDeclarative` (fail-closed, but `ServeOutcome` has no code for it).

### S3-5 — LOW/MEDIUM — the served contract identity may disagree with the journaled one

`harness-serving.ts:140` publishes `entry.contractId` — for the real resolver that is the
**manifest's** declaration (`declarative-recipes.ts:114`) — while the broker's record and receipt use
`recipe.tool.contractId`. Repro: pass `contractId: '@attacker/other-contract/review'` with
`text-title.json` → `ok: true`, `served[0].contractId === '@attacker/other-contract/review'`, journal
records `text.title`. `parseRecipe` has an identity-claim refusal for precisely this
(`recipe-format.ts:852-866`); the serving path never calls it (S3-1). No test asserts either field.

### S3-6 — LOW — a VALID recipe can send an EMPTY prompt and be reported `completed`

Reachable through every served tool, so it belongs with the claim that nothing quietly becomes a
result. A recipe `parseRecipe` accepts — one optional input, `promptTemplate: "Focus on {{focus}}"`
— renders to `""` when `focus` is omitted (`renderPrompt` drops a line binding an absent optional,
`recipe-format.ts:1102-1110`) and the broker dispatches it: outcome `completed`, provider received
`""`, journal recorded `prompt: ""` (probe 5). The broker guards empty *output*
(`broker.ts:873-880`) but not an empty model-visible input. Complementary to F1 above: F1 shows the
test cannot see an empty renderer; this shows the empty render being sent as a success.

### S3-7 — LOW — a lying provider degrades the typed error to a raw `TypeError`

A provider returning an unmodelled completion `kind` makes `broker.run` resolve `undefined`
(`broker.ts:850-892`, `switch` with no `default`), so `harness-serving.ts:144` throws
`TypeError: Cannot read properties of undefined (reading 'kind')` instead of `HarnessFailedError`
(probe 3G). Claim 2 survives — nothing is returned as a value — but the machine-readable code the
class exists to carry is lost.

## S3 — Mutations caught (16 mutations, 11 caught)

Applied to a frozen TEMP copy, each re-run with `npx tsx --test` against the unmodified test file:
delete the `authorize` statement (4 pass/3 fail) · authorize a different name · remove the
no-provider refusal · reword the refusal to blame the package · ignore the supplied journal · return
the value for a `failed` outcome · return `''` instead of throwing · treat `cancelled` as a success ·
drop the caller signal · collapse `cancelled` into `HarnessFailedError` · report a failure as
`HarnessCancelledError` — **all CAUGHT**. The cancellation test (`tests:162-189`) is load-bearing: it
alone catches the cancellation trio, so it is what makes claim 2 true for `cancelled` and what proves
the `signal` is forwarded. The refusal test's assertion on the error *type* (`tests:145-148`)
survives rewording, which the old prose match did not.

## S3 — Mutations NOT caught (the gaps)

| mutation | result | why it matters |
|---|---|---|
| **authorization moved from preparation into `invoke`** | 7/7 pass | "Authorization happens at PREPARATION" is unobservable. Because `authorize` cannot fail (S3-2), no test can distinguish the timings. |
| **hardcode `code` on `HarnessFailedError`** (`'MUTATED_CODE'`) | 7/7 pass | `tests:147` asserts only `typeof error.code === 'string'`, while the class exists "so a caller branches on the CAUSE" (`src:162-164`). Assert `error.code === 'MODEL_REFUSED'`. |
| **replace the failure `reason` with a constant** | 7/7 pass | Nothing asserts the broker's reason reaches the caller. |
| **fake `implementationId` / `contractId`** (`'MUTATED'`) | 7/7 pass | `ServedRecipe`'s identity fields are never asserted (S3-5 invisible). |
| **tolerate a missing journal at runtime** (fall back to `requireRecording: false`) | 7/7 pass | No test composes a path without a journal, so the module could silently downgrade to no-recording; today it is fail-closed. |

## S3 — What this reviewer could not determine

- **Whether a deployment ever supplies `harnessProvider`** — outside the two files; §6 asks the
  same. The peer's C1 (the package declares `tools: []`, so nothing is served) makes most findings
  here latent, which is why S3-3 is reported as a live defect *the moment* C1 is fixed.
- **Whether `parseRecipe` is skipped by design.** It is exported, imported and asserted by the test
  (`tests:31`), so validation may be intended at manifest-install time; I found no call site in the
  host package but did not audit the install path (§3's C1 covers part of it).
- **Exploitability of the mutable-recipe repro.** The resolver's array is local to activation, so a
  mutation needs another holder of the reference; I could not construct one from outside the files.
- **Downstream effect of `toolName === ''`.** I proved an empty and a duplicate name are served and
  callable; I did not trace what a DSH registry does with either.
- **Concurrency/ordering of journal writes** — not exercised (one call at a time here).
