# DSH plugin & bundle architecture — an authoring and installation reference

Scope: how a third party authors a DSH plugin package, how a bundle is declared and installed,
how peer-dependency compatibility is enforced, how profiles and patch layers compose, whether
tools can be registered dynamically at runtime, how `apply(ctx, config)` gets validated config,
and how plugin tests are written and run.

Every claim below cites the checkout at `D:\deepseek-harness\` with file path and line numbers.
Where a claim could not be verified in source, it says so explicitly.

---

## 1. Plugin package shape

### 1.1 A plugin is a Cordis plugin module

A DSH plugin is a TypeScript/JavaScript module exporting (docs/user/develop/basic/index.md:17):

```ts
export const name = 'my-plugin'
export function apply(ctx: Context) { /* register capabilities */ }
```

Three shapes are supported (docs/user/develop/basic/index.md:105-138): a function module, an
object `export default { name, inject, apply }`, and a class extending Cordis `Service` (used
when the plugin *provides* a service rather than consuming one).

### 1.2 A fully-read example: `@deepseek-ai/dsh-tool-todo`

`packages/todo/tool-todo/package.json` (66 lines) is the canonical publishable shape:

```json
{
  "name": "@deepseek-ai/dsh-tool-todo",
  "version": "0.2.0-rc.2",
  "publishConfig": { "access": "public" },
  "repository": { "type": "git", "url": "...", "directory": "packages/todo/tool-todo" },
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./invariant": { "types": "./lib/types/invariant.d.ts", "default": "./lib/invariant.js" },
    "./client": { "types": "./lib/types/client.d.ts", "default": "./lib/types/client.js" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": ["lib/index.js", "lib/invariant.js", "lib/types/**/*.js", "lib/types/**/*.d.ts"],
  "dependencies": { "@deepseek-ai/schemastery": "workspace:~", "zod": "^4.4.3" },
  "peerDependencies": {
    "@deepseek-ai/dsh-agent": "workspace:*",
    "@deepseek-ai/dsh-session": "workspace:*",
    "@deepseek-ai/dsh-tools": "workspace:*",
    "@deepseek-ai/cordis": "workspace:~"
  },
  "devDependencies": { "...": "every peer mirrored here" }
}
```
(`packages/todo/tool-todo/package.json:1-66`)

Facts to extract:

* **Required fields.** `name`, `version`, `type: "module"`, `main: "lib/index.js"`,
  `types: "lib/types/index.d.ts"`, `exports`, `files`, `license`, and (for the workspace)
  `publishConfig.access: "public"` + `repository` metadata.
* **`main`/`types` point at `lib/`** — the *published* artifact, not `src/`. `main` is
  `lib/index.js`; `types` is `lib/types/index.d.ts`. Both are produced by the repo build:
  `tsc -b tsconfig.host.json` emits declarations (and `.js`) into `lib/types/`, then `tsdown`
  bundles `lib/types/index.js` → `lib/index.js` (root `package.json:25`, and
  `tsdown.config.ts:19-34` with `entry: ['lib/types/{index,invariant,startup}.js']`, `outDir: 'lib'`,
  `format: ['esm']`, `platform: 'node'`, `target: 'es2024'`, `dts: false`).
* **`exports` map convention.** Every subpath is a two-key object `{ types, default }`.
  The `.` entry is `{ "types": "./lib/types/index.d.ts", "default": "./lib/index.js" }`.
  Every package additionally exports `./src/*` (source passthrough for tooling) and
  `./package.json` (so `require.resolve(pkg + '/package.json')` works — bundle/profile
  resolution depends on this; see §3.4). Bundles add `"./cordis.patch.yml"` (see §3).
* **`files` must not publish `src`.** The invariant is enforced by
  `scripts/check-workspace-constraints.ts` (`expectedDshPackageFiles`, lines 246-290) and
  restated in `docs/cookbook/adding-a-package.md:27-29`: exactly `lib/index.js`,
  `lib/types/**/*.d.ts`, plus `lib/invariant.js` when `./invariant` is exported, plus
  `lib/types/**/*.js` when any export's `default` points into the emitted tree
  (`usesEmittedTreeDefaults`, `check-workspace-constraints.ts:325-329`).

### 1.3 `tsconfig.json`

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "lib/types" },
  "include": ["src"],
  "references": [
    { "path": "../../../vendor/cosmokit" },
    { "path": "../../../vendor/cordis" },
    { "path": "../../core/tools" },
    { "path": "../../core/agent" },
    { "path": "../../core/session" },
    { "path": "../../session/session-projection" },
    { "path": "../../runtime-diagnostics/invariants" }
  ]
}
```
(`packages/todo/tool-todo/tsconfig.json:1-33`)

`rootDir: src` + `outDir: lib/types` is what makes `lib/types/index.js` and
`lib/types/index.d.ts` exist for tsdown to bundle. TypeScript project references are explicit
(no wildcards) — `tsconfig.base.json:195-197` states the reason. In-package relative imports use
explicit `.ts` specifiers (`export * from './types.ts'`,
`packages/todo/tool-todo/src/index.ts:20`) which the compiler rewrites to `.js` in emitted JS and
leaves as `.ts` in declarations, resolving to sibling `.d.ts` for NodeNext consumers
(`docs/cookbook/adding-a-package.md:29`).

A runnable checklist for adding a *workspace* package (including the two aggregate tsconfig edits)
is `docs/cookbook/adding-a-package.md` §1-2 and §6. For a **third-party, out-of-tree** package the
author writes only §1's package shape plus a patch file — see §3.

### 1.4 What peer dependencies are required and why

Two rules, both observable in every package:

1. **`@deepseek-ai/cordis` must be in BOTH `peerDependencies` and `devDependencies`, with the
   same range** (`docs/cookbook/adding-a-package.md:27`). Reason: the plugin shares the *single*
   Cordis `Context`/registry instance owned by the running dsh installation. A second copy of
   `@deepseek-ai/cordis` in the plugin's own `node_modules` would create a second service
   registry (a class-identity split). The published tutorial states the same for out-of-tree
   plugins: "Declare dsh packages whose instances the plugin must share with the host under both
   `peerDependencies` and `devDependencies`" (docs/user/develop/basic/publish.md:103). At runtime
   the profile's pnpm settings force this: `pnpm-workspace.yaml` is written with
   `nodeLinker: hoisted` + `autoInstallPeers: false`
   (`packages/boot/app-boot/src/profile.ts:230-235`), so a missing peer is *not* installed
   locally and Node resolution falls through to the installation's copy via the launcher's
   runtime resolution (`profile.ts:16-20`, `collectInstallationScopePackages`, `profile.ts:363-414`).
2. **Every `@deepseek-ai/dsh-*` service package the plugin imports must also be declared** in
   `peerDependencies` (and mirrored in `devDependencies` for typechecking;
   `docs/cookbook/adding-a-package.md:27`, and `packages/todo/tool-todo/package.json:43-65`).
   Those peers are exactly what the compatibility checker reads — see §2.

`@deepseek-ai/schemastery` goes in `dependencies`, not peers: it is a runtime validator whose
identity does not need to be shared (`docs/cookbook/adding-a-package.md:27`, and
`packages/todo/tool-todo/package.json:40`).

### 1.5 Subpath-export plugins

A *subpath export plugin* is a plugin that lives in a second entry point of an existing package,
so a deployment can load one half without the other. The canonical example is
`@deepseek-ai/dsh-tool-subagent-control/list-agents`.

Package side (`packages/subagent/tool-subagent-control/package.json:16-27`):

```json
"exports": {
  ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
  "./list-agents": { "types": "./lib/types/list-agents.d.ts", "default": "./lib/types/list-agents.js" },
  "./src/*": "./src/*",
  "./package.json": "./package.json"
}
```

Note the `./list-agents` **default points into `lib/types/`** (`./lib/types/list-agents.js`), i.e.
it is a tsc-emitted file rather than a tsdown root bundle — which is why `files` includes
`lib/types/**/*.js` (`package.json:28-32`).

Authoring side (`packages/subagent/tool-subagent-control/src/list-agents.ts`): a completely
ordinary plugin module with its own identity and injections (lines 19-20):

```ts
export const name = 'tool-subagent-list-agents'
export const inject = ['tools', 'subagents', 'agents']
```

…and its own `apply` that registers one tool (lines 85-177). The root entry
(`src/index.ts:20-21`) is a *different* plugin (`name = 'tool-subagent-control'`,
`inject = ['tools','subagents']`) registering `send_message`/`interrupt_agent`.

Why the split is deliberate is in the module docblock (`src/list-agents.ts:1-8`): "It stays
separately loadable from the root `send_message` plugin so a deployment can register continuation
delivery without exposing discovery."

The consuming profile patch therefore has *two* rows pointing at the same package
(`packages/bundle/base/cordis.patch.yml:364-368`):

```yaml
- id: tool-subagent-control
  name: '@deepseek-ai/dsh-tool-subagent-control'

- id: tool-subagent-list-agents
  name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'
```

For the workspace to resolve `pkg/subpath` to `src` during typecheck/tests, an alias is required:
`tsconfig.base.json:173`
(`"@deepseek-ai/dsh-tool-subagent-control/list-agents": ["./packages/subagent/tool-subagent-control/src/list-agents.ts"]`).
An out-of-tree plugin author does **not** need this — Node resolves the subpath through `exports`.

---

## 2. Peer-dependency / compatibility checking

### 2.1 Where a plugin declares the DSH version range: `peerDependencies`, not `engines`

**The field is `package.json` `peerDependencies`, on `@deepseek-ai/dsh` or any
`@deepseek-ai/dsh-*` name.** `engines.dsh` exists in the manifest type
(`packages/util/package-manifest/src/types.ts:23-24, 56-66`, documented as "Runtime
requirements; DSH compatibility is declarative until a reader enforces it") but **no reader
enforces it** — a repository-wide grep for `engines?.dsh` / `'engines'` finds only
`scripts/benchmark-npm-resolution.ts:31`. The app-boot README states it directly:
"These checks use peer declarations, not `engines.dsh`, and are not a sandbox against malicious
package code" (`packages/boot/app-boot/README.md:52`).

### 2.2 The validation rule

`packages/boot/app-boot/src/plugin-compatibility.ts:51-88` is the whole rule:

```ts
export function evaluatePluginCompatibility(
  manifest: object,
  exemptions: Readonly<Record<string, readonly string[]>> = {},
  runtimeVersion = getDshRuntimeVersion(),
): PluginCompatibility | undefined {
  runtimeVersionOf(runtimeVersion)
  const fields = objectOf(manifest, 'Plugin manifest')
  if (!Object.hasOwn(fields, 'peerDependencies')) return undefined
  const dependencies = objectOf(fields.peerDependencies, 'Plugin manifest peerDependencies')
  const peers: Record<string, string> = {}
  for (const [name, range] of Object.entries(dependencies)) {
    if (typeof range !== 'string') {
      throw new Error(`Plugin manifest peerDependencies[${JSON.stringify(name)}] must be a string`)
    }
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    const requirement = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range) ? runtimeVersion : range
    if (requirement.trim() === '' || !semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })) {
      peers[name] = range
    }
  }
  if (Object.keys(peers).length === 0) return undefined
  const name = identityField(fields, 'name')
  const version = identityField(fields, 'version')
  const key = `${name}@${version}`
  const exemptedVersions = Object.hasOwn(exemptions, key) ? exemptions[key] : undefined
  const exempted = exemptedVersions?.includes(runtimeVersion) === true
  return { name, version, runtimeVersion, peers, exempted }
}
```

Precise semantics:

* Only names equal to `@deepseek-ai/dsh` or starting with `@deepseek-ai/dsh-` are checked
  (line 75). `@deepseek-ai/cordis` is **not** checked here.
* `workspace:^`, `workspace:~`, `workspace:*` all mean "the running runtime" (line 76) — this is
  how in-repo packages pass against a single shared version.
* Prereleases participate: `includePrerelease: true` (line 77).
* An empty/whitespace range is incompatible (line 77, first clause).
* `runtimeVersion` comes from `getDshRuntimeVersion()` (`plugin-compatibility.ts:44-49`), which
  reads **`packages/boot/app-boot/package.json`'s `version`** via
  `new URL('../package.json', import.meta.url)`. That file is the single source of the runtime
  version.
* Non-string peer values, missing `name`/`version` on a mismatch, and an invalid runtime version
  all **throw** (lines 34, 59, 73) — a malformed manifest is refused rather than admitted.

### 2.3 Where the rule is enforced (five call sites)

1. **Install-time preflight** (before pnpm runs) — `packages/boot/plugin-manager/src/operations.ts:332-351`.
   For an install command naming packages, the manifest is read first and checked; an incompatible
   peer rejects with "nothing was installed":
   ```ts
   const issue = evaluatePluginCompatibility(manifest, exemptions)
   if (issue !== undefined && !issue.exempted) {
     preflight.push(pluginCompatibilityWarning(issue))
     incompatible.push(incompatiblePlugin(issue))
   }
   ...
   if (preflight.length > 0) return rejected(preflight, 'nothing was installed')
   ```
   (`operations.ts:344-351`) — a *path* spec reads the checkout's `package.json`; a *registry*
   spec is resolved via `pnpm view <spec> name version peerDependencies --json`
   (`operations.ts:167-188`, called at `operations.ts:342`). Git/tarball specs cannot be read
   before fetching, so they are judged after installation.
2. **Post-install validation** (after pnpm exits) — `operations.ts:465-523`. On exit 0 it walks
   every direct dependency's `package.json` plus `bundleComponentManifests(...)` (the manifest of
   every package a bundle's patch rows name, `operations.ts:248-272`), and on a conflict restores
   `package.json`+`pnpm-lock.yaml` and reinstalls the restored lockfile
   (`operations.ts:499-520`).
3. **Profile startup / bundle layer load** — `packages/boot/app-boot/src/profile.ts:665-683`
   (`loadProfileDirectory`): a bundle whose own DSH peers are incompatible is **skipped** and
   listed in `skippedBundles` rather than failing the boot:
   ```ts
   const issue = evaluatePluginCompatibility(bundleManifest, exemptions)
   if (issue !== undefined && !issue.exempted) throw new Error(pluginCompatibilityWarning(issue))
   ```
   (`profile.ts:675-676`, inside the `try` whose `catch` pushes to `skippedBundles`, lines 680-682.)
4. **Row admission before mount** — `packages/boot/app-boot/src/compatibility-preflight.ts:89-169`
   (`preflight`) and its two entry points `prepareProfileEntries` (line 74) and
   `prepareProfilePatches` (line 180). Called from `mountRootInclude`
   (`packages/boot/app-boot/src/index.ts:569`) and `reconcileProfilePatches`
   (`index.ts:288`). A denied ordinary row gets `row.disabled = true`
   (`compatibility-preflight.ts:114-118`); a native `cordis:include` that *reaches* a denied
   plugin is denied whole because its file is never rewritten (lines 142-167). This runs before
   the module is imported, so a denied plugin never executes.
5. **Plugin-manager runtime selection** — `packages/boot/plugin-manager/src/index.ts:301-302`
   (`listBundles`), `:546-547` (`installBundle`), `:722-723` (`selectBundle`). Each raises
   `ManagementFailure('incompatible-version', [incompatiblePlugin(compatibility)])`.

### 2.4 Exemptions — the escape hatch, and where it lives

Exemptions are a **separate profile file, not the plugin manifest and not a patch layer**:
`compatibility.json` in the profile directory
(`packages/boot/app-boot/src/profile-compatibility.ts:10`):

```ts
export const PROFILE_COMPATIBILITY_FILENAME = 'compatibility.json'
```

Shape: exact `package-name@version` keys → list of exact DSH runtime versions
(`profile-compatibility.ts:43-53, 62-93`). `isExactPluginVersion` (lines 24-27) refuses ranges,
prefixes, whitespace, and malformed versions. A malformed file never stops the profile: accepted
records still apply, rejected ones are reported, and `rewritable: false` makes a later grant
refuse rather than overwrite user content (lines 128-130).

Grants require explicit risk acknowledgement and the exact current runtime
(`setProfileVersionExemption`, lines 113-141):

```ts
if (enabled && !acceptRisk) {
  throw new Error('Incompatible plugins may cause crashes or data loss. To explicitly acknowledge ...')
}
const current = getDshRuntimeVersion()
if (enabled && runtimeVersion !== current) {
  throw new Error(`Cannot approve DSH ${runtimeVersion}: this application runs DSH ${current}. ...`)
}
```

The user-facing remedy string is `pluginCompatibilityWarning`
(`plugin-compatibility.ts:96-103`), which names the exact `dsh plugin allow-version` command.
CLI surface: `dsh plugin --profile <p> version-exemptions | allow-version | revoke-version`
(`packages/boot/plugin-manager/README.md:69`). Tool surface:
`plugin_manager` with `list_version_exemptions` / `set_version_exemption`
(`packages/boot/plugin-manager/src/tools.ts:47-53`).

The manager's tool description states the headline rule verbatim
(`packages/boot/plugin-manager/src/tools.ts:21`): *"Incompatible DSH peer dependencies block
installation and activation."*

---

## 3. Bundles

### 3.1 What a bundle is

Two concepts, two manifests, from `docs/user/develop/basic/publish.md:9-16`:

> - A **bundle** is an npm package that ships a configuration layer. Its manifest declares
>   `dsh.bundle`, answering "what does this package contribute?": a patch file that inserts or
>   overrides plugin rows.
> - A **profile** is a directory under `$DSH_HOME/profiles/<name>` describing one runnable
>   composition. Its manifest declares `dsh.profile`, answering "which bundles compose this
>   setup, in what order?".
>
> A bundle is what you author and distribute; a profile is what a user boots with
> `dsh --profile <name>`. Nothing is both.

The manifest types are in `packages/util/package-manifest/src/types.ts`:

```ts
export interface DshManifest {
  manifestVersion?: 1
  bundle?: DshBundleManifest
  profile?: DshProfileManifest
  client?: DshClientManifest
}
export interface DshBundleManifest {
  /** One patch file path, or an ordered list applied in sequence, each relative to the declaring package root. */
  patch: string | string[]
}
export interface DshProfileManifest {
  /** Ordered bundle layer list, using installed package names. */
  bundles?: string[]
}
```
(`types.ts:29-39, 68-78`)

So the marking field is **`package.json`'s top-level `dsh.bundle.patch`** — there is no `cordis`
key in package.json. `packages/bundle/base/package.json:31-35`:

```json
"dsh": {
  "bundle": {
    "patch": "./cordis.patch.yml"
  }
}
```

An array form is legal and ordered; `packages/bundle/web-app/package.json:41-51` declares five
files, and `bundlePatchFiles` validates/normalizes it
(`packages/boot/app-boot/src/profile.ts:58-64`), `bundlePatchPaths` resolves them to absolute
paths (lines 73-75). A non-string/non-string-array `patch` throws
(`profile.ts:60-62`).

`packages/bundle/base/src/index.ts` is the entire runtime API of the base bundle (9 lines):

```ts
/**
 * @deepseek-ai/dsh-base — the shared dsh core as a profile bundle. The
 * package's substance is `cordis.patch.yml`, declared by the `dsh.bundle.patch`
 * manifest field and resolved by the profile composer through that field;
 * this module carries no runtime API.
 * @module @deepseek-ai/dsh-base
 */
export {}
```

A bundle *may* also ship a normal plugin as a subpath row (web-app does: `./startup`,
`packages/bundle/web-app/src/index.ts:225-301`), but that is optional.

### 3.2 A bundle and its `cordis.patch.yml`

The bundle's substance is the patch file. `packages/bundle/base/cordis.patch.yml` (529 lines) is
**one** top-level `insert:` of ~100 rows:

```yaml
- insert:
    - id: tool-plugin-manager
      name: '@deepseek-ai/dsh-plugin-manager/tools'
      disabled: true

    - id: plugin-manager
      name: '@deepseek-ai/dsh-plugin-manager'
      disabled: !!js "!ctx.get('profileContext')"
    ...
```
(`cordis.patch.yml:15-22`)

Its own header comment states the contract (lines 1-13): the patch is "applied as ONE insert over
the empty profile root. Later bundle patches and the user's profile `cordis.patch.yml` address
these rows by id, with the last write winning per row." And: "A patch replaces the targeted
row's whole `config` rather than merging into it."

A *standalone* bundle owns the complete tree instead of layering over base —
`packages/bundle/sdk-minimal/cordis.patch.yml:1-5`:

```yaml
# Standalone minimal SDK application. Unlike the ordinary SDK profile, this
# bundle does not layer over dsh-base: this insert is the complete Cordis tree.
# User profile, home, and invocation patches still apply above it.
```

### 3.3 The `install_bundle` path, end to end

Entry points: the `plugin_manager` tool action `install_bundle`
(`packages/boot/plugin-manager/src/tools.ts:76-82`) and `PluginManager.installBundle`
(`packages/boot/plugin-manager/src/index.ts:461-567`). Steps, in order, with citations:

1. **Reject empty/dash-leading specs**, refuse a stopped request
   (`index.ts:471-472`), record caller-supplied build approvals
   (`index.ts:473-476` → `approveBuilds`, `build-approval.ts:44-50` which sets
   `allowBuilds.<name> = true` in the profile's `pnpm-workspace.yaml`).
2. **Snapshot `package.json` + `pnpm-lock.yaml`** for restore-on-failure
   (`index.ts:477`, `RESTORED_FILES` at `index.ts:79`, `readRestoredFiles` at `:698-705`).
3. **GitHub connection pre-check** (`index.ts:482-496`): for a `github.com` spec only,
   `git -c credential.helper= ls-remote -- <repo> HEAD` under
   `githubConnectionTimeoutMs` (default 5000), with credential helpers and prompts disabled
   (`github-connection.ts:28-68`). Only `network`/`timeout` stop the install.
4. **Registry plan loop** (`index.ts:498-522`): `pnpm add <spec> [--registry=<url>]` in the
   profile directory; between attempts the snapshot is restored (`index.ts:501`); an
   `incompatible` result from the run is a package's own answer and stops the loop
   (`index.ts:510`).
5. **Determine what was installed** by diffing the profile manifest's dependencies before/after
   (`index.ts:536-542`); exactly one new/changed name is required, else
   `ManagementFailure('ambiguous-install')`.
6. **Validate the bundle**: resolve the package dir, read the manifest, require
   `manifest.dsh?.bundle !== undefined` else `ManagementFailure('not-bundle')`
   (`index.ts:543-545`). Then run the compatibility check (§2.3.5, `index.ts:546-547`) and
   **eagerly parse each declared patch file** so a malformed patch fails the install rather than
   the next boot (`index.ts:548`):
   ```ts
   for (const file of bundlePatchPaths(dir, manifest.dsh.bundle)) loadOverlayPatches('dsh', file)
   ```
7. **On any failure, restore both files** (`index.ts:549-553`) and throw; the caller folds it
   into `ChangeResult.application = 'failed'` with a `ManagementError` (`index.ts:779-786`).
8. **Apply**: `selectBundle(name, true)` then, on a live (HMR) profile, `reload()`
   (`index.ts:559-563`). `selectBundle` appends the name to
   `manifest.dsh.profile.bundles` and writes the manifest atomically
   (`index.ts:715-735` → `saveManifest`, `operations.ts:84-86`).
   `reload()` calls `reconcileProfilePatches` (`index.ts:762-765`), which re-reads every bundle
   layer and updates the root Include (`packages/boot/app-boot/src/index.ts:273-302`).

#### What gets written where in `$DSH_HOME`

`$DSH_HOME` resolves as: explicit configured path → `$DSH_HOME` env → `~/.dsh`
(`packages/util/home-paths/src/index.ts:87-91`; empty/whitespace `$DSH_HOME` is treated as
unset, line 89). Profile directories are `join(home, 'profiles', name)`
(`packages/boot/app-boot/src/profile.ts:169-176`).

Profile initialization writes exactly three files if absent
(`packages/boot/app-boot/src/profile.ts:244-263`):

| Path | Content | Source |
|---|---|---|
| `$DSH_HOME/profiles/<name>/package.json` | `{ name, private: true, dependencies: {}, dsh: { profile: { bundles: [...] } } }` | `profile.ts:250-258` |
| `$DSH_HOME/profiles/<name>/cordis.patch.yml` | the user patch template (`[]` plus comments) | `profile.ts:220-224, 259-260` |
| `$DSH_HOME/profiles/<name>/pnpm-workspace.yaml` | `packages: [.]`, `nodeLinker: hoisted`, `autoInstallPeers: false` | `profile.ts:230-235, 261-262` |

`install_bundle` then:
* adds the dependency spec to `package.json.dependencies` (pnpm does this),
* appends the package name to `package.json.dsh.profile.bundles`
  (`index.ts:730-733`, written atomically by `saveManifest`/`writeFileAtomic`),
* writes `pnpm-lock.yaml`, `node_modules/` (pnpm),
* may write `pnpm-workspace.yaml` `allowBuilds.<pkg>: true` (build approval),
* keeps diagnostics under `<profile>/.plugin-manager/logs/operation-*/pnpm.log`
  (`operations.ts:290-294`) and a run record at `<profile>/.plugin-manager/run.json`
  (`operations.ts:199-207`).

Nothing outside the profile directory changes. Bundle *selection* (enable/disable) is
`dsh.profile.bundles`; *installation* is `dependencies`. Disabling retains the dependency;
enabling appends at the end, which can change precedence
(`packages/boot/plugin-manager/README.md:40`).

#### The CLI equivalent

`dsh plugin --profile <name> <pnpm args...>` forwards to pnpm with relative path specs anchored
to the invocation directory, then reconciles `dsh.profile.bundles` against installed state
(`apps/cli/reference/README.md:81`). Initialization for a name without a shipped template uses
`DEFAULT_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base']`
(`packages/boot/app-boot/src/profile.ts:202-203`, consumed in
`packages/boot/plugin-manager/src/operations.ts:544-557`).

The author-facing tutorial for this whole flow (including the git-install `prepare` script and
pnpm ≥10 `allowBuilds` caveat) is `docs/user/develop/basic/publish.md:75-184`.

### 3.4 Bundle resolution order

`resolveBundleDir` probes **the dsh installation first, then the profile directory**
(`packages/boot/app-boot/src/profile.ts:630-641`), using Node's own `require.resolve.paths`
walk (`packageDirFromAnchor`, lines 608-616). That is why `@deepseek-ai/dsh-base` always comes
from the same installation as the running `dsh` (`profile.ts:618-623`), and why the docs can
promise "your bundle can rely on `@deepseek-ai/dsh-base` being present and current"
(`docs/user/develop/basic/publish.md:134`).

### 3.5 Optional bundles

Packages the installation ships switched off are named by `OPTIONAL_BUNDLES`
(`packages/boot/app-boot/src/profile.ts:213-218`): `@deepseek-ai/dsh-experimental-agent-team-profile`,
`@deepseek-ai/dsh-experimental-voice-input-bundle`, `@deepseek-ai/dsh-experimental-auto-review`,
`@deepseek-ai/dsh-experimental-schedule-bundle`. Admission conditions (runtime dependency of the
installation declaring `dsh.bundle.patch`, an `icon`, `./locale/*.json` metadata, selected by no
shipped template) are documented at `profile.ts:205-212`. Such a bundle is `optional: true`,
never removable, and listed switched off (`packages/boot/plugin-manager/src/index.ts:290-293`).

---

## 4. Profiles and patch composition

### 4.1 The loader config model

The effective Cordis tree is composed **over an empty root** by applying, in order
(`apps/cli/reference/README.md:9`, restated in `docs/user/develop/basic/publish.md:120-125`):

1. each bundle patch named in the profile's `dsh.profile.bundles` list, in list order
   (`@deepseek-ai/dsh-base` first, then each installed bundle in the order added);
2. the profile's own `$DSH_HOME/profiles/<name>/cordis.patch.yml`;
3. the home-level `$DSH_HOME/cordis.patch.yml` (machine-local; outranks the per-profile layer);
4. each `--patch <path>` overlay, in argv order.

This is implemented in `readProfilePatches`
(`packages/boot/app-boot/src/profile-context.ts:63-75`):

```ts
const patches = structuredClone([
  ...profile.layers.flatMap(layer => layer.patches),
  ...(initialProfile?.patches ?? loadOptionalPatches(binName, context.patchPath) ?? []),
  ...(loadOptionalPatches(binName, join(context.home, PROFILE_PATCH_FILENAME)) ?? []),
  ...context.overlays,
])
```
followed by an appended hard telemetry-disable patch (lines 71-73) driven by
`DSH_TELEMETRY_DISABLED` (`resolveTelemetryPatch`, lines 52-55 — any non-empty value disables).

**Later layers win per row, and a patch replaces the row's entire `config` value** — it does not
deep-merge keys (`apps/cli/reference/README.md:9`, `packages/bundle/base/cordis.patch.yml:6-10`).
Consequence for bundle authors, quoted from `docs/user/develop/basic/publish.md:131-132`: a patch
"can override rows from earlier layers by `id` … but must restate every key the row needs, not
just the changed one."

### 4.2 Which file the user edits to add a plugin row

**`$DSH_HOME/profiles/<name>/cordis.patch.yml`** — the profile's own patch layer
(`PROFILE_PATCH_FILENAME = 'cordis.patch.yml'`, `packages/boot/app-boot/src/profile.ts:40`; path
exposed as `ProfileContext.patchPath`, `profile-context.ts:20`). The file's own template
(`profile.ts:220-224`):

```yaml
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
[]
```

For a machine-local tweak across every profile, the user edits `$DSH_HOME/cordis.patch.yml`
instead (it outranks the per-profile file). For a one-off, `--patch <file>`.

The plugin manager writes here too: `setPluginEnabled` persists enablement by editing the last
matching override in this file (`writePluginEnabled`,
`packages/boot/plugin-manager/src/patch.ts:14-43`), preserving comments via `parseDocument` and
appending `{ id, disabled: !enabled }` when no override matches.

### 4.3 `insert:` rows

A patch file is a top-level YAML **array**. Each element is either an `insert` or an id-targeted
override. The loader's type is `PatchOptions` (`vendor/include/src/index.ts:129-140`):

```ts
export interface PatchOptions {
  id?: string
  insert?: EntryOptions[]
  name?: string
  config?: any
  group?: boolean | null
  disabled?: boolean | null
  inject?: any
  intercept?: any
  isolate?: any
  [key: string]: any
}
```

and each inserted row is an `EntryOptions` (`vendor/loader/src/config/entry.ts:10-23`):

```ts
export interface EntryOptions {
  /** Stable id inside the containing entry tree. */
  id: string
  /** Module specifier imported by the entry tree. */
  name: string
  /** Config passed to the plugin. */
  config?: any
  /** Marks this entry as a nested group. */
  group?: boolean | null
  /** Prevents this entry and descendants from running. */
  disabled?: boolean | null
  /** Required services or service intercept config for this entry. */
  inject?: Inject | null
}
```

Field semantics:

* `id` — stable row identity; the address other layers use to override it. It is also the
  diagnostics key (`StartupError` entries are keyed by `entry.options.id`).
* `name` — module specifier (package name, package subpath, absolute path, file URL, or
  `cordis:*` builtin). Relative `./`/`../` names and absolute paths in `insert` rows are
  converted to file URLs anchored beside the patch file
  (`anchorInsertedPluginNames`, `packages/boot/app-boot/src/index.ts:346-356`).
* `config` — passed to the plugin's `apply(ctx, config)` after schema validation (§6).
* `disabled` — `true` suppresses the row and its descendants; `!!js` is allowed.
* `inject` — per-row required services or intercept config, layered onto the plugin's own
  `static inject`.
* `group: true` — the row is a group carrier whose `config` is itself an `EntryOptions[]`.

Patch application semantics are in `applyEntryPatches` (`vendor/include/src/index.ts:57-127`).
Notable details:

* One `insert` **without** `id` appends to the root list (line 93); an `insert` **with** `id`
  targets an existing `group: true` row and pushes into its `config` array (lines 80-91),
  warning `patch insert: entry %C is not a group` when the target is not a group.
* Rows inserted by a patch are immediately indexed so a **later patch in the same list** can
  target them (lines 95-100) — the comment at lines 95-99 records that this was a real bug.
* A non-insert patch requires `id` (lines 104-107) and warns
  `patch: entry %C not found` when the target is absent (lines 109-113). An optional `name` is a
  mismatch assertion (lines 115-118).
* Overrides assign keys wholesale onto the target object (lines 120-123) — hence "replaces the
  whole `config`".

Canonical examples: `packages/bundle/base/cordis.patch.yml:15-22` (insert + `disabled` + `!!js`)
and `packages/bundle/base/cordis.patch.yml:96-103` (config preservation note).

### 4.4 The `!!js` expression tag

`!!js` scalars become expression nodes evaluated at entry activation. Defined by
`packages/boot/app-boot`'s use of the include's YAML dialect
(`vendor/include/src/index.ts:9-23`):

```ts
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  predicate: isJsExpr,
  represent: (data) => data['__jsExpr'],
})

export const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)
```

Evaluation is a `with (ctx) { return eval(expr) }` over the **entry's own context**
(`vendor/loader/src/config/utils.ts:5-9`), interpolated recursively
(`utils.ts:12-22`). `disabled` is evaluated too (`vendor/loader/src/config/entry.ts:89-93`), and
"a throwing disabled expression is an entry failure, not a disabled entry"
(`packages/boot/app-boot/README.md:100`).

What is in scope inside the expression is whatever the entry's injected context exposes plus the
globals. Two are used heavily in shipped patches:

* `ctx.get(name)` — service lookup, e.g.
  `disabled: !!js "!ctx.get('profileContext')"` (`bundle/base/cordis.patch.yml:22`) and
  `config: { desktopPlatform: !!js "ctx.get('profileContext')?.name === 'desktop' && ..." }`
  (line 115).
* `process.env` / `process.platform` / `process.cwd()`, e.g.
  `disabled: !!js process.platform === 'win32'` (line 237) and
  `mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'` (line 232).
* `dshHomePath(...)`, installed on the boot context before any entry mounts
  (`packages/boot/app-boot/src/index.ts:995`, declared at `index.ts:40-44`):
  `root: !!js dshHomePath('sessions')` (`bundle/base/cordis.patch.yml:133`).

The key ordering guarantee (`docs/user/develop/basic/publish.md:157`): "Loader mounts the
composition once, waits for each row's ordinary injections, and only then evaluates that row's
`!!js` config against its injected context." Hence the pattern for app-argument rows
(`publish.md:149-155`):

```yaml
- id: my-app
  name: '@example/my-app'
  inject: [myAppStartup]
  config:
    port: !!js ctx.myAppStartup.port ?? 8080
```

`--dump-config` prints `!!js` expressions **verbatim, unevaluated**
(`apps/cli/reference/README.md:51`).

### 4.5 Profile directory layout

```
$DSH_HOME/                                  # resolveDshHome(); default ~/.dsh
├── cordis.patch.yml                        # home-level tweak layer (layer 3)
├── .env                                    # user env layer (bootstrap names refused)
├── .credentials.yaml
├── sessions/  storages/                    # from dshHomePath(...) in bundle patches
└── profiles/
    └── <name>/
        ├── package.json                    # deps + dsh.profile.bundles
        ├── cordis.patch.yml                # the user's own patch layer (layer 2)
        ├── pnpm-workspace.yaml             # hoisted linker, autoInstallPeers: false, allowBuilds
        ├── compatibility.json              # exact-version exemptions (optional)
        ├── pnpm-lock.yaml
        ├── node_modules/
        └── .plugin-manager/
            ├── run.json                    # active pnpm run record
            └── logs/operation-*/pnpm.log
```
Sources: `packages/util/home-paths/src/index.ts:87-100`; `profile.ts:169-176` (profile dir),
`profile.ts:244-263` (init files); `plugin-manager/src/index.ts:794` (`compatibility.json` is one
of the four files whose text defines `diskState()`); `operations.ts:199-207, 290-294`.

Shipped templates (`PROFILE_TEMPLATES`, `profile.ts:179-195`): `acp`, `web`, `headless`, `sdk`
are each `['@deepseek-ai/dsh-base', <mode bundle>]`; `sdk-minimal` is `['@deepseek-ai/dsh-sdk-minimal']`.
Custom profiles: `dsh --profile <name> --from-default-profile <template>`
(`apps/cli/reference/README.md:15-17`).

### 4.6 Previewing the composition

* `dsh --profile <p> --dump-default-config` — bundle layers only.
* `dsh --profile <p> --dump-config` — adds the profile patch, the home patch, and `--patch`
  overlays, with `# ==` comments naming the contributing file and every overlay that changed each
  row (`renderConfigDump`, `packages/boot/app-boot/src/index.ts:430-493`; `groupedDump`,
  lines 496-524).
* `dsh --profile <p> --dump-config-schema` — JSON Schema 2020-12 of the composed entry list
  (`apps/cli/reference/README.md:56-62`).

---

## 5. Dynamic tool registration at runtime

**Answer: YES.** A plugin can register a tool after its own `apply()` has returned, and can
unregister/replace it later in response to runtime events. There is no `unregister(name)` method:
the *disposer returned by `register()`* is the unregister API.

### 5.1 The exact API

From `packages/core/tools/src/index.ts`:

```ts
/**
 * Register globally or in the calling agent scope. Scoped tools shadow
 * globals; duplicates within one layer and the reserved `run_code` name fail.
 * @param definition - tool schema, execution, and optional finalization/presentation callbacks.
 * @returns the exact disposer that unregisters the tool.
 */
register(definition: ToolDefinition): () => void {
```
(`index.ts:1057-1063`)

Validation performed before the effect is created (`index.ts:1064-1082`): `output` must be
`{ schema, render, presentationMeta? }` with `render` a function (`TypeError` otherwise);
`assertSupportedJsonSchema(output.schema)`; `timeoutMs` must be a positive finite number; and the
name `run_code` is reserved unconditionally:

```ts
if (name === RUN_CODE_NAME) {
  throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the PTC mode presentation transport and cannot be registered or shadowed`)
}
```
(`index.ts:1080-1082`)

The registration itself is a Cordis effect owned by the *calling* context
(`index.ts:1083-1087`):

```ts
return this.layers.effect(
  this.ctx,
  layer => layer.tools.insert(name, definition),
  { label: 'tools.register()' },
)
```

`ScopedLayers.effect` is where scoping and teardown are decided
(`packages/core/scope/src/store.ts:226-266`):

```ts
effect(
  ctx: Context,
  action: (layer: L) => () => void,
  options: { label: string; notify?: boolean },
): () => void {
  const scope = scopeOf(ctx)
  const notify = options.notify ?? true
  const dispose = ctx.effect(function* (this: ScopedLayers<L>) {
    let layer: L
    let created = false
    if (scope === undefined) {
      layer = this.global
    } else {
      const existing = this.scoped.get(scope)
      if (existing === undefined) {
        layer = this.createLayer(scope)
        this.scoped.set(scope, layer)
        created = true
      } else {
        layer = existing
      }
    }
    let undo: () => void
    try {
      undo = action(layer)
    } catch (error) {
      if (scope !== undefined && created && layer.isEmpty()) this.scoped.delete(scope)
      throw error
    }
    yield () => {
      undo()
      if (scope !== undefined && layer.isEmpty()) this.scoped.delete(scope)
      if (notify) this.onChange()
    }
    if (notify) this.onChange()
  }.bind(this), options.label)
  return dispose
}
```

So:

* **Scope = the registering Context.** `scopeOf(ctx)` is `undefined` for a plain context
  (register globally) and the agent key for an `agent.ctx` (register into that agent's layer).
  `ToolLayer`'s duplicate message states the rule (`index.ts:746-748`):
  *"tool \"${name}\" is already registered (for a per-agent variant, register through that
  agent's `agent.ctx` instead)"*.
* **Teardown is automatic.** The effect is owned by the registration context's fiber; disposing
  that fiber runs the undo. This is asserted by tests:
  `packages/core/tools/tests/tools.spec.ts:2087-2099` ("rejects duplicate names and unregisters
  on fiber dispose (HMR safety)") and `:2101-2110` ("returns a callable disposer from register()
  that unregisters the tool"). Every tool package carries the equivalent test, e.g.
  `packages/todo/tool-todo/tests/tool-todo.spec.ts:214` and
  `packages/subagent/tool-subagent-control/tests/list-agents.spec.ts:241-251`.
* **A throwing `tools/change` listener rolls the registration back** rather than leaking it
  (`packages/core/tools/tests/tools.spec.ts:2112-2129`).
* The registry emits a payload-free `'tools/change'` notification whenever the available set
  changes — including "a tool was registered or unregistered, or a scoped restriction changed"
  (`index.ts:199-208`), which is what makes late registration visible to prompt assembly.

### 5.2 Reading back: `get` and `schemas`

```ts
/**
 * Look up a tool as one scope sees it (scoped
 * shadows global; a restricted-away global reads as absent). ...
 * @returns the definition the scope resolves, or undefined when none is visible.
 */
get(name: string, scope?: ScopeKey): ToolDefinition | undefined {
  return this.view(scope).visible.get(name)
}
```
(`index.ts:1221-1232`)

```ts
/**
 * Project visible definitions onto the allowlisted model-facing schema fields,
 * excluding execution and presentation callbacks.
 * @returns one deep-cloned schema per visible tool.
 */
schemas(scope?: ScopeKey): ToolSchema[] {
  return [...this.view(scope).visible.values()].map(definition => this.schemaOf(definition, true))
}
```
(`index.ts:1254-1262`)

Plus `presentAs(mode)` (`index.ts:974-1002`), `restrict(filter)` (`index.ts:1097-1124`) and
`guard(guard)` (`index.ts:1136-1142`), each returning its own disposer.

### 5.3 Runtime re-registration in shipped code — the proof

`packages/shell/tool-bash/src/index.ts:536-554` swaps the registered tool as a service appears
and disappears, then restores it:

```ts
// The background surface follows the registry. The foreground-only variant
// registers now unless a registry is already composed, the job-backed
// variant replaces it for as long as `ctx.jobs` is present, and the
// foreground-only one returns when the registry unloads while this plugin
// stays. Both registrations belong to this plugin's own fiber.
if (!backgroundEnabled) {
  ctx.tools.register(bashTool(undefined))
  return
}
let foregroundOnly = ctx.get('jobs') === undefined ? ctx.tools.register(bashTool(undefined)) : undefined
ctx.inject(['jobs'], (jobCtx) => {
  foregroundOnly?.()
  foregroundOnly = undefined
  const unregister = ctx.tools.register(bashTool(jobCtx.jobs))
  jobCtx.effect(() => () => {
    unregister()
    if (ctx.fiber.state === FiberState.ACTIVE) foregroundOnly = ctx.tools.register(bashTool(undefined))
  })
})
```

`packages/shell/tool-pwsh/src/index.ts:602-604` is the same pattern. Beyond plugins,
`packages/extensions/cordis-host-runner` lets agent-authored code register and unregister tools
during a session, with a test asserting both directions
(`tests/composition.spec.ts:160-170`):

```ts
it('unregisters a self-made tool on stop, and registers it again on the next run', async () => {
  const harness = await setup()
  const id = await mount(harness, REVERSE_TOOL_CODE)
  expect(harness.ctx.tools.get('reverse_text')).toBeDefined()
  await harness.runner.stop(AGENT_A, id)
  expect(harness.ctx.tools.get('reverse_text')).toBeUndefined()
  await harness.runner.run(AGENT_A, id, latestPackage(harness, id), 'run')
  expect(harness.ctx.tools.get('reverse_text')).toBeDefined()
})
```

### 5.4 The one hard limit

`ctx.effect()` **throws once the owning fiber is disposed** (`vendor/cordis/src/fiber.ts:418-422`):

```ts
effect(execute: () => Effect, label = 'anonymous'): any {
  this.assertActive()
  if (this.state === FiberState.UNLOADING) {
    throw new CordisError('INACTIVE_EFFECT')
  }
```

So "dynamically at runtime" means *during the plugin's active lifetime*: any event handler,
injected-service callback, timer, or stream owned by the plugin's fiber may register or dispose
tools freely; code running after fiber disposal cannot. The docs state the same contract from the
consumer side (`docs/user/develop/framework/index.md:40-63`): "Every registration made through
`ctx` is undone when the plugin unloads", explicitly listing `ctx.tools.register(tool)`.
The in-repo guidance for a hot swap: "To hot-swap a tool, dispose its owning effect and register
the replacement" (`docs/cookbook/adding-a-tool.md:43`).

---

## 6. Config pattern

Every plugin exports a **`Config` interface** and a **same-named Schemastery schema**; Cordis
validates the row's `config:` block against it while the plugin loads, filling defaults
(`docs/user/develop/basic/config.md:9-45`).

### 6.1 Function-plugin form (the common one)

`packages/todo/tool-todo/src/index.ts:22-43`:

```ts
export const name = 'tool-todo'
export const inject = ['tools', 'sessionProjections']

/** Model-facing todo tool configuration. */
export interface Config {
  allowParallelInProgress: boolean
}

/** Schemastery configuration for the todo consumer. */
export const Config: z<Config> = z.object({
  allowParallelInProgress: z.boolean().required(),
})
```

consumed at `src/index.ts:117-118`:

```ts
export function apply(ctx: Context, config: Config): void {
  const allowParallel = config.allowParallelInProgress
```

Note `z` here is `@deepseek-ai/schemastery`'s default export
(`import z from '@deepseek-ai/schemastery'`, `src/index.ts:9`), *not* zod — the same file imports
zod separately for the wire projection schema (`import { z as zod } from 'zod'`, line 10).

Defaults live on the schema fields, e.g. `packages/bundle/web-app/src/index.ts:60-65`:

```ts
export const Config: z<Config> = z.object({
  openBrowser: z.boolean().default(true),
  printUrl: z.boolean().default(true),
  surfaceContext: z.boolean().default(true),
  trustedHosts: z.array(String).default([]),
})
```

### 6.2 Service/class-plugin form

A plugin that *provides* a service extends Cordis `Service` and declares `static inject` +
`static Config`, e.g. `packages/boot/plugin-manager/src/index.ts:176-187`:

```ts
export class PluginManager extends TypertRemoteService {
  static inject = ['loader', 'profileContext']
  static Config: z<Config> = z.object({
    pnpmCommand: z.string().default('pnpm'),
    outputBytes: z.number().step(1).min(1).default(16384),
    lockWaitMs: z.number().step(1).min(1).default(120000),
    inspectTimeoutMs: z.number().step(1).min(1000).default(20000),
    githubConnectionTimeoutMs: z.number().step(1).min(1000).default(5000),
    idleTimeoutMs: z.number().step(1).min(600000).default(600000),
    registry: z.string().pattern(REGISTRY_URL),
    fallbackRegistries: z.array(z.string().pattern(REGISTRY_URL)).default([NPMMIRROR_REGISTRY]),
  })
```

`ToolRuntime` is the same (`packages/core/tools/src/index.ts:807-813`). The constructor receives
the validated config: `constructor(ctx: Context, config: Config)`
(`plugin-manager/src/index.ts:205`).

### 6.3 Rules the docs state

* "Do not export a plain object as `Config`; it does not implement the Standard Schema interface
  required by Cordis." (`docs/user/develop/basic/config.md:45`)
* Anything two deployments may set differently must be a config field — "the test is whether
  `cordis.yml` can change the value without a code edit" (`config.md:78-92`).
* Self-contained constraints belong in the schema so invalid config fails at load
  (`config.md:94-96`); anything referencing a service needs `inject`.
* Invalid config fails the load with an actionable error (`config.md:74`).

### 6.4 The full config reference

`docs/config-catalog.md` (4521 lines) is generated from source by `scripts/gen-config-catalog.ts`
and verified fresh by `pnpm run verify-config-catalog`. It prints, per package, the `inject` keys,
the referenced types, the source link, and the verbatim Config declaration, e.g.
`docs/config-catalog.md:15-33`. It cross-checks the runtime schemastery schema against the pasted
declaration so a field the Loader accepts cannot be hidden (`config-catalog.md:8`).
`--dump-config-schema` produces the machine-readable form at runtime
(`apps/cli/reference/README.md:56-62`).

---

## 7. Testing a plugin

### 7.1 Policy and tiers

`docs/testing.md` is the authority. Summary of the tiers relevant to a plugin author
(`docs/testing.md:7-17`):

| Command | What it is |
|---|---|
| `pnpm run test` | vitest unit tier over `packages/*/*/tests/**` + `apps/*/tests/**` + `scripts/**/*.spec.ts` (`vitest.config.ts:123-128`) |
| `pnpm run test:coverage` | the CI gate: **per-file 100 %** statements/branches/functions/lines on `packages/*/*/src` (`vitest.config.ts:366-378`) |
| `pnpm run test:e2e` | real-API, self-skipping without keys |
| `pnpm run test:expected` | keyless assembled CLI/process expectations |
| `pnpm run test:snapshot` | recorded-session replay through shipped profiles |

Root scripts: `package.json:56-77`. Note `test` and `test:coverage` both first run
`pnpm run build:native-system` (`package.json:56-57`).
`AGENTS.md:89-94` lists the same commands; `AGENTS.md:120` states
"`test:coverage`, not `test`, is the CI coverage gate".

Policy points a plugin author must satisfy (`docs/testing.md:39-41`):

* "Product-visible plugins require a non-unit REAL-composition test. Hand-built `ctx.plugin(...)`
  suites are insufficient: boot test-only `cordis.yml` through Loader and app/process, mock only
  external services or nondeterministic inputs."
* A plugin without `inject` needs an explicit `expect('default' in mod).toBe(false)` plus an
  `unwrapExports` round-trip assertion, because a default export would silently replace the
  required named exports.
* Tests resolve to `src` only: every vitest config points `vite-tsconfig-paths` at
  `tsconfig.base.json`, never through package `exports` into `lib/` (`docs/testing.md:43-45`,
  `vitest.config.ts:16-20`).

### 7.2 How a plugin is booted on a real context in a test

**(a) Hand-mounted context** — the standard unit shape, from
`packages/todo/tool-todo/tests/tool-todo.spec.ts:30-49`:

```ts
async function setup(allowParallelInProgress: boolean): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(tool, { allowParallelInProgress })
  return ctx
}

let callCounter = 0
function callTodo(ctx: Context, args: unknown, over: { agent?: Agent | undefined } = {}) {
  const agent = 'agent' in over ? over.agent : agentWithSession()
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`call-${++callCounter}`),
    name: 'todo_write',
    arguments: args,
    ...agent ? { agent } : {},
  })
}
```

The docblock above it (lines 16-22) states the intent: "Drives the REAL plugin body: mounts
`dsh-tool-todo` on a real `ToolRuntime` and invokes the registered `todo_write` tool through
`ctx.tools.execute` … only the agent wrapper is a stand-in; the session and the tool are the
shipping code."

**(b) The `@deepseek-ai/dsh-agent-loop-testkit` helper** — mounts the standard prerequisite
services without mounting the loop itself. From `packages/todo/tool-todo/tests/loader-composition.spec.ts:20`
and `packages/subagent/tool-subagent-control/tests/list-agents.spec.ts:8`:

```ts
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
```

Its contract (`packages/test-support/agent-loop-testkit/src/index.ts:55-77`):

```ts
/**
 * Mount the standard prerequisite services for an AgentLoop test.
 *
 * The function deliberately does not mount AgentLoop or register an adapter,
 * so tests retain control of load order and the topology under test. The
 * context owns every mounted service and remains responsible for disposal. ...
 */
