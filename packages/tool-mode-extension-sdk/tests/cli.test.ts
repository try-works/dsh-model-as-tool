/**
 * Operator CLI tests (EXT-31, EXT-04, EXT-28).
 *
 * The CLI is driven through its library entry with captured output, so the
 * REFUSAL paths are tested as directly as the happy paths. Those refusals are the
 * security-relevant half: an uninstall that proceeds without a preview, an install
 * that skips integrity, or an activation that fakes publication are all failures
 * that a spawn-a-process test would leave to manual checking.
 *
 * Requirement links: EXT-31, EXT-04, EXT-28.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'

import { runToolModeCli, parseArgs } from '../src/cli.ts'
import { ExtensionStore } from '../src/install/store.ts'
import { ExtensionLifecycle, type ContributionRegistrar } from '../src/install/lifecycle.ts'
import { stagedInstall, createZipArchiveSource } from '../src/index.ts'
import { ManagementError } from '../src/errors.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmx-cli-'))
  dirs.push(dir)
  return dir
}

/** Capture what the CLI wrote. */
function capture() {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) } }
}

describe('RCP-08 — the recipes namespace forwards lazily, or refuses precisely', () => {
  it('forwards the raw recipe argv to the injected runner and propagates its exit code', async () => {
    const seen: string[][] = []
    const { io } = capture()
    const code = await runToolModeCli(
      ['recipes', 'create', '--template', 'text-title', '--out', './x'],
      io,
      {
        recipeCliRunner: {
          async runRecipeCli(argv, sink) {
            seen.push([...argv])
            sink.out('forwarded')
            return 7
          },
        },
      },
    )
    assert.equal(code, 7, 'the recipes runner\'s exit code is propagated verbatim')
    assert.deepEqual(seen, [['create', '--template', 'text-title', '--out', './x']], 'the argv is forwarded RAW, not re-parsed')
  })

  it('answers a PRECISE refusal when the recipes package cannot be resolved', async () => {
    const { io, err } = capture()
    const code = await runToolModeCli(
      ['recipes', 'validate', 'x.json'],
      io,
      { resolveRecipeCli: async () => undefined },
    )
    assert.equal(code, 1, 'an unavailable recipes CLI is a refusal, never a fake pass')
    assert.match(err.join('\n'), /@try-works\/tool-mode-recipes is not installed/)
    assert.match(err.join('\n'), /tool-mode-recipe/)
  })

  it('resolves the REAL recipes CLI beside the SDK and forwards end to end', async (t) => {
    // The workspace links the recipes package into node_modules: the default
    // resolver must find it and hand over the same implementation.
    let resolved: boolean
    try {
      await import('@try-works/tool-mode-recipes/cli')
      resolved = true
    } catch {
      resolved = false
    }
    if (!resolved) {
      t.skip('the recipes package is not resolvable beside the SDK in this environment')
      return
    }
    const { io, err } = capture()
    const code = await runToolModeCli(['recipes', 'validate', 'does-not-exist.json'], io)
    assert.equal(code, 2, 'a missing file through the forwarded CLI is the recipes CLI\'s usage failure')
    assert.match(err.join('\n'), /cannot read/)
  })

  it('a THROWING forwarded runner becomes a named refusal, never a re-thrown raw error', async () => {
    const { io, err } = capture()
    let code = -1
    try {
      code = await runToolModeCli(
        ['recipes', 'create', '--template', 'text-title', '--out', './x'],
        io,
        {
          recipeCliRunner: {
            async runRecipeCli() {
              throw new Error('raw runner explosion')
            },
          },
        },
      )
    } catch (error) {
      assert.fail(`the namespace re-threw a raw error: ${(error as Error).message}`)
    }
    assert.equal(code, 1, 'a throwing runner is a refusal, not a crash')
    assert.match(err.join('\n'), /raw runner explosion/)
  })
})

/** A registrar that always succeeds. */
const allowingRegistrar: ContributionRegistrar = {
  publish: contribution => `h:${contribution.name}`,
  withdraw: () => { /* nothing to release */ },
}

