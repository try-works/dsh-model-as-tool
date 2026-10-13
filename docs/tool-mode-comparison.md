# How `dsh-model-as-tool` compares to the "Tool Mode" proposal

A review of an external design write-up proposing **Tool Mode**: a portable
capability runtime for model-backed tools, with `dsh-model-as-tool` as its first
harness binding.

The short version: **the write-up is a framework specification; this repository is
a working binding.** They sit at different layers, so most of the proposal is not
a criticism of what is here — but four of its points identify real gaps in this
code, and one of them is a gap against our own sibling repository.

## Grounding

The proposal cites `dsh-stt` and `role-model`. Both exist on this machine
(`D:\DEV\dsh-stt`, `D:\DEV\role-model`), and `dsh-stt` really does contain the
machinery it wants extracted:

```
dsh-stt/src/provider-kit/   audio.js  http.js  oneshot.js  preparation.js  worker.js
dsh-stt/src/providers/voz/  index.js  spec.js  worker.js
```

So the proposal is based on inspected code, not speculation. Everything below was
checked against the files in this repository.

## Where this repository already does what the proposal asks

| Proposal | Status here |
| --- | --- |
| §2 "Register a tested model-plus-recipe, not a model name" | **Done for the two working models.** `src/adapters/tongue.ts` and `voz.ts` are hand-written, tested against real inference, and each knows its own load/call/dispose shape. |
| §3 "Do not assume packaging includes redistributing weights" | **Done, and enforced.** Weights are never bundled or mirrored; a recorded decision fixes this. The Voz path downloads from Hugging Face into the vendor's own cache. |
| §3 "Keep usage instructions beside the executable definition" | **Done.** `catalog/playbooks.json` holds when-to-use / when-not-to-use / workflow / caveats per model, rendered into a skill by `src/skills.ts`. |
| §4 "Hard eligibility checks before ranking" | **Half done.** `src/capability.ts` performs exactly the hard checks — platform, missing runtime, prebuild availability, closed-beta status — and refuses with a reason. There is no *ranking* step, because there is never more than one candidate. |
| §5 "Ordinary tool calls should be the default" | **Done.** Plain native tools; no program required to transcribe one file. |
| §5 "A skill teaches usage; it is not the enforcement mechanism" | **Agreed and consistent** — nothing in the skills is load-bearing for safety. |
| §5 "The next model request must receive a consistent snapshot" | **Already solved by the harness.** `ctx.tools.register` emits `tools/change` and DSH reassembles schemas per request, so dynamic enable/disable is consistent without the plugin doing anything. |
| §2 "Do not introduce a universal `confidence: 0.95`" | **Mostly done.** Tongue's `reliability` / `isTooCloseToCall` and Voz's `realtimeFactor` pass through unmodified rather than being flattened. |
| §8 "Licensing is a real architectural constraint" | **Done.** The licence is in every catalog entry, restated in every rendered skill, and the reason the remote bridge is user-hosted. |

Also worth stating: the proposal's §1 distinction — Code Mode composes, Tool Mode
owns capability semantics — is a fair way to describe the split, and nothing here
conflicts with it.

## Where the proposal is right and this code is behind

### 1. `capability` is a label, not an interface

Every catalog entry carries a `capability` string (`text.language-identification`,
`audio.speech-recognition`), but it is **metadata only**. Grepping `src/`, the word
appears in type definitions and comments; no code branches on it. The public
interface is the *model*: `lang_detect`, `transcribe_audio`.

