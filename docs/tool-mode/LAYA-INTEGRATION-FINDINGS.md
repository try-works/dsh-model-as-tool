# Laya Integration Findings

Read-only-into-the-repo investigation, 2026-10-14. Scope: can the upstream `laya-ts/` source be
resolved, pinned, licensed, built and exported on this host; what is the actual blocker; and does
any of it change the quality position on the multilingual checkpoint.

Everything below was verified by executing a command or reading a file on this host. Where
something could not be verified it is under **What is uncertain** rather than inferred. All build
and export work happened in `E:\tmp\laya-investigation\` (`$env:TEMP` on this machine); **nothing
was installed into the repository, and no repository file was modified except this document.**

---

## Summary

- **The source exists, is resolvable and is pinnable.** `https://github.com/NandhaKishorM/laya`
  at commit `c73908d96ff73c0062c340a11bf7c54ec7d8bc4d` (tag `v0.4.6`), **Apache-2.0**, contains a
  real `laya-ts/` package. The npm name `laya-ts` genuinely 404s; the source does not.
- **It builds on Windows.** `npm ci` (115 packages, 0 vulnerabilities) then `npm run build` →
  **exit code 0**, 26 files in `dist/`. Node `v24.11.0`, npm `11.6.1`.
- **The upstream suite passes.** `npm test` → 35 files / **886 tests, 0 failed**. Plus
  `npm run test:package` → 1/1, which packs the module and installs it into an external ESM
  TypeScript consumer.
- **The ONNX export runs and every numerical-parity check passes.** `encoder.onnx` +
  `head.onnx` exported from the multilingual checkpoint with the built-in torch-vs-ONNX ≤1e-4
  check passing **3 of 3** passes (worst logits diff `1.0e-06`); an independent PyTorch-vs-ONNX-in-Node
  comparison passed with **0 errors**; 194 weight-free upstream ONNX checks passed; and the CI gate
  `tests/test_onnx.py` passed 2/2. **`--no-verify` was never used and no check was relaxed.**
- **The one real blocker is a Windows console-encoding defect in the documented export command**,
  not a source or numerics defect: torch's ONNX exporter prints `✅` (U+2705) and the command dies
  with `UnicodeEncodeError` on a code page the interpreter maps to `cp1252`. `PYTHONIOENCODING=utf-8`
  clears it and nothing else was changed. **A registry 404 is not the blocker; this is.**
- **Quality is untouched by any of the above.** The multilingual model card states the checkpoint
  "Ships uncalibrated" and is "Near chance on typed-decisions zero-shot" (0.342 against a 0.461
  majority-class baseline) — and the library's **own code** emits a `RuntimeWarning` clamping a
  shipped temperature of `0.10058280825614929` to `0.5` and calling the affected confidences
  uncalibrated. DEC-08 is still `NOT_RUN`. **Packaging it does not make it a reliable default.**

---

## Upstream identity

### Repository

| Fact | Value | How it was read |
| --- | --- | --- |
| Repo URL | `https://github.com/NandhaKishorM/laya` | GitHub REST `/repos/NandhaKishorM/laya`, HTTP 200 |
| Default branch | `main` | same |
| **Pinned commit (full 40-char SHA)** | **`c73908d96ff73c0062c340a11bf7c54ec7d8bc4d`** | `git rev-parse HEAD` after clone; identical to the API's `commits/main` sha |
| Tag at that commit | `v0.4.6` (`git describe --tags --exact-match`) | local clone |
| Commit subject | `release: 0.4.6` | `git log -1` |
| Commit author / date | `Nandakishor <nandumpilicode@gmail.com>`, `2026-10-12T14:59:59+05:30` | same |
| Tree SHA | `a3c658bd9c314962e37e7c486585ee09e3bab840` | GitHub REST |
| Other branches | `research`, `dependabot/pip/ruff-0.16.10` | GitHub REST `/branches` |
| `laya-ts/` tree SHA | `7c167c2581dd9079c3a815eafc4694d1d4f3ec57` | GitHub REST `/contents/laya-ts` |

Clone used `--depth 1` and was then deepened with `git fetch --unshallow` so the pinned commit is
verifiable in the object database (`git rev-parse --is-shallow-repository` → `false`,
15,298 objects in pack).

**Do not track a branch.** `main`'s `pushed_at` was `2026-10-12T09:30:04Z` and the repository is
actively released; the SHA above is the only stable reference.

### Licence

`LICENSE` at the repository root, and a byte-identical copy at `laya-ts/LICENSE`
(SHA256 `6D1D968FB225ECA367CB7F0B8831AB012A35D92B547E945E17EF8E7B05C3E5CC` for both):

- **Apache License, Version 2.0, January 2004.** Verbatim opening line:
  `Apache License` / `Version 2.0, January 2004` / `http://www.apache.org/licenses/`.
- Stored size in git: **10,173 bytes**. Checked-out size on this Windows host: **10,349 bytes**
  (line-ending normalisation).
- **The Apache appendix is NOT filled in.** The file ends at `END OF TERMS AND CONDITIONS`; there
  is **no `Copyright [yyyy] [name of copyright owner]` line anywhere in it**. The only
  copyright-holder statement in the package is the manifest field `"author": "Convai Innovations"`.
- Declared identically in `laya-ts/package.json` (`"license": "Apache-2.0"`) and in `pyproject.toml`
  (`license = { text = "Apache-2.0" }`).

