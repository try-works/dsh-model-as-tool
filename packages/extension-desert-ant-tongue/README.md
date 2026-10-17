# @try-works/extension-desert-ant-tongue

First-party Tool Mode extension implementing the standard `tool-mode/lang_detect`
contract on the Desert Ant Labs Tongue model (TOOL-03).

## Naming deviation (recorded, deliberate)

The spec's proposed package names use the `@try-works/tool-mode-*` prefix; this
package is published as `@try-works/extension-desert-ant-tongue`. The name is
NOT being renamed: the repo's junction/packaging matrix and the host's legacy
model catalog resolve this exact name, and a rename would break that wiring.
The deviation is recorded in the SPEC-AUDIT ledger.

## Licensing and telemetry honesty (LIC-02/03/04)

- `licenses.code` is MIT; the Tongue weights are Desert Ant Labs
  Source-Available 1.0 (NOT open source, redistribution not permitted,
  attribution required) — recorded per layer in the manifest.
- `network.requiredTelemetry: true` is a REAL declaration: the Desert Ant SDK
  requires a monthly active-device count. This package does not claim to be
  network-free, and suppression would breach the licence (LIC-04).
