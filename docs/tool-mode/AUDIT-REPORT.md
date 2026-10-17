# Tool Mode implementation audit — consolidated report

**Audited:** `dsh-model-as-tool` at `D:\DEV\dsh-model-as-tool`, against
`docs/tool-mode/specs/Tool_Mode_DSH_Implementation_Spec_v1.2.md`,
`Tool_Mode_Extension_Protocol_v1.1.md` and `Tool_Mode_Verification_Checklist_v1.2.md`.
**Rounds:** ~64 audit rounds, each pairing implementation fixes with read-only adversarial
subagent review before results were recorded as verified.

## The one-line answer

**The audit is complete and every one of the 317 requirements (227 normative + 90 acceptance
tests) has a recorded, evidence-backed status. The implementation is a substantial, honestly
partial product: 13 requirements DONE, 240 PARTIAL, 4 BLOCKED by external facts, 60 NOT_RUN.
The dev loop is green (1,442 tests pass, 0 fail), the release gate is correctly red (13 of
317 PASS) — and that red gate is itself a verified result, not a failure of the audit.**

## What verification proves

| Check | Result |
| --- | --- |
| `npm run verify` (typecheck + build + 1,452 tests + built + packed + architecture + MCP + inventory + traceability) | **1,442 pass / 10 skip / 0 fail** (skips are environment-gated: no needle artifacts, no v2 MCP client installed, Windows ACL workspace-write, symlink elevation) |
| `verify:packed` (real tarballs into a clean project, no registry/junction/workspace) | PACKED-OK ×3 — `lang_detect -> de` (real inference), confinement seam closed, voz discovery |
| `verify:built` (built artifact under plain Node) | real inference through package `main` |
| `verify:architecture` | host holds no model-specific code; all extensions use only the published SDK |
| `verify:mcp` | 39 schema checks over 17 fixtures + live-server conformance |
| Release gate (`--release-gate`) | **NOT PASSED — 13 of 317 PASS** (correct for a partial implementation; deliberately separate from the green dev loop) |

## What the audit fixed (selected, by theme)

- **Schema enforcement** (P26-13): DSH projection can no longer be stricter than a contract
  (union→json, annotation-only→json, non-scalar enums dropped with a recorded reason); host
  output validation refuses a provider result violating its declared schema (the
  `__violate_output__` fixture, with only the host able to emit the refusal message).
- **Code Mode** (CODE-*): the exposure gate is a tested conjunction (operator consent +
  confinement evidence, seam env-gated); `serveProgram` runs the real NodePtcRuntime with
  real tool-call counting; budgets clamp; cancellation is never reported as failure; the
  recursive/composition bindings are refused.
- **MCP wire layer** (P26-*): first-request statelessness at three levels, per-request
  metadata, header/Base64-sentinel refusals, live Ajv validation of every response shape,
  subscription ack-before-event with per-subscriber isolation, request-scoped stdio
  cancellation, POST-only with no session/replay surface.
- **OAuth resource server** (P26-15): embedded local AS with HS256 JWTs; review-driven fixes
  (scope capped at the registered grant, revocation checked after signature, no unserved
  token_endpoint) and the F4 status mapping (invalid_request 400, invalid_token 401,
  insufficient_scope 403).
- **Extension lifecycle** (EXT-*): store lock made reentrant with canonical-path keying and
  refusal-safe depth (three review holes closed); lifecycle state mutations run under it;
  the CLI's raw acquires replaced with the reentrant wrapper; hostile install scripts proven
  inert by a sentinel test; stat-first bounded lock reads; qualification records enforced at
  discovery with a host/SDK parity test.
- **HTTP acquisition** (RES-03/NDL-01): a real range-fetching source with RFC 9110 §14.2
  range-ignore handling and streamed, memory-bounded bodies; the host-driven acquisition
  path RAN against the pinned Needle URLs with both digests verified — NDL-01 re-adjudicated
  from BLOCKED to PARTIAL (the Windows-exe route is the qualified strategy).
- **Observability** (OBS-*): the OBS-02 dropped-hook bug fixed end to end — external MCP
  calls now land in a bounded accounting ring, exposed through the host's own MCP surface
  (`model-tools.mcp-host` service) and reported by the receipts action, with a real-call e2e
  test asserting sizes/class and never a payload.
- **Inventory integrity** (TDD-*): the release report reads SDK support from the fixture
  MANIFEST instead of a hardcoded contradiction; the probe mechanically maintains the
  manifest's check counts; stale evidence corrected wherever a review found it (v2 SDK
  support, seventeen fixtures, 39 checks, the NDL-01/DEC-01 notes, MODEL-03's re-scoped
  blocker).

## What remains honestly incomplete

- **BLOCKED by external facts (4):** MODEL-02/TOOL-02/DEC-02 (npm `laya-ts` 404 — no
  published Laya Node entry point; the source builds and exports with 1e-6 parity, but
  nothing is packaged) and MODEL-03 (Needle planning adapter not registered).
- **NOT_RUN because the artifacts do not exist on this host (60):** real STT qualification
  (no node-variant voz weights, no real speech), EmbeddingGemma inference/media decoders,
  the Laya/Needle/vision acceptance clusters, multi-machine Windows matrix, confinement
  acceptance gate, and the end-to-end orchestration scenarios (AT-40/AT-90).
- **PARTIAL but real (240):** each entry in `docs/tool-mode/status.json` names exactly what
  is implemented and tested, and what remains — the audit's core deliverable.

## Provenance

- Machine-verifiable status per requirement: `docs/tool-mode/status.json` (authoritative),
  `verification/requirements.json`, `verification/evidence.json`,
  `verification/RELEASE-REPORT.md`, `verification/FINAL-REPORT.md`,
  `verification/results/release.json`, `docs/tool-mode/TRACEABILITY.md`.
- Every adversarial review in this audit was read-only; each finding was empirically
  verified against the tree before acceptance, and each fix was re-reviewed.