Apache-2.0 permits redistribution of source and object form with attribution, which is what a
vendored/scoped internal artifact would be.

### `laya-ts/package.json` — verbatim

```json
{
  "name": "laya-ts",
  "version": "0.1.0",
  "description": "Fast, local, on-device decision engine (TypeScript runtime)",
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" } },
  "scripts": {
    "clean": "node -e \"require('node:fs').rmSync('dist', { recursive: true, force: true })\"",
    "build": "npm run clean && tsc -p tsconfig.json && node -e \"require('node:fs').copyFileSync('../LICENSE', 'LICENSE')\"",
    "test": "npm run test:types && vitest",
    "test:types": "tsc --noEmit -p tests/tsconfig.types.json",
    "test:package": "node --test tests/package-e2e.mjs",
    "prepack": "npm run build"
  },
  "files": ["dist", "scripts/export_onnx.py"],
  "repository": {
    "type": "git",
    "url": "git+https://github.com/NandhaKishorM/laya.git",
    "directory": "laya-ts"
  },
  "keywords": [
    "decision-model",
    "system-one",
    "routing",
    "guardrails",
    "moderation",
    "triage",
    "onnx"
  ],
  "author": "Convai Innovations",
  "license": "Apache-2.0",
  "bugs": {
    "url": "https://github.com/NandhaKishorM/laya/issues"
  },
  "homepage": "https://nandhakishorm.github.io/laya/",
  "devDependencies": { "@types/node": "^26.6.4", "typescript": "^7.0.2", "vitest": "^5.0.1" },
  "optionalDependencies": { "onnxruntime-node": "^1.20.0", "onnxruntime-web": "^1.20.0" }
}
```

**Dependency reading.** There are **no** required runtime `dependencies`. The declared surface is:

| Kind | Package | Declared | Resolved by `npm ci` |
| --- | --- | --- | --- |
| dev | `@types/node` | `^26.6.4` | `26.6.4` |
| dev | `typescript` | `^7.0.2` | `7.0.2` |
| dev | `vitest` | `^5.0.1` | `5.0.3` |
| optional | `onnxruntime-node` | `^1.20.0` | `1.30.0` |
| optional | `onnxruntime-web` | `^1.20.0` | `1.30.0` |

All five exist on the public npm registry at those ranges;
`typescript@7.0.2` is the current `latest` dist-tag. `npm ci` installed **115 packages** with
**0 vulnerabilities**.

Source size of the package: `laya-ts/` is 695,534 bytes across 64 files (13 modules in `src/`,
39 test files, 2 Python scripts, 2 example scripts).

---

## Build attempt

### Environment

| Fact | Value | How it was read |
| --- | --- | --- |
| OS | Microsoft Windows 11, `10.0.26200` | `platform.platform()` from the parity fixture |
| Node | `v24.11.0` | `node --version` |
| npm | `11.6.1` | `npm --version` |
| Scratch dir | `E:\tmp\laya-investigation\` | `$env:TEMP` on this host |
| Repository | untouched except this file | `git status --porcelain` in `D:\DEV\dsh-model-as-tool` |

### Step 1 — install

```
cd E:\tmp\laya-investigation\laya\laya-ts
npm ci
```

Full output:

```
npm warn Unknown env config "manage-package-manager-versions". This will stop working in the next major version of npm.

added 115 packages, and audited 116 packages in 44s

31 packages are looking for funding
  run `npm fund` for details

found 0 vulnerabilities
```

**Exit code: 0.** (`npm ci` was chosen over `npm install` because `laya-ts/package-lock.json` is
committed, 62,980 bytes, SHA256 `8336371266D951EF39FD6C04A4B13336FE88BEA184065492651CAFBF7BE99306`
— it makes the install reproducible rather than resolving `^` ranges fresh.)

### Step 2 — build

The build command documented in `laya-ts/README.md:278` is `npm run build` run inside `laya-ts/`.

```
cd E:\tmp\laya-investigation\laya\laya-ts
npm run build
```

Full output:

```
> laya-ts@0.1.0 build
> npm run clean && tsc -p tsconfig.json && node -e "require('node:fs').copyFileSync('../LICENSE', 'LICENSE')"

> laya-ts@0.1.0 clean
> node -e "require('node:fs').rmSync('dist', { recursive: true, force: true })"
```

**Exit code: 0. The build SUCCEEDED.** `dist/` contains all 13 modules as `.js` + `.d.ts`:

```
agent.d.ts 9292        agent.js 32529        common.d.ts 8513      common.js 21260
dx.d.ts 990            dx.js 1507            email.d.ts 266        email.js 9886
hooks.d.ts 6665        hooks.js 14136        index.d.ts 2921       index.js 1801
lang.d.ts 947          lang.js 28011         presets.d.ts 377      presets.js 6544
providers.d.ts 2984    providers.js 26566    router.d.ts 9462      router.js 35295
shortlist.d.ts 3057    shortlist.js 18660    structured.d.ts 4379  structured.js 10601
tokenizer.d.ts 3089    tokenizer.js 20481
```

`git status --porcelain` on the clone after the build is **empty** — the build produced no
tracked-file changes (`laya-ts/dist/` is gitignored; the `LICENSE` copy is byte-identical to the
tracked `laya-ts/LICENSE`).

### Step 3 — upstream test suite

```
npm test
```

which is `npm run test:types && vitest`.

```
> laya-ts@0.1.0 test:types
> tsc --noEmit -p tests/tsconfig.types.json

 RUN  v5.0.3 E:/tmp/laya-investigation/laya/laya-ts

 Test Files  35 passed (35)
      Tests  886 passed (886)
   Duration  15.86s (tests 46%, transform 38%, import 14%, worker 2%)
