# Adversarial Security Review — security and extension surface

**Reviewer role:** adversarial (break it, do not praise it).
**Repository:** `D:\DEV\dsh-model-as-tool`, HEAD `5e1cde0`, Windows, Node v24.11.0.
**Canonical source of truth used:** `docs/tool-mode/specs/` — `Tool_Mode_DSH_Implementation_Spec_v1.2.md`
(§5 MCP-08, §6 SEC-01…SEC-10, §7 DECL-01…DECL-08, §10 CODE-01…CODE-08, §16 EXT-01…EXT-36 and §16.9
AT-25…AT-40), `Tool_Mode_Extension_Protocol_v1.1.md`, `Tool_Mode_Verification_Checklist_v1.2.md`.
Repo status files, test names and code comments were treated as **claims under audit**, not evidence.
**Constraints honoured:** the repository was not modified. All probes live in `E:\tmp\tmx-adversarial\`
and `E:\tmxadv-clean\` and import the repo's `src/*.ts` directly (via `npx tsx`), or the repo's
`lib/` build. `npm run verify` was not run.

---

## Verdict

**Do not hand this build untrusted extension code and treat the result as contained.** The archive and
path defenses are genuinely strong — 16 real traversal/symlink/junction/device attacks on the extractor
and 5 000 fuzzed store identities produced **no** escape, and the contribution registrar survived every
handle forgery I could construct. But two things disqualify a clean verdict: (1) a real, reproduced
defect in the installer's runtime link lets a **package supply its own copy of the host runtime SDK**
instead of the host's, reported to the operator as success; and (2) the **entire PTC / generated-code
authorization layer (`ptc-authority.ts`, `ptc-runtime.ts`) has zero callers in the shipped plugin** —
`mayExposeToClients()`, `mountPtcRuntimeIfAbsent` and `buildToolBindings` are reachable only from tests,
so the safety they appear to provide is dormant code, not an enforced control, and `tool_mode_run`
(CODE-02) does not exist at all.

Confidence: **high** on the parts I attacked (exact reproductions below); **medium** that I have found
the most serious issue, because the extension-worker/process isolation boundary (EXT-20) is out of
reach in this checkout and was not attacked.

---

## Exploited

### X-1. A package can substitute the host runtime SDK, and the installer reports it as success

**Attack (goal 1 and goal 7).** `linkRuntimeSdk` decides whether to make the host's
`@try-works/tool-mode-extension-sdk` resolvable by calling `existsSync(linkPath)` and returning
`{ linked: false, reason: 'already-present' }` if anything at all is already there
(`packages/tool-mode-extension-sdk/src/install/runtime-link.ts:81`). An extension archive is fully
entitled to ship a real directory at that path, and every entry it needs passes
`validateArchiveEntries` — there is no link, no traversal, no device name, nothing to refuse. The
installer therefore never creates the link, and Node resolves the package's own bare import
`@try-works/tool-mode-extension-sdk` to the **package-supplied** module, because Node walks
`node_modules` upward from the importing file first. The extension then runs against a runtime the
package wrote, while the receipt and `.tool-mode-install.json` record the reassuring
`already-present`.

**Exact input.** Archive entries (verbatim):

```text
package.json
tool-mode.extension.json
dist/extension.js
node_modules/@try-works/tool-mode-extension-sdk/package.json
node_modules/@try-works/tool-mode-extension-sdk/index.js
```

`dist/extension.js` contains exactly:

```js
import { HOST_PROVIDED } from '@try-works/tool-mode-extension-sdk'
export const proof = HOST_PROVIDED
export default { apiVersion: 1, async create() { return { async createProvider() { return {} }, async dispose() {} } } }
```

`node_modules/@try-works/tool-mode-extension-sdk/package.json` contains exactly:

```json
{"name":"@try-works/tool-mode-extension-sdk","version":"99.0.0","type":"module","exports":{".":"./index.js","./package.json":"./package.json"}}
```

`node_modules/@try-works/tool-mode-extension-sdk/index.js` contains exactly:

```js
export const HOST_PROVIDED = 'PLANTED-SDK-99.0.0'
```

**Command** (probe `E:\tmxadv-clean\p6-shadow.ts`; builds the ZIP with the repo's own raw writer and
drives the real `stagedInstall`):

```powershell
npx tsx E:\tmxadv-clean\p6-shadow.ts
node E:\tmxadv-clean\entry-runner.mjs 'E:\tmp\tmx-adversarial\p6\store\extensions\shadow-pkg\1.0.0\dist\extension.js'
```

**Observed result.**

```text
INSTALL SUCCEEDED
  installPath : E:\tmp\tmx-adversarial\p6\store\extensions\shadow-pkg\1.0.0
  runtimeLink : {"linked":false,"reason":"already-present","path":"...\node_modules\@try-works\tool-mode-extension-sdk"}
  is it a SYMLINK/JUNCTION (the host link)? false
  is it a REAL DIRECTORY (planted by the archive)? true
  planted index.js: "export const HOST_PROVIDED = 'PLANTED-SDK-99.0.0'\n"
  resolved entry: ...\store\extensions\shadow-pkg\1.0.0\dist\extension.js
```
```text
entry                            : ...\shadow-pkg\1.0.0\dist\extension.js
the extension saw HOST_PROVIDED  = "PLANTED-SDK-99.0.0"
VERDICT: *** the extension ran against the PACKAGE-SUPPLIED SDK, not the host runtime ***
```

Independent corroboration that this is real module resolution and not a probe artefact — a plain
`.mjs` run from inside the installed package reports the same thing:

```text
require.resolve(sdk/package.json) = E:\...\shadow-pkg\1.0.0\node_modules\@try-works\tool-mode-extension-sdk\package.json
HOST_PROVIDED                     = "PLANTED-SDK-99.0.0"
```

**Why the repo's own tests do not catch it.** In a workspace checkout,
`D:\DEV\dsh-model-as-tool\node_modules\@try-works\tool-mode-extension-sdk` is a **junction into
`packages/`**, and `adm-zip`/`tsx` resolution in the test process finds that one, so the shadow is
masked. It becomes visible the moment the host SDK is resolved the way a consumer install resolves it
(one junction-free ancestor `node_modules`), which is the deployment the spec targets.

**Impact.** The host's stated reason for the link is that "*copying it into every install would ship N
copies that drift independently — and an extension running against a stale copy of the runtime is worse
than one that refuses to start*" (`runtime-link.ts:14-17`). The package-supplied directory is precisely
that stale copy, chosen by the package instead of the host, and nothing reports it. Today the blast
radius is bounded because the plugin consumes the SDK **type-only** at runtime
(`import type { Contribution, ContributionRegistrar }`); the moment the SDK grows a runtime helper that
an extension calls — the SDK's own docs already require "*runtime SDK helpers … belong in declared
runtime dependencies*" (`Tool_Mode_DSH_Implementation_Spec_v1.2.md`, EXT-13 note) — the package
controls the code on both sides of that call. The operator-visible record is wrong either way: a
`linked:false, already-present` receipt reads as "the host runtime was already in place", not "the host
runtime was not installed and this package supplied its own".

**Severity:** Moderate (real defect, exact reproduction, contained but silently misreported; the
containment argument depends on the SDK staying type-only).
**Requirement gap:** EXT-02 (public SDK is a host-provided, single implementation), EXT-19, EXT-33
(installed source identity must be checkable). The `already-present` path is the bug: the correct
behaviour is to verify that what is at the link path **is** the host SDK (and refuse, or replace, when
it is not), or to fail the install with a named reason rather than continue silently.

### X-2. The installer publishes the entry list it validated but never uses it — validated and written paths are allowed to differ

**Attack (goal 1).** `stagedInstall` validates the entry list and **discards the returned normalized
paths** (`packages/tool-mode-extension-sdk/src/install/staged.ts:163-168`), then calls
`options.archive.extract(bytes, extracted, '')`. `extract()` re-reads the archive independently and
applies its own `resolve(join(target, name))` containment test. The `ArchiveSource` contract never
requires the extractor's view to equal the lister's view, and `findPackageRoot` (the function whose
whole job is to reconcile an archive's root with an extraction prefix) is exported and never called by
any install path.

**Exact input / evidence.**

* `archive.ts:122-217` returns the normalized list; `grep findPackageRoot` in
  `src/install/staged.ts` finds the identifier only inside doc comments — the executable call is
  `options.archive.extract(bytes, extracted, '')`.
* A wrapped archive (`wrapped-pkg/package.json`, `wrapped-pkg/tool-mode.extension.json`,
  `wrapped-pkg/dist/extension.js`) — which `findPackageRoot` accepts and returns `wrapped-pkg` for —
  is refused by the real installer:

```text
=== 4. wrapped archive (single top-level directory) ===
  REFUSED -> the package does not ship package.json
  extract call in staged.ts: options.archive.extract(bytes, extracted, '') | ...
```

**Impact.** Two consequences. (a) A supported archive shape (EXT-11/EXT-13 wrapped packages) is
silently unusable, and the only code that understands it is dormant. (b) The security-relevant half:
because the validator's output is thrown away, every *future or third-party* `ArchiveSource` is free to
report benign entry names to validation and write different ones during extraction, and **nothing
compares the two**. I could not turn this into a live escape with the shipped adapters — see "attacks
that failed" — so the escape is a precondition away rather than demonstrated. The refusal itself is
demonstrated above.

**Severity:** Low-to-moderate. The demonstrated half (wrapped archives refused) is correctness; the
path-divergence half is a real design gap that the code's own comment claims is closed ("*Confinement is
re-asserted at the write … even if validation were bypassed*" — `zip-source.ts:68-70`), which is true
for that one adapter and unenforced as a contract.
**Requirement gap:** EXT-11 ("*Resolve manifest paths inside the installed package*"), EXT-08
(staged install), AT-29.

---

## Theoretical

### T-1. `acquireAsset` can never complete a zero-byte asset

**Precondition:** an asset lock declaring `bytes: 0` (a legitimate possibility for a marker or an empty
tokenizer file).
**Evidence.** With `bytes: 0`, the transfer loop never runs, so `write(partial, …)` never runs, so
`read(partial)` returns `undefined`; the size check passes (`0 === 0`) and the digest of the empty
buffer legitimately matches, but `rename(partial, finalPath)` then fails because no partial exists. The
whole body is inside `try { … } catch { return { acquired: false, reason: <message>, retryable: true } }`,
so a deterministic, permanently-failing case is reported as **retryable** and retried forever:

```text
=== 10. declared size 0 ===
bytes:0 with empty-content digest -> {"acquired":false,"reason":"ENOENT: no such file or directory,
   rename '...\.partial-e3b0…' -> ...","retryable":true}
```

Aggravating detail: a transport error and a digest mismatch are reported differently in the *reason* but
the `catch` at `asset-acquisition.ts:199-207` re-labels everything it swallows as `retryable: true`,
so a caller cannot distinguish "flaky network" from "this will never work".

**Severity:** Low. **Requirement gap:** RES-03.

### T-2. `acquireAsset` never validates the digest string it turns into a path

**Precondition:** a `PlannedAsset` whose `digest` is attacker-influenced (all current callers pass a
lock-file value, and `acquireAsset` has **no caller outside its own test file**, so this is a
robustness gap today, not a live path).
**Evidence.** `contentPath` and `partialPath` interpolate `asset.digest` directly
(`asset-acquisition.ts:92-101`). I tried `'../../escaped-digest'`, `'..\\escaped-digest-bs'`,
`'C:/abs-digest'`, `'/abs-digest'`, `'a/b'`, `'CON'`, `'x.'` — every one **failed safely** (no escape,
no file created anywhere, including `E:\abs-digest`), because the digest mismatch aborts before the
rename and Windows rejects the intermediate directory names. So the missing validation is not currently
exploitable; it is a single future change to the comparison (or a digest that happens to match) away
from writing outside the asset root.
**Severity:** Informational/Low.

### T-3. `installPathFor` accepts a version whose prerelease contains `..`

**Precondition:** the version string reaching `installPathFor` is not already pinned by a lock record.
**Evidence.** `/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/` accepts `1.0.0-..` and `1.0.0-.`:

```text
ACCEPT "1.0.0-con..x" -> \extensions\pkg\1.0.0-con..x
ACCEPT "1.0.0-."      -> \extensions\pkg\1.0.0-.
ACCEPT "1.0.0-.."     -> \extensions\pkg\1.0.0-..
```

These stay inside the store (the separators are the real defense and they hold), they are not legal
semver, and a trailing-dot component is silently normalised by Windows. **Severity:** Informational.

### T-4. A store lock held by a live process can be broken by racing the `acquireExclusive` probe

**Precondition:** two writers interleaving inside the `readJsonBounded` → `isProcessAlive` → `writeJsonAtomic`
window (`store.ts:205-232`), or a pid-reuse collision.
**Evidence.** The logic is sound in the common case — a live holder raises `EXTENSION_IN_USE`, a dead
holder is treated as stale, and release only removes *our own* lock. There is no atomic
create-if-absent (`open(…, 'wx')`) and no re-read after writing, so the exclusivity EXT-31 requires
("offline edits require exclusive store ownership") is advisory between two offline writers.
**Severity:** Low. **Requirement gap:** EXT-31.

---

## Attacks that FAILED (evidence for the code)

Each item is the attack as attempted, the exact input, and what stopped it.

**F1. Escape the store through archive entry names.** 39 entry shapes against
`validateArchiveEntries` and then, bypassing validation entirely, 16 hostile archives through a real
`adm-zip` extractor into a real directory.

| Attack (exact name) | Result |
|---|---|
| `../evil.js`, `a/../../evil.js`, `..`, `nested/../../escaped-nested.txt` | refused: traversal |
| `/etc/passwd`, `/abs-posix.txt`, `/` | refused: absolute |
| `\\srv\share\e.js`, `//srv/share/e.js`, `//unc-host/share/x.txt`, `\\srv\share\escaped-unc.txt` | refused (staged path) / written **inside** the target with the separators neutered (raw-extract path) |
| `C:/Windows/e.js`, `C:e.js`, `C:drive-relative.txt`, `D:/other-drive.txt` | refused as a drive letter; on the raw-extract path nothing left the target |
| `a.js:evil` (alternate data stream) | **accepted** by the validator, but writes a file literally named `a.js` inside the target — no escape. Assertion: no write landed outside the extraction root in any of the 16 cases |
| `a\0.js` | refused: NUL byte |
| `CON`, `CON.txt`, `COM1`, `LPT9`, `a/NUL` | refused: reserved device name |
| `evil.`, `evil `, `a./b` | refused: trailing dot/space |
| `\\?\C:\escaped-device.txt`, `//?/C:/escaped-slash-device.txt` | refused by the validator; on the raw path the `mkdir` failed with ENOENT inside the target |
| symlink / hardlink entries | refused by kind |
| `a.js` twice; `A.js` + `a.js`; `a.js`/`a//b.js`/`a/b.js`; `a/b.js` + `a/./b.js` | refused as duplicates / Windows case collision |
| `K.js` (U+212A) + `k.js` | refused: case collision |
| 5 000 entries; 100 MB entry; 1 KB → 100 MB ratio bomb; negative/NaN size | refused on every bound |
| `café.js` (NFC) + `café.js` (NFD) | **accepted** — a Unicode-normalisation collision the validator does not fold. Verify-then-open never re-reads this path, and NTFS stores the two as distinct byte sequences, so no escape follows; recorded here as a residual gap, not a bypass |
| `COM0`, ` leading-space.js`, `....//escaped-four.txt` | accepted; none escapes (NTFS does not treat `COM0` as a device, and the others are literal names) |

Assertion after all 16 raw extractions: `escaped-above.txt` did not exist at the base directory or one
level above it; the only files present were inside the 16 target directories.

**F2. Break the extractor's own comment-claimed confinement.** `src/install/zip-source.ts:72` re-tests
`out.startsWith(target + sep)` at the write. Every traversal name I could encode — including
double-encoded `....//`, backslash forms, device namespaces and a second drive letter — was either
skipped or failed inside the target. I found no input that wrote outside it.

**F3. Escape the extension store through the identity/version grammar.** 5 000 pseudo-random
identities drawn from `a Z 0 . - _ / \ : * ? " < > | (space) .. @ NUL RLO é K ~ % $ ; = + tab newline`
→ `installPathFor` accepted **35**, escaped **0**. Hand-picked probes (`../../etc`, `..\..\etc`,
`a/../b`, `@scope/../pkg`, `..`, `UPPER`, `con`, `a.`, `ok@1.0.0/../../evil`) were all refused or
contained. The `path.startsWith(root + sep)` double-check at `staged.ts:285` is redundant but correct.

**F4. Escape an approved filesystem root (SEC-06).** 21 path shapes against a real grant with a real
**junction** inside the approved root pointing outside it:

```text
AUTHORIZED  forward-slash form of in-root  -> E:\...\approved\ok.txt
AUTHORIZED  dot-dot resolved already       -> E:\...\approved\ok.txt
AUTHORIZED  case-flipped root              -> E:\...\approved\ok.txt
denied      sibling with same prefix       [PATH_OUTSIDE_GRANT]
denied      sibling via ..                 [PATH_OUTSIDE_GRANT]
denied      via junction inside root       [PATH_OUTSIDE_GRANT]
denied      device namespace / UNC         [PATH_UNSUPPORTED]
denied      ADS, trailing dot, trailing space, 8.3 short name, drive-relative  [PATH_NOT_FOUND]
```

The prefix-sibling case (`E:\…\approved-evil` vs `E:\…\approved`) is the classic `startsWith` bug and it
is handled: the `root + sep` boundary comparison plus `realpathSync.native` canonicalization means a
junction is resolved before containment is tested and the caller is handed the canonical path to open,
which closes the check-then-open race SEC-06 names.

**F5. Reach the prototype through a binding name.** `authorizeProgramTools` /
`buildToolBindings`. `__proto__`, `constructor`, `toString`, `valueOf`, `hasOwnProperty`, `prototype`,
`isPrototypeOf`, `propertyIsEnumerable`, `__defineGetter__`, `__defineSetter__`, `__lookupGetter__`,
`__lookupSetter__`, `toLocaleString`, `eval`, `Function`, `globalThis`, `process`, `require`, `module`,
`exports`, `Reflect`, `Proxy`, `Symbol`, `Object`, `Array` → **all** `invalid-name`. Unicode lookalikes
(`stt‐transcribe` U+2010, fullwidth `ｓtt_transcribe`, Cyrillic `strаng`, zero-width `ok`),
whitespace, empty string, `a-b`, `a.b` → `invalid-name`. The map is `Object.create(null)`,
`Object.getPrototypeOf(bindings) === null`, `'toString' in bindings === false`,
`bindings['__proto__'] === undefined`, own keys are exactly the bound names, and the bindings are
non-writable/non-configurable. A symbol key cannot be requested at all (`requested` is `string[]`).
**No prototype or global is reachable through a binding name.**

**F6. Obtain a binding you were not granted.** Requesting `X`, `STT_TRANSCRIBE`, `sTT_transcribe`
against `granted: ['stt_transcribe']` → `forbidden`; requesting the visible name twice → `duplicate`;
one forbidden name among several → the **whole** request refused (all-or-nothing held). The `resolve`
callback is invoked **only after** the grant and visibility checks — a deliberate ordering I verified by
recording every call: for `['secret_tool','toString','__proto__']` it was called with `[]`, so no
oracle leaks the registered/visible set. The `forbidden`-before-`unknown` ordering works as documented.

**F7. Forge a contribution handle.** 13 structural forgeries against `withdraw`:
`null`, `undefined`, the string `'1'`, the number `1`, `{}`, `{__contributionHandle:true}`,
`{__contributionHandle:true,id:1}`, a getter for `__contributionHandle`, an object inheriting it from
its prototype, a full reconstruction `{__contributionHandle:true,id:1,name:'victim_tool',extensionId:'good-ext'}`,
`JSON.parse(JSON.stringify(realHandle))`, and a `Proxy` whose `get` trap always returns `true`. **Every
one was ignored**; the victim tool stayed live, and only the real handle disposed it. The registry is a
closure `Map` keyed by id and the check `entry.handle !== handle` is reference identity, so the id
counter is irrelevant to forgery. Withdrawing a stale handle after a new publish did **not** dispose the
new contribution (`b_tool.disposed === false`), which is the idempotence property the module claims.

**F8. Publish under another extension's identity / without activation.** `never-installed`, `''`,
`'good-ext '`, `'GOOD-EXT'`, `'@scope/good-ext'` → all `unknown-extension`, so the activated-set
membership test is exact and unforgiving. Name collision → `name-collision`; taking over a name is
possible only after the first publisher withdraws, which is correct.

**F9. Make a partial look complete (RES-03).** Tampered payload → digest mismatch, partial removed,
final path absent. Pre-existing **wrong** bytes at the final path → detected and refetched (verified
bytes afterwards). Declared-sha512 length with a false digest → refused. Uppercase digest → refused.
Cancellation mid-transfer → partial left as a partial, final path absent. Non-resumable source with a
poisoned partial → partial removed and the asset correctly re-acquired.

**F10. Fail-open on corrupt state (EXT-33, AT-29).** A truncated lock, a lock with no `extensions`
array, `null`, an array root, a 32 MB lock, a profile state that is not JSON, one with no array, one
with a single malformed entry out of two — **all** returned `corrupt: true` with **zero** records and a
diagnostic, and `recordInstall` on a corrupt lock raised `EXTENSION_FAULT` rather than appending. The
tempting fail-open (treat everything as active) does not occur. `digestInstalledContent` is stable when
the receipt is added and changes when a package file changes.

---

## Unverified surface

* **The process-isolation boundary (EXT-20, AT-38).** I did not attack the managed-worker boundary:
  I found no worker-spawn implementation in this checkout to attack (the extension entry is imported
  in-process at `index.ts:1092`), so claims about confinement, crash quarantine and resource caps are
  untested by me. The spec is explicit that a managed process is "*resource/crash lifecycle, not proof
  of security confinement*".
* **Live DSH registry behaviour on hostile tool names.** `createContributionRegistrar` accepts
  `__proto__`, `constructor`, `toString`, `model_tools`, `tool_mode_run`, `''`, `'A B'` and a 300-char
  name as tool names (probe 7 §6) and passes them to the host's `registerTool`, which forwards
  `tool.name` straight into `ctx.tools.register(defineTool({ name: tool.name, … }))`
  (`index.ts:1121-1122`). Whether DSH's registry refuses those names, and whether any host structure
  keys a plain object by them, I could not determine without a live DSH host — I did **not** run one.
  This is the one place where a hostile name reaches an external sink, and it deserves a follow-up.
* **MCP client-facing surface.** The `src/mcp/**` surface is outside this review's scope and was
  covered by a separate review (`docs/tool-mode/ADVERSARIAL-REVIEW-MCP.md`).
* **`stagedInstall` against a malicious `ArchiveSource`.** I argued the validate/extract divergence
  from the code and from the dormant `findPackageRoot`, but I did not write a divergent adapter to
  demonstrate an escape, because doing so would mean attacking an interface no shipped code implements
  — it would be my own code doing the escaping, not the repository's.
* **Alternative extraction libraries.** Only `adm-zip` (the shipped dev adapter) was exercised.

---

## What I could not determine

1. **Whether the PTC pipeline is dead code by accident or by decision.** `ptc-authority.ts` and
   `ptc-runtime.ts` have **zero** callers outside `tests/`: across the whole repository the only hits
   for `mountPtcRuntimeIfAbsent`, `buildToolBindings`, `mayExposeToClients`, `exposureWithheldReason`
   and `tool_mode_run` in executable code are `src/ptc-runtime.ts` itself and three test files
   (`ptc-runtime.test.ts`, `ptc-composition.test.ts`, `ptc-sandbox.test.ts`). `index.ts` contains no
   `tool_mode_run`, no `buildToolBindings`, no `mayExpose`. Consequences: `mayExposeToClients()`'s
   `false` guards nothing (there is no caller to refuse), `mountPtcRuntimeIfAbsent`'s guard never runs
   (its own comment calls it "*mandatory in both outcomes*"), CODE-02's `tool_mode_run` is absent, and
   the directive that "*native DSH PTC and external `tool_mode_run` must use the SAME authorized tool
   pipeline*" is unmet because neither surface is wired to that pipeline. The repository's own
   `docs/tool-mode/PTC-INTEGRATION-FINDINGS.md:338` already states "*There is no Code Mode, no
   `run_code`, and no `tool_mode_run`*", and I independently confirm it. What I cannot determine is
   whether a later milestone is expected to wire it, or whether the exported functions exist only to
   satisfy a traceability check — which decides whether the exposure gate is "withheld" or merely
   "unplugged".
2. **Whether `ctx.tools.register` enforces the naming constraints EXT-21 requires.** The registrar
   does not, and I have no live DSH host here.
3. **Whether the runtime link is exercised in a real consumer install.** The one deployment I could
   construct (a junction-free ancestor `node_modules`) reproduces the shadow; I cannot observe the
   publisher's actual consumer layout from this checkout.
4. **The severity ceiling of X-1.** It depends on whether any future or planned runtime SDK helper is
   called by an extension, which I cannot see from the current type-only usage.

---

## Reproduction index

All probes are read-only with respect to the repository and live outside it.

| Probe | Attacks | Notable outcome |
|---|---|---|
| `E:\tmp\tmx-adversarial\p1-archive.ts` | entry-list validation, 39 shapes | traversal/device/case/bomb all refused; ADS + NFC/NFD accepted |
| `E:\tmp\tmx-adversarial\p2-extract.ts` | first combined attempt (superseded) | aborted when the raw extractor hit an unhandleable name; its findings are superseded by `p2b` |
| `E:\tmp\tmx-adversarial\p2b-extract.ts` | 16 hostile archives through a real extractor | **0 escapes** |
| `E:\tmp\tmx-adversarial\p4-authority-path.ts` | 21 path shapes vs a real junction | **0 escapes** |
| `E:\tmp\tmx-adversarial\p3-ptc-authority.ts` | 44 binding names | every prototype name `invalid-name`; `resolve` never called early |
| `E:\tmxadv-clean\p6-shadow.ts` + `entry-runner.mjs` | runtime-link substitution | **EXPLOITED** (X-1) |
| `E:\tmxadv-clean\p7-registrar.ts` | 13 handle forgeries, identity spoofing, name collisions | **0 forgeries succeeded** |
| `E:\tmxadv-clean\p8-store.ts` | corrupt lock/profile state, wrapped archive, store roots | fails closed; wrapped archive refused (X-2) |
| `E:\tmxadv-clean\p9-fuzz.ts` | 5 000 fuzzed store identities | 35 accepted, **0 escaped** |
| `E:\tmp\tmx-adversarial\p5b-assets.ts` | digest/length/cancel/partial attacks | verified atomic; zero-byte case unwinnable (T-1) |

The single most serious item is **X-1**; the most consequential *observation* is that the PTC and
exposure controls are not wired into the plugin at all, so the security they are written to provide is
not currently provided by anything.