export async function mountAgentLoopTestDependencies(
  ctx: Context,
  options: AgentLoopTestDependenciesOptions = {},
): Promise<void> {
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, options.systemPrompt ?? {})
  await ctx.plugin(ToolRuntime, options.tools ?? {})
  await ctx.plugin(AgentRegistry)
}
```

It also exports `mountAgentLoopTestHarness` (lines 79-93, which mounts `AgentLoop` and returns
`{ create, claim }`) and the Inbox stubs `createInboxStub` / `unsupportedInbox` (line 21).
Usage, from `packages/subagent/tool-subagent-control/tests/list-agents.spec.ts:58-74`:

```ts
async function setupWith(adapter: MockAdapter | GatedAdapter) {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-tool-list-agents-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(tool)                       // the plugin under test
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  parkParent(ctx, parent)
  return { ctx, parent, adapter }
}
```

Teardown owns the resources (`list-agents.spec.ts:49-56`):

```ts
const roots: string[] = []
const contexts = new Set<Context>()
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
```

**(c) Real Loader composition through a test-only `cordis.yml`** — required for any
product-visible plugin. `packages/todo/tool-todo/tests/loader-composition.spec.ts:56-92` writes a
config file, installs the real Loader + Include builtins, injects a module table so bare names
resolve to the in-test classes, and waits for settlement:

```ts
const ctx = new Context()
context = ctx
ctx.baseUrl = pathToFileURL(root).href + '/'
await ctx.plugin(Loader)
ctx.loader.builtins.include = Include
const modules = new Map<string, unknown>([
  ['@deepseek-ai/dsh-agent', AgentRegistry],
  ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
  ['@deepseek-ai/dsh-tools', ToolRuntime],
  ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
  ['@deepseek-ai/dsh-tool-todo', ToolTodo],
])
ctx.loader.internal = {
  version: 'v2',
  async import(specifier: string) {
    if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
    return modules.get(specifier)
  },
} as unknown as NonNullable<typeof ctx.loader.internal>
await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
await ctx.loader.await()
for (const entry of ctx.loader.entries()) await entry.fiber?.await()
```

That suite's purpose is exactly configurability proof (lines 1-3): "Proves
`allowParallelInProgress` is real configurability and not a constant: the flag is set in a
`cordis.yml` booted through the real Loader, and both faces it controls — the model-facing
description and the accepted input — follow it." It also asserts the *failure* mode
(lines 136-143):

```ts
it.each([
  { label: 'is omitted', configLines: [], failure: '$.allowParallelInProgress missing required value' },
  { label: 'is not boolean', configLines: ['    allowParallelInProgress: "no"'], failure: '$.allowParallelInProgress expected boolean' },
])('fails loading when allowParallelInProgress $label', async ({ configLines, failure }) => {
  await expect(boot(configLines)).rejects.toThrow(failure)
}, 30_000)
```

**(d) Namespace/export-shape assertion** — the guard the policy demands
(`list-agents.spec.ts:253-258`):

```ts
it('has the namespace-plugin export shape', () => {
  expect('default' in tool).toBe(false)
  expect(tool.name).toBe('tool-subagent-list-agents')
  expect(tool.inject).toEqual(['tools', 'subagents', 'agents'])
  expect(typeof tool.apply).toBe('function')
})
```

**(e) Fixtures.** `@deepseek-ai/dsh-tools` exports `defineContentToolFixture` for test-only tools
(`packages/core/tools/src/testing.ts:20-40`, exported at `src/index.ts:107`). The mock LLM
adapter lives beside the loop tests and is imported by sibling packages by relative path
(`packages/subagent/tool-subagent-control/tests/list-agents.spec.ts:16`):
`import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'`.
Shared fixtures belong in a plain `tests/harness.ts`, never another spec
(`docs/testing.md:35`).