```

**Exit code: 0.**

```
npm run test:package
```

```
✔ the packed module installs and works in an external ESM TypeScript project (62378.7718ms)
ℹ tests 1  ℹ pass 1  ℹ fail 0  ℹ skipped 0
```

**Exit code: 0.** This test is material to the "prebuilt Node consumer" requirement: it `npm pack`s
the module, installs the tarball into a throwaway external project with
`--ignore-scripts --omit=optional --no-package-lock`, asserts `onnxruntime-node` /
`onnxruntime-web` are **absent** from the consumer tree, runs real inference through an injected
`SessionProvider` stub, and type-checks a TypeScript consumer against the emitted declarations.

**So the build and its own gates are green. There is no build blocker.**

---

## Export attempt

### What the runtime consumes

`laya-ts/README.md:3` — "TypeScript inference for Laya ... on Node and the browser via split ONNX
(`encoder.onnx` + `head.onnx`)". The export script is `laya-ts/scripts/export_onnx.py` and is
listed in the published `files` array, so it ships with the npm package.

The checkpoint family is `convaiinnovations/laya` on Hugging Face (public, 46,160 downloads,
sha `7b928d828b7b0e022f929d9bd2e44165aa270148`, last modified 2026-10-03). It contains three
checkpoints in one repository: root (English), `multilingual/`, and `typed-decisions/`. The
**multilingual** checkpoint is the one this directive names.

### Attempt 1 — the documented command, as written: **FAILED**

```
cd E:\tmp\laya-investigation\laya
python laya-ts\scripts\export_onnx.py --repo convaiinnovations/laya --subfolder multilingual --out-dir model-ml
```

Environment: `HF_HOME=E:\tmp\laya-investigation\hf-cache`, venv Python `3.14.0`. The checkpoint
downloaded successfully (`Fetching 5 files: 100%`, ~9m50s, 646 MB). The failure is in the export:

```
[torch.onnx] Obtain model graph for `_EncoderOnly([...]` with `torch.export.export(..., strict=False)`...
Traceback (most recent call last):
  File "E:\tmp\laya-investigation\laya\laya-ts\scripts\export_onnx.py", line 251, in <module>
    main()
  File "E:\tmp\laya-investigation\laya\laya-ts\scripts\export_onnx.py", line 169, in main
    torch.onnx.export(
  ...
  File "E:\tmp\laya-investigation\venv\Lib\site-packages\torch\onnx\_internal\exporter\_capture_strategies.py", line 31, in <lambda>
    return lambda *args, **kwargs: print("[torch.onnx]", *args, **kwargs)
  File "C:\Python314\Lib\encodings\cp1252.py", line 19, in encode
    return codecs.charmap_encode(input,self.errors,encoding_table)[0]
UnicodeEncodeError: 'charmap' codec can't encode character '\u2705' in position 93: character maps to <undefined>
```

**Exit code: 1.** (Raw log preserved: `evidence/07a-export-multilingual-FAILED-cp1252.log`.)

### Smallest reproduction of the failing operation

```
> chcp
Active code page: 437

> python -c "import sys; print('stdout encoding =', sys.stdout.encoding); print('\u2705')"
stdout encoding = cp1252
Traceback (most recent call last):
  File "<string>", line 1, in <module>
    import sys; print('stdout encoding =', sys.stdout.encoding); print('\u2705')
  File "C:\Python314\Lib\encodings\cp1252.py", line 19, in encode
    return codecs.charmap_encode(input,self.errors,encoding_table)[0]
UnicodeEncodeError: 'charmap' codec can't encode character '\u2705' in position 0: character maps to <undefined>
                                                    ^ exit code 1
```

The character is not incidental: **`torch.onnx`'s progress printer emits `✅` (U+2705) on every
successful stage**, and on this host Python's stdout uses the `cp1252` charmap codec, which has no
mapping for it. The export aborts inside a `print()`, *after* the graph was captured but before any
ONNX file is written. The same command with the encoding forced to UTF-8:

```
> $env:PYTHONIOENCODING='utf-8'
> python -c "import sys; print('stdout encoding =', sys.stdout.encoding); print('\u2705')"
stdout encoding = utf-8
✅
                                                    ^ exit code 0
```

**This is a defect in the documented export path on a non-UTF-8 Windows console, not a defect in
the model, the export logic, or any check.** It is not a registry 404 and it is not a blocker to
the integration — it is a one-line environment requirement that upstream does not document.

### Attempt 2 — same command, encoding fixed: **SUCCEEDED**

The **only** difference from attempt 1 is `PYTHONIOENCODING=utf-8`. `--no-verify` was **not**
passed; every verification the script performs ran.

```
cd E:\tmp\laya-investigation\laya
$env:PYTHONIOENCODING='utf-8'
python laya-ts\scripts\export_onnx.py --repo convaiinnovations/laya --subfolder multilingual --out-dir model-ml
```

Final output:

```
[torch.onnx] Obtain model graph for `_EncoderOnly([...]` with `torch.export.export(..., strict=False)`... ✅
[torch.onnx] Run decompositions... ✅
[torch.onnx] Translate the graph into ONNX... ✅
[torch.onnx] Optimize the ONNX graph... ✅
[torch.onnx] Obtain model graph for `_HeadOnly([...]` with `torch.export.export(..., strict=False)`... ❌
[torch.onnx] Obtain model graph for `_HeadOnly([...]` with `torch.export.export(..., strict=True)`... ✅
[torch.onnx] Run decompositions... ✅
[torch.onnx] Translate the graph into ONNX... ✅
[torch.onnx] Optimize the ONNX graph... ✅
verify ok: torch vs onnx match within 1e-4 (logits 8.9e-07, act_probs 0.0e+00)
verify ok: torch vs onnx match within 1e-4 (logits 1.0e-06, act_probs 0.0e+00)
verify ok: torch vs onnx match within 1e-4 (logits 5.4e-07, act_probs 0.0e+00)
wrote model-ml\encoder.onnx and model-ml\head.onnx
```

**Exit code: 0.** (The single `❌` on `_HeadOnly` is torch's own capture strategy falling back from
`strict=False` to `strict=True` and succeeding — the script is written for exactly that, and it is
followed by a success line. It is not a failure of the export.)

### Exported artifacts

Written to `E:\tmp\laya-investigation\laya\model-ml\`:

| File | Bytes | SHA256 |
| --- | ---: | --- |
| `encoder.onnx` | 2,451,566 | `A774C5C634B99D1A4CED21ACBF11B9617A5CD55C7C7957BD52480B17D95A97F4` |
| `encoder.onnx.data` | 1,227,816,960 | `F1E49A027352064D72831863456BE6160748854296BFF8332DF14130DBF79834` |
| `head.onnx` | 245,312 | `7F6B9AC15D5FDF9EEBB352E66BDD3CE799D32885F1446014D268D8C53207858B` |
| `head.onnx.data` | 59,899,904 | `0292A4EB478C2C3EC0B6555B4A4093BC802E965654D7AEB4AC22907A17F261D3` |
| `rl_agent_config.json` | 472 | `25061739243B617AD88D1219BA6F8A9C86C5881CA28DF024FA2D9B3B2FCC30C6` |
| `tokenizer.json` | 34,363,188 | `609D8F4C067CD3950F88594C5A802616CEA245823836EF5848EE4FC40AAB5B6F` |

**Two things a packaging plan must absorb, both measured here:**

1. **The export is 1.29 GB and is SIX files, not two.** The encoder exceeds the 2 GB protobuf
   limit so torch emits `encoder.onnx.data` and `head.onnx.data` as **external tensor data**.
   A consumer that ships only `encoder.onnx` + `head.onnx` will not load.
2. **Artifacts are byte-reproducible against the checkpoint.** `tokenizer.json` and
   `rl_agent_config.json` in the export are **byte-identical** (matching SHA256) to the checkpoint
   files, and `model.safetensors` hashes to
   `9d628fd971b700382ac6f65920a86f149777b2e748e0c955fb3b19695aa8f204` — the same value the
   parity fixture independently records for the source weights.

### Python is maintainer-side only

The export requires Python with `torch`, `transformers`, `onnx`, `onnxruntime`, `onnxscript`,
`safetensors` and the `laya` package itself. That is **maintainer-side export only**. It is worth
stating precisely because it is measured, not assumed:

- The exported **artifacts are consumed from Node with no Python at all** — the cross-runtime check
  below ran real inference on these files under `node` alone.
- `onnxruntime-node@1.30.0` ships **prebuilt** binaries; `npm ci` produced
  `node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node` (298,848 bytes)
  plus `onnxruntime.dll` (28,754,232 bytes). **No `node-gyp`, no compiler, no WSL, no Docker.**
- `laya-ts/tests/package-e2e.mjs` asserts the consumer install works with `--omit=optional`, i.e.
  the library itself does not even require onnxruntime to be present.

**No consumer of the packaged artifact needs Python, model export, compilation, WSL or Docker.**

---

## Parity checks

### What upstream ships

The repository ships parity checks at four levels. All of these were found by reading the tree:

| Check | Path | What it compares |
| --- | --- | --- |
| Split-export verification | inside `laya-ts/scripts/export_onnx.py` (`_verify`) | torch vs ONNX, encoder+head |
| TS unit parity suite | `laya-ts/tests/{tokenizer,parity-sequence,flat,legend}-parity.test.ts` | TS runtime vs the Python reference behaviour |
| Cross-runtime tournament parity | `laya-ts/scripts/tournament_parity.py` + `laya-ts/examples/tournament.mjs` | PyTorch eager vs split ONNX in Node |
| Python ONNX gates | `tests/test_onnx*.py` (7 files) | ONNX graph, batch, long-context, truncation, language, sort, quantize |
| Machine numerics check | `verify/numerics_check.py` | RoPE bases, run-to-run noise floor, SDPA vs eager |
| Port parity lanes | `laya-java/`, `laya-go/`, `laya-dotnet/` | each port vs Python |

The upstream CI contract, read from `.github/workflows/`:

- `ci.yml:25-47` — the TypeScript lane on every PR: `npm ci`, `npm test -- --run`,
  `npm run test:package`. Node 20 and 22, ubuntu-latest.
- `ci.yml` also runs `ruff check ... laya-ts/scripts/` (`ci.yml:273`).
- `evals.yml:70` — a step literally named **"Torch/ONNX numerical parity"**, running
  `python -m pytest tests/test_onnx.py -q`. The comment above it (`evals.yml:65-69`) states this
  test "performs a real export and a numerical parity check", is skip-guarded on `onnxruntime`,
  and is the only automated check for torch↔ONNX parity and the dynamic-shape export.
- `laya-java`, `laya-go`, `laya-dotnet` each have their own parity matrices; the Go and .NET
  parity jobs are marked **advisory** (`continue-on-error`).

### What was run here, and the result

**1. The split-export verification — RAN, PASSED (3/3).** This is the check that matters most,
because it runs against the exact artifacts the Node runtime loads. Three passes are performed by
`_verify`: batch 2 at seq-len 16, batch 1 at seq-len 16, and batch 2 at seq-len 512 (past the
`local_attention=128` sliding window). Results, verbatim from the export log:

```
verify ok: torch vs onnx match within 1e-4 (logits 8.9e-07, act_probs 0.0e+00)
verify ok: torch vs onnx match within 1e-4 (logits 1.0e-06, act_probs 0.0e+00)
verify ok: torch vs onnx match within 1e-4 (logits 5.4e-07, act_probs 0.0e+00)
```

Worst observed logits difference `1.0e-06` against a `1e-4` threshold — four orders of magnitude of
headroom. `--no-verify` was **not** passed.

**2. Cross-runtime parity, PyTorch eager vs split ONNX in Node — RAN, PASSED.** The two documented
commands, run against the multilingual checkpoint and the export produced above:

```
python laya-ts/scripts/tournament_parity.py --model-dir <multilingual ckpt> --onnx-dir model-ml \
    --fixture tournament-python.json
node laya-ts/examples/tournament.mjs --model-dir model-ml \
    --fixture tournament-python.json --report tournament-node.json
```

Both exited **0**. The Node side is a real comparator, not a smoke test: it requires the recorded
inputs (`state`, `questions`, `kwargs`) to match **exactly** by JSON serialisation, compares answer
fields against a `0.001` tolerance, compares `tournament` metadata **exactly**, verifies the loaded
ONNX files against the fixture's SHA256 digests, and sets `process.exitCode = 1` on any mismatch.
Its verdict:

```json
{"passed":true,"max_absolute_difference":0.00009999999999998899,"errors":0,
 "report":"E:\\tmp\\laya-investigation\\tournament-node.json"}
```

Four cases (`banking-default-group`, `mixed-group-8`, `nothing-to-narrow`, `banking-two-rounds`),
each through both the plain and tournament paths, including a three-call two-round narrowing case.
**0 errors.** Reference environment recorded in the fixture:
`{"python":"3.14.0","platform":"Windows-11-10.0.26200-SP0","laya":"0.4.6","torch":"2.14.1+cpu",
"transformers":"5.19.0","device":"cpu","backend":"eager"}`.

Node was also substantially faster than eager PyTorch on the same inputs, e.g.
`banking-default-group` plain 793 ms (Node/ONNX) vs 2,426 ms (Python/torch). That is a timing
observation from a small parity experiment, **not** a throughput benchmark — the fixture's own
`timing_note` says so.

**3. Weight-free upstream Python ONNX gates — RAN, PASSED (194 checks, 0 failed).** Six of the
seven `tests/test_onnx*.py` files build stub models and need **no weight download**. They are
**standalone scripts**, not pytest modules — each ends with a module-level
`sys.exit(1 if FAIL else 0)`, so collecting them under pytest raises `INTERNALERROR ... SystemExit: 0`.
Run as scripts they all pass:

| Script | Result | Exit |
| --- | --- | --- |
| `tests/test_onnx_batch.py` | 65 passed, 0 failed | 0 |
| `tests/test_onnx_lang_parity.py` | 20 passed, 0 failed | 0 |
| `tests/test_onnx_long.py` | 58 passed, 0 failed | 0 |
| `tests/test_onnx_quantize.py` | 16 passed, 0 failed | 0 |
| `tests/test_onnx_sort.py` | 18 passed, 0 failed | 0 |
| `tests/test_onnx_truncation_parity.py` | 17 passed, 0 failed | 0 |

**4. TS parity files inside `npm test` — RAN, PASSED.** `tokenizer-parity.test.ts` (40 tests),
`parity-sequence.test.ts` (14), `flat-parity.test.ts` (2), `legend-parity.test.ts` (8), and
`bpe-complexity.test.ts` (34, which includes "agrees with the previous algorithm on 20 000
randomised strings"). All green inside the 886-test run.

**5. `verify/numerics_check.py` — NOT RUN.** See **What is uncertain**.

**6. `python -m pytest tests/test_onnx.py -q` — RAN, PASSED (2 passed, exit 0, 875.65s).** This is
the upstream CI step literally named **"Torch/ONNX numerical parity"** (`evals.yml:70`). It
downloads the English checkpoint, performs a real export to a single `laya.onnx`, and checks the
exported graph at batch 1, 3 and 7 against the PyTorch model including the declared symbolic
shapes. Green. It also emitted a first-party correction to the model's confidence — see
**Quality caveat**.

### Checks that were NOT weakened, and one that had to be corrected

No check was disabled, bypassed, relaxed, or skipped to obtain a green result. Specifically:
`--no-verify` was never passed; the `1e-4` thresholds in the exporter were never edited; the
upstream test files were never modified; the npm test invocation was not filtered.

Two things that *looked* like failures and are not, recorded so they are not misread later:

- `run npm test` was **not** invoked as `npm test -- --run` (the CI form). The plain `npm test`
  still runs vitest in run mode and exited 0 with 886/886. The CI form adds nothing here.
- Running the six script-style ONNX tests under pytest fails with `INTERNALERROR` and exit 3. That
  is a **harness mismatch, not a test failure** — the correct invocation is `python tests/<file>.py`,
  which is how they were run and how they pass.

---

## Quality caveat

**Packaging the multilingual checkpoint does not make it a reliable default, and nothing in this
document should be read as claiming otherwise.** The runtime-availability work above is entirely
orthogonal to model quality. The upstream multilingual model card
(`convaiinnovations/laya-multilingual`, sha `1720e3e3357cfe1e281542e223f8273b0890ca34`) is explicit,
under a section headed **Limits**:

> - **Ships uncalibrated.** `temperature = [1.0, 1.0, 1.0]` with no per-option-count buckets. It is
>   systematically over-confident (mean confidence 0.75–0.83 against much lower accuracy). Refitting
>   one temperature per (question type, option count) on held-out data moves mean ECE
>   **0.314 → 0.106**. Do this on your own data before trusting the probabilities.
> - **Weaker on English** than the English checkpoint: 0.619 vs 0.684 macro across English suites.
>   Route rather than replace.
> - **Near chance on typed-decisions zero-shot** — 0.342, against a 0.318 random and 0.461
>   majority-class baseline. Fine-tune for a specific workflow; that is where the capability comes
>   from.
> - **Keep `choice` questions under ~20 options.** ...
> - Low-resource languages are weak, not fixed: Swahili 0.210, Tamil 0.250, Amharic 0.110.
> - Ordinal `score` questions are the weakest primitive (SST-5 0.282), and this checkpoint has a
>   **measured position bias on them**: it rarely picks the first-listed level, in any language,
>   including English (0 of 290 in one independent run, [#131](https://github.com/NandhaKishorM/laya/issues/131)).

The family card (`convaiinnovations/laya`) says the same thing in its own words:

> - **Base checkpoints are near chance on typed-decisions zero-shot** — 0.362 here and 0.352 for
>   multilingual, against a 0.318 random and 0.461 majority-class baseline. The 0.766 belongs to
>   the checkpoint fine-tuned on that benchmark's own training split. **Laya is a fast base to
>   specialise, not a zero-shot decision engine.**
> - **Ships over-confident:** Refitting one temperature per (question type, option count) moves mean
>   ECE **0.466 → 0.081** (`laya`) and **0.314 → 0.106** (`laya-multilingual`). Do this on your own
>   data before trusting the probabilities.
> - **`action.act_probability` carries no usable signal yet** ... Gate on `confidence` instead.

The measured table on the family card puts the multilingual checkpoint at **accuracy 0.342,
Brier 0.439, ECE 0.285** on typed-decisions, i.e. **below the 0.461 majority-class baseline**.

### The library itself says the confidences are uncalibrated

This is not only a model-card claim. Running the upstream ONNX gate above made the **library emit a
calibration warning of its own accord**, unprompted, on the base English checkpoint — verbatim from
the pytest run:

```
RuntimeWarning: laya: this checkpoint ships invalid temperatures or values outside [0.5, 5];
using choice:11+=0.10058280825614929 -> 0.5. Treat confidence from the affected entries as uncalibrated.
```

```
RuntimeWarning: laya ONNX: this checkpoint ships temperatures outside [0.5, 5] which would distort
confidence; clamping choice:11+=0.10058280825614929 -> 0.5. Treat confidence from the affected
buckets as uncalibrated.
```

These are first-party strings, emitted from `laya/agent.py:742`, `laya/calibrate.py:627` and
`laya/onnx_agent.py:218`. The shipped temperature for the `choice:11+` bucket is
`0.10058280825614929`, which the library judges **outside the valid `[0.5, 5]` range**, so it
**clamps it to `0.5`** and tells the operator in the same breath that the resulting confidence is
uncalibrated.

**The TypeScript runtime this directive is about behaves identically** — it is not a Python-only
concern. `laya-ts/src/agent.ts:435` and `:438` run every temperature through `clampTemperature`
(defined at `laya-ts/src/common.ts:399`), and `laya-ts/src/agent.ts:455-456` emits the same
sentence verbatim:

```ts
`laya: this checkpoint ships invalid temperatures or values outside [${TEMP_MIN}, ${TEMP_MAX}]; ` +
`using ${rejected.join(", ")}. Treat confidence from the affected entries as uncalibrated.`,
```

That is a console warning on the `stderr` stream — the same channel the TS suite already uses for
its `laya: WebGPU encoder run failed ... falling back to WASM` notice. **An extension that surfaces
`confidence` from this checkpoint would be surfacing a value its own runtime has already
disclaimed, and the disclaimer is only a log line.** The `confidence` field should therefore not
reach a model-visible tool result as if it were calibrated until DEC-08 says otherwise.

**This is the strongest available evidence for the DEC-08 position, and it comes from upstream's
own code rather than from this investigation's judgement.**

**Therefore: the multilingual checkpoint remains an unqualified candidate.** It stays behind the
existing DEC-08 evaluation gate, which in this repository is
`docs/tool-mode/specs/Tool_Mode_DSH_Implementation_Spec_v1.2.md:1321`:

> **DEC-08. Quality evaluation.** Include held-out examples for clear choices, ambiguous choices,
> contradictory/insufficient state, off-domain text, multilingual content and choice-order
> permutations. Report accuracy, abstention coverage, Brier score and calibration error where
> probabilities are available. Set thresholds in reviewed evaluation configuration before observing
> the held-out outputs. Separate schema/API conformance from model accuracy; a domain-specific
> checkpoint's results do not prove all decision tasks are solved.

and which `docs/tool-mode/TRACEABILITY.md:300` still records as:

```
| DEC-08 | Quality evaluation. | 18. Dedicated decision models and Needle 3 | NOT_RUN | — |
```

**DEC-08 remains `NOT_RUN` after this work.** Nothing here advances it: a successful build and a
passing numerics check demonstrate that the artifact is *loadable and faithful to its source*, not
that its decisions are *good*. A packaging step that made the checkpoint reachable while implying
it was a dependable default would be a correctness error, and the model card's own numbers are the
evidence against it.

---

## What is uncertain

- **`verify/numerics_check.py` was not run.** It is the most thorough numerics check upstream ships
  — it validates the RoPE bases actually in use against those the checkpoint records, measures the
  float32 run-to-run noise floor, and compares SDPA against eager on the *unrounded* `(logits, act)`
  pair plus exact answer labels. It iterates over **all three** checkpoints
  (`models/laya`, `models/laya-multilingual`, `models/laya-typed-decisions`) from **local paths**,
  so running it needs a further ~2.2 GB of checkpoint download (English 803.6 MB and
  typed-decisions 803.6 MB are still absent; only multilingual is cached). It was not run for
  budget reasons, **not** because it failed or was skipped in the code. Its coverage is partly
  substituted by the export's own verification and the cross-runtime parity run above, but the
  RoPE-base assertion and the SDPA-vs-eager comparison are **not** covered by anything that ran.
- **`python -m pytest tests/test_onnx.py -q`** — **resolved: it was run and passed** (2 passed,
  exit 0). See the addendum.
- **Only the multilingual checkpoint was exported.** The English and typed-decisions exports were
  not attempted, so their split-export artifact hashes and any checkpoint-specific export behaviour
  are unmeasured. (The English checkpoint *was* downloaded and exported to a single `laya.onnx` by
  `tests/test_onnx.py`, but not to the split `encoder.onnx` + `head.onnx` form the TS runtime uses.)
- **The pipeline was exercised on exactly one host** — Windows 11 `10.0.26200`, x64, Node
  `v24.11.0`, npm `11.6.1`, Python `3.14.0`. Upstream CI builds the TypeScript lane on **Node 20
  and 22 / ubuntu-latest**, which was not reproduced; the `PYTHONIOENCODING` defect is
  Windows-console-specific and would not appear there.
- **`npm test` ran without a pinned Node version** beyond this host's `v24.11.0`.
- **The Windows sandbox limitation recorded in `docs/tool-mode/SLICE-5-QUALIFICATION.md`**
  (`workspace-write` blocked, Win32 5 `ACCESS_DENIED`) is unrelated to this work but still stands;
  nothing here was run under `workspace-write`.
- **Model-asset redistribution.** Apache-2.0 covers the code. The checkpoint repository is public
  and the model card ends `Apache 2.0 · Convai Innovations`, but I did **not** locate a separate
  licence file inside the Hugging Face checkpoint repository itself, so the weights' licensing rests
  on that card statement and the family README. If a vendored artifact is to redistribute the
  1.29 GB of ONNX, that is worth a second look rather than an assumption. (Consistent with
  decision `Licensing placement` / "Shipped-package licensing" in this repo's memory.)
- **`laya-ts` on npm** — the name 404s (re-verified: `npm error code E404 ... GET
  https://registry.npmjs.org/laya-ts - Not found`). Whether upstream *intends* to publish it under
  that name is unknown; `package.json` has `prepack` wired to `npm run build`, which implies intent
  to publish something. **This is exactly why the directive's "do not impersonate upstream
  publication" constraint applies**: a scoped/vendored artifact must not be named `laya-ts` on the
  public registry.

---

## Exact reproduction

Everything below was run on the host described in **Build attempt → Environment**. `$B` is a scratch
root outside the repository; `E:\tmp\laya-investigation` was used here.

### 1. Clone and pin

```powershell
$B = "$env:TEMP\laya-investigation"
New-Item -ItemType Directory -Force -Path $B | Out-Null
Set-Location $B
git clone --depth 1 https://github.com/NandhaKishorM/laya.git laya
Set-Location laya
git fetch --unshallow
git rev-parse HEAD          # expect c73908d96ff73c0062c340a11bf7c54ec7d8bc4d
git describe --tags --exact-match   # expect v0.4.6
```

### 2. Build and test the TypeScript package

```powershell
Set-Location "$B\laya\laya-ts"
npm ci                      # 115 packages, 0 vulnerabilities
npm run build               # exit 0; dist/ gets 26 files
npm test                    # exit 0; 35 files / 886 tests pass
npm run test:package        # exit 0; packs + installs into an external ESM TS consumer
```

### 3. Build the maintainer-side Python environment

```powershell
$venv = "$B\venv"
python -m venv $venv
$py = "$venv\Scripts\python.exe"
& $py -m pip install torch transformers onnx onnxruntime safetensors pytest
& $py -m pip install -e "$B\laya[onnx]"     # adds onnxscript, needed by torch.onnx.export
```

Resolved on this host: `torch 2.14.1+cpu`, `transformers 5.19.0`, `onnx 1.23.2`,
`onnxruntime 1.31.0`, `onnxscript 0.7.2`, `safetensors 0.8.0`, `laya 0.4.6` (editable).
`HF_HOME` must point somewhere with room for ~2.2 GB; the default `C:\Users\<user>\.cache\huggingface`
had only 1.2 GB free here, so it was redirected:

```powershell
$env:HF_HOME = "$B\hf-cache"
```

### 4. Export the multilingual checkpoint

```powershell
$env:PYTHONIOENCODING = 'utf-8'          # REQUIRED on a non-UTF-8 Windows console; see Export attempt
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = '1'
Set-Location "$B\laya"
& $py "laya-ts\scripts\export_onnx.py" --repo convaiinnovations/laya --subfolder multilingual --out-dir model-ml
```

Expect three `verify ok: torch vs onnx match within 1e-4 ...` lines and
`wrote model-ml\encoder.onnx and model-ml\head.onnx`, exit 0. Writing `PYTHONIOENCODING` is the
**only** difference from the failing run. Do not add `--no-verify`.

### 5. Cross-runtime parity

```powershell
$ck = "$B\hf-cache\hub\models--convaiinnovations--laya\snapshots\7b928d828b7b0e022f929d9bd2e44165aa270148\multilingual"
Set-Location "$B\laya"
& $py "laya-ts\scripts\tournament_parity.py" --model-dir $ck --onnx-dir "$B\laya\model-ml" --fixture "$B\tournament-python.json"
node "laya-ts\examples\tournament.mjs" --model-dir "$B\laya\model-ml" --fixture "$B\tournament-python.json" --report "$B\tournament-node.json"
```

Expect `{"passed":true,...,"errors":0}` from the Node step, exit 0.

### 6. Weight-free upstream ONNX gates

```powershell
Set-Location "$B\laya"
foreach ($f in "test_onnx_batch.py","test_onnx_lang_parity.py","test_onnx_long.py",
               "test_onnx_quantize.py","test_onnx_sort.py","test_onnx_truncation_parity.py") {
  & $py "tests\$f"; ">>> $f exit=$LASTEXITCODE"
}
```

Run them as **scripts**, not under pytest. Expect 65/20/58/16/18/17 passed, all exit 0.

### 7. The gate that needs more weights

```powershell
Set-Location "$B\laya"
& $py -m pytest tests/test_onnx.py -q     # downloads convaiinnovations/laya (English, 803.6 MB) first
```

### Evidence captured during this investigation

Raw logs were kept under `$B\evidence\` and are not part of the repository:

| File | Content |
| --- | --- |
| `01-npm-ci.log` | `npm ci` output |
| `02-npm-run-build.log` | `npm run build` output |
| `03-npm-test.log` | `npm test` output (886 tests) |
| `05-npm-test-package.log` | `npm run test:package` output |
| `04-pip-install.log`, `06-pip-install-laya.log` | Python environment resolution |
| `07a-export-multilingual-FAILED-cp1252.log` | **the failing export, verbatim** |
| `08-export-multilingual-utf8.log` | the successful export with all three verify lines |
| `09-tournament-parity-python.log` | Python reference run |
| `10-tournament-parity-node.log`, `10-tournament-node-report.json` | Node comparison, `passed: true` |
| `11-script-test_onnx_*.log` | the six weight-free ONNX gates |
| `hf-model-card.md`, `hf-model-card-multilingual.md` | the two model cards quoted above |

---

## Addendum — `tests/test_onnx.py`: RAN, PASSED

The one gate that needed more weights finished **after** the sections above were written. It
**passed**, so the "what is uncertain" entry above is now closed:

```
python -m pytest tests/test_onnx.py -q
...
2 passed, 10 warnings in 875.65s (0:14:35)
```

**Exit code: 0.** This is the upstream CI step named "Torch/ONNX numerical parity"
(`.github/workflows/evals.yml:70`). It performed a real export of the English checkpoint to a
single `laya.onnx` and checked the exported graph at batch 1, 3 and 7 against the PyTorch model,
including the declared symbolic shapes.

**It also produced the single most useful quality datapoint in this investigation** — see below.

---

## Bottom line

The directive's step 1 (pin), step 2 (build), step 3 (fetch + export), step 4 (preserve and run
parity) and step 6 (report precisely) are all satisfied with executed evidence:

- The source is found, pinned to `c73908d96ff73c0062c340a11bf7c54ec7d8bc4d`, and Apache-2.0.
- It **builds** (exit 0) and its **own suite passes** (886 tests) — there is no build blocker.
- The **export runs** and its numerical-parity check passes 3/3, and an independent cross-runtime
  comparison passes with 0 errors.
- The **specific blocker is narrow and named**: `torch.onnx`'s U+2705 progress glyph against a
  `cp1252` stdout, fixed by `PYTHONIOENCODING=utf-8`. It is a documented-command gap, not a source,
  build, export or numerics defect — and **a registry 404 was never the blocker.**

Step 5 (package a prebuilt Node consumer through an independent Laya TMX extension) is **not
performed by this document**. The technical preconditions are now demonstrated — a built ESM
package, a verified 1.29 GB split-ONNX export, prebuilt `onnxruntime-node` binaries needing no
compiler, and a package-e2e test proving consumption with optional deps omitted — but the packaging
itself depends on decisions this document does not own: where assets are acquired and cached
(`src/asset-acquisition.ts`), how shipped-package licensing is recorded (decision
**Licensing placement**), and how a model that has not passed DEC-08 is presented to a user.
Those are the Lead's calls, and the quality caveat above is the input to them.
