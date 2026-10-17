# Host lane LOW-item documentation (task-68)

Consolidates the four LOW findings from the host spec audit into one reviewed
note set. Each item records the design decision, the file:line evidence and the
exact remaining seam — no code changed.

## 1. Bridge architecture (ARCH-04 wording note)

The "documented public bridge" through which the host reuses compatible
registered providers is `src/provider-bridge.ts`. The architecture:

- The CATALOG path (`adapterFor`) binds a catalog entry's `provider` to an
  extension entry; `#activate` imports the extension module once per
  activation generation and caches the instance (`#activated`), and `#invoke`
  runs the provider with a host-issued context: the invocation id, the caller
  signal, the authority's limits, and a `resolvePath` bound to the host's own
  authority — never the caller's raw request (SEC-06).
- The MANAGED path (opt-in `managedWorkers: true`) routes the same calls to an
  out-of-process worker keyed by the TRUE manifest id; inspection runs entirely
  in the child through the SDK's inspect API, and every provider path resolves
  through the request-scoped host broker. No in-process fallback exists.
- The DISPATCH path (`src/extension-dispatch.ts`) resolves declared tools to
  implementations and executes them through the host's registry pipeline
  (`ctx.tools.execute`), applying the same admission/schema/meta disciplines —
  ARCH-05's "no second executor" property.

The voz extension runs headlessly through this bridge: a connected MCP client
does not start a second Voz instance, and no microphone/browser UI is required
for headless transcription. The bridge is documented in code; this page is the
public note the audit requested.

## 2. MCP-03 stdio binary naming mapping

The spec's `dsh-tool-mode mcp-stdio` subcommand maps to the packaged binaries:

- `dsh-tool-mode-mcp-stdio` (bin/dsh-tool-mode-mcp-stdio.mjs) — the standalone
  stdio relay: stdout carries ONLY protocol frames, diagnostics go to stderr,
  and a missing credential exits non-zero rather than hanging (P26-16).
- `dsh-tool-mode mcp-stdio` (bin/dsh-tool-mode.mjs) — the launcher's subcommand
  with the same env contract (`DSH_TOOL_MODE_MCP_TOKEN`,
  `DSH_TOOL_MODE_MCP_URL`), delegating to the same `createStdioBridge` from
  `src/mcp/stdio.ts`. Both are aliases of one relay implementation, not two
  code paths.

The naming deviation (spec command vs package bin names) is this mapping; the
functionality is the same and the stdio suite covers the relay.

## 3. SEC-06 TOCTOU residual

The host's path-authority resolution: a caller-supplied path is resolved ONCE
through `createInvocationAuthority`/`authority.ts` (`resolvePath`), which
checks the approved roots before the provider ever opens the file. The residual
window the independent verification recorded: between the authority's check and
the provider's own open, the filesystem can change (a junction flipped at the
target). The host closes this for the managed path by making the AUTHORITY the
child's only resolver (the request-scoped broker — the child cannot open
anything without asking); for the in-process path the resolution is the
authority's canonical answer and the provider's subsequent open is the
documented sub-millisecond window. The recipes CLI's own check-then-write
bound is recorded in the recipes lane (its `wx`-exclusive writes + post-write
verification). The residual is bounded and documented; it is not eliminated —
full elimination needs OS-level handle-based opens, which is the recorded
remainder.

## 4. CODE-11 repair-budget lineage

The harness recipe repair path (one repair attempt, the shared timeout, the
1024-token output bound, the two-image cap) charges against the ROOT program
budget: `tool_mode_run`'s accounting attributes nested model calls to the
program's budget through the invocation accounting
(`src/invocation-accounting.ts` + `tool-mode-run.ts`'s runner), and the repair
attempt is one more nested call on the same lineage — a program cannot escape
its budget through a repair. The per-attempt ceilings live in
`src/harness-budgets.ts`; they are fixed defaults, not operator-configurable in
the flat config (the §12 config-v3 nested shape now carries the
`harnessExecutorV3` fields, recorded in the task-64 freeze).

The per-attempt TRACE half now exists: `src/title-proposal.ts` exports
`RepairLineageEntry` (which repair, `budgetBefore`, `budgetAfter`,
`previousKind`, and the outcome `repaired|exhausted|not-needed`) and the pure
`recordRepairLineage` recorder, pinned by
`tests/repair-lineage.test.ts` (the deep-equal lineage: attempt 1 repaired,
attempt 2 exhausted, a proposed outcome never consumes budget). The
recipe-runtime caller accumulates the lineage alongside the existing `repairs`
count, so the lineage and the count cannot diverge — the lineage is derived
from the SAME decision object. The configurable-ceilings half remains the
recorded remainder.
