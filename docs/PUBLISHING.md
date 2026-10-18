# Publishing the plugin to npm

The plugin ships as `@try-works/dsh-model-as-tool` and installs like any other
DSH plugin. This file records the release flow; it contains no credentials.

## Where the credentials live

The npm token is kept **outside the repository** and is never written into it:

- `%USERPROFILE%\.dsh\secrets\npm-token.env` — one line, `NPM_TOKEN=<token>`
- `%USERPROFILE%\.dsh\secrets\npmrc` — `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`

npm expands `${NPM_TOKEN}` from the environment at call time, so the token itself
is not duplicated into another file. Load it per shell session:

```powershell
$line = Get-Content (Join-Path $env:USERPROFILE '.dsh\secrets\npm-token.env') -Raw
if ($line -match '^NPM_TOKEN=(.+)$') { $env:NPM_TOKEN = $Matches[1] }
$npmrc = Join-Path $env:USERPROFILE '.dsh\secrets\npmrc'
npm whoami --userconfig $npmrc   # expect the publisher account
```

Never `git add` a token, an `.npmrc`, or a copied env file. `.gitignore` already
covers the usual suspects; the secrets above live outside the tree.

## What gets published

`packages/dsh-model-as-tool` — host half (`lib/`), browser half
(`client/index.js` + the generated `client.model-tools.js` chunk), the Remote
artifacts (`remote/*.mjs`), the catalog, the launcher bins, and the bundle patch.
Its three internal `@try-works/*` dependencies are declared as
`bundledDependencies`, so a registry install does not depend on them being
published — but `@try-works/tool-mode-recipes` is published as well so the
dependency graph resolves cleanly.

Before publishing:

```powershell
npm run verify                       # full chain, must be exit 0
node packages/dsh-model-as-tool/scripts/check-package.mjs
```

## Release steps

```powershell
# 1. bump the version (semver)
node -e "const fs=require('fs');const p='packages/dsh-model-as-tool/package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.version='X.Y.Z';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"

# 2. publish the recipes dependency first when it changed
cd packages/tool-mode-recipes
npm publish --userconfig $npmrc --access public

# 3. publish the plugin (prepack builds lib/client/remote; postpack cleans)
cd ../dsh-model-as-tool
npm publish --userconfig $npmrc --access public
```

`publishConfig` in the package already pins `access: public` and
`registry: https://registry.npmjs.org/`. Registry propagation can lag a minute or
two; `npm view` may show the old `latest` until the document updates. Confirm
directly:

```powershell
(Invoke-RestMethod 'https://registry.npmjs.org/@try-works%2Fdsh-model-as-tool').'dist-tags'.latest
```

## Installing it as a DSH plugin

From the registry, into any profile (first use initializes the profile):

```powershell
node D:\deepseek-harness\apps\cli\lib\bin.js plugin --profile <profile> add @try-works/dsh-model-as-tool@<version>
```

The CLI installs the package and adds it to `dsh.profile.bundles` because the
package declares `dsh.bundle.patch`. A minimal profile also needs the web app to
show the Settings page:

```powershell
node D:\deepseek-harness\apps\cli\lib\bin.js plugin --profile <profile> add @deepseek-ai/dsh-web-app@0.2.1-rc.2
```

## Extensions are npm packages too

The first-party Tool Mode extensions are published under `@try-works/extension-*`
so a deployment can install them the same way the plugin installs: from the
registry, with a verified digest, never from an unverified path.

| Package | Published |
|---|---|
| `@try-works/extension-desert-ant-tongue` | 0.1.1 |
| `@try-works/extension-desert-ant-voz` | 0.1.1 |
| `@try-works/extension-embeddinggemma` | 0.1.0 |
| `@try-works/extension-laya` | 1.0.0 |
| `@try-works/extension-minilm-embed` | 1.0.0 |
| `@try-works/extension-minilm-rerank` | 1.0.0 |
| `@try-works/extension-needle` | 0.1.0 |
| `@try-works/extension-declarative-recipes` | 0.1.0 |

Each package ships its extension manifest (`tool-mode.extension.json`), built
`lib/`, asset lock (`models.lock.json`), schemas/recipes, and its license. The
model weights are NOT in the package: they are acquired by the host's
`prepare` step from the pinned URLs and digests in the lock, so publishing stays
small and the assets remain verifiable independently.

To publish an extension:

```powershell
cd packages/extension-<name>
npm publish --userconfig $npmrc --access public
```

Bump the version for any republish; `private` must be absent and
`publishConfig.access` must be `public` (both are set in this repository). The
package's `files` list must keep covering everything its manifest references —
a schema path pointing at a file the tarball omits fails at activation, not at
publish time.

An extension installed from npm materializes its declared runtime dependencies
through the same dependency-graph discipline as the plugin (digest-verified,
never into the host's tree). Model assets still require the operator's
`prepare` step.

If pnpm refuses on ignored build scripts (for example `koffi`), approve or skip
them; the plugin itself has no install scripts.

### A profile with `minimumReleaseAge`

Some profiles configure pnpm's `minimumReleaseAge` (supply-chain policy), which
refuses a package published within that window. A just-published version then
fails with `ERR_PNPM_NO_MATURE_MATCHING_VERSION` even though the tarball is fine.
Options, in order of preference:

1. wait until the release ages past the cutoff, then install from the registry;
2. add the package to the profile's `minimumReleaseAgeExclude` (a deliberate
   policy change — the plugin is first-party and digest-verified, but the
   decision belongs to the operator);
3. keep installing the packed tarball (`npm run plugin:install`), which bypasses
   the age check because the source is a local file.

Note that `dsh plugin add` forwards to pnpm in the profile directory, so the
profile's own pnpm configuration applies.

Verify the composed row and boot:

```powershell
node D:\deepseek-harness\apps\cli\lib\bin.js --profile <profile> --dump-config | Select-String 'model-tools'
node D:\deepseek-harness\apps\cli\lib\bin.js --profile <profile> --port <port>
```

In the GUI: **Account menu → Settings → Model as Tool**. The page comes from the
package's `./client` export; the extension card's live state comes from the
`modelTools` Remote namespace, so installed/active/blocked rows are host truth.

Extensions themselves are installed into the deployment's extension store, not
from npm: set `extensionStore`, `extensionSourceDir` and
`extensions.allowSourceDirectories` in the profile row, then use Install (and
Prepare, for model assets) on the settings page.

## Release checklist

- [ ] `npm run verify` exit 0
- [ ] version bumped; `npm view` shows the new `latest` after propagation
- [ ] fresh-profile install from the registry composes `model-tools`
- [ ] Settings → Model as Tool renders, and a row's actions reflect host state
- [ ] token only under `%USERPROFILE%\.dsh\secrets\`; `git status` clean