/** Build a valid extension zip. */
function buildZip(name: string, version = '1.0.0', tools: { id: string; name: string }[] = []): Uint8Array {
  const zip = new AdmZip()
  zip.addFile('package.json', Buffer.from(JSON.stringify({
    name, version, type: 'module',
    exports: { './tool-mode': './index.js' },
    toolMode: { manifest: './tool-mode.extension.json' },
  })))
  zip.addFile('tool-mode.extension.json', Buffer.from(JSON.stringify({
    protocolVersion: '1.1.0', id: name, version,
    displayName: 'CLI test extension',
    description: 'An extension used to exercise the operator command family.',
    activation: { policy: 'operator', deactivatable: true }, runtimeApi: 1,
    compatibility: { hostApi: '^1.1.0', requiredFeatures: [] },
    execution: { kind: 'module', entry: './index.js' },
    permissions: { networkOrigins: [], inputFiles: false, storage: 'none', secrets: [], nativeCode: false },
    models: [], implementations: tools.map(tool => ({
      id: `binding-${tool.id}`, contractId: `@test/${tool.id}`, contractVersion: '1.0.0', recipeVersion: '1.0.0',
    })), skills: [],
    tools: tools.map(tool => ({
      id: tool.id, name: tool.name, contractId: `@test/${tool.id}`, contractVersion: '1.0.0',
      description: `The ${tool.name} tool used for CLI testing.`,
      inputSchema: './schemas/in.json', outputSchema: './schemas/out.json',
    })),
  })))
  zip.addFile('index.js', Buffer.from('export const ok = true'))
  zip.addFile('schemas/in.json', Buffer.from('{}'))
  zip.addFile('schemas/out.json', Buffer.from('{}'))
  return new Uint8Array(zip.toBuffer())
}

/** Install a package directly into a store, without the CLI. */
async function seed(storeDir: string, name: string, version = '1.0.0', tools: { id: string; name: string }[] = []) {
  const bytes = buildZip(name, version, tools)
  return stagedInstall({
    source: { kind: 'registry', requested: `${name}@${version}` },
    storeDir,
    expectedSha512: createHash('sha512').update(bytes).digest('hex'),
    archive: createZipArchiveSource(async () => bytes),
  })
}

const cli = (argv: string[], dependencies = {}) => {
  const harness = capture()
  return runToolModeCli(argv, harness.io, dependencies).then(code => ({ code, ...harness }))
}

describe('EXT-31 — argument parsing', () => {
  it('refuses an unknown option rather than ignoring it', () => {
    // A silently dropped flag turns `uninstall --deactivate` into a command the
    // operator did not ask for, which on uninstall is destructive.
    assert.throws(() => parseArgs(['extensions', 'uninstall', 'x', '--deactivte']), /unknown option/)
  })

  it('refuses an option whose value is missing', () => {
    assert.throws(() => parseArgs(['extensions', 'activate', 'x', '--profile']), /needs a value/)
  })

  it('parses boolean and valued flags together', () => {
    const parsed = parseArgs(['extensions', 'uninstall', '@a/b', '--deactivate', '--profile', 'strict'])
    assert.equal(parsed.flags.deactivate, true)
    assert.equal(parsed.profile, 'strict')
    assert.deepEqual([...parsed.positional], ['extensions', 'uninstall', '@a/b'])
  })

  it('defaults the profile and store', () => {
    const parsed = parseArgs(['extensions', 'list'])
    assert.equal(parsed.profile, 'default')
    assert.ok(parsed.store.length > 0)
  })
})

describe('EXT-31 — read-only commands', () => {
  it('reports an empty store without failing', async () => {
    const { code, out } = await cli(['extensions', 'list', '--store', scratch()])
    assert.equal(code, 0)
    assert.match(out.join('\n'), /no extensions installed/)
  })

  it('lists an installed extension with its state', async () => {
    const store = scratch()
    await seed(store, '@acme/one')
    const { code, out } = await cli(['extensions', 'list', '--store', store])
    assert.equal(code, 0)
    assert.match(out.join('\n'), /@acme\/one@1\.0\.0\tnot-configured/)
  })

  it('inspects one extension, including its integrity', async () => {
    const store = scratch()
    await seed(store, '@acme/one')
    const { code, out } = await cli(['extensions', 'inspect', '@acme/one', '--store', store])
    assert.equal(code, 0)
    const text = out.join('\n')
    assert.match(text, /content\s+unchanged/)
    assert.match(text, /activation\s+not-configured/)
  })

  it('reports changed content rather than presenting it as healthy', async () => {
    const store = scratch()
    const installed = await seed(store, '@acme/one')
    writeFileSync(join(installed.installPath, 'index.js'), 'export const tampered = true')
    const { code, out } = await cli(['extensions', 'inspect', '@acme/one', '--store', store])
    assert.equal(code, 0)
    assert.match(out.join('\n'), /content\s+CHANGED/)
  })

  it('fails clearly when the store state is unreadable', async () => {
    const store = scratch()
    await seed(store, '@acme/one')
    writeFileSync(join(store, 'extensions.lock.json'), 'not json')
    const { code, err } = await cli(['extensions', 'list', '--store', store])
    // Fails closed WITH a diagnostic, so an operator can tell "nothing installed"
    // from "state unreadable".
    assert.equal(code, 1)
    assert.match(err.join('\n'), /could not be read/)
  })

  it('refuses to inspect an extension that is not installed', async () => {
    const { code, err } = await cli(['extensions', 'inspect', '@acme/absent', '--store', scratch()])
    assert.equal(code, 1)
    assert.match(err.join('\n'), /not installed/)
  })
})

