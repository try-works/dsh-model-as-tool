// DSH plugin package invariants. Run with: node scripts/check-package.mjs
//
// A plugin installed into a profile by name must declare everything the loader
// needs; when one of these drifts the failure appears at MOUNT time in someone
// else's profile, which is the worst place to discover it. This mirrors the
// reference plugin's pre-flight (D:\DEV\dsh-memory\scripts\check-package.mjs)
// and is asserted by tests/plugin-package.test.ts.
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const note = (ok, message) => { if (!ok) problems.push(message) }

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

note(manifest.name === '@try-works/dsh-model-as-tool',
  'package name must be "@try-works/dsh-model-as-tool", found ' + manifest.name)
note(manifest.type === 'module', 'package must be ESM ("type": "module")')
note(typeof manifest.main === 'string', 'package must declare "main"')
if (typeof manifest.main === 'string') {
  note(existsSync(join(root, manifest.main)), 'main does not exist: ' + manifest.main
    + ' (run the package build first)')
}
note(typeof manifest.engines?.node === 'string', 'engines.node must be declared')

// The loader must be able to import the entry and find the plugin contract.
if (typeof manifest.main === 'string' && existsSync(join(root, manifest.main))) {
  const entry = await import(new URL('../' + manifest.main, import.meta.url))
  note(typeof entry.name === 'string' && entry.name === 'model-tools',
    'entry must export name = "model-tools" (the row id the bundle patch mounts)')
  note(Array.isArray(entry.inject), 'entry must export inject')
  note(typeof entry.apply === 'function', 'entry must export apply')
  note(entry.Config !== undefined, 'entry must export Config')
  note(entry.default === undefined,
    'entry must NOT export default (the loader does exports.default ?? exports, '
    + 'which would discard name/inject/Config)')
}