### 7.3 The vitest invocation

Root `package.json` scripts (`package.json:56-78`, and `vitest.config.ts`):

```json
"test": "pnpm run build:native-system && vitest run",
"test:coverage": "pnpm run build:native-system && vitest run --coverage",
"test:e2e": "vitest run --config vitest.e2e.config.ts",
"test:expected": "vitest run --config vitest.expected.config.ts",
"test:snapshot": "vitest run --config vitest.snapshot.config.ts",
"test:web": "npm run build && npm run test:web:built"
```

`vitest.config.ts` in full outline:

* Plugins: `vite-tsconfig-paths` pointed at `tsconfig.base.json` (match-all), plus
  `standardDecoratorPlugin()` (lines 168, 20).
* `setupFiles`: `./scripts/test-proxy-environment.ts`, `./scripts/test-invariants.ts`,
  `./scripts/test-dom-environment.ts` (line 170).
* `include`: `['packages/*/*/tests/**/*.spec.{ts,tsx}', 'apps/*/tests/**/*.spec.{ts,tsx}',
  'scripts/**/*.spec.ts', 'website/tests/**/*.spec.ts']` (lines 123-128).
* Two projects, both `pool: 'forks'`: `thread-safe` (everything except `processBoundTests`) and
  `process-bound` (an explicit list at lines 156-165, e.g. `app-boot.spec.ts`,
  `workflow-ptc.spec.ts`).
