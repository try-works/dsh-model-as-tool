# dsh-model-tools

Install on-device models as DSH tools and skills, with per-platform capability
gating. Ships with the [Desert Ant Labs](https://desertant.com/models/) catalog.

A DSH agent gets a real tool for every model that can run in its process, a
skill that teaches it *when* to reach for that tool, and an honest explanation
for every model that cannot run — instead of a tool that fails at call time.

## What it does

The plugin composes five layers:

1. **Catalog** (`catalog/desert-ant-models.json`) — all 18 Desert Ant models,
   their inputs, outputs, language counts and the npm package that runs them.
2. **Capability resolver** (`src/capability.ts`) — decides, per model, whether it
   can actually run *in this process*, and why not when it cannot.
3. **Adapters** (`src/adapters/`) — lazily import a model package and invoke it.
4. **Registrar** (`src/registrar.ts`) — turns each runnable model into a
   `defineTool` definition registered on `ctx.tools`.
5. **Skills** (`src/skills.ts` + `catalog/playbooks.json`) — publishes one skill
   per registered tool describing when to use it, when not to, and how.

Nothing is imported from a model package at plugin load, so a deployment that
installs none of them still starts cleanly and reports exactly what is missing.

## Tools it registers

| Tool | Model | Runs on Windows x64 | Notes |
| --- | --- | --- | --- |
| `lang_detect` | Tongue | **yes** | Pure JavaScript, 2 MB model inside the package, no network |
| `transcribe_audio` | Voz | **yes** | Needs `onnxruntime-node`; ~349 MB weights download on first use |
| `model_tools` | — | yes | Lists every catalogued model and whether/how it runs here |

The other 16 catalog models are reported by `model_tools` with the exact reason
they cannot run, for example:

```
- [unavailable] redact (`redact_pii`): On-device redaction that strips personal
  data as you type, in 27 languages, with restore support.
  why not: Redact has no prebuilt native build for win32-x64; @desert-ant-labs/redact/native
  ships one for linux-x64, linux-arm64 and darwin-arm64 only.
```

## Install

The package is a DSH bundle. Install it into a profile with `plugin_manager`'s
`install_bundle` action, or add the row from [`cordis.patch.yml`](cordis.patch.yml)
to the profile's own patch file.

Model packages are **optional dependencies**: install only the ones you want.

```sh
npm i @desert-ant-labs/tongue          # language detection, works everywhere
npm i @desert-ant-labs/voz onnxruntime-node   # transcription on Windows/Linux/macOS
```

The plugin never bundles or re-hosts model weights.

## Configuration

```yaml
- id: model-tools
  name: '@dsh-plugins/dsh-model-tools'
  config:
    models: []              # empty = every runnable model; or list ids, e.g. [tongue]
    exclude: []             # ids to drop after `models`
    exposeUnavailable: false # true registers tools that will fail at call time
    registerSkills: true
    registerControlTool: true
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
node --import tsx --test tests/plugin.test.ts
```

The suite boots the plugin on a real Cordis context with the shipping
`ToolRuntime`, `SystemPrompt` and `SkillRegistry`, then drives the registered
tools through `ctx.tools.execute` — including a real Tongue inference.

## Design notes

- See [docs/model-as-tool-architecture.md](../../docs/model-as-tool-architecture.md)
  for the full design.
- See [docs/adding-a-model.md](../../docs/adding-a-model.md) to add a model.
- See [docs/model-tool-playbook.md](../../docs/model-tool-playbook.md) for the
  per-model use cases, tool shapes and skill content.
