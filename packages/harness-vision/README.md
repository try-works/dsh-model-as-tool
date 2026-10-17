# @try-works/harness-vision

The `describe_image` declarative harness-model package (HLM-12, RCP-01).
Recipes-only: this package ships no executable code; the host interprets the
recipe through the controlled harness-model path.

## Recipe provenance

The shipped `recipes/describe-image.json` is a COPY of the host's builtin
declarative recipe (`packages/extension-declarative-recipes/recipes/describe-image.json`).
A sync test asserts byte-equality so the two can never drift.

## Naming deviation (recorded, deliberate)

The spec's proposed name is `@try-works/tool-mode-harness-vision`; this package
is published as `@try-works/harness-vision` to match the repo's current
`harness-*` layout. The deviation is recorded in the SPEC-AUDIT ledger.

## Licensing and telemetry honesty (LIC-02/04)

No weights, no engine and no SDK ship here: the execution resource is the
host-approved harness model. `permissions.harnessModel` is a capability
REQUEST, not a grant; the actual provider's network use is governed by the host
executor profile, not by this package's empty `networkOrigins` list.
