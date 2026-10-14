# @try-works/extension-needle

A first-party Tool Mode extension implementing **`tools_plan`** and **`structured_extract`**
on the Cactus Needle 3 native engine.

## The route

There is no npm package named after Needle, and no GitHub release of one. `GET
https://api.github.com/repos/cactus-compute/needle/releases` answers `[]`. The engine is a
**native executable** published in the HuggingFace model repository `Cactus-Compute/needle3`:

```
https://huggingface.co/Cactus-Compute/needle3/resolve/93e88ede867e4311c39151285e74df513e4b835b/windows-x86_64/needle.exe
```

That is the route this package takes. The WASM pair (`wasm/needle.js`, `wasm/needle.wasm`)
exists in the same repository and is an **additional** qualification route, not a
prerequisite; it is recorded in `models.lock.json` under `inspectedNotPinned` and is not used
here. The digests, the licence evidence, the measurement method and the open questions are in
[PINNING.md](./PINNING.md).

## What runs, and what has actually been observed

The engine was executed on this host on 2026-10-14, over the real 35 MB weights, and returned
real answers. This is a transcript, not a description:

```json
{"type":"call","success":true,"error":null,"error_code":null,"reason":null,
 "function_calls":[{"name":"get_weather","arguments":{"city":"Shanghai"}}],
 "suppressed_calls":[],
 "reasoning":"Query asks for weather in Shanghai. get_weather tool with city 'Shanghai'.",
 "confidence":0.9677,"prefill_tps":29.8,"decode_tps":8.9,"peak_ram_mb":80.4,
 "validation":{"ungrounded":[],"negation":false}}
```

```json
{"type":"call","success":true,
 "function_calls":[{"name":"record_extraction","arguments":{"invoice_number":"AC-4471",
   "total_amount":418.75,"currency":"EUR","due_date":"2026-04-01",
   "line_items":["3x aluminium bracket","1x shipping"]}}],
 "reasoning":"invoice_number 'AC-4471' from query.","confidence":0.4332,
 "validation":{"ungrounded":[],"negation":false}}
```

Nothing in this package reports model quality. Throughput numbers are the engine's own
self-report, `confidence` is a self-report and not a calibrated probability, and no accuracy
claim is made.

## The process bridge

`src/process-bridge.ts` is the whole runtime surface, and each property below has a test that
fails if the property is removed (`tests/process-bridge.test.ts`):

| Property | How it is enforced |
| --- | --- |
| **Argument arrays, never a shell** | `argv` only; `shell: false` hard-coded. A test passes an argument containing spaces, quotes, `&`, `\|`, `^` and a redirect, and asserts it arrives as ONE element and that the sentinel file the redirect would create does not exist. |
| **A scrubbed environment** | A closed allow-list (`PATH`, `SystemRoot`, `TEMP`, `TMP`, and three harmless Windows values). `process.env` is READ for those names and never spread. A test sets `AWS_SECRET_ACCESS_KEY` in the parent and asserts the child cannot see it, and that every variable the child DOES see is accounted for. |
| **Bounded I/O** | Byte counters on both streams; passing either cap KILLS the child. A test runs a child that writes forever and asserts the promise settles quickly with `output-overflow` — a truncating bridge would hang until the timeout. |
| **Cancellation** | An `AbortSignal` terminates the child and the outcome is `cancelled`. A test asserts a terminated child's later timer never fires, so the process really died. |
| **A timeout** | A wall-clock budget that kills the child and reports `timed-out`. |
| **No public listener** | `assertNoListenerArgument` REFUSES `--serve` and `--port`, including in the value position of a caller-text flag, and a structural test asserts the module imports no networking module and never inherits stdio. |

## One-shot processes, and the state question

`needle.exe` keeps a conversation in process memory. The CLI has **no reset flag**; the only
reset in the product is `POST /reset` on the `--serve` HTTP server this package never starts,
and the C ABI's `needle_reset()` is not reachable from the CLI. The answer is therefore
**process-per-call**: every invocation starts a fresh `needle.exe`. The provider holds no
child handle, no session id and no conversation buffer, so there is no state that could leak
between calls.

`--fail-input-overflow` is passed on every call, so a turn that would not fit the context
window is refused rather than silently trimmed into a different question.

## The tools

**`tools_plan`** proposes tool calls as **data**. Each proposal is `{ name, arguments,
offered, valid, issues }` and nothing else — the output schema is closed, so there is no field
an executor could travel in, and this package contains no dispatcher, registry or callable
handle anywhere. A proposal naming a tool the caller never offered, or one whose arguments
violate the offered schema, is reported under `rejected` rather than passed through. The
engine's grammar constrains shapes, not intent; that check is this package's job.

**`structured_extract`** fills a caller-supplied JSON Schema. The engine compiles the schema
into a byte-level grammar, so a returned object is well-formed by construction — and the
package **re-validates it anyway**, because well-formed is not correct. A schema keyword the
grammar would silently DROP (`minimum`, `pattern`, `format`, `$ref`, …) is refused **by name**
rather than ignored: a dropped constraint produces a plausible object that violates the
caller's contract in a way nobody can see. `extraction: null` with `proposed: false` is a
reported outcome, not an error.

## Honesty

If the pinned artifacts are not resolvable and verified, `inspect()` reports `unprepared` and
names every artifact it could not verify, with the routes it searched; `invoke()` REFUSES and
says what is missing. There is no third state, no fabricated proposal and no substitute model.
Every resolved path — including an operator-supplied one — is verified by size and SHA-256
before anything is executed or loaded.

## Configuration

| Key | Meaning |
| --- | --- |
| `enginePath`, `weightsPath` | Local paths for the two artifacts. They are VERIFIED against the pin like every other route. |
| `timeoutMs`, `maxOutputBytes`, `maxNewTokens`, `threads` | Bounded budgets. |
| `system` | Session facts: the date, the locale, the device. |
| `resolutionEnv` | Fixes the environment the resolver reads, making resolution deterministic. |

Without configuration, the resolver also honours `NEEDLE_EXTENSION_ENGINE` and
`NEEDLE_EXTENSION_WEIGHTS`, then an extension-private directory.

## Licensing

Five layers are declared in `tool-mode.extension.json`: the code (MIT), the engine and the
weights (both **Apache-2.0**, OSI-approved, redistribution permitted — identified from the
upstream repository's own `LICENSE` and GitHub's `spdx_id`), the Tool Mode SDK, and
`conversion-artifacts` as `none:` because no conversion is performed. The native engine has no
telemetry; the `NEEDLE_TELEMETRY` / `DO_NOT_TRACK` controls documented for the Python wrapper
do not apply to this artifact. Full evidence in [PINNING.md](./PINNING.md).

## Building and testing

```
npx tsc --noEmit -p packages/extension-needle/tsconfig.json
npx tsc -p packages/extension-needle/tsconfig.build.json   # lib/ is gitignored and required
npx tsx --test packages/extension-needle/tests/*.test.ts
```

`lib/` must be built before the tests run: the manifest validator refuses a package whose
declared entry does not exist on disk.

To run the prepared half of the suite against real artifacts:

```
$env:NEEDLE_EXTENSION_ENGINE  = '<path>\needle.exe'
$env:NEEDLE_EXTENSION_WEIGHTS = '<path>\needle3.cact'
```