The consequence the proposal predicts is real here: a second transcription
implementation could not be substituted without the caller changing which tool it
calls. And there is **no version field anywhere** — so a change in output meaning
(§3's "breaking even when the JSON shape is unchanged") is invisible.

### 2. No execution receipts

Zero instrumentation. A tool result is the model's output and nothing else. We
cannot separate download from load from inference, which is precisely the data
needed to avoid learning "Voz is slow" when the truth is "Voz cold-loads".

This matters more than it looks, because it is the prerequisite for any future
ranking. Doing §4's resolver without receipts would mean ranking on nothing.

### 3. File arguments are unvalidated paths

```ts
const audioPath = requireString(args, 'audio_path')
const result = await voz.transcribe(audioPath)
```

No existence check, no readable check, no root restriction. A grep for
`existsSync|isAbsolute|realpath` across the adapters and transport returns nothing.
The proposal's artifact guidance (§4) is the right framing — the path is doing an
artifact reference's job without any of its access control.

### 4. Downloads are not an authorization event

The proposal: *"Discovering a capability should never silently install an
executable or fetch hundreds of megabytes."* This package currently does both.
`npm install` pulls ~333 MB of optional dependencies, and a first `transcribe_audio`
call fetches ~367 MB with no gate. Measured on this machine:

```
onnxruntime-node        287.1 MB   (npm)
@desert-ant-labs/voz     44.2 MB   (npm)
@desert-ant-labs/tongue   2.1 MB   (npm, model included)
voz weights             367.0 MB   (Hugging Face, first call)
```

There is no "this capability requires preparation" state and no approval step.

### 5. One lifecycle strategy, not three

`voz.ts` caches the loaded instance in a closure and releases it on plugin
teardown. That is a resident worker with **no idle eviction, no queue bound, no
startup deadline** beyond the tool's cancellation signal — Voz holds roughly
1.2 GB until the plugin unloads.

`dsh-stt` already distinguishes a one-shot process from a resident worker, with
preparation, download handling, warming and idle reclamation. **On this axis we are
behind our own sibling repository**, which is the proposal's strongest concrete
point.

### 6. The generic transports are the anti-pattern §2 warns about

`tongue` and `voz` have tested adapters. The other sixteen models are reached
through `transport.ts`, which builds an argv from `cliVerb` plus the declared
parameters and assumes the CLI's JSON *is* the capability's semantics. That is
exactly "register a model name and infer everything else from its description" —
fine as a reach mechanism, unproven as an abstraction.

### 7. "Verified" means it runs, not that it is good

51 tests cover interface and wiring, including one real inference. There is no
evaluation: no word error rate, no abstention behaviour, no calibration. The
proposal's conformance-versus-quality split (§8) is a fair criticism of how the
word "verified" is used here.

One concrete instance: the Voz skill lists "the recording is one of the 25
supported languages" as a trigger but never warns that a transcriber pointed at
the wrong language can return confident nonsense. Our own research captured that
warning — though note the quote is from the **Ear** page, motivating Ear, not from
Voz's page as the proposal states.

## Where I would push back on the proposal

**It specifies a framework ahead of its second implementation.** The tree in §9
(registry, resolver, policy, receipts, artifacts, four bindings, conformance,
evaluation, marketplace) is a reasonable destination, but there is exactly **one
implementation per capability** in scope today, and on this Windows host only
**2 of 18 models can run at all**. A resolver with nothing to resolve, and a
many-to-many capability model exercised only at 1:1, would be untested
architecture. The proposal's own instinct — "prove the abstraction with a
deliberately small catalog" — argues for building the second implementation
*before* the machinery around it.

**"No new wire protocol is needed because MCP exists" is only true for the MCP
binding.** This repository's binding is DSH native tools with `defineTool`; MCP
would add a hop and not simplify that path.

**It under-weights the hardest problem here.** Most of its examples assume the
model can run and the question is orchestration. The dominant reality in this
repository is capability *absence* — 16 of 18 models cannot execute — and the most
valuable behavior is the resolver refusing precisely and telling the agent why.
That is the part worth keeping unchanged through any refactor.

## What I would actually do next

In value order, cheapest first:

1. **Add an execution receipt** to the tool result (implementation id, route,
   timings, package versions). Small, and it is the prerequisite for ranking.
2. **Promote `capability` to an id with a version**, and let a tool be addressed by
   capability while the model name stays an implementation detail. Small.
3. **Validate path arguments** against a root allow-list. Small, and it is a real
   security boundary today.
4. **Gate downloads** — report "requires preparation" instead of fetching ~367 MB,
   with an explicit enable. Medium.
5. **Borrow `dsh-stt`'s `provider-kit` lifecycle** rather than reinventing
   one-shot/resident/warm/idle. Medium.

Steps 1–3 are worth doing regardless of whether Tool Mode is ever built, because
they are gaps in this plugin on its own terms.

## Summary

| Area | This repository | Proposal |
| --- | --- | --- |
| Layer | Working binding | Framework specification |
| Capability as public interface | Label only | Core idea |
| Implementation substitution | Untested (1:1) | Designed for many-to-many |
| Eligibility gating | Implemented, with reasons | Required, plus ranking |
| Receipts / observability | None | Central |
| Model lifecycle | One strategy | Three, extracted from `dsh-stt` |
| Artifacts | Raw paths | Access-controlled references |
| Download authorization | Silent | Explicit approval |
| Permissions | None (skills advise only) | Runtime-enforced |
| Verification | Interface tests + one real inference | Conformance *and* evaluation |
| Licensing discipline | Enforced | Enforced |
| Scope realism | Narrow, working | Broad, partly speculative |