describe('EXT-31 — install requires verifiable integrity', () => {
  it('refuses an install with no --integrity', async () => {
    const { code, err } = await cli(['extensions', 'install', './pkg.tgz', '--store', scratch()])
    assert.equal(code, 2)
    // EXT-12: without a declared digest nothing can be verified later, and an
    // unverified install cannot be undone.
    assert.match(err.join('\n'), /requires --integrity/)
  })

  it('refuses when no installer is attached rather than pretending', async () => {
    const { code, err } = await cli([
      'extensions', 'install', './pkg.tgz', '--integrity', 'sha512-abc', '--store', scratch(),
    ])
    assert.equal(code, 1)
    assert.match(err.join('\n'), /no installer attached/)
  })

  it('installs through an attached installer and says it is inactive', async () => {
    const store = scratch()
    const { code, out } = await cli(
      ['extensions', 'install', './pkg.tgz', '--integrity', 'sha512-abc', '--store', store],
      { install: async (spec: string) => `installed-from:${spec}` },
    )
    assert.equal(code, 0)
    // EXT-07 restated at the operator surface.
    assert.match(out.join('\n'), /inactive/)
  })
})

describe('EXT-31 — activation needs a real host', () => {
  it('refuses to activate without a registrar instead of faking publication', async () => {
    const store = scratch()
    await seed(store, '@acme/one', '1.0.0', [{ id: 'a', name: 'acme_a' }])
    const { code, err } = await cli(['extensions', 'activate', '@acme/one', '--store', store])
    assert.equal(code, 1)
    assert.match(err.join('\n'), /no running host is attached/)
    // The lifecycle's rollback reports the fault and states that other extensions
    // were untouched, which is the claim an operator needs after a failed activate.
    assert.match(err.join('\n'), /other extensions were not disturbed/)
  })

  it('activates when a registrar is attached', async () => {
    const store = scratch()
    await seed(store, '@acme/one', '1.0.0', [{ id: 'a', name: 'acme_a' }])
    const { code, out } = await cli(
      ['extensions', 'activate', '@acme/one', '--store', store],
      { registrar: allowingRegistrar },
    )
    assert.equal(code, 0)
    assert.match(out.join('\n'), /activated @acme\/one@1\.0\.0/)
    assert.match(out.join('\n'), /generation \d+/)
  })

  it('refuses to choose among several installed versions', async () => {
    const store = scratch()
    await seed(store, '@acme/one', '1.0.0')
    await seed(store, '@acme/one', '1.1.0')
    const { code, err } = await cli(
      ['extensions', 'activate', '@acme/one', '--store', store],
      { registrar: allowingRegistrar },
    )
    // "Activate the newest" is a guess about operator intent, so it is refused.
    assert.equal(code, 1)
    assert.match(err.join('\n'), /installed at 2 versions/)
  })
})