* Coverage: provider `v8`, `include: ['packages/*/*/src/**/*.{ts,tsx}']` with a long `exclude`
  list, `reporter` `text` + a custom uncovered-locations reporter, thresholds
  `{ perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 }`
  (lines 212-384). Comment at 366-369: "100% or it doesn't merge (docs/testing.md: excessive
  tests are welcome). Per-file so a well-covered big file can't subsidize a bare one."

Practical invocation for one plugin package during development:

```
pnpm vitest run packages/todo/tool-todo/tests
```

and for the gate:

```
pnpm run test:coverage
```

A plugin *outside* this repository has no vitest config of its own here; the author would run
their own vitest with the same shape (`new Context()`, `await ctx.plugin(plugin, config)`,
`afterEach(() => ctx.fiber.dispose())`).

### 7.4 Note on `pnpm run constraints`

For an in-repo package, `pnpm run constraints` (`scripts/check-workspace-constraints.ts`,
`package.json:192`) enforces the package.json invariants listed in §1.2 —
`private: true`, version matching root, `type: module`, `main`/`types`/`exports` shapes, cordis in
peer+dev at the same range, every dsh peer mirrored in devDependencies, and the exact `files`
list (`check-workspace-constraints.ts:246-290, 307-329`). `pnpm run publint` and
`pnpm run verify-package-meta` are the adjacent publication checks.

