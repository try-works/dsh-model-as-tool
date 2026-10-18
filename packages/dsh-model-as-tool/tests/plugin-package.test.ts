import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * The DSH plugin package invariants.
 *
 * A plugin installed into a profile by name must satisfy these or it fails at
 * MOUNT time in someone else's profile. The authoritative check is
 * scripts/check-package.mjs (shared with `npm run plugin:check`); this test runs
 * it and then pins the pieces a loader/consumer reads directly.
 *
 * The reference implementation of these invariants is the dsh-memory plugin
 * (D:\DEV\dsh-memory): entry exports name/inject/apply/Config and NO default,
 * dsh.bundle.patch mounts the package by its published name, and schemastery is
 * a pinned dependency rather than a peer (a profile-supplied 3.18.1 throws).
 */
const PACKAGE_DIR = join(process.cwd(), 'packages', 'dsh-model-as-tool')
const CHECK = join(PACKAGE_DIR, 'scripts', 'check-package.mjs')

/**
 * Load the generated client bundle the way the web shell does: the file
 * registers through window.__ModuleLoader__.load({ id, factory }), and the
 * factory receives the lazy-CJS module table's require. Only 'react' may be
 * requested, so the fake table provides just that.
 *
 * This is deliberately an execution of the SHIPPED bundle (not the template):
 * the helper functions it exposes are what the page renders from, and a source
 * marker alone cannot prove they behave as the two extension flows expect.
 */
function loadGeneratedClient(): Record<string, unknown> {
  const source = readFileSync(join(PACKAGE_DIR, 'client', 'index.js'), 'utf8')
  type Registration = { factory: (request: (id: string) => unknown) => Record<string, unknown> }
  let registration: Registration | undefined
  const window = { __ModuleLoader__: { load(value: Registration) { registration = value } } }
  const request = (id: string): Record<string, unknown> => {
    assert.equal(id, 'react', 'the client bundle may require only "react"')
    return {
      createElement: () => null,
      useState: () => [null, () => {}],
      useEffect: () => {},
    }
  }
  new Function('window', 'require', source)(window, request)
  assert.ok(registration !== undefined, 'the client bundle must register through __ModuleLoader__.load')
  return registration.factory(request)
}

/** One internal helper from the generated bundle, with its callable face checked. */
function clientHelper(exports: Record<string, unknown>, name: string): (...args: unknown[]) => unknown {
  const internals = exports.__internals
  assert.ok(internals !== null && typeof internals === 'object', 'the client bundle must expose __internals')
  const candidate = (internals as Record<string, unknown>)[name]
  assert.equal(typeof candidate, 'function', '__internals.' + name + ' must be a function')
  return candidate as (...args: unknown[]) => unknown
}

/** A fake Context that answers the one read the extension card performs. */
function contextWith(remote: unknown): { get: (name: string) => unknown } {
  return { get: (name: string) => name === 'remote' ? remote : undefined }
}

/** The control decision shape returned by the generated requirement helper. */
interface RequirementControlsView {
  readonly blocked: boolean
  readonly unmet: readonly unknown[]
  readonly enableBlocked: boolean
  readonly installBlocked: boolean
  readonly prepareNeeded: boolean
}