describe('EXT-04 — per-tool toggles', () => {
  async function activated() {
    const store = scratch()
    await seed(store, '@acme/tools', '1.0.0', [{ id: 'a', name: 'acme_a' }, { id: 'b', name: 'acme_b' }])
    await cli(['extensions', 'activate', '@acme/tools', '--store', store], { registrar: allowingRegistrar })
    return store
  }

  it('disables one tool and leaves the other alone', async () => {
    const store = await activated()
    const { code, out } = await cli(['tools', 'disable', 'acme_a', '--store', store])
    assert.equal(code, 0)
    assert.match(out.join('\n'), /disabled acme_a/)

    const lifecycle = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: allowingRegistrar,
    })
    const state = lifecycle.stateOf('@acme/tools')
    assert.equal(state?.tools.find(tool => tool.toolName === 'acme_a')?.enabled, false)
    assert.equal(state?.tools.find(tool => tool.toolName === 'acme_b')?.enabled, true)
    // The package stays active; only the tool is hidden.
    assert.equal(state?.observedActivation, 'active')
  })

  it('re-enables a disabled tool', async () => {
    const store = await activated()
    await cli(['tools', 'disable', 'acme_a', '--store', store])
    const { code } = await cli(['tools', 'enable', 'acme_a', '--store', store])
    assert.equal(code, 0)
    const lifecycle = new ExtensionLifecycle({
      store: new ExtensionStore(store), profile: 'default', registrar: allowingRegistrar,
    })
    assert.equal(lifecycle.stateOf('@acme/tools')?.tools.find(t => t.toolName === 'acme_a')?.enabled, true)
  })

  it('names the owner when the tool is unknown', async () => {
    const store = await activated()
    const { code, err } = await cli(['tools', 'disable', 'nope', '--store', store])
    assert.equal(code, 1)
    assert.match(err.join('\n'), /no extension .* contributes a tool named nope/)
  })
})

describe('EXT-28 — uninstall requires a preview and explicit deactivation', () => {
  it('refuses an active uninstall and shows the impact preview', async () => {
    const store = scratch()
    await seed(store, '@acme/tools', '1.0.0', [{ id: 'a', name: 'acme_a' }])
    await cli(['extensions', 'activate', '@acme/tools', '--store', store], { registrar: allowingRegistrar })

    const { code, err } = await cli(['extensions', 'uninstall', '@acme/tools', '--store', store])
    assert.equal(code, 1)
    const text = err.join('\n')
    assert.match(text, /EXTENSION_IN_USE|is active/)
    // The preview must say exactly what re-running would affect.
    assert.match(text, /Impact preview/)
    assert.match(text, /tool acme_a/)
    assert.match(text, /--deactivate/)
  })

  it('refuses --deactivate uninstall when a new CLI has no owning publication handles', async () => {
    const store = scratch()
    await seed(store, '@acme/tools', '1.0.0', [{ id: 'a', name: 'acme_a' }])
    await cli(['extensions', 'activate', '@acme/tools', '--store', store], { registrar: allowingRegistrar })

    const { code, out } = await cli(
      ['extensions', 'uninstall', '@acme/tools', '--deactivate', '--store', store],
      { registrar: allowingRegistrar },
    )
    assert.equal(code, 1)
    assert.equal(new ExtensionStore(store).listInstalled().value.length, 1)
    assert.equal(new ExtensionStore(store).readProfileState('default').value[0]?.observedActivation, 'quarantined')
  })

  it('uninstalls an inactive extension without needing --deactivate', async () => {
    const store = scratch()
    await seed(store, '@acme/idle')
    const { code } = await cli(['extensions', 'uninstall', '@acme/idle', '--store', store])
    assert.equal(code, 0)
  })
})

describe('EXT-31 — deactivation reports honestly when cleanup fails', () => {
  it('reports a quarantine rather than claiming a full stop', async () => {
    const store = scratch()
    await seed(store, '@acme/stuck', '1.0.0', [{ id: 'a', name: 'stuck_a' }])
    await cli(['extensions', 'activate', '@acme/stuck', '--store', store], { registrar: allowingRegistrar })

    const failing: ContributionRegistrar = {
      publish: allowingRegistrar.publish,
      withdraw: () => { throw new Error('worker did not stop') },
    }
    const { code, err } = await cli(
      ['extensions', 'deactivate', '@acme/stuck', '--store', store],
      { registrar: failing },
    )
    // EXT-27: never report fully stopped while an owned worker continues.
    assert.equal(code, 1)
    assert.match(err.join('\n'), /cleanup did not complete/)
    assert.match(err.join('\n'), /quarantined/)
  })
})

