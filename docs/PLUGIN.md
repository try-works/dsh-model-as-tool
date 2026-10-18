# Using this repository as a DSH plugin

`packages/dsh-model-as-tool` is a DeepSeek Harness **plugin/bundle**, built the
same way as the reference plugin `@try-works/dsh-memory`
(`D:\DEV\dsh-memory`): a plain install-by-name package with a bundle patch, a
Cordis entry (`name` / `inject` / `apply` / `Config`, no `default` export), and
the plugin contract the harness loader reads.

| Field | Value |
|---|---|
| Package | `@try-works/dsh-model-as-tool` |
| Plugin id (row id) | `model-tools` |
| Injects | `tools` |
| Bundle patch | `cordis.patch.yml` (`dsh.bundle.patch`) |
| Entry | `lib/index.js` (built from `src/index.ts`) |
| Remote namespace | `modelTools` (`./typert` + `./remote` + `client/client.model-tools.js`) |
| Requires | Node ≥ 24, DSH ≥ 0.2.1-rc.2 (peers: cordis, dsh-tools, optional dsh-skill) |

## Install into a profile

```powershell
# from the repository root
npm run plugin:install -- --profile tool-mode-test            # web template (default)
npm run plugin:install -- --profile tool-mode-test --template headless
```

The script (`scripts/install-dsh-plugin.mjs`):

1. builds the host package and its bundled `@try-works/tool-mode-*` packages when their `lib/` is stale;
2. initializes the profile (if missing) and gives it the chosen template's bundle list plus this plugin;
3. runs `npm pack` **into `<profile>/plugins/`** so the installed `file:` dependency survives temp cleanup
   (the tarball is self-contained — its `bundledDependencies` are inside);
4. installs it with `dsh plugin --profile <p> add <tarball>` (pnpm under the hood);
5. declares it in the profile's `dsh.profile.bundles`;
6. runs `dsh --profile <p> --dump-config` and fails unless the `model-tools` row is composed.

## Boot it

```powershell
# the web app prints its URL with a token; use a spare port if the normal GUI runs
node D:\deepseek-harness\apps\cli\lib\bin.js tool-mode-test --port 3091
```

Open the printed `http://127.0.0.1:3091/?token=…` URL. The plugin mounts on the
profile root, registers one tool per model that is actually runnable on this
platform (plus the `model_tools` control tool, discovery tools and skills), and
the harness' tool list shows them to the model in a session.

## Verify the package without booting

```powershell
npm run plugin:check          # package/entry/bundle-patch/dependency-closure invariants
npm run test:sdk              # the SDK lane
node --import tsx --test packages/dsh-model-as-tool/tests/plugin-package.test.ts
node D:\deepseek-harness\apps\cli\lib\bin.js --profile tool-mode-test --dump-config
```

`plugin:check` mirrors the reference plugin's `scripts/check-package.mjs`: entry
exports (`name`/`inject`/`apply`/`Config`, **no** `default`), the bundle patch
mounting the published name, `files[]` shipping the patch and `lib/`, peers, and
`schemastery` as a pinned **dependency** (a peer would let a profile supply
3.18.1, which throws at module load).

## Config

The bundle patch mounts the row with the catalog defaults; a top-level
`- id: model-tools` row in the profile's `cordis.patch.yml` overrides them
(patch semantics replace the whole `config`, so restate every key you keep):

```yaml
- id: model-tools
  config:
    models: []              # [] = every model runnable in this process, not an allowlist
    exclude: []
    exposeUnavailable: false
    registerSkills: true
    registerControlTool: true
    allowNpm: true
    cli: { enabled: true, command: desertant }
    remote: { endpoint: '', token: '' }
```

### The harness model (declarative extensions)

Declarative extension packages (e.g. `@try-works/extension-declarative-recipes`)
are served by the host's harness broker, which needs a composed `LlmProvider`.
The plugin resolves one in this order:

1. **`config.harnessProvider`** — an explicit provider (a test double, or a
   deployment-built provider). Always wins.
2. **`config.harnessModel = {provider, model}`** — builds a real DSH-backed
   provider over the deployment's `ctx.llm` for the named route.
