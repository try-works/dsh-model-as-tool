# TDD-02 — retained red-run evidence

**Honesty note:** the team's red→green discipline is documented per-lane in the task board
descriptions, but full pre-fix command outputs from the earlier session rounds were NOT archived
to `verification/`. This file lists only the red episodes whose references survive in the repo
records (board task texts, adversarial review repros, and this lane's own probe logs). **No entry
is invented**; where a reference is second-hand (an implementer's report), that is stated.

## Recorded red episodes

1. **Round-67 packed regression — `lang_detect` vanished from the packed registry.**
   Red: `verify:packed` printed a packed registry of `["stt_transcribe","model_tools","tool_mode_run"]`
   (no `lang_detect`) and the packed probes failed; the Lead's diagnostic reproduced it.
   Fix: task-13 (root cause: the orchestration script's un-isolated `stateFile` persisted a
   tongue-disable into the developer's real home state; guard added — `scripts/check-probe-isolation.mjs`).
   Reference: board task-13 description (revision 3); guard wired into `verify:packed`.

2. **Task-36 live-conformance failures — 8 of 929 host tests red.**
   Red: full host suite `929 tests / 916 pass / 8 fail`, all in `mcp-live-conformance.test.ts`
   (requests sent without the now-REQUIRED `Mcp-Method` header; transport refused with `-32020`).
   Fix: task-36 (fixtures updated; the missing-header purpose converted to the negative assertion).
   Reference: board task-36 description; post-fix result 930/925/0/5 (platform skips).

3. **Task-46 discovery — lifecycle `#writeState` erased the EXT-30 pointers.**
   Red: the task-43 host e2e (commit → activate) lost `activeVersions`/`previousVersions` on the
   next lifecycle write, breaking the staged-update flow (a REAL cross-lane defect found by the
   host test, not by unit reasoning).
   Fix: task-46 (`#writeState` now preserves both pointer maps; corrupt reads write no pointers;
   regression tests added — SDK update-flow grew 16→18).
   Reference: board task-46/task-43 descriptions; verified post-fix in gate-8 (probe (c) and (d)).

4. **Task-35 adversarial reds (pre-hardening CLI).**
   Red (repros at `E:\tmp\task28-review`, reviewer-run): cross-drive junction target exited 0 and
   wrote through the junction (HIGH-1); the TOCTOU race flipped a junction mid-run and WON at
   iteration 2 of 400 with project files landing in the attacker's victim directory (HIGH-2);
   `__proto__` whitelist crash; `--live <value>` silent downgrade; pre-decode base64 allocation.
   Fix: task-35 (full-root reparse walk, exclusive `wx` opens + post-write verification,
   null-prototype whitelist, boolean-flag value refusal, pre-decode cap).
   Reference: board task-35 description + the reviewer's repro files; post-fix re-verified in
   gate-3 (all repros fail-to-win, 0/800 race wins).

5. **Gate-6 probe red (this lane's independent observation).**
   Red: probe (a) of gate-6 — a lock-BYPASSING second process tampering the profile pointers
   between quiesce and the pointer write was silently OVERWRITTEN by the commit (the probe's
   fail-closed expectation was not met; no compare-and-swap exists).
   Resolution: judged CONCERN-LOW — outside the design's §5 lock contract (store-using updaters
   are serialized and were proven safe ×3); recorded in the gate-6 verdict, not code-fixed.
   Reference: gate-6 (task-44) completion message; the design contract
   `docs/tool-mode/EXT-30-UPDATE-DESIGN.md` §5.

## Not retained

- Pre-fix command transcripts for the episodes above (the board texts and repro scripts survive;
  the raw red output did not).
- Earlier round reds (pre-round-67) — no surviving references, so none are listed.