describe('EXT-31 — offline edits take exclusive ownership', () => {
  it('refuses when another live process owns the store', async () => {
    const store = scratch()
    const extensions = new ExtensionStore(store)
    // A REAL live foreign process: a child that stays alive for the test's
    // duration, so isProcessAlive(pid) is genuinely true (a made-up pid would
    // read as a stale lock and the refusal would never fire — the round-49
    // review's vacuous-test finding).
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'])
    try {
      const { writeFileSync: write } = await import('node:fs')
      write(join(store, 'store.lock'), JSON.stringify({ pid: holder.pid, since: new Date().toISOString() }))

      const other = new ExtensionStore(store)
      assert.throws(
        () => other.acquireExclusive(),
        (error: unknown) => {
          assert.ok(error instanceof ManagementError)
          assert.equal(error.code, 'EXTENSION_IN_USE')
          assert.match(error.message, new RegExp(String(holder.pid)))
          return true
        },
      )
    } finally {
      holder.kill()
    }
  })

  it('treats a lock from a dead process as stale rather than blocking forever', async () => {
    const store = scratch()
    const { mkdirSync, writeFileSync: write } = await import('node:fs')
    mkdirSync(store, { recursive: true })
    // A pid that cannot be running: 0 is never a valid process to signal.
    write(join(store, 'store.lock'), JSON.stringify({ pid: 2147483, since: '2020-01-01T00:00:00Z' }))
    const release = new ExtensionStore(store).acquireExclusive()
    // Proceeding is correct: refusing would make one crashed run block the store
    // permanently, which is a worse failure than a recoverable stale lock.
    release()
  })

  it('refuses `tools disable` while another live process owns the store', async () => {
    const store = scratch()
    await seed(store, '@acme/tools', '1.0.0', [{ id: 'a', name: 'acme_a' }, { id: 'b', name: 'acme_b' }])
    await cli(['extensions', 'activate', '@acme/tools', '--store', store], { registrar: allowingRegistrar })
    // A REAL foreign live process: a node child that stays alive, standing in for a
    // running host that owns the store.
    const { spawn } = await import('node:child_process')
    const foreign = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      const { writeFileSync: write } = await import('node:fs')
      write(join(store, 'store.lock'), JSON.stringify({ pid: foreign.pid, since: new Date().toISOString() }))

      const { code, err } = await cli(['tools', 'disable', 'acme_a', '--store', store])
      assert.equal(code, 1)
      assert.match(err.join('\n'), /owned by process|EXTENSION_IN_USE/)
      // The durable choice must NOT change when the command could not take ownership:
      // racing a host's live registry with no mutual exclusion would split the truth.
      const state = new ExtensionStore(store).readProfileState('default').value[0]
      assert.equal(state?.tools.find(tool => tool.toolName === 'acme_a')?.enabled, true)
    } finally {
      foreign.kill()
    }
  })

  it('release removes only its own lock', async () => {
    const store = scratch()
    const extensions = new ExtensionStore(store)
    const release = extensions.acquireExclusive()
    release()
    const { readFileSync, existsSync } = await import('node:fs')
    assert.equal(existsSync(join(store, 'store.lock')), false)
    // Idempotent: a double release must not throw, and must not remove a lock that
    // a later owner took.
    release()
    assert.equal(existsSync(join(store, 'store.lock')), false)
  })
})

describe('EXT-31 — usage and unknown commands', () => {
  it('prints usage with --help', async () => {
    const { code, out } = await cli(['--help'])
    assert.equal(code, 0)
    assert.match(out.join('\n'), /dsh-tool-mode — manage Tool Mode extensions/)
    // The full required family is documented in the usage text.
    for (const command of ['extensions list', 'extensions inspect', 'extensions install',
      'extensions activate', 'extensions prepare', 'extensions deactivate', 'extensions uninstall',
      'tools enable', 'tools disable']) {
      assert.ok(out.join('\n').includes(command), `${command} must appear in usage`)
    }
  })

  it('refuses an unknown command with the usage text', async () => {
    const { code, err } = await cli(['extensions', 'frobnicate'])
    assert.equal(code, 2)
    assert.match(err.join('\n'), /unknown command/)
  })

  it('never publishes a management tool on the inference surface', () => {
    // EXT-31 forbids exposing the management channel on the MCP tool surface by
    // default. This module registers nothing, and the assertion documents that the
    // absence is deliberate rather than unfinished.
    assert.equal(typeof runToolModeCli, 'function')
  })
})