3. **AUTO** — when neither is set, the plugin composes from the deployment's
   LLM surface using the deployment's default/selected model, discovered from
   the `agent-default-model` settings entry (or `model.default` as a
   `provider/model` string). Auto-detection is DEFAULT-SAFE: an absent LLM
   surface, or a model that cannot be resolved unambiguously, composes NOTHING
   — and the extension enable/describe preflight reports the exact reason
   instead of an activation fault.

When no provider can be composed the remediation is:

> no chat model is configured for this deployment, so declarative extensions
> cannot be served; set config.harnessModel = {provider, model} to a runnable
> model

The same resolution decides both the preflight status and the actual
activation, so the reported reason can never contradict what enabling the
extension would do.

### Settings → Model as Tool

Installing the plugin also adds a **Model as Tool** page to the Harness Settings
dialog (`client/index.js`, declared by `dsh.client` in the package manifest).

- **Every catalog model is a row with an enable/disable toggle** — name, source,
  size, license, and whether it is runnable in this process. Unavailable models
  stay listed with a disabled toggle and the reason they cannot run here.
- **Extension-backed models are first-class catalog entries.** Laya, Needle 3,
  MiniLM-L6, MiniLM Rerank, EmbeddingGemma 2, Tongue and Voz carry a `provider`
  binding to their Tool Mode extension, so they appear in the list (and in
  `model_tools`) beside the Desert Ant models. Their row is badged `extension`
  rather than `runnable here`: only the host can see whether that extension is
  installed and active, so the page does not promise it.
- Toggles write the `exclude` list; the advanced **Allowlist override** pins an
  exact set when a config-file operator needs one.
- The remaining operator switches (expose unavailable, register skills, register
  the inspection tool, allow in-process packages, managed workers, repair
  attempts, approved roots) are the same fields as before.

The model list is **generated into the client bundle at build time**
(`scripts/gen-client-catalog.mjs` reads the catalog and resolves each model's
capability verdict on the host). `npm run verify:built` regenerates and compares,
so a catalog edit cannot ship a page listing a model that no longer exists, and
`plugin:check` refuses a bundle whose placeholder was never filled.

Two rules make the page work, and both are pinned by tests:

- **Only `.volatile()` Config fields are exposed to the Settings UI.** Without
  the marker the page renders "namespace not exposed" and nothing is writable.
- **A volatile field parses to a live reference (`{ get() }`), not a plain
  value.** `apply` unwraps the volatile keys before reading them (and re-unwraps
  on `loader/volatile-update`); `new Set(config.models)` on a raw reference was a
  real mount-time `TypeError`.

Credentials, the bridge endpoint, the extension store and the headless MCP
listener stay config-file only, where the launcher and `doctor` read them.

### Remote namespace `modelTools`

The extension card does not guess state from config: it asks the host. The
host ↔ browser contract is `src/extensions-api.ts`, published as one Typert
Remote namespace mounted as `ctx.remote.modelTools`:

| Piece | Where | What it is |
|---|---|---|
| Host artifact | `remote/typert.host.mjs` (`./typert`) | strict invocation descriptors; `@deepseek-ai/dsh-typert-loader` registers them for this package's Loader row |
| Client artifact | `remote/typert.remote-client.mjs` (`./remote`) | mountable `TypertRemoteInfo` contribution for a standard Client assembly |
| Browser chunk | `client/client.model-tools.js` | the contribution as a package-local lazy-CJS chunk; the client module system serves only `./client`, so the page loads it with `require.async('./client.model-tools.js')` and calls `mount(ctx)` |
| Source of truth | `remote/spec.mjs` | descriptors, codecs, and documentation the three artifacts are built from (`scripts/gen-remote-artifacts.mjs`; `--check` catches drift) |
| Host wiring | `src/extensions-remote.ts` | `provideModelToolsService(ctx, service)` attaches the Gateway's `typertRemote` binding and provides the `modelTools` Cordis service |

Three wire facts a caller must respect:

- **Every client method resolves a `RemoteResult`, not a bare value** —
  `{ ok: true, value }` or `{ ok: false, error }`. Unwrap `.ok` before rendering
  state; the host service signatures in `src/extensions-api.ts` are the raw
  in-process shape.
