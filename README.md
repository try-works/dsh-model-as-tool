# dsh-model-as-tool

Expose on-device models to a DSH agent as **tools**, rather than as chat endpoints.

Each model is wrapped by a **contract** — a stable name with explicit input and output
schemas, semantics, limits and unsupported cases — and bound to one or more
**implementations**. The agent sees `lang_detect` and `stt_transcribe`; which model serves
them is a binding decision, not something the schema changes.

## Implementation status — read this first

**The specifications are not fully implemented.** The normative specification has 227
requirements and the verification checklist adds 90 acceptance tests; **3 are done, 96 are
partial, 5 are blocked and 213 were never started.**

> **[`verification/FINAL-REPORT.md`](verification/FINAL-REPORT.md) is the honest summary**
> — generated from the recorded evidence, it states what genuinely stands with the
> verification method for each claim, names the concrete condition behind every blocked
> item, and says explicitly what it does not claim.

That report is generated, not written, precisely because a hand-maintained summary of 317
tracked items drifts from its data — and the drift is always in the flattering direction.

## Published packages

| Package | Version | What it is |
| --- | --- | --- |
| [`@try-works/dsh-model-as-tool`](https://www.npmjs.com/package/@try-works/dsh-model-as-tool) | 0.1.3 | The DSH plugin: catalogue, contracts, dispatch and the MCP surface |
| [`@try-works/tool-mode-contracts`](https://www.npmjs.com/package/@try-works/tool-mode-contracts) | 0.1.0 | Model-free contract definitions |
| [`@try-works/tool-mode-extension-sdk`](https://www.npmjs.com/package/@try-works/tool-mode-extension-sdk) | 0.1.0 | The public API an extension is built against |
| [`@try-works/extension-desert-ant-tongue`](https://www.npmjs.com/package/@try-works/extension-desert-ant-tongue) | 0.1.0 | Language detection, pure JavaScript, runs on Windows x64 |
| [`@try-works/extension-desert-ant-voz`](https://www.npmjs.com/package/@try-works/extension-desert-ant-voz) | 0.1.0 | Speech-to-text through ONNX Runtime, runs on Windows x64 |

## Quick start

```bash
npm install @try-works/dsh-model-as-tool
```

Enable the plugin in your DSH configuration, then:

```
model_tools            # list every catalogued model and why an unavailable one cannot run
model_tools { "action": "describe", "model": "tongue" }
```

## The one architectural rule

**The host contains no model-specific code, and there is no private built-in adapter
path.** Every model lives in an independently versioned extension package that depends
only on the published extension SDK.

This is enforced rather than intended: `npm run verify:architecture` fails the build on a
model name, a model branch or a model import in host source, and on any extension that
imports the host or DSH directly. The published artifact is checked the same way — the
installed `lib/` is read to confirm the model-specific adapters are absent from it.

The rule exists because the alternative is a plugin that knows about whichever model was
written first, and that quietly stops working for every model added afterwards.

## Verifying it yourself

```bash
npm run verify           # typecheck, build, tests, architecture, MCP conformance, inventory
npm run release:gate     # exits nonzero while any mandatory gate is not done
```

**`release:gate` is deliberately red**, and it is kept separate from `verify` on purpose.
Collapsing them would make one of them lie: the suite passing means *the code that exists*
is correct, and the release gate failing means *the specifications* are not finished. Both
are true at once, and a single command would have to misreport one of them.

Other checks:

| Command | What it proves |
| --- | --- |
| `npm test` | 721 tests across five packages |
| `npm run verify:architecture` | The host holds no model-specific code |
| `npm run verify:built` | **A real inference through the built artifact** — `lang_detect` on German text must return `de` |
| `npm run verify:mcp` | 39 checks validating SAVED FIXTURES against the pinned `2026-07-28` schema — not live server conformance |
| `npm run verify:verification` | The evidence never reports a pass for a partial requirement |
| `npm run traceability` | Regenerates the requirement-by-requirement traceability table |

## What runs on this host

Two of the eighteen catalogued models run here, and the other sixteen do not:

- **Tongue** — pure JavaScript, weights bundled (2 MB), no runtime or accelerator needed.
- **Voz** — `onnxruntime-node` on CPU.

The other sixteen are unavailable for concrete reasons: most LiteRT/TFLite models have no
`win32-x64` native build, `title` is Apple-only (Core ML / MLX, no JS SDK), and six are
closed beta with no shipping SDK.

## What is unfinished, and what is actually blocked

Most of what is unstarted is **implementation with a known route**, not a missing artifact:
the extension-host worker bridge (`EXT-20`), DSH PTC composition (`CODE-01..03`), the
provider-neutral LLM broker and recipe interpreter (`HLM`, `RCP`), and multimodal
EmbeddingGemma 2 inference (`MOD-01..`). DSH publishes its PTC runtime sources, `MODEL-04`
permits a managed native Windows executable, and the Laya TypeScript source and checkpoint
are obtainable even though the npm name is not.

**Genuinely external, stated narrowly:**

- **npm `laya-ts` returns 404** — the npm *route* is unavailable. This does not establish
  that the TypeScript implementation or the checkpoint is unavailable, and the
  maintainer-side source build `DEC-02` describes has not been attempted.
- **The Laya multilingual checkpoint ships uncalibrated** — packaging it does not make it a
  reliable default. That is a qualification result to report, not a blocker to work around.
- **Target-platform qualification** — Windows clean-install and multi-client
  interoperability have not been run on an authorized machine.

## MCP compatibility

This targets MCP revision **`2026-07-28`**. The published `@modelcontextprotocol/sdk` does
*not* support that revision — it caps at `2025-11-25` — so the wire layer is a
schema-conformant adaptation checked against the pinned upstream schema rather than an SDK
wrapper. The pinned schema, its commit and its SHA-256 hashes are recorded in
`docs/tool-mode/specs/`.

**Scope of that check, stated precisely:** the 39 probe checks validate **saved
request/response fixtures** against the pinned schema. The probe reads frozen files from
disk and never starts the server — its own documentation says so. It is a useful
schema-fixture test and it is **not** live server conformance. Live conformance against a
running server is not yet demonstrated.

## Licensing

The Desert Ant Labs models are covered by the **Desert Ant Labs Source-Available License
1.0** — source-available, *not* open source. Redistribution is not permitted; attribution
is required; a commercial licence applies above the per-platform, per-model
active-device threshold.

Both shipped extensions declare all five licence layers, and a package that declares
nothing is treated as telemetry-bearing rather than network-free — silence about telemetry
is not an absence of telemetry.

## Repository layout

```
packages/dsh-model-as-tool/       the plugin: catalogue, contracts, dispatch, MCP surface
packages/tool-mode-contracts/     model-free contract definitions
packages/tool-mode-extension-sdk/ the public extension API
packages/extension-*/             independently versioned model packages
docs/tool-mode/specs/             the specification, and the pinned MCP schema
verification/                     generated evidence, and FINAL-REPORT.md
```
