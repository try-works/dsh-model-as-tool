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
