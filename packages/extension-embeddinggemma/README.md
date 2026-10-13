# @try-works/extension-embeddinggemma

A first-party Tool Mode extension for **EmbeddingGemma 2** (`google/embeddinggemma-2` through a
pinned ONNX conversion). It is an independent track: it shares no adapter, runtime or code with
the Desert Ant packages or with any other model package, and like every other package it reaches
the host only through `@try-works/tool-mode-extension-sdk` (EXT-02).

## What this build does

- Declares the model deployment with the three separately loadable asset groups MOD-02 requires:
  `text-backbone`, `vision-encoder`, `audio-encoder`. A text-only call must not fetch or load the
  vision and audio weights.
- Declares the three tool contracts this package OWNS (EXT-21), each with a closed, compilable
  JSON Schema under `schema/`:
  `multimodal_embed`, `semantic_similarity`, `semantic_rank`.
- Implements the deterministic vector operations those tools rest on (`src/vectors.ts`): finite
  and width checks, embedding-space identity, L2 normalization and its idempotence, the
  reduced-width route (truncate then renormalize), cosine similarity, stable ranking with an
  explicit tie-break, and deterministic greedy de-duplication.
- Validates a call's arguments against MOD-05, MOD-06 and MOD-08 before any model work: unique
  non-empty item ids, non-empty bounded text, purpose/role compatibility, the documented widths,
  and the declared per-call limits.

## What this build does NOT do

**It runs no inference.** No ONNX session is created, nothing is downloaded, and no embedding is
computed. Consequently:

- `inspect()` reports `unprepared` with the reasons — the provider-level form of the lifecycle's
  `needs-preparation` — and reports **no features**, because a feature list is a claim about what
  can run;
- `load()` refuses, naming the asset group the host did not prepare or the runtime package that
  does not resolve, and refuses even when everything declared is present;
- `invoke()` fails with the reason and states that no vector was computed.

`semantic_classify`, `semantic_deduplicate` and `media_find_moments` belong to the same
requirement family but are **not declared**: a caller-facing tool name that nothing serves would
advertise a capability this build does not have (MOD-15, MOD-20). The grouping maths
`semantic_deduplicate` needs already exists in `src/vectors.ts` and is tested.

Nothing here is model evidence. MOD-16 (pinned golden fixtures), MOD-17 (real cross-modal
retrieval), MOD-18 (negative media paths), MOD-19 (measurements from the built package on Windows
CPU) all require the artifact this build does not yet run. `models.lock.json` records that state
explicitly rather than guessing: no revision, quantization profile or SHA-256 is written down,
because a digest that was never computed is indistinguishable from a verified one to every later
reader.

## Embedding space

EmbeddingGemma 2 produces 768-dimensional embeddings reducible to 512, 256 and 128. The rules
enforced in `src/vectors.ts`, mirrored from the host's `model-qualification` module because an
extension may not import host internals:

- a 384-dimensional MiniLM vector must not silently stand in for a 768-dimensional one
  (BASE-12) — the widths are compared, and the refusal names both and requires a re-index;
- the same model at a reduced width is a **different** space, not a smaller view of one (MOD-04);
- a normalization mismatch at equal width is refused, because a dot product over unnormalized
  vectors is not a cosine (MOD-03);
- two spaces whose recorded `embeddingSpaceId` differ, or where only one records one, are refused
  (MOD-03, MOD-14).

## Preparation

The host acquires and verifies the pinned bytes; the extension performs no network call of its
own, which is why `permissions.networkOrigins` is empty while `network.otherNetworkUse` is true.
The runtime route is `@huggingface/transformers` driving `onnxruntime-node` (the native CPU
execution provider), both declared as optional dependencies.

## Licensing

Five layers are declared in `tool-mode.extension.json`, with no gaps. Unlike the Desert Ant
packages, the **weights are Apache-2.0**: open source, and redistribution is permitted with
attribution. The declaration records what the model card states, citing it so a reviewer can read
the terms rather than trust the label.

## Commands

```powershell
npx tsc --noEmit -p packages/extension-embeddinggemma/tsconfig.json   # typecheck
npx tsc -p packages/extension-embeddinggemma/tsconfig.build.json      # build lib/
npx tsx --test packages/extension-embeddinggemma/tests/*.test.ts      # tests (build first)
```

The tests are two files with different jobs. `tests/vectors.test.ts` is deterministic arithmetic
over hand-written vectors. `tests/extension.test.ts` reads the package the way a host does —
through `discoverExtension`, as data, before importing any code — and then asserts the provider is
honest about what it cannot do. The manifest and the shipped schemas are checked against the code,
so the published description, the declared limits and the contract identities cannot drift.
