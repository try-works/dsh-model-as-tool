# @try-works/extension-desert-ant-voz

First-party Tool Mode extension implementing the standard
`tool-mode/stt_transcribe` contract on the Desert Ant Labs Voz speech model,
with honest partial-coverage reporting.

## Naming deviation (recorded, deliberate)

The spec's proposed package names use the `@try-works/tool-mode-*` prefix; this
package is published as `@try-works/extension-desert-ant-voz`. The name is NOT
being renamed: the repo's junction/packaging matrix and the host's legacy model
catalog resolve this exact name. The deviation is recorded in the SPEC-AUDIT
ledger.

## Licensing and telemetry honesty (LIC-02/03/04)

- `licenses.code` is MIT; the Voz weights are Desert Ant Labs Source-Available
  1.0 (NOT open source, redistribution not permitted, attribution required) —
  recorded per layer in the manifest.
- `permissions.nativeCode: true` and `permissions.inputFiles: true` are
  truthful: Voz runs ONNX Runtime and reads an audio file. No secrets are
  declared because nothing here reads a credential.
- The package makes no network claims beyond its declared manifest surface.
