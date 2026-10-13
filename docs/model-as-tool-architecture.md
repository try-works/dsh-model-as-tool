# Turning a model into a DSH tool

How `@try-works/dsh-model-as-tool` makes an on-device model callable by a DSH
agent, and why it is built the way it is.

## The problem

A DSH agent can only act through **tools**. A model that is not reachable through
a tool does not exist to the agent, no matter how good it is. So "make model X
available to the agent" decomposes into four separate problems:

1. **Describe it** — what the model does, what it takes, what it returns.
2. **Prove it can run** — on *this* machine, in *this* process.
3. **Invoke it** — load the weights, call it, render the result for the model.
4. **Teach it** — tell the agent when using it is the right move.

A plugin that skips (2) and (4) produces tools that fail at call time and that
the agent never thinks to use. Both are treated as first-class here.

## The DSH seams this uses

Three extension points, all from the shipping harness:

| Seam | API | Used for |
| --- | --- | --- |
| Tool registry | `ctx.tools.register(defineTool({...})) : () => void` | One tool per runnable model |
| Skill registry | `ctx.skills.register({ name, description, content }) : () => void` | One skill per registered tool |
| Plugin lifecycle | `apply(ctx, config)` + `ctx.effect()`, schemastery `Config` | Composition, teardown, validation |

Both registries return the **disposer that is the only unregister API**, and a
registration is a Cordis effect owned by the calling context's fiber. That means
the plugin's whole contribution is torn down automatically when its fiber
unloads — and, because registration is scope-aware, an agent preset that mounts
this plugin can expose a different model set to its own agents.

`Config` is validated by the harness before `apply` runs, which is why `models`
is declared `.default([])`: an unset array would otherwise arrive as `[]` and
silently mean "no models". The code reads an empty list as "no explicit
allowlist".

## The five layers

```
catalog/desert-ant-models.json   ← 18 models, declarative
        │
        ▼
src/capability.ts                ← can it run here? by which route? why not?
        │
        ▼
src/adapters/{tongue,voz}.ts     ← lazy import + invoke   (in-process)
src/transport.ts                 ← CLI / bridge           (out-of-process)
        │
        ▼
src/registrar.ts                 ← defineTool + ctx.tools.register
        │
        ▼
src/skills.ts  +  playbooks.json ← when to use it
```

### 1. Catalog — data, not code

Every model is a JSON record: identity, capability, input/output shape, language
count, licence, docs URL, and the npm package that runs it. Adding a model is a
data edit plus (if it needs code) an adapter.

The catalog is validated strictly at load. A malformed entry fails the plugin
rather than becoming a silently missing tool, and duplicate ids or duplicate
tool names are rejected.

### 2. Capability resolver — the honesty layer

This is the part with no equivalent in a naive wrapper. It answers, per model:
*can an adapter actually invoke this in the current process?*

```ts
resolveCapability(entry) → { runnable, route, reason, resolved?, missing? }
```

It resolves package specifiers with `createRequire(import.meta.url)` from the
plugin's own location — so the packages an operator installs into the profile
are the ones found — without importing them, because importing a model package
pulls in a WASM or native runtime and probing must stay cheap.

The rules encode real upstream behaviour:

- A declared ONNX runtime outranks the package's default entry, because for
  these packages the default import is the browser build and refuses Node.
- A `browser-only` model on `win32` is refused with the exact upstream reason
  (no `win32-x64` prebuild) rather than being attempted.
- Missing runtime dependencies are reported by name, so the agent can tell the
  user to `npm i onnxruntime-node`.

Every negative verdict carries a reason, which is what `model_tools` prints.

### 3. Adapters — where the model is actually called

```ts
interface ModelAdapter {
  readonly modelId: string
  invoke(invocation: { args, signal }): Promise<Record<string, JsonValue>>
  dispose?(): Promise<void>
}
```

There are two kinds:

- A **model adapter** is hand-written for a model with a real in-process SDK
  (Tongue, Voz).
- A **transport adapter** is generic: it drives *any* model through the Desert Ant
  CLI or a bridge, using only the catalog's verb and parameter declarations. This
  is what makes the other 16 models reachable at all.

Both obey the same rules:

- **Lazy, speculative-free loading.** The package specifier is held in a variable
  and passed to `import()`, so it never enters the module graph at plugin load.
  Optional dependencies stay genuinely optional.
- **Load once, reuse.** Tongue parses a bundled 2 MB weight file; Voz allocates
  ~1.2 GB of ONNX sessions. Both cache the loaded instance and release it from
  `dispose()`, which the plugin calls on teardown.

A failed load clears the cache, so a transient failure or a later install can be
retried instead of poisoning the tool for the process lifetime.

### 3b. Transports — reaching a model this machine cannot run

Two out-of-process routes exist, and they are what turn "16 of 18 models are
unavailable on Windows" into "16 more models are one configuration away".

**CLI.** The Desert Ant CLI exposes every shipping model as
`desertant <verb> … --json` and runs on macOS and Linux. The transport maps the
tool arguments onto it mechanically: the first declared parameter becomes a
positional (several positionals for a file model), every other parameter becomes
`--option key=value`, and `--json --quiet` makes stdout one JSON value with no
colour and no progress noise. Its exit codes are honoured — `1` is a runtime
error, `64` is a usage error, and the CLI's own stderr is the message the agent
sees.

**Bridge.** For models that cannot run even under the CLI on the local OS —
above all the Apple-only ones — the plugin can POST to a bridge the *user* runs
on a machine that can execute the model:

```
POST <endpoint>/invoke      Authorization: Bearer <token>
  { "model": "title", "verb": "title", "input": "…", "options": { "max-tokens": "96" } }
  → 200 { "ok": true,  "result": <the model's JSON> }
  → 5xx { "ok": false, "error": "<message>" }
```