test('the package check script passes (the shape a loader requires)', (t) => {
  if (!existsSync(join(PACKAGE_DIR, 'lib', 'index.js'))) {
    return t.skip('the package lib/ is not built; run the host build first')
  }
  const result = spawnSync(process.execPath, [CHECK], { encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /plugin package check OK/)
})

test('the manifest declares the bundle patch and the plugin row mounts by published name', () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
  assert.equal(manifest.name, '@try-works/dsh-model-as-tool')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  const patch = readFileSync(join(PACKAGE_DIR, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id:\s*model-tools\b/)
  assert.match(patch, /name:\s*'@try-works\/dsh-model-as-tool'/)
  // The loader addresses CONFIG by top-level row id, so the row id must be stable.
  assert.ok((manifest.files ?? []).includes('cordis.patch.yml'))
})

test('the client half is a generated ModuleLoader bundle with the model list embedded', () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.ok((manifest.dsh?.client?.inject ?? []).includes('@deepseek-ai/dsh-client-ui-settings'),
    'the client half needs the settings UI slot provider injected')
  const clientExport = manifest.exports?.['./client']
  const target = typeof clientExport === 'string' ? clientExport : clientExport?.default
  assert.equal(typeof target, 'string', 'exports["./client"] must resolve to a file')
  const source = readFileSync(join(PACKAGE_DIR, String(target).replace(/^\.\//, '')), 'utf8')
  assert.match(source, /window\.__ModuleLoader__\.load\(/)
  assert.ok(source.includes(`id: '${manifest.name}'`), 'the loader id must be the package name')
  assert.match(source, /settings\.section/)
  assert.match(source, /label: 'Model as Tool'/)
  // One row per catalog model with a toggle, not a free-text field.
  assert.ok(!source.includes('/*__CATALOG_JSON__*/ []'), 'the catalog placeholder must be replaced by the build')
  assert.match(source, /"id": "tongue"/)
  assert.match(source, /mtt-toggle/)
  assert.ok((manifest.files ?? []).includes('client/index.js'), 'files[] must ship the generated bundle')
  assert.ok(!(manifest.files ?? []).some(f => String(f).includes('template')),
    'files[] must not ship the template')

  // Drift guard: the committed bundle must equal what the generator produces now.
  const generated = spawnSync(process.execPath, [join(PACKAGE_DIR, 'scripts', 'gen-client-catalog.mjs'), '--check'], { encoding: 'utf8' })
  assert.equal(generated.status, 0, `${generated.stdout}\n${generated.stderr}`)
})

test('the client half ships both extension flows: host Remote and config-only fallback', () => {
  const source = readFileSync(join(PACKAGE_DIR, 'client', 'index.js'), 'utf8')
  // Host Remote flow: the optional wire chunk is attempted, state comes from
  // describe(), install/enable/disable go through the Remote, and a busy label
  // makes an action in flight visible rather than a silent click.
  assert.match(source, /\.modelTools\b/, 'the page must read the modelTools Remote')
  assert.match(source, /client\.model-tools\.js/, 'the page must attempt the optional wire chunk')
  assert.match(source, /\.describe\(\)/, 'the page must read extension state from the host')
  assert.match(source, /installExtension/, 'the page must call the wire installExtension operation')
  // The wire descriptor is installExtension(id, source): the gateway counts
  // business arguments exactly, so an omitted source must still be passed as
  // undefined or the call is refused before it reaches the host.
  assert.match(source, /install\.call\(namespace, id, undefined\)/,
    'installExtension must be called with its source positional slot filled')
  // The install result names the route and the resolved version; a legacy result
  // without those fields must fall back to today's rendering (no invented source).
  assert.match(source, /installResultNote/, 'the page must render install provenance from the result')
  assert.match(source, /from npm/, 'a registry install must say so on the row')
  assert.match(source, /from the local package directory/, 'a directory install must say so on the row')
  assert.match(source, /\.enable\(id\)/, 'the page must enable an installed extension through the Remote')
  assert.match(source, /\.disable\(id\)/, 'the page must disable an installed extension through the Remote')
  // Preparation: a blocked installed row offers Prepare, calls prepare(id), and
  // shows a busy label; the host's own reason text is rendered, not replaced.
  assert.match(source, /namespace\.prepare\(id\)/, 'the page must prepare model assets through the Remote')
  assert.match(source, /'Preparing…'/, 'a prepare in flight must be visible, not a silent click')
  assert.match(source, /addNote\(state\.reason/,
    'an installed row must render the host reason verbatim')
  assert.match(source, /extensionNeedsPreparation/,
    'the Prepare control must be offered only for a host-named preparation blocker')
  assert.match(source, /prepareResultNote/, 'a prepare result must render the host disclosure/refusal')
  // Requirements: satisfied ones are disclosed compactly; unmet ones are rendered
  // prominently and gate the controls by kind/action/satisfied (never by text).
  assert.match(source, /Requirements checked:/, 'the row must disclose the satisfied requirements')
  assert.match(source, /mtt-row-blocker/, 'an unmet requirement must be rendered prominently')
  assert.match(source, /requirementControls\.enableBlocked/,
    'Enable must be disabled when the host marks the row blocked')
  assert.match(source, /requirementControls\.installBlocked/,
    'Install must be disabled for an unmet store/source requirement')
  assert.match(source, /Configure the deployment to satisfy this requirement\./,
    'a config-action blocker must carry its remediation hint')
  assert.match(source, /'Installing…'/, 'an install in flight must be visible, not a silent click')
  // Two durable sources describe "disabled": the lifecycle the Remote changes and
  // Config.disabledExtensions, which the restore filter re-checks. Every
  // enable/disable must dual-write the list or a restart undoes the user's choice.
  assert.match(source, /form\.set\('disabledExtensions', nextList\)/,
    'the ready state must dual-write disabledExtensions after enable/disable')
  assert.match(source, /refused the disabledExtensions update/,
    'a refused dual-write must be surfaced as a non-fatal note')
  assert.match(source, /config list still names this extension/,
    'an active-but-listed extension must warn that a restart will disable it')
  assert.match(source, /config list does not name this extension/,
    'an inactive-but-unlisted extension must warn that a restart may restore it')
  // Fallback flow: no Remote -> the disabledExtensions preference, and a note
  // that says exactly what the switch can and cannot do.
  assert.match(source, /kind: 'absent'/, 'the page must keep the absent-Remote fallback branch')
  assert.match(source, /extension controls are not available/, 'the fallback must say the Remote is unavailable')
  assert.match(source, /disabledExtensions preference/, 'the fallback must say the switch only records a preference')
  // Only react may be requested from the lazy-CJS module table; the wire chunk
  // travels through require.async, not require().
  assert.ok(source.includes("require('react')"))
  assert.equal((source.match(/require\(/g) ?? []).length, 1, 'the client half must request only "react"')
  assert.match(source, /require\.async\(/, 'the wire chunk must load through require.async')
})

test('the generated client helpers map both Remote result shapes to the rows the page draws', async () => {
  const exports = loadGeneratedClient()
  const modelToolsRemote = clientHelper(exports, 'modelToolsRemote')
  const extensionInstallMethod = clientHelper(exports, 'extensionInstallMethod')
  const remoteErrorText = clientHelper(exports, 'remoteErrorText')
  const unwrapRemoteResult = clientHelper(exports, 'unwrapRemoteResult')
  const normalizeDescribe = clientHelper(exports, 'normalizeDescribe')
  const describeExtensions = clientHelper(exports, 'describeExtensions')
  const findExtensionState = clientHelper(exports, 'findExtensionState')
  const nextDisabledExtensions = clientHelper(exports, 'nextDisabledExtensions')
  const extensionNeedsPreparation = clientHelper(exports, 'extensionNeedsPreparation')
  const prepareResultNote = clientHelper(exports, 'prepareResultNote')
  const installResultNote = clientHelper(exports, 'installResultNote')
  const extensionRequirements = clientHelper(exports, 'extensionRequirements')
  const unmetExtensionRequirements = clientHelper(exports, 'unmetExtensionRequirements')
  const extensionRequirementSummary = clientHelper(exports, 'extensionRequirementSummary')
  const requirementHint = clientHelper(exports, 'requirementHint')
  const extensionRequirementControls = clientHelper(exports, 'extensionRequirementControls')

  const namespace = {
    describe: async () => ({ ok: true, value: { store: 'C:/store', writable: true, extensions: [] } }),
  }
  // Remote absent: no chunk status, no service, or a context that throws.
  assert.equal(modelToolsRemote(contextWith(undefined), null), null)
  assert.equal(modelToolsRemote(contextWith({}), null), null)
  assert.equal(modelToolsRemote({ get: () => { throw new Error('not mounted') } }, null), null)
  // The wire chunk's mount status is the primary route.
  assert.equal(modelToolsRemote(contextWith(undefined), { remote: { modelTools: namespace } }), namespace)
  assert.equal(modelToolsRemote(contextWith(undefined), { modelTools: namespace }), namespace)
  // The namespace service itself is the second route (readable without inject).
  assert.equal(modelToolsRemote({ get: name => name === 'remote.modelTools' ? namespace : undefined }, null), namespace)
  // The associated `remote` service is the last route.
  assert.equal(modelToolsRemote(contextWith({ modelTools: namespace }), null), namespace)
  // An associated namespace can throw on an undeclared `remote`; the direct
  // service route must still win rather than taking the page down.
  const directWins = {
    get(name: string) {
      if (name === 'remote.modelTools') return namespace
      throw new Error('cannot get property "remote.modelTools" without inject')
    },
  }
  assert.equal(modelToolsRemote(directWins, null), namespace)

  // The install verb is installExtension on the wire; the raw `install` is
  // tolerated only as a fallback, because the harness gateway refuses it.
  const wireInstall = async () => 'installExtension'
  const hostInstall = async () => 'install'
  assert.equal(extensionInstallMethod({ installExtension: wireInstall, install: hostInstall }), wireInstall)
  assert.equal(extensionInstallMethod({ install: hostInstall }), hostInstall)
  assert.equal(extensionInstallMethod({}), null)
  assert.equal(extensionInstallMethod(null), null)

  // A generated Typert method resolves a RemoteResult; the host service resolves
  // the raw value. Both must reach the page as the value, and a refusal must
  // surface the host's own message.
  assert.deepEqual(unwrapRemoteResult({ ok: true, value: { model: 'laya' } }), { model: 'laya' })
  assert.deepEqual(unwrapRemoteResult({ model: 'laya' }), { model: 'laya' })
  assert.throws(
    () => unwrapRemoteResult({ ok: false, error: { code: 'no-store', message: 'No extension store configured.' } }),
    /No extension store configured/,
  )
  assert.throws(() => unwrapRemoteResult({ ok: false }), /did not explain/)
  assert.equal(remoteErrorText(new Error('boom')), 'boom')
  assert.equal(remoteErrorText('plain text'), 'plain text')

  // describe() narrowing is strict about the list and drops unnamed rows.
  assert.deepEqual(
    normalizeDescribe({ store: null, writable: false, extensions: [{ id: 'a' }, null, { package: 'b' }] }),
    { store: null, writable: false, extensions: [{ id: 'a' }] },
  )
  assert.throws(() => normalizeDescribe(null), /no extension state/)
  assert.throws(() => normalizeDescribe({ store: null }), /without its extension list/)
  assert.deepEqual(await describeExtensions(namespace), { store: 'C:/store', writable: true, extensions: [] })

  // Row matching: a host may key its row by the extension id or the package name.
  const state = { id: '@try-works/extension-laya', package: '@try-works/extension-laya', installed: true }
  assert.equal(findExtensionState({ id: '@try-works/extension-laya', package: 'x' }, [state]), state)
  assert.equal(findExtensionState({ id: 'x', package: '@try-works/extension-laya' }, [state]), state)
  assert.equal(findExtensionState({ id: 'x', package: 'y' }, [state]), null)

  // The dual-write list: enable removes the id, disable adds it, both sorted and
  // tolerant of a malformed saved value (a config edit can put anything there).
  assert.deepEqual(nextDisabledExtensions(['b', 'a'], 'a', 'enable'), ['b'])
  assert.deepEqual(nextDisabledExtensions(['b'], 'a', 'disable'), ['a', 'b'])
  assert.deepEqual(nextDisabledExtensions(undefined, 'a', 'disable'), ['a'])
  assert.deepEqual(nextDisabledExtensions([null, 7, 'b'], 'a', 'disable'), ['a', 'b'])
  assert.deepEqual(nextDisabledExtensions(['a'], 'a', 'enable'), [])

  // Prepare is offered only when the HOST names preparation as the blocker; the
  // detector follows the host's own blocker phrases and must not guess from a
  // missing/other reason (a spurious Prepare would send the operator in circles).
  const blocked = {
    installed: true,
    active: false,
    reason: 'activation blocked: embeddinggemma-2 needs its model assets prepared — run prepare for this extension',
  }
  assert.equal(extensionNeedsPreparation(blocked), true)
  assert.equal(extensionNeedsPreparation({ ...blocked, reason: 'the model needs preparation before use' }), true)
  assert.equal(extensionNeedsPreparation({ ...blocked, reason: 'activation blocked: broken schema' }), false)
  assert.equal(extensionNeedsPreparation({ ...blocked, reason: null }), false)
  assert.equal(extensionNeedsPreparation({ ...blocked, installed: false }), false)
  assert.equal(extensionNeedsPreparation(null), false)

  // prepare() reports acquisition refusals in band (ok:true, prepared:false); the
  // refusal text is shown verbatim. Success renders the host disclosure instead of
  // a bare "done", and activationReady:false is never called a success.
  assert.equal(
    prepareResultNote({ prepared: false, reason: 'executable asset needs separate approval (RES-02)' }),
    'executable asset needs separate approval (RES-02)',
  )
  assert.match(String(prepareResultNote({ prepared: false, reason: null })), /did not complete/)
  const prepared = prepareResultNote({
    prepared: true,
    reason: null,
    activationReady: true,
    plan: {
      modelId: 'embeddinggemma-2',
      modelRevision: 'r1',
      assets: [],
      totalBytes: 1234,
      storageBytes: 1200,
      requiresExecutableApproval: false,
      license: { name: 'Gemma Terms', url: 'https://example.invalid/terms' },
    },
  })
  assert.match(String(prepared), /Prepared embeddinggemma-2/)
  assert.match(String(prepared), /1234 bytes download/)
  assert.match(String(prepared), /Gemma Terms/)
  assert.doesNotMatch(String(prepared), /remaining blockers/)
  const partiallyReady = prepareResultNote({ prepared: true, plan: null, activationReady: false })
  assert.match(String(partiallyReady), /remaining blockers/)

  // Install provenance: the result names the route and resolved version. A legacy
  // result (older host, no source/resolvedVersion) yields no invented note — the
  // describe() row keeps today's "installed v<version>" text.
  assert.equal(installResultNote({ id: 'a', version: '0.1.0', active: false, source: 'registry', resolvedVersion: '0.1.2' }),
    'installed v0.1.2 from npm')
  assert.equal(installResultNote({ id: 'a', version: '0.1.0', active: false, source: 'directory', resolvedVersion: '0.1.0' }),
    'installed v0.1.0 from the local package directory')
  assert.equal(installResultNote({ id: 'a', version: '0.1.0', active: false }), null)
  assert.equal(installResultNote({ id: 'a', version: '0.1.0', active: false, source: 'npm' }), null)
  assert.equal(installResultNote({ id: 'a', active: false, source: 'registry' }), null)
  assert.equal(installResultNote(null), null)

  // Blocked-state behavior is keyed ONLY on requirement kind/action/satisfied and
  // the host's `blocked` flag. The reason text is rendered verbatim but never
  // parsed for control decisions (the host may reword it).
  const harnessBlocked = {
    installed: true,
    blocked: true,
    reason: 'this deployment composes no harness LlmProvider',
    requirements: [
      { kind: 'store', satisfied: true, reason: '', action: 'none' },
      { kind: 'harness-model', satisfied: false, reason: 'this deployment composes no harness LlmProvider', action: 'config' },
    ],
  }
  const harnessControls = extensionRequirementControls(harnessBlocked) as RequirementControlsView
  assert.deepEqual([harnessControls.enableBlocked, harnessControls.installBlocked, harnessControls.prepareNeeded],
    [true, false, false])
  assert.equal(harnessControls.unmet.length, 1)
  assert.equal(String(extensionRequirementSummary(harnessBlocked)), 'Requirements checked: store ✓')
  assert.equal(String(requirementHint(harnessBlocked.requirements[1])),
    'Configure the deployment to satisfy this requirement.')
  assert.equal(requirementHint({ kind: 'platform', satisfied: false, reason: 'x', action: 'none' }),
    'This requirement cannot be fixed from this page.')
  assert.equal(requirementHint({ kind: 'assets', satisfied: false, reason: 'x', action: 'prepare' }), null)

  // assets/executable keep Prepare available and block Enable; the Prepare
  // decision uses requirements (not the reason text) on a current host.
  const assetsBlocked = {
    installed: true,
    blocked: true,
    reason: null,
    requirements: [
      { kind: 'assets', satisfied: false, reason: 'embeddinggemma-2 needs its model assets prepared', action: 'prepare' },
    ],
  }
  const assetsControls = extensionRequirementControls(assetsBlocked) as RequirementControlsView
  assert.deepEqual([assetsControls.enableBlocked, assetsControls.prepareNeeded], [true, true])
  assert.equal(extensionNeedsPreparation(assetsBlocked), true)
  assert.equal(extensionNeedsPreparation({
    installed: true,
    blocked: false,
    reason: 'needs its model assets prepared',
    requirements: [{ kind: 'assets', satisfied: true, reason: 'prepared', action: 'none' }],
  }), false, 'requirements win over legacy reason text')

  // A satisfied row: no blocked controls and no unmet line.
  const satisfied = {
    installed: true,
    blocked: false,
    requirements: [
      { kind: 'store', satisfied: true, reason: '', action: 'none' },
      { kind: 'platform', satisfied: true, reason: '', action: 'none' },
    ],
  }
  const satisfiedControls = extensionRequirementControls(satisfied) as RequirementControlsView
  assert.deepEqual([satisfiedControls.blocked, satisfiedControls.enableBlocked, satisfiedControls.installBlocked],
    [false, false, false])

  // unmet-but-not-blocked (the host says activation is possible) keeps Enable open.
  const unmetNotBlocked = {
    installed: true,
    blocked: false,
    requirements: [{ kind: 'assets', satisfied: false, reason: 'not prepared yet', action: 'prepare' }],
  }
  assert.equal((extensionRequirementControls(unmetNotBlocked) as RequirementControlsView).enableBlocked, false)

  // store/source block Install; an uninstalled row has no Enable to block.
  const storeBlocked = {
    installed: false,
    blocked: true,
    requirements: [{ kind: 'store', satisfied: false, reason: 'no extension store is configured', action: 'config' }],
  }
  const storeControls = extensionRequirementControls(storeBlocked) as RequirementControlsView
  assert.deepEqual([storeControls.installBlocked, storeControls.enableBlocked], [true, false])

  // Legacy rows (no requirements/blocked) are not blocked and invent nothing.
  const legacy = { installed: true, active: true, reason: null }
  assert.deepEqual(extensionRequirements(legacy), [])
  assert.equal(extensionRequirementSummary(legacy), null)
  const legacyControls = extensionRequirementControls(legacy) as RequirementControlsView
  assert.deepEqual([legacyControls.blocked, legacyControls.enableBlocked, legacyControls.installBlocked], [false, false, false])
  // Malformed entries are dropped rather than rendered as facts.
  assert.equal((extensionRequirements({
    requirements: [null, { kind: 'assets' }, { kind: 'assets', satisfied: false, reason: 'x', action: 'prepare' }],
  }) as unknown[]).length, 1)
})

test('the Settings-editable fields are marked volatile so the host exposes them', async (t) => {
  if (!existsSync(join(PACKAGE_DIR, 'lib', 'index.js'))) {
    return t.skip('the package lib/ is not built; run the host build first')
  }
  // schemastery exposes a Config field to the settings mirror ONLY when it carries
  // the volatile marker; without it the page renders "namespace not exposed".
  const { pathToFileURL } = await import('node:url')
  const { Config } = await import(pathToFileURL(join(PACKAGE_DIR, 'lib', 'index.js')).href) as {
    Config: { dict?: Record<string, { meta?: { volatile?: boolean } }> }
  }
  for (const key of ['models', 'exclude', 'exposeUnavailable', 'registerSkills',
    'registerControlTool', 'allowNpm', 'managedWorkers', 'repairAttempts', 'approvedRoots']) {
    const field = Config.dict?.[key]
    assert.ok(field !== undefined, `${key} must exist on Config`)
    assert.equal(field.meta?.volatile, true, `${key} must be marked .volatile() for the Settings page`)
  }
})

test('schemastery is a pinned dependency, never a peer (the profile cannot supply it)', () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
  assert.equal(Object.hasOwn(manifest.peerDependencies ?? {}, '@deepseek-ai/schemastery'), false)
  assert.match(manifest.dependencies['@deepseek-ai/schemastery'], /^\^3\.18\.[4-9]/)
})

test('every bare runtime import of a bundled package is installed by the host', () => {
  // Bundling copies the package directory but not its dependencies, so an
  // undeclared import (the adm-zip incident) fails only in a real profile.
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
  const hostDeps = manifest.dependencies ?? {}
  const bundled = [
    ['packages/tool-mode-contracts', '@try-works/tool-mode-contracts'],
    ['packages/tool-mode-extension-sdk', '@try-works/tool-mode-extension-sdk'],
    ['packages/tool-mode-recipes', '@try-works/tool-mode-recipes'],
  ]
  for (const [dir, name] of bundled) {
    const pkgDir = join(process.cwd(), dir)
    const own = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).dependencies ?? {}
    const imports = new Set()
    const stack = [join(pkgDir, 'src')]
    while (stack.length > 0) {
      const current = stack.pop()
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name)
        if (entry.isDirectory()) stack.push(full)
        else if (entry.name.endsWith('.ts')) {
          for (const match of readFileSync(full, 'utf8').matchAll(/from\s+'([^.'\n][^'\n]{0,120})'/g)) {
            imports.add(match[1])
          }
        }
      }
    }
    for (const specifier of imports) {
      if (specifier.startsWith('node:') || specifier.startsWith('@try-works/')) continue
      const bare = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0]
      assert.ok(own[bare] !== undefined || hostDeps[bare] !== undefined,
        `${name} imports "${bare}" but it is declared nowhere`)
    }
  }
})
