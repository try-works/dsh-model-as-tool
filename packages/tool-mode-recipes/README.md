# @try-works/tool-mode-recipes

Declarative harness-model recipes, one provider-neutral LLM broker, and the built-in
`text_title` and `describe_image` tools — slice 3 of the Tool Mode review directive.

Requirements implemented here: **RCP-01…RCP-06, RCP-10, RCP-12** (the recipe package
format) and **HLM-01, HLM-02, HLM-05, HLM-06, HLM-07, HLM-09, HLM-10, HLM-11, HLM-12**
(the generic broker), with TOOL-06's title rules re-applied to the built-in text recipe and
RES-10's initial per-leaf maxima as the limits.

## What is in the box

| File | What it is |
| --- | --- |
| `src/recipe-format.ts` | The declarative recipe format: strict validation, bindings, prompt rendering, JSON Schema projection |
| `src/broker.ts` | The broker: authorizations, one isolated request, policy, cancellation, honest reporting |
| `src/titles.ts` | `text_title`, built on the broker, applying the TOOL-06 rules |
| `src/images.ts` | `describe_image`, built on the broker, transporting the image as typed media |
| `recipes/*.json` | The two built-in recipes as static files a TMX manifest can point at |

## A recipe is data, not a program

A recipe is a static instruction string plus typed input bindings. It has no statements,
no expressions, no imports and no filesystem access, and the format refuses anything that
would give it one:

- **`tools`, `messages`, `history`, `conversation`** (and their synonyms, at any depth)
  are refused **by name**, with a reason saying a recipe is data — the request is built
  from the recipe and the bound inputs alone (HLM-05, HLM-06).
- **`${…}` and `<%…%>` are refused as template code** (RCP-02).
- **A placeholder naming no declared input is refused** — an unbound pointer can never be
  satisfied (RCP-03).
- **Unknown keys are refused, not ignored**, because a dropped key runs a recipe other
  than the one the author wrote.
- **The limits are RES-10's initial maxima**: at most 1024 output tokens and two image
  inputs. A reviewed profile may lower them; a recipe may not raise them.
- **The parsed recipe is deep-frozen**, so a caller cannot widen the limits or rewrite the
  instructions it was authorized with (RCP-05, RCP-06).

Bindings are a name-keyed map rather than JSON Pointers on purpose: a closed map of
identifier-named inputs has no pointer language to abuse (`/a/b/0`, `~0`, traversal past a
reserved member), so RCP-03's pointer rules hold by construction rather than by check.

## The broker's invariants

Each of these is enforced in code and each has a test that fails if it stops being true:

| Invariant | Where |
| --- | --- |
| The request carries the recipe and the bound inputs, **nothing else** — no parent history, no parent system prompt, no tool list, no skills, attachments or memory | `buildIsolatedRequest`, asserted key-by-key and on the wire shape (one message) |
| Images travel as **typed media**, never as a path, a URL or base64 inside the text | `bindImage`, `buildIsolatedRequest` |
| An image recipe on a provider without image support is **refused before any call**, never degraded to a text-only request | `IMAGE_INPUT_UNAVAILABLE` |
| An **unknown** image capability is refused rather than assumed (three-state capability, MODEL-06) | `EXECUTOR_CAPABILITY_UNKNOWN` |
| `allowRemote: false` / a local-only host policy **refuses a remote provider** (RES-10's `permitsDestination`, mirrored) | `permitsDestination`, `EXECUTOR_NOT_CONFIGURED` |
| An authorization is for a **provider generation**, not a name; a generation that changes before or during a call is refused | `EXECUTOR_NOT_CONFIGURED`, `PROVIDER_FAILED` |
| Cancellation is reported as **cancelled**, and can never produce a success — not even an empty one | `run`, `runOrThrow`, `CANCELLED` |
| Refusal, truncation, an empty completion and a stray tool call are **distinct errors**, and none continues into an agent loop | `MODEL_REFUSED`, `MODEL_OUTPUT_TRUNCATED`, `INVALID_MODEL_OUTPUT`, `UNEXPECTED_MODEL_TOOL_CALL` |
| Budgets are the **intersection** of recipe, host and provider, and can only be lowered | `MODEL_BUDGET_EXCEEDED` |
| Recording is a **precondition**: a recipe that declines it under a host that requires it is refused *before* the call, and the journal entry is written before dispatch | `CAPTURE_POLICY_CONFLICT`, `RECORDING_FAILED` |
| Unreported usage is **unknown**, never zero | `LlmUsage` |

## Evidence: what the tests do and do not prove

**Every test in this package runs a deterministic fake provider.** They prove the request
shape (what is sent and what is not), image transport as typed media, and the policy
decisions: destinations, capability refusals, budgets, recording and cancellation.

They prove **nothing about model quality**, because no model ran. Nothing here is evidence
that a real provider produces a good title, an accurate description, or any description at
all. Real-provider evidence has to be recorded separately, against a configured executor,
and labelled as such.

## Not implemented in this slice

- **JSON response mode (RCP-04b).** The format is text-out; `text_title` parses the single
  JSON document itself, strictly, with no prose extraction.
- **`image_path` resolution.** The specification's contract takes a path; resolving and
  authorizing it is a host step (HLM-11's admission and validation). The broker has no
  filesystem access at all, which is the point. The host resolves the approved image and
  calls the tool with typed media.
- **The TMX manifest.** A declarative package needs `execution.kind: "declarative"` in a
  TMX 1.1 manifest (EXT-13, RCP-01). The recipe files here are the artefacts such a
  manifest points at.
- **A wall-clock deadline by default.** `run(..., { deadlineMs })` enforces one when the
  caller passes RES-10's 60 s figure; the broker does not impose it silently.

## Registering the built-ins

The tools expose plain functions a registration step can call:

```ts
import { HarnessBroker, createTextTitleTool } from '@try-works/tool-mode-recipes'

const broker = new HarnessBroker({ record: entry => journal.write(entry) })
broker.authorize('text_title', dshProviderAdapter)

const textTitle = createTextTitleTool({ broker })
// textTitle.name, textTitle.contractId, textTitle.description, textTitle.inputSchema
const result = await textTitle.invoke({ text, kind: 'section' })
if (result.kind === 'error') throw new Error(`${result.code}: ${result.reason}`)
console.log(result.title)
```

`inputSchema` is projected from the recipe's declarations, so the contract, the DSH
parameter schema and the MCP schema all come from one source (DECL-01).