- **The install method is named `installExtension` on the wire.** The harness'
  client `RemoteNamespaceService` owns a private method `install` and the
  gateway refuses any Remote method that collides with it
  (`client api: method "modelTools/install" conflicts with its namespace
  service`). The Host service keeps its member `install`; the descriptor's
  `implementation` maps the wire name to it. `prepare` has no such collision and
  keeps its name.
- **Optional wire parameters still occupy a positional slot.** `source` is
  optional on the host, but a client call must pass it explicitly:
  `installExtension(id, undefined)` uses the configured first-party source.

The namespace exposes `describe`, `installExtension`, `enable`, `disable`, and
`prepare`:

- **`prepare(id)`** acquires and verifies the installed extension's model assets
  and records the readiness a following `enable` needs. `prepare` is id-only, so
  `prepare(id)` is a valid call. Its raw result is an `ExtensionPrepareResult`
  with the RES-02 disclosure (`plan`: assets, bytes, storage, license,
  executable gate), the per-declared-model `readiness` record, the prepared
  `groups`, and `activationReady`. Acquisition problems are returned in `reason`,
  not thrown. It never downloads unless the operator approved the disclosure
  through the UI.
- **Executable assets need a separate RES-02 approval.** Downloading a prebuilt
  engine counts as executable installation, so a plan containing an
  `executable: true` asset is refused with `prepared: false` and this exact
  reason: *"the plan includes an EXECUTABLE asset, which requires the separate
  executable-preparation approval (RES-02); this call did not grant it"*. The
  Settings/Remote path has no per-call flag, so the approval is the deployment's
  standing configuration value `allowExecutablePreparation: true` (**default
  false**). That value is the operator's consent for EVERY executable asset of
  the digest-pinned plans this host resolves, so enable it only for first-party,
  pinned engines (Needle 3's `needle.exe`, for example) — never for an arbitrary
  package source. The management channel's `extensions-prepare` action keeps its
  own per-call `allowExecutable` flag and ignores this setting.
  After a successful prepare, re-read `describe()`: a row that previously
  reported `failed` now says the store records no remaining preparation blocker,
  and the next `enable` activates it.
- **`describe()` rows carry the preflight `requirements` model.** `requirements`
  lists every prerequisite the host checked (`store`, `source`, `dependencies`,
  `assets`, `executable`, `harness-model`, `platform`, `integrity`,
  `activation`) as `{ satisfied, reason, action }`, and `blocked` is the host's
  verdict that an unmet requirement prevents activation. Unmet entries can exist
  while `blocked` is false (for example unprepared assets on a row that can
  still be installed), so render the unmet entries, not only `blocked`. Both
  fields are ADDITIVE for older hosts: treat an absent `blocked` as false and an
  absent `requirements` as "the host did not check" — never invent blockers.

Proof without a page:
`node --import tsx --test packages/dsh-model-as-tool/tests/remote-typert.test.ts`
validates the host artifact with the shipping Typert loader, mounts the client
contribution through the shipping Typert registry and Gateway client over a
fake Connection carrier, and asserts `describe()`/`enable()`/`installExtension()`/
`prepare()` send the exact `/api/<namespace>/<method>` payload and return a
`RemoteResult`.

## Troubleshooting (observed while validating this install)

- **`did not activate` / `failed to import: Cannot find package "X"`** — a bundled
  `@try-works/*` package imports `X` at runtime but bundling copies only the
  package directory, not its dependencies. Declare `X` in the host package's
  `dependencies` (and, for correctness, in the bundled package's own
  `dependencies`). `adm-zip` was exactly this case; `plugin:check` now guards the
  whole closure.
- **`patch: entry "connection" not found`** — the home-level
  `~/.dsh/cordis.patch.yml` targets a row that a `dsh-base`-only profile lacks.
  Use the `web` (or `headless`) template, which includes it.
- **HTTP 401 on the printed URL** — the web app's auth fence; use the URL with
  the `?token=…` query the launcher printed.
- **Port already in use** — the GUI is on 3080; pass `--port <n>` to the app.
