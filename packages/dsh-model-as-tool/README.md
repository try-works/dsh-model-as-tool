# dsh-model-as-tool

Install on-device models as DSH tools and skills, with per-platform capability
gating. Ships with the [Desert Ant Labs](https://desertant.com/models/) catalog.

A DSH agent gets a real tool for every model that can run in its process, a
skill that teaches it *when* to reach for that tool, and an honest explanation
for every model that cannot run — instead of a tool that fails at call time.

## What it does

The plugin composes six layers:

1. **Catalog** (`catalog/desert-ant-models.json`) — all 18 Desert Ant models,
   their inputs, outputs, language counts and the npm package that runs them.
2. **Capability resolver** (`src/capability.ts`) — decides, per model, whether it
   can actually run *in this process*, and why not when it cannot.
3. **Adapters** (`src/adapters/`) — lazily import a model package and invoke it.
4. **Transports** (`src/transport.ts`) — reach a model this machine cannot run:
   through the Desert Ant CLI, or through a bridge on a machine that can.
5. **Registrar** (`src/registrar.ts`) — turns each reachable model into a
   `defineTool` definition registered on `ctx.tools`.
6. **Skills** (`src/skills.ts` + `catalog/playbooks.json`) — publishes one skill
   per registered tool describing when to use it, when not to, and how.

Nothing is imported from a model package at plugin load, so a deployment that
installs none of them still starts cleanly and reports exactly what is missing.

## Tools it registers

| Tool | Model | Runs on Windows x64 | Notes |
| --- | --- | --- | --- |
| `lang_detect` | Tongue | **yes** | Pure JavaScript, 2 MB model inside the package, no network |
| `transcribe_audio` | Voz | **yes** | Needs `onnxruntime-node`; ~349 MB weights download on first use |
| `model_tools` | — | yes | Lists every catalogued model, and installs/removes tools |

The other 16 catalog models are reported by `model_tools` with the exact reason
they cannot run, for example:

```
- [unavailable] redact (`redact_pii`): On-device redaction that strips personal
  data as you type, in 27 languages, with restore support.
  why not: Redact has no prebuilt native build for win32-x64; @desert-ant-labs/redact/native
  ships one for linux-x64, linux-arm64 and darwin-arm64 only.
```

## Reaching the other 16 models

A model only needs a route, not a rewrite. Two routes cover the rest.

### The CLI (macOS and Linux)

Every shipping model is `desertant <verb> … --json`, so wherever the CLI is
installed the plugin will drive it. Nothing to configure — it is detected on
PATH:

```sh
curl -fsSL https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-cli/main/install.sh | sh
```

That immediately makes Redact, Emo, Gist, Clear, Ear, Moderator, Shapes, Align,
Tongue and Voz callable on that machine.

### The bridge (an Apple machine, for Apple-only models)

Title and Uhm run only on Apple silicon. Run the reference bridge there and point
the plugin at it:

```sh
# on the Mac
node scripts/desert-ant-bridge.mjs --token "$(openssl rand -hex 16)"
```

```yaml
- id: model-tools
  config:
    remote:
      endpoint: http://mac-studio.local:8787
      token: <the token>
```

`suggest_title` then registers here with `route: remote`, and the existing
catalog entry, parameter schema and skill apply unchanged. The bridge is a thin
wrapper over the CLI; it binds to loopback and requires a token. **The plugin
does not host anything** — the licence forbids re-hosting the models as a
service, so the bridge must be your own machine.

## Installing tools at run time

`model_tools` actions: `list`, `installed`, `describe <id>`, `enable <id>`,
`disable <id>`, `reset [<id>]`.

**Enable and disable are remembered across restarts.** A plugin `config` states
the *deployment* default; `enable`/`disable` record the *user's* choice on top of
it:

- `disable` always wins, so a user can turn off something the config ships.
- `enable` adds to the config selection, so a user can turn something on without
  editing YAML.
- `reset` forgets the choice and makes the configuration authoritative again.

Choices are stored as JSON at `<DSH_HOME>/model-as-tool/state.json`, written
through a temporary file and a rename so a crash cannot leave a truncated
document that reads as "everything is gone".

```json
{ "enabled": ["voz"], "disabled": ["tongue"] }
```

The plugin writes its own state file rather than rewriting your
`cordis.patch.yml`: a rewrite there would fight the profile's reload and could
clobber comments you wrote. Point it elsewhere with `stateFile`, or set
`persist: false` for the earlier session-scoped behaviour.

Enabling a model that cannot run here fails with the resolver's reason and
nothing is written — persisting a failed enable would install it silently on the
next start.

## Install

The package is a DSH bundle: `package.json` declares
`dsh.bundle.patch: ./cordis.patch.yml`, and that patch is the single `insert`
row a profile mounts. Install it with `plugin_manager`'s `install_bundle`
action, or copy the row from [`cordis.patch.yml`](cordis.patch.yml) into the
profile's own patch file.

The package builds itself on install: `prepare` runs `tsc` from `src/` into
`lib/`, which is the entry point `main` and `exports` advertise. A registry
tarball ships `lib/` prebuilt by `prepack`, so a consumer needs no toolchain.

Model packages are **optional dependencies**: install only the ones you want.

```sh
npm i @desert-ant-labs/tongue                 # language detection, works everywhere
npm i @desert-ant-labs/voz onnxruntime-node   # transcription on Windows/Linux/macOS
```

The plugin never bundles or re-hosts model weights.

## What gets downloaded, and when

Three separate things arrive at three separate times. Measured sizes are from a
Windows x64 install of this package.

**1. The plugin itself — ~58 kB, from npm, at install.** `lib/`, the two catalog
JSON files, `cordis.patch.yml` and this README. It contains **no model weights
and no inference runtime**.

**2. The model SDK packages — from npm, at install, only if you asked for them.**
They are `optionalDependencies`, so a failed or skipped download does not fail the
install; the capability resolver simply reports the model as unavailable.

| Package | Size on disk | Contains |
| --- | --- | --- |
| `@desert-ant-labs/tongue` | 2.1 MB | **The model itself** — `tongue_int8.bin` (2.0 MB) ships inside the tarball |
| `@desert-ant-labs/voz` | 44.2 MB | The WebAssembly runtime (`VozWeb.wasm`), not the weights |
| `onnxruntime-node` | 287.1 MB | The prebuilt inference engine for this platform |

**3. The weights — from Hugging Face, on first call, not at install.** Each SDK
pins one revision and verifies the download, then caches it. Voz fetches about
**367 MB** on its first transcription:

```
~/.cache/desert-ant-models/desert-ant-labs/voz      367 MB   (first call)
```

Tongue never downloads anything: its model is inside the npm package.

Point an SDK at a pre-populated folder to run offline (each adapter accepts a
`directory`), and set `HF_TOKEN` for a gated repo. Because the licence forbids
redistribution, the plugin never bundles or mirrors weights — it downloads them
the way the vendor intends, once, into the vendor's own cache.

### Install cost is real, so it is opt-out

Installing with the optional dependencies present pulls roughly **333 MB** before
any model runs, and a first Voz call adds **367 MB** more. If that is unwanted,
install the plugin with them skipped and add only what you use:

```sh
npm i @try-works/dsh-model-as-tool --omit=optional
npm i @desert-ant-labs/tongue        # 2 MB, and its model is included
```

**Watch out for the other model packages.** They ship prebuilt native cores for
`linux-x64`, `linux-arm64` and `darwin-arm64` inside one tarball — roughly 50 MB
each — so `@desert-ant-labs/redact` is ~166 MB of which the great majority is
Linux and macOS binaries that can never load on Windows. Installing one on
Windows buys ~130 MB that cannot run.

## Development

```sh
npm install          # devDependencies: tsc, tsx, and the two model packages
npm run link:dsh     # point @deepseek-ai/* peers at a DSH checkout
npm run verify       # typecheck -> build -> 35 tests -> built-artifact check
```

`link:dsh` exists because `@deepseek-ai/*` are **peer** dependencies — DSH
supplies them at runtime, so locally they must be pointed at a checkout:

```sh
node scripts/link-dsh.mjs --checkout /path/to/deepseek-harness
```

Run it again after any `npm install`: npm prunes anything in `node_modules` it
does not own, which includes those links.

`npm run verify` ends with `verify:built`, which loads `lib/index.js` — resolved
through the package's own `main`, under plain Node with no TypeScript loader —
and runs a real inference. That is the artifact DSH loads, so it is the only
build whose behaviour proves the plugin is installable; passing tests against
`src/` under `tsx` does not.

| Command | Purpose |
| --- | --- |
| `npm run demo` | Mount the plugin on a real context and print what it registered |
| `npm run gating` | Print the resolved route for every catalogued model |
| `npm run gen-docs` | Regenerate the data-derived docs from the catalog |
| `npm run bridge` | Run the reference bridge for an Apple/Linux machine |

Tests always mount through `tests/helpers.ts`, which points the durable state at
a throwaway directory. That is not cosmetic: the plugin writes user choices into
`DSH_HOME` by default, so an unisolated test would edit the developer's real
configuration and a later test would read those edits as a user decision.

## Configuration

```yaml
- id: model-tools
  name: '@try-works/dsh-model-as-tool'
  config:
    models: []              # empty = every runnable model; or list ids, e.g. [tongue]
    exclude: []             # ids to drop after `models`
    exposeUnavailable: false # true registers tools that will fail at call time
    registerSkills: true
    registerControlTool: true
    persist: true           # remember enable/disable across restarts
    # stateFile: /path/to/state.json   # default <DSH_HOME>/model-as-tool/state.json
    allowNpm: true          # false forces the CLI/bridge routes
    cli:
      enabled: true         # use the Desert Ant CLI when it is on PATH
      command: desertant
    remote:
      endpoint: ''          # a bridge on a machine that can run what this one cannot
      token: ''
    # catalogFile: /path/to/other-catalog.json
    # playbookFile: /path/to/other-playbooks.json
```

## Platform support

This is the part that matters most, because Desert Ant's Node prebuilds cover
`linux-x64`, `linux-arm64` and `darwin-arm64` — **not `win32-x64`**.

| Tier | Models | How |
| --- | --- | --- |
| Runs in plain Node everywhere | Tongue | Pure JS, no WASM, no inference runtime |
| Runs where ONNX Runtime runs | Voz | `onnxruntime-node` ships win32-x64 binaries |
| Prebuilt for linux/darwin only | Redact, Emo, Gist, Clear, Ear, Moderator, Shapes, Align | `/native` subpath |
| Apple only (Core ML / MLX) | Title, Uhm | Swift SDK; no JS or Kotlin SDK |
| Closed beta, no SDK | Schemer, Toxic, Who, Eye, Face | Weights on Hugging Face, nothing ships them |

The browser/WASM entry of the LiteRT models explicitly refuses to run in plain
Node ("needs a browser/Worker environment"), so it is not a fallback.

## Licensing

The Desert Ant Labs models are under the
[Source-Available License 1.0](https://license.desertant.com/1.0) — not an
open-source license. Inference is unlimited and free below 100,000 monthly active
devices **per platform, per model**; above that a commercial license is required.
Attribution ("Powered by Desert Ant Labs", linked) is required, and the models
may not be redistributed or re-hosted as a standalone product or service.

That is exactly why this plugin is an installer/wrapper: it loads the official
npm packages locally and never ships, mirrors or proxies the weights.

## Tests

```sh
npm run verify        # from the repository root
```

The suite boots the plugin on a real Cordis context with the shipping
`ToolRuntime`, `SystemPrompt` and `SkillRegistry`, then drives the registered
tools through `ctx.tools.execute` — including a real Tongue inference. The
transport suite injects its command runner and HTTP poster, so the CLI and bridge
failure paths are covered without a process or a socket.

## Design notes

- See [docs/model-as-tool-architecture.md](../../docs/model-as-tool-architecture.md)
  for the full design.
- See [docs/adding-a-model.md](../../docs/adding-a-model.md) to add a model.
- See [docs/model-tool-playbook.md](../../docs/model-tool-playbook.md) for the
  per-model use cases, tool shapes and skill content.
