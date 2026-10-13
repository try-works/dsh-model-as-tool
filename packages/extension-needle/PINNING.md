# Pin: the Needle 3 native engine and weights

Everything on this page was **measured on this host on 2026-10-14**, not copied from a
README. Where a value was not measured it says so.

## Where the artifacts actually are

The review directive says "the official repository lists `windows-x86_64/needle.exe`". That
is true, and the repository in question is **not** the git repository:

| Looked for | Result |
| --- | --- |
| `GET https://api.github.com/repos/cactus-compute/needle/releases` | `200` with body `[]` — **there are no releases** |
| the git tree at commit `3da4261073199444f2e070800854436fbc31fb6a` | 81 entries, **no `.exe` and no `windows-x86_64/`** |
| `https://huggingface.co/api/models/Cactus-Compute/needle3` | **the folder is here**: `windows-x86_64/needle.exe`, `windows-arm64/needle.exe`, `wasm/needle.js`, `wasm/needle.wasm`, `needle3.cact`, and 15 other platform folders |

The git repository's `needle/agent/fetch.py` confirms the arrangement:

```python
ENGINE_REPOS = {2: "Cactus-Compute/needle2", 3: "Cactus-Compute/needle3", WHISTLE: "Cactus-Compute/whistle"}
ENGINE_VERSIONS = {2: "2.0.4", 3: "3.3.1", WHISTLE: "2.0.0"}
PLATFORMS = ("macos-arm64", "linux-x86_64", ..., "windows-x86_64", "windows-arm64", "wasm", "wasm-component")
```

`download_platform()` builds `{repo}/resolve/.../{platform}/{file}` paths. There is also a
Python wheel per platform at `python/cactus_needle-<version>-py3-none-win_amd64.whl`, whose
payload under `needle/` is a **shared library** (`libneedle.dll`), not an executable — the
wheel route is a different integration and was not taken.

## Pinned

**HuggingFace repository revision** `93e88ede867e4311c39151285e74df513e4b835b`
(`Cactus-Compute/needle3`). The digests below are meaningful only relative to this revision,
which is why every URL resolves that sha rather than `main`.

| Artifact | URL | Bytes | SHA-256 |
| --- | --- | --- | --- |
| `needle.exe` | `https://huggingface.co/Cactus-Compute/needle3/resolve/93e88ede867e4311c39151285e74df513e4b835b/windows-x86_64/needle.exe` | `1,569,280` | `47cd411a022d22e393d87ce091848fd446e6d25df2ce31b12a7328337557c85b` |
| `needle3.cact` | `https://huggingface.co/Cactus-Compute/needle3/resolve/93e88ede867e4311c39151285e74df513e4b835b/needle3.cact` | `35,335,380` | `c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38` |

All four requested URLs answered `HTTP 200`. Nothing 404'd.

## Inspected but deliberately not pinned

| Artifact | Bytes | SHA-256 | Why not pinned |
| --- | --- | --- | --- |
| `windows-x86_64/needle.h` | `4,528` | `a27dac4b3239eead91d124b7f7dbce5495c13019903fd817b68c16d39b055a99` | read for the engine contract; not loaded at runtime |
| `wasm/needle.js` | `63,072` | `964681b2a5ec3c4db2f06e45a5b60c8981a7d4ab4cac16ef6bf5b1988657a5f1` | the alternative qualification route; the directive states WASM is additional, not a prerequisite |
| `wasm/needle.wasm` | `929,343` | not downloaded | listed upstream; recorded so its absence is a stated fact |
| `windows-arm64/needle.exe` | `1,357,824` | not downloaded | this package declares `win32`/`x64` only |

## The two engine versions disagree

`needle/agent/fetch.py` at source commit `3da4261073199444f2e070800854436fbc31fb6a` names
engine version **`3.3.1`** for generation 3. The pinned revision's own `config.json` says:

```json
"model_type": "needle",
"engine_version": "3.1.0",
```

Both are recorded in `models.lock.json` and neither is silently preferred. The practical
consequence is that "the pinned engine revision" cannot be stated as a single version string:
what is actually pinned is **the artifact bytes**, which is why the SHA-256 is the identity
this package verifies and the version strings are annotations.

The same `config.json` also records the model shape and quantisation, which is useful for
recognising a substituted artifact:

```json
"total_parameters": 121021910,
"num_hidden_layers": 20,
"quantization": { "method": "cactus-quants", "scheme": "embedding=4,mhc=4,default=2", "group_size": 128 }
```

## Licence

`GET https://api.github.com/repos/cactus-compute/needle` reports
`"license": { "spdx_id": "Apache-2.0", "name": "Apache License 2.0" }`, and the repository's
`LICENSE` is 11,358 bytes — the Apache-2.0 text. The HuggingFace model repository ships a
`LICENSE` of the same size. **Apache-2.0 is OSI-approved open source and permits
redistribution**, which is why the weights layer in `tool-mode.extension.json` records
`redistribution: "permitted"` rather than the `not-permitted` the Desert Ant packages must
use.

The identification is repository-level. The individual source files carry no per-file Apache
header, so this is not per-artifact provenance and an auditor should read the licence text.

## Telemetry: a control that does not apply to this artifact

`needle/_telemetry.py` in the git repository publishes anonymous usage counts to a Supabase
endpoint, honouring `NEEDLE_TELEMETRY=0`, `DO_NOT_TRACK` and `CI`. **That module is Python
wrapper code and is not part of `needle.exe`.** Search the pinned binary and there is no
`cactuscompute`, no `huggingface`, no `supabase` and no HTTP endpoint at all — the only URL
string in it is `http://127.0.0.1:%d`, which is its own `--serve` server.

So the honest statement is not "telemetry controls were preserved" but **"the engine has no
telemetry to control, and the controls documented for the wrapper do not apply to this
artifact"**. The bridge's scrubbed environment removes `NEEDLE_TELEMETRY` and `DO_NOT_TRACK`
regardless, so nothing depends on this finding either way.

## The capability that IS in the binary: a listener

`needle.exe` imports from `WS2_32.dll` and its strings include `WSAStartup`, `socket`, `bind`,
`listen`, `--serve`, `--port` and `http://127.0.0.1:%d`. The engine ships an HTTP server.

This package never starts it, and the matter is not left to discipline:
`assertNoListenerArgument` in `src/process-bridge.ts` **refuses** `--serve` and `--port`
(including `--port=8080`) before any process is spawned, and a test asserts the refusal. The
listener is also the reason the provider is process-per-call rather than session-based: the
only reset the CLI product exposes is `POST /reset` on that server.

## What is NOT yet done

- The digests were obtained through an operator-set path in a scratch directory. The
  **host-driven acquisition path has not been exercised** against these URLs.
- No second revision was fetched, so the pin has not been shown to *fail* on a different
  artifact — only to match the one it was computed from.
- The WASM route is unqualified.
