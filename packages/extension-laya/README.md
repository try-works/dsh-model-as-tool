# extension-laya — the Laya decision family (H5)

`decision_choose`, `decision_test` and `decision_score` over the pinned
multilingual Laya checkpoint, running through the **vendored** laya-ts
runtime.

## Vendored runtime + attribution

`vendor/laya-ts/` is the BUILT `dist/` of the upstream `laya-ts` package,
vendored verbatim (26 files: 13 modules + their declarations) from

- **github.com/NandhaKishorM/laya**, commit `c73908d96ff73c0062c340a11bf7c54ec7d8bc4d`
  (tag `v0.4.6`), Apache License 2.0 — the license text is vendored at
  `vendor/LICENSE.laya-ts`.

No unpublished npm dependency is required: the runtime ships inside this
package. The vendored code is upstream's built output, not a fork; any change
to it must be a new upstream pin recorded here.

## Honesty posture (DEC-08)

Every confidence this extension returns is the runtime's **uncalibrated**
probability mass, marked `calibrated: false` in every answer. The upstream
model card ships uncalibrated logits with a clamping warning; DEC-08 stays
NOT_RUN until a real calibration corpus measures it.

## Artifacts

`models.lock.json` pins the six-artifact split ONNX export (encoder + head
with external data, the tokenizer and the RL-agent config) by SHA-256; the
host acquires and verifies them through extensions-prepare, and the vendored
runtime re-verifies the digests at load (`createNodeProvider` with
`expectedSha256`).

## Qualification

`node scripts/qualify-laya.mjs` (env `LAYA_MODEL_DIR` overrides the default
`E:\tmp\laya-investigation\laya\model-ml`) verifies the six digests and runs
real decision calls, writing `docs/tool-mode/qualification/laya.json`.