---

## 8. Files read

All under `D:\deepseek-harness\` unless noted.

**Plugin package shape**
- `packages/todo/tool-todo/package.json`
- `packages/todo/tool-todo/tsconfig.json`
- `packages/todo/tool-todo/src/index.ts`
- `packages/subagent/tool-subagent-control/package.json`
- `packages/subagent/tool-subagent-control/tsconfig.json`
- `packages/subagent/tool-subagent-control/src/index.ts`
- `packages/subagent/tool-subagent-control/src/list-agents.ts`
- `packages/bundle/base/src/index.ts`
- `packages/bundle/web-app/src/index.ts`
- `tsdown.config.ts`, `package.json` (root), `tsconfig.base.json`
- `scripts/check-workspace-constraints.ts` (grep: `expectedDshPackageFiles`, `usesEmittedTreeDefaults`)

**Compatibility**
- `packages/boot/app-boot/src/plugin-compatibility.ts` (full)
- `packages/boot/app-boot/src/profile-compatibility.ts` (full)
- `packages/boot/app-boot/src/compatibility-preflight.ts` (full)
- `packages/util/package-manifest/src/types.ts` (full)
- `packages/boot/app-boot/README.md` (lines 44-113)

**Bundles**
- `packages/bundle/base/package.json`, `packages/bundle/base/cordis.patch.yml` (full)
- `packages/bundle/headless/package.json`, `packages/bundle/web-app/package.json`
- `packages/bundle/sdk-minimal/cordis.patch.yml`
- `packages/experimental/schedule-bundle/package.json`
- `packages/boot/app-boot/src/profile.ts` (full, 738 lines)
- `apps/cli/composition.md`

**Plugin manager**
- `packages/boot/plugin-manager/src/index.ts` (full, 804 lines)
- `packages/boot/plugin-manager/src/operations.ts` (full, 640 lines)
- `packages/boot/plugin-manager/src/patch.ts`, `registry.ts`, `types.ts`, `install-spec.ts`,
  `install-failure.ts`, `failure.ts`, `build-approval.ts`, `run-tree.ts`, `github-connection.ts`,
  `tools.ts`
- `packages/boot/plugin-manager/README.md`
- `packages/boot/plugin-manager/package.json`

**Profiles & patch composition**
- `packages/boot/app-boot/src/profile-context.ts` (full)
- `packages/boot/app-boot/src/index.ts` (full, 1066 lines)
- `packages/util/home-paths/src/index.ts` (full)
- `vendor/include/src/index.ts` (lines 1-140)
- `vendor/loader/src/config/entry.ts` (lines 1-130)
- `vendor/loader/src/config/utils.ts` (full)
- `apps/cli/reference/README.md` (grep)
- `docs/user/develop/basic/publish.md`, `config.md`, `index.md`, `tool.md`
- `docs/config-catalog.md` (head), `docs/subsystems/boot.md`

**Dynamic tool registration**
- `packages/core/tools/src/index.ts` (lines 1-1311 + targeted reads; register 1057-1088,
  get 1221-1232, schemas 1254-1262, restrict 1090-1124, guard 1126-1142, events 199-208)
- `packages/core/scope/src/store.ts` (full)
- `packages/core/tools/src/testing.ts`
- `packages/core/tools/tests/tools.spec.ts` (lines 2085-2129)
- `packages/shell/tool-bash/src/index.ts` (lines 525-555)
- `packages/extensions/cordis-host-runner/tests/composition.spec.ts` (lines 140-180)
- `vendor/cordis/src/fiber.ts` (lines 400-459), `vendor/cordis/src/registry.ts` (lines 285-335)

**Testing**
- `docs/testing.md` (full)
- `vitest.config.ts` (full)
- `packages/test-support/agent-loop-testkit/src/index.ts` (full)
- `packages/todo/tool-todo/tests/tool-todo.spec.ts`, `tests/loader-composition.spec.ts`
- `packages/subagent/tool-subagent-control/tests/list-agents.spec.ts`
- `AGENTS.md` (grep)

**Docs consulted but not central:** `docs/cookbook/adding-a-package.md`,
`docs/cookbook/adding-a-tool.md`, `docs/user/develop/framework/index.md`,
`docs/user/develop/practice/dynamic-cordis.md`, `docs/subsystems/boot.md`.

### Things checked and NOT found

* No `engines.dsh` enforcement anywhere — only `peerDependencies` is read
  (grep for `engines?.dsh` / `'engines'` matched only `scripts/benchmark-npm-resolution.ts:31`).
* No `tools.unregister(name)` method; the only unregister API is the disposer returned by
  `register()`.
* No top-level `cordis` key in any package.json; bundle marking is `dsh.bundle.patch`.
* There is no `docs/configuration.md` — the configuration references are `docs/config-catalog.md`
  (generated, per-package Config declarations) and the per-package README config tables (e.g.
  `packages/boot/plugin-manager/README.md:71-83`). `docs/user/develop/basic/config.md` is the
  authoring tutorial.
* `docs/testing.md` does not name a per-package test command; the tiers are the root scripts.