// Bundle patch: what makes an install-by-name mount the plugin.
const patchPath = manifest.dsh?.bundle?.patch
note(typeof patchPath === 'string', 'dsh.bundle.patch must be declared for install-by-name')
if (typeof patchPath === 'string') {
  const full = join(root, patchPath.replace(/^\.\//, ''))
  note(existsSync(full), 'bundle patch does not exist: ' + patchPath)
  if (existsSync(full)) {
    const text = readFileSync(full, 'utf8')
    note(/id:\s*model-tools\b/.test(text), 'bundle patch must insert an entry with id: model-tools')
    note(/name:\s*'@try-works\/dsh-model-as-tool'/.test(text),
      'bundle patch must mount the package by its published name')
  }
  note((manifest.files ?? []).some((f) => String(f).includes('cordis.patch.yml')),
    'files[] must ship the bundle patch')
}

// Everything the entry imports at load time must ship.
const files = manifest.files ?? []
note(files.some((f) => String(f).startsWith('lib/')), 'files[] must ship the built lib/')
note(files.some((f) => String(f).startsWith('catalog/')), 'files[] must ship the catalog data')
note(files.some((f) => String(f).startsWith('bin')), 'files[] must ship the launcher bin/')
note(existsSync(join(root, 'README.md')) && files.includes('README.md'), 'files[] must ship README.md')

// Client half: the Settings page. Without it the plugin is visible only in
// config files, which is what "the settings need to be exposed in Settings" means.
const client = manifest.dsh?.client
note(client !== undefined, 'dsh.client must be declared for the Settings page')
if (client !== undefined) {
  note(client.platform === 'web', 'dsh.client.platform must be "web"')
  const clientExport = manifest.exports?.['./client']
  const target = typeof clientExport === 'string' ? clientExport : clientExport?.default
  note(typeof target === 'string', 'exports["./client"] must resolve to a file')
  if (typeof target === 'string') {
    note(existsSync(join(root, target)), 'client half missing: ' + target)
    if (existsSync(join(root, target))) {
      const source = readFileSync(join(root, target), 'utf8')
      note(source.includes('__ModuleLoader__.load'), 'the client half must call window.__ModuleLoader__.load')
      note(source.includes(`id: '${manifest.name}'`), 'the client loader id must be the package name')
      note(source.includes('settings.section'), 'the client half must register a settings.section')
      // The page renders one row per model, so the catalog must be embedded and
      // current; a template placeholder left in place means the build was skipped.
      note(!source.includes('/*__CATALOG_JSON__*/ []'), 'the catalog placeholder must be replaced by the build')
      note(!source.includes('/*__EXTENSIONS_JSON__*/ []'), 'the extensions placeholder must be replaced by the build')
      note(source.includes('"id": "tongue"'), 'the generated catalog must list the catalog models')
      note(source.includes('"name": "Laya"'), 'the generated extensions must list the Laya extension')
      note(source.includes('"name": "Needle 3"'), 'the generated extensions must list the Needle extension')
      note(/mtt-toggle/.test(source), 'the client half must render model toggles')
      // The extension card ships two honest flows: the host Remote (read state,
      // install when absent, enable/disable when installed) and the config-only
      // disabledExtensions fallback for a host that does not mount it. A build
      // that loses either one ships a page that lies about extension state.
      note(/\.modelTools\b/.test(source),
        'the client half must read the extension state through the modelTools Remote')
      note(/kind: 'absent'/.test(source),
        'the client half must keep its config-only extension fallback')
      note(/installExtension/.test(source) && /install\.call\(namespace, id, undefined\)/.test(source)
        && /\.enable\(id\)/.test(source) && /\.disable\(id\)/.test(source),
        'the client half must call installExtension(id, undefined)/enable(id)/disable(id) through the Remote')
      // Two sources describe "disabled": the lifecycle the Remote changes and
      // Config.disabledExtensions, which the restore filter re-checks. Losing
      // either half of the dual-write lets a restart undo the operator's choice.
      note(/form\.set\('disabledExtensions', nextList\)/.test(source),
        'the client half must dual-write disabledExtensions after a Remote enable/disable')
      note(source.includes('refused the disabledExtensions update'),
        'the client half must surface a refused dual-write as a non-fatal note')
      note(source.includes('config list still names this extension')
        && source.includes('config list does not name this extension'),
        'the client half must warn when the config list disagrees with the effective extension state')
      note(source.includes('./client.model-tools.js'),
        'the client half must attempt the optional extension Remote chunk (client.model-tools.js)')
      note(source.includes("require('react')") && (source.match(/require\(/g) ?? []).length === 1,
        'the client half must request only "react" from the lazy-CJS module table')
    }
    note((manifest.files ?? []).includes('client/index.js'),
      'files[] must ship the GENERATED client/index.js (not the template)')
    note(!(manifest.files ?? []).some(f => String(f).includes('template')),
      'files[] must not ship the client template')
  }
}

// Peers: a missing declaration means an unresolvable import in a clean profile.
for (const peer of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools']) {
  note(Object.hasOwn(manifest.peerDependencies ?? {}, peer),
    'peerDependencies must declare ' + peer)
}

// schemastery is the exception, and it is deliberate: `.volatile()` exists only
// from 3.18.4, and a PEER lets the profile supply 3.18.1, which throws at module
// load. As a dependency the version is ours to pin.
note(!Object.hasOwn(manifest.peerDependencies ?? {}, '@deepseek-ai/schemastery'),
  'schemastery must NOT be a peer dependency')
note(/^\^3\.18\.[4-9]/.test((manifest.dependencies ?? {})['@deepseek-ai/schemastery'] ?? ''),
  'schemastery must be a dependency pinned at 3.18.4 or newer, for .volatile()')

// The internal @try-works packages are unpublished: they must be bundled, or a
// clean-profile install cannot resolve them.
for (const internal of ['@try-works/tool-mode-contracts', '@try-works/tool-mode-extension-sdk',
  '@try-works/tool-mode-recipes']) {
  note((manifest.dependencies ?? {})[internal] !== undefined,
    'the internal package must be a dependency: ' + internal)
  note((manifest.bundledDependencies ?? manifest.bundleDependencies ?? []).includes(internal),
    'the internal package must be a bundledDependency: ' + internal)
}

// Bundling copies the package directory but NOT its dependencies, so every bare
// import a bundled package makes at runtime must be installed by the HOST (or
// declared by that package itself). A missing one fails at mount time in the
// profile — exactly how `adm-zip` was first discovered.
const BUNDLED = [
  ['packages/tool-mode-contracts', '@try-works/tool-mode-contracts'],
  ['packages/tool-mode-extension-sdk', '@try-works/tool-mode-extension-sdk'],
  ['packages/tool-mode-recipes', '@try-works/tool-mode-recipes'],
]
const hostDeps = manifest.dependencies ?? {}
for (const [dir, name] of BUNDLED) {
  const packageDir = join(root, '..', dir.split('/').pop())
  const packageManifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  const ownDeps = packageManifest.dependencies ?? {}
  const sourceDir = join(packageDir, 'src')
  const stack = [sourceDir]
  const imports = new Set()
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) { stack.push(full); continue }
      if (!entry.name.endsWith('.ts')) continue
      const text = readFileSync(full, 'utf8')
      // Single-line ESM imports only: a multi-line concatenation can contain a
      // stray `from '` fragment, which is not a specifier.
      for (const match of text.matchAll(/from\s+'([^.'\n][^'\n]{0,120})'/g)) imports.add(match[1])
    }
  }
  for (const specifier of imports) {
    if (specifier.startsWith('node:') || specifier.startsWith('@try-works/')) continue
    const bare = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
    const declaredByPackage = ownDeps[bare] !== undefined
    const installedByHost = hostDeps[bare] !== undefined
    note(declaredByPackage || installedByHost,
      `${name} imports "${bare}" but neither its dependencies nor the host's declare it `
      + '(bundling copies the package directory, not its dependencies)')
  }
}

if (problems.length > 0) {
  console.error('plugin package check FAILED:')
  for (const problem of problems) console.error('  - ' + problem)
  process.exit(1)
}
console.log('plugin package check OK (' + manifest.name + '@' + manifest.version + ')')
