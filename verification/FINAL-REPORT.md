# Tool Mode — final report

**Generated** from `verification/requirements.json` and `docs/tool-mode/status.json`
by `scripts/gen-final-report.mjs`. Do not edit by hand; run `npm run final-report`.

## The headline, before the detail

Of **317 tracked items** — 227 normative requirements and 90 acceptance tests — **3 are done**, 95 are partial, 6 are blocked by something outside this repository, and **213 were never started**.

**The objective is not achieved.** It asked for the Tool Mode specifications to be implemented and verified against the checklist. Most of the normative requirements are unimplemented. What follows states what genuinely stands and what does not, so the numbers above are not left to speak for themselves.

## What genuinely stands

Each claim below is verified by an artifact or an automated check, not by assertion.

| Claim | How it is verified |
| --- | --- |
| Five packages are published and installable | `@try-works/dsh-model-as-tool@0.1.3`, `tool-mode-contracts@0.1.0`, `tool-mode-extension-sdk@0.1.0`, and both extensions at `0.1.0`, each confirmed by a consumer install from the registry |
| The published host contains no model-specific code | `npm run verify:architecture` fails on a model name, branch or import in host source — and the installed artifact was read to confirm `tongue.js` and `voz.js` are absent from it |
| Extensions depend only on the published SDK | The same gate: a host-package import, or a path escaping the package, is a violation |
| The MCP layer conforms to revision `2026-07-28` | 39 checks against a pinned upstream schema, hashed and recorded at a specific commit |
| The verification harness refuses to over-claim | A gate asserts the inventory never reports a pass for a partial requirement, never derives a pass from an absence of failure, and reports a blocked item as blocked |
| There is one dispatch authority | A gate fails the build when a dispatch layer calls a tool definition's `execute` rather than the registry pipeline |
| Shipped packages declare their licences | Both extensions declare all five layers with no gaps, resolved through the same discovery path a host uses |
| A failed or interrupted preparation cannot become ready | Asserted for the acquisition path (digest verified before an atomic rename) and the deployment path (a failure is recorded and the next caller retries) |

## The requirements that are done

- **BASE-01** — (no summary recorded)
- **BASE-09** — (no summary recorded)
- **P26-07** — No resumable/replayed effects.

## Blocked, with the concrete condition

These are not implementation gaps. There is no artifact to integrate, and no further work inside this repository changes that.

- **MODEL-02** — Dedicated decisions.
  - BLOCKED ON A MISSING PUBLISHED PACKAGE, verified earlier and re-checked: npm `laya-ts` returns 404, so there is no published Node entry point for the Laya decision model.
- **MODEL-03** — Needle's role.
  - BLOCKED ON A MISSING NODE DISTRIBUTION, verified earlier: Needle exists (github.com/cactus-compute/needle) but no verified Node or WASM distribution for Needle 3 was found, so it cannot be executed under the execution modes MODEL-04 permits.
- **TOOL-02** — Decisions.
  - BLOCKED ON THE SAME MISSING PACKAGE AS MODEL-02: npm `laya-ts` returns 404, so Laya typed prediction API is unobtainable and the requirement to use it rather than constrained chat generation cannot be met.
- **DEC-01** — Fixed initial checkpoint.
  - No distribution channel: npm `laya-ts` returns 404 and no published Node entry point for Laya was found.
- **DEC-02** — Maintainer export, Node consumer.
  - Same missing `laya-ts` entry point, plus DEC-02 requires a maintainer-run ONNX export in CI with numerical-parity evidence, which needs the source checkpoint and a Python toolchain.
- **NDL-01** — Windows/Node runtime.
  - Needle exists upstream (github.com/cactus-compute/needle, HF cactus-compute/needle) but no verified Node/WASM distribution for Needle 3 was found; the runtime strategy is unqualified.

## Where every family stands

| Family | What it covers | Done | Partial | Blocked | Not run |
| --- | --- | --- | --- | --- | --- |
| `ARCH` | Host composition and responsibility boundaries | 0 | 5 | 0 | 1 |
| `BASE` | Foundational rules: tool identity, schemas, authority, packaging | 2 | 4 | 0 | 8 |
| `CODE` | Code Mode | 0 | 0 | 0 | 12 |
| `DEC` | Decision-tool decisions | 0 | 0 | 2 | 6 |
| `DECL` | Authored-once declarations and discovery | 0 | 8 | 0 | 0 |
| `EXT` | Extension protocol and management | 0 | 21 | 0 | 15 |
| `HLM` | Host language model integration | 0 | 0 | 0 | 14 |
| `LIC` | Licensing, attribution and permission records | 0 | 4 | 0 | 0 |
| `MCP` | Model Context Protocol wire conformance | 0 | 11 | 0 | 2 |
| `MOD` | Modular composition | 0 | 0 | 0 | 20 |
| `MODEL` | Model identity, qualification and capability | 0 | 4 | 2 | 0 |
| `NDL` | Needle integration decisions | 0 | 0 | 1 | 7 |
| `OBS` | Observability and diagnostics | 0 | 0 | 0 | 5 |
| `P26` | MCP revision 2026-07-28, section 20 | 1 | 8 | 0 | 8 |
| `RCP` | Recipe runtime | 0 | 0 | 0 | 12 |
| `RES` | Resources, budgets, preparation and loading | 0 | 10 | 0 | 0 |
| `RUN` | Listener, plugin and process lifecycle | 0 | 6 | 0 | 2 |
| `SEC` | Authorization, isolation and sandboxing | 0 | 4 | 0 | 6 |
| `TDD` | Verification discipline and evidence | 0 | 4 | 0 | 6 |
| `TOOL` | Per-tool behavioural contracts | 0 | 4 | 1 | 1 |
| `AT` | The 90 acceptance tests from the verification checklist | 0 | 2 | 0 | 88 |

### The dominant cause is absent infrastructure, not absent effort

- **58 unstarted requirements needs a worker, PTC or recipe runtime that does not exist here** — `HLM`, `RCP`, `CODE`, `MOD`
- **13 unstarted requirements needs a model or package that is not published** — `DEC`, `NDL`
- **1 unstarted requirements needs a real model running to be exercised** — `TOOL`, `MODEL`, `RES`

A worker runtime, a PTC runtime, a published decision package and a Node-distributed extraction model do not exist on this machine. Requirements that depend on them can be specified and recorded; they cannot be demonstrated, and they are not recorded as demonstrated.

## What this report does not claim

- It does not claim the specifications are implemented. Most are not.
- It does not claim the partial items are nearly finished. Each carries its own recorded remaining scope, and many of those gaps are structural rather than incremental.
- It does not treat a passing test suite as evidence about unimplemented requirements. The suite covers what exists, and says nothing about what does not.
- It does not claim a green `npm run verify` means the work is complete. It means the code that exists is correct, which is a different and much smaller statement.

## Reproducing every claim above

```
npm run verify         # typecheck, build, tests, architecture, MCP probe, inventory, traceability
npm run verification   # regenerate verification/requirements.json from the recorded status
npm run final-report   # regenerate this document
npm run release:gate   # exits nonzero while any mandatory gate is not done -- RED BY DESIGN
```

`npm run release:gate` is deliberately red and is kept separate from `npm run verify`. Collapsing the two would make one of them lie: the suite passing means the code that exists is correct, and the release gate failing means the specifications are not finished. Both are true at once.
