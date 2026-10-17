# What would make the release gate green — prioritized gap list

Derived from the recorded evidence in `docs/tool-mode/status.json` (current state:
12 DONE / 241 PARTIAL / 4 BLOCKED / 60 NOT_RUN of 317). Each work item names the
requirements it moves and the evidence already in place. Effort classes are rough
and honest: **S** = days, **M** = 1-2 weeks, **L** = a month+, **XL** = a project.

## Tier 0 — blocked on artifacts outside this repository (cannot close in-repo alone)

1. **A published Laya Node package (or the maintainer ONNX-export route packaged).**
   Unblocks ~15 items: MODEL-02, TOOL-02, DEC-02 (currently BLOCKED), DEC-03..08,
   BASE-11, AT-53..57. The source builds and exports with 1e-6 parity (recorded in
   `docs/tool-mode/LAYA-INTEGRATION-FINDINGS.md`); what is missing is a published
   artifact. Effort: **L**, mostly upstream coordination.

2. **Qualified voz STT run**: node-variant ONNX weights + real speech recordings.
   Unblocks AT-19/AT-21, the voz MODEL-05 record, SEC-07's positive half.
   Effort: **S-M** once the ~367 MB weight set and a few WAVs are available.

3. **EmbeddingGemma artifact preparation + ONNX inference + Node media decoders.**
   The largest single lever: MOD-01/02/06/07/13/16/17/19, AT-41..46, AT-51,
   BASE-12/14 tails, plus the embedding half of AT-19/22/47..49.
   Effort: **XL** (download/pin weights, wire the session, write bounded
   image/audio/video decoders, golden fixtures, quality evaluation).

4. **Two live vision provider routes.** Unblocks AT-72, HLM-14, AT-63..65 tails.
   Effort: **S-M** given access to two image-capable providers; **BLOCKED**
   without them (the checklist itself says so).

## Tier 1 — in-repo, high leverage (each unblocks a cluster of PARTIALs)

5. **Register the Needle planning adapter in the host** (frozen host-approved
   schema snapshot + execution-time policy checks). The extension already
   implements `tools_plan`/`structured_extract` with a pinned, digest-verified
   engine (NDL-04/07 DONE). Unblocks NDL-02/03, MODEL-03, AT-58..62.
   Effort: **M**.

6. **Update/migration flow**: version the extension store, add the explicit
   migration table (preserve model ids, selected providers, prepared-asset
   mappings, disabled choices). Unblocks BASE-09's unmet clause (the false-DONE
   found in round 65), BASE-10, EXT-30, AT-18/32/36 tails, RCP-06.
   Effort: **M**.

7. **Managed worker execution** (EXT-20): run extension entries and native libs
   in managed processes with scrubbed environments. Unblocks EXT-20, AT-38's
   adversarial half. Effort: **L**.

8. **Per-client external grant and isolated execution context** (SEC-01/04/05):
   construct a narrower grant per MCP client instead of dispatching through the
   interactive grant; add credential generation and owner-only ACL storage.
   Unblocks SEC-04/05 (currently NOT_RUN), SEC-01 tails.
   Effort: **M**.

9. **Wire a real DSH LLM service into the harness broker** (HLM-01/02/03 tails):
   the broker is tested only against fake providers. Unblocks the harness-model
   half of AT-09, AT-67/68, HLM-01..10 tails. Effort: **M**.

## Tier 2 — smaller, targeted

10. **Rate limiter** (AT-12's named gap — zero rate limiting exists).
    Effort: **S**.
11. **Recipe authoring CLI + recipe install lifecycle** (RCP-07/08/09, AT-73/74/75,
    EXT-36 kit bundling). Effort: **M**.
12. **Publish `harness-model-recipe.schema.json`** (RCP-02's gap) and the
    `tool-mode-harness-text` package/examples (RCP-12's clause) — or record TDD-01
    spec deviations for both. Effort: **S**.
13. **End-to-end orchestration scenarios** (AT-40/AT-90): scripts chaining packed
    install → preparation → two MCP clients → composition → lifecycle → evidence.
    The pieces all exist and are tested separately. Effort: **S-M**.

## Tier 3 — acceptance evidence that needs machines/operators

14. **Confinement acceptance demonstration** (CODE-08/09, AT-14): an operator-run
    confined run with the acceptance env marker. Effort: **S** with operator sign-off.
15. **Multi-machine Windows CPU matrix** (MODEL-05, AT-19): re-run the suites on a
    second machine and record the measurements (cold/warm timing, peak memory —
    also closes OBS-05). Effort: **S-M** per machine.

## The shape of the answer

- **~30% of the gate** unblocks in-repo at **S–M** effort (items 5, 6, 8, 9, 10,
  11, 12, 13, 14, 15).
- **The largest single chunk** is item 3 (the multimodal inference slice) — an
  **XL** implementation project.
- **~15 items** wait on external artifacts only (Laya publication, STT weights +
  recordings, two vision routes).