A reference implementation is in
[`scripts/desert-ant-bridge.mjs`](../scripts/desert-ant-bridge.mjs); it is a thin
wrapper over the CLI, binds to loopback, and requires a token. The plugin never
runs this service, and the licence is why: re-hosting the models as a service for
others is prohibited, so the bridge must be the user's own machine. See
[reaching Apple-only models](#reaching-apple-only-models-title) below.

Both transports take their side-effecting primitive by injection
(`CommandRunner`, `HttpPost`), which is why every path — including the failure
paths a real CLI only reaches on a machine that has one — is covered by tests
without spawning a process.

**Route preference** is deliberate: an in-process package wins (fastest, no
external dependency), then the CLI (local, out-of-process), then the bridge
(another machine). `allowNpm: false` forces everything through the out-of-process
routes for a deployment that would rather not load model packages in-process.

### 4. Registrar — the tool contract

Each model becomes one `defineTool` definition:

- `parameters` — compiled from the catalog, with the **first declared parameter
  as the required primary input** and real types for the rest (`integer`,
  `boolean`, `string[]`), so a numeric knob reaches the model as a number.
- `output.schema` — one open object schema; the adapter's value is validated
  against it before the model sees anything.
- `output.render` — a small projection. Tongue renders a sentence the model can
  act on; Voz renders the transcript text; everything else falls back to stable
  JSON so nothing is lost to a lossy humanization.
- `presentCall` — a transcript-friendly card title.

### 5. Skills — teaching the agent when

A tool schema says *what* the agent can call. It cannot say when the call is the
right move, and a model that is merely *available* tends not to be used. So each
registered tool also publishes a skill whose body is rendered from the catalog
entry plus its playbook:

```
## When to use
## When not to use
## Use cases
## Calling it
## Workflow
## Pairs with
## Caveats
## Licensing
```

The skill is published through `ctx.skills.register(...)`, so it appears in the
session skill catalog and is loadable with the `skill` tool like any other.

## Worked example: Tongue, end to end

**Catalog entry** (`catalog/desert-ant-models.json`):

```json
{
  "id": "tongue",
  "capability": "text.language-identification",
  "input": "text",
  "windowsSupport": "native-node",
  "npmPackage": "@desert-ant-labs/tongue",
  "tool": {
    "name": "lang_detect",
    "description": "Identify the language of a short piece of text across 84 languages…",
    "params": {
      "text": "The text whose language to identify.",
      "top": { "description": "How many runner-up candidates to include.", "type": "integer" }
    },
    "returns": "The detected language code, a reliability verdict, and the top candidates."
  },
  "skill": { "name": "desert-ant-tongue", "description": "Detect the language of short text…" }
}
```

**Capability verdict** — `@desert-ant-labs/tongue` resolves, it declares no
runtime, so `{ runnable: true, route: 'npm-native' }`.

**Adapter** (`src/adapters/tongue.ts`) — imports the package on first call,
caches `Tongue.load()`, slices the candidate list to `top`, and returns a plain
object.

**Registration** — `ctx.tools.register(defineTool({ name: 'lang_detect', … }))`.

**What the model sees** when it calls `lang_detect({ text: "kann ich das haben" })`:

```
Detected language: de
Candidates: de 100.0%, sv 0.0%, da 0.0%
```

**And the skill** tells it to reach for this before translating, to route by
locale, or to check generated copy — and *not* to use it for audio (that is Ear),
or for a single proper noun where there is too little signal.

## Why `title` cannot be a local tool on Windows

The user-facing example — a model that writes headings and descriptions for
landing-page sections and docs — is **Title**, and it is the clearest case of why
capability gating matters.

Title runs **only on Apple platforms, on the GPU through MLX**, and requires the
Swift package's `MLX` trait:

- There is **no JavaScript and no Kotlin SDK** for Title. Its docs list platforms
  iOS/macOS/tvOS/visionOS only, and it does not ship weights that download
  themselves — the app points the initializer at a folder.
- A Swift build without the `MLX` trait compiles the module as a stub, so even in
  the Apple ecosystem it must be opted into explicitly.
- On Windows/Linux there is no path at all: not a missing prebuild, but no
  runtime the model can execute on.

So on this Windows host, `suggest_title` is **catalogued and reported, never
registered**, and `model_tools` says exactly why:

> Title is Apple-only (Core ML/MLX through the Swift package); there is no
> JavaScript SDK, so it cannot run in a Node process.

**The realistic routes to a `suggest_title` tool**, in order of honesty:

1. **Reach a machine that can run it.** The bridge transport exists for exactly
   this. On the Mac:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-cli/main/install.sh | sh
   node scripts/desert-ant-bridge.mjs --token "$(openssl rand -hex 16)"
   ```

   and in the DSH profile:

   ```yaml
   - id: model-tools
     config:
       remote:
         endpoint: http://mac-studio.local:8787
         token: <the token>
   ```

   On the next load, `suggest_title` is registered and `model_tools describe
   title` reports `route: remote` instead of a refusal. Nothing else changes: the
   catalog entry, the parameter schema, the skill and the licence text are the
   same ones that were already there. This is the payoff of routing capability
   through a resolver rather than hard-coding it — a new transport is a new
   *route*, not a new tool.

2. **Run it on Linux.** Title is Core ML/MLX-only, so this does not help it, but
   the same CLI transport gives Redact, Emo, Gist, Clear, Ear, Moderator, Shapes
   and Align a working route on any macOS or Linux host — no bridge required.

3. **Substitute a different model for the job.** For "title a section", the agent
   can use the LLM it already is. The skill should say so rather than leaving a
   gap.

4. **Do not fake it.** Registering a `suggest_title` tool that throws on this
   machine wastes a model turn and misleads the agent — which is precisely what
   `exposeUnavailable: false` prevents.

Note that the licence independently forbids option 5 — standing up a hosted
Desert Ant service for others — so any remote route must be the user's own
machine, which is why the reference bridge binds to loopback and demands a token.

## Installing and removing tools at run time

The capability resolver decides what *can* run; the user decides what *is*
installed. `model_tools` exposes that as actions:

| Action | Effect |
| --- | --- |
| `list` | Every catalogued model, with `installed`, `runnable` and the reason |
| `installed` | Only the models whose tools are currently registered |
| `describe <id>` | One model in full |
| `enable <id>` | Register that model's tool and skill now |
| `disable <id>` | Unregister them now |

`enable` on a model that cannot run here fails with the resolver's reason rather
than silently doing nothing — an agent that asked for a tool should learn why it
did not get one.

Because `ctx.tools.register` returns the disposer that is the only unregister
API, enable/disable is just register/dispose, and the whole surface still tears
down with the plugin's fiber.

## Adding a model

See [adding-a-model.md](adding-a-model.md).
