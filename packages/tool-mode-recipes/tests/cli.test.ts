/**
 * Recipe authoring CLI tests (RCP-08).
 *
 * The commands are exercised through the argv/IO surface, exactly as an author
 * or an agent would drive them. The validation corpus is the SAME 21 damaged
 * documents the schema-parity tests refuse, so the CLI's `validate` verdict and
 * the library authorities cannot drift.
 *
 * Requirement links: RCP-07 (the packed artifact installs through the
 * declarative installer surface), RCP-08 (validate/pack/describe), RCP-02.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'

import { runRecipeCli, type RecipeCliIo } from '../src/cli.ts'
import { REPRESENTATIVE, damagedJson } from './corpus.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(prefix = 'tmx-recipe-cli-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A capturing IO pair. */
function capture(): { io: RecipeCliIo; lines: string[]; errors: string[] } {
  const lines: string[] = []
  const errors: string[] = []
  return {
    io: { out: line => lines.push(line), err: line => errors.push(line) },
    lines,
    errors,
  }
}

function writeRecipe(path: string, content: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8')
}

/** The sha-512 the installer verifies against (EXT-12). */
const sha512 = (bytes: Uint8Array) => createHash('sha512').update(bytes).digest('hex')

describe('RCP-08 — usage and exit codes are a contract', () => {
  it('prints usage and exits 2 with no arguments', async () => {
    const { io } = capture()
    assert.equal(await runRecipeCli([], io), 2)
  })

  it('rejects an unknown command', async () => {
    const { io } = capture()
    assert.equal(await runRecipeCli(['frobnicate', 'x.json'], io), 2)
  })

  it('rejects an unknown option', async () => {
    const { io } = capture()
    assert.equal(await runRecipeCli(['validate', 'x.json', '--bogus'], io), 2)
  })

  it('reports a missing file as a usage failure, not a validation verdict', async () => {
    const { io, errors } = capture()
    assert.equal(await runRecipeCli(['validate', join(scratch(), 'absent.json')], io), 2)
    assert.match(errors.join('\n'), /cannot read/)
  })
})

describe('RCP-08 — validate runs BOTH authorities', () => {
  it('accepts a valid draft with both verdicts clean', async () => {
    const dir = scratch()
    const path = join(dir, 'valid.json')
    writeRecipe(path, REPRESENTATIVE)
    const { io, lines } = capture()
    assert.equal(await runRecipeCli(['validate', path], io), 0)
    assert.ok(lines.includes('schema: OK'), lines.join('\n'))
    assert.ok(lines.includes('code: OK'), lines.join('\n'))
  })

  it('names every refusal and exits nonzero for each damaged document in the corpus', async () => {
    const dir = scratch()
    const corpus = damagedJson()
    assert.equal(Object.keys(corpus).length, 21, 'the corpus must stay complete')
    for (const [label, text] of Object.entries(corpus)) {
      const path = join(dir, `${label.replaceAll(' ', '-')}.json`)
      writeRecipe(path, text)
      const { io, errors } = capture()
      assert.equal(await runRecipeCli(['validate', path], io), 1, `${label} must exit 1`)
      assert.ok(errors.length > 0, `${label} must name at least one refusal`)
      assert.ok(errors.some(line => line.includes(': ')), `${label} refusals must be rendered: ${errors.join(' | ')}`)
    }
  })

  it('reports malformed JSON as a validation verdict with the refusal named', async () => {
    const dir = scratch()
    const path = join(dir, 'broken.json')
    writeRecipe(path, '{ this is not json')
    const { io, errors } = capture()
    assert.equal(await runRecipeCli(['validate', path], io), 2)
    assert.match(errors.join('\n'), /not valid JSON/)
  })
})

describe('RCP-08 — describe prints the effective bounds', () => {
  it('describes a valid recipe with ceilings, destinations, recording and context', async () => {
    const dir = scratch()
    const path = join(dir, 'valid.json')
    writeRecipe(path, REPRESENTATIVE)
    const { io, lines } = capture()
    assert.equal(await runRecipeCli(['describe', path], io), 0)
    const text = lines.join('\n')
    assert.match(text, /full_coverage \(contract sample\.full\)/)
    assert.match(text, /output ceiling: at most 256 tokens/)
    assert.match(text, /image ceiling: at most 1 image input/)
    assert.match(text, /recording: requested/)
    assert.match(text, /local only, by the recipe/)
    assert.match(text, /context: none supplied/)
  })

  it('refuses to describe a recipe that does not validate', async () => {
    const dir = scratch()
    const path = join(dir, 'invalid.json')
    writeRecipe(path, damagedJson()['maxOutputTokens above the RES-10 ceiling'] ?? '{}')
    const { io } = capture()
    assert.equal(await runRecipeCli(['describe', path], io), 1)
  })
})

describe('RCP-08 — pack builds a declarative package with no executable code', () => {
  it('packs one recipe file into manifest + recipes + a store-method zip', async () => {
    const dir = scratch()
    const out = join(dir, 'dist')
    const recipePath = join(dir, 'full-coverage.json')
    writeRecipe(recipePath, REPRESENTATIVE)
    const { io, errors, lines } = capture()
    assert.equal(
      await runRecipeCli(['pack', recipePath, '--name', '@acme/coverage', '--out', out], io),
      0,
      errors.join('\n'),
    )
    const packageDir = join(out, '@acme__coverage-1.0.0')
    assert.ok(existsSync(packageDir), 'the package directory must exist')
    const manifest = JSON.parse(readFileSync(join(packageDir, 'tool-mode.extension.json'), 'utf8')) as {
      id: string
      execution: { kind: string }
      implementations: { id: string; contractId: string; recipeVersion: string }[]
    }
    assert.equal(manifest.id, '@acme/coverage')
    assert.equal(manifest.execution.kind, 'declarative')
    assert.deepEqual(manifest.implementations, [{
      id: 'full-coverage-sample',
      contractId: 'sample.full',
      contractVersion: '1.0.0',
      recipeVersion: '1.0.0',
    }])
    assert.ok(existsSync(join(packageDir, 'recipes', 'full-coverage-sample.json')))
    const zipPath = join(out, '@acme__coverage-1.0.0.zip')
    assert.ok(existsSync(zipPath))
    const zip = new AdmZip(zipPath)
    const entries = zip.getEntries().map(entry => entry.entryName).sort()
    assert.deepEqual(entries, [
      'package.json',
      'recipes/full-coverage-sample.json',
      'tool-mode.extension.json',
    ])
    assert.match(lines.join('\n'), /NO executable code ships/)
  })

  it('packs a project directory with several recipes', async () => {
    const dir = scratch()
    const project = join(dir, 'project')
    mkdirSync(join(project, 'recipes'), { recursive: true })
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'acme-two', version: '2.3.4' }))
    writeRecipe(join(project, 'recipes', 'first.json'), REPRESENTATIVE)
    const second = { ...REPRESENTATIVE, id: 'second-recipe', tool: { name: 'second_tool', contractId: 'second.tool' } }
    writeRecipe(join(project, 'recipes', 'second.json'), second)
    const out = join(dir, 'dist')
    const { io, errors } = capture()
    assert.equal(await runRecipeCli(['pack', project, '--out', out], io), 0, errors.join('\n'))
    const manifest = JSON.parse(readFileSync(join(out, 'acme-two-2.3.4', 'tool-mode.extension.json'), 'utf8')) as {
      implementations: { id: string }[]
    }
    assert.deepEqual(manifest.implementations.map(entry => entry.id), ['full-coverage-sample', 'second-recipe'])
  })

  it('refuses to pack a recipe that does not validate', async () => {
    const dir = scratch()
    const path = join(dir, 'invalid.json')
    writeRecipe(path, damagedJson()['executable template syntax in the prompt'] ?? '{}')
    const out = join(dir, 'dist')
    const { io, errors } = capture()
    assert.equal(await runRecipeCli(['pack', path, '--name', '@acme/bad', '--out', out], io), 1)
    assert.ok(errors.length > 0)
    assert.equal(existsSync(join(out, '@acme__bad-1.0.0')), false, 'no package may be emitted from an invalid recipe')
  })

  it('refuses two recipes claiming one tool name', async () => {
    const dir = scratch()
    const first = join(dir, 'first.json')
    const secondPath = join(dir, 'second.json')
    writeRecipe(first, REPRESENTATIVE)
    writeRecipe(secondPath, { ...REPRESENTATIVE, id: 'second-recipe' })
    const out = join(dir, 'dist')
    const { io, errors } = capture()
    assert.equal(await runRecipeCli(['pack', dir, '--name', '@acme/clash', '--out', out], io), 1)
    assert.match(errors.join('\n'), /already claimed/)
  })
})

describe('RCP-07 — a packed artifact round-trips through the declarative installer surface', () => {
  it('the zip installs through stagedInstall and discovers as a declarative extension', async () => {
    const dir = scratch()
    const out = join(dir, 'dist')
    const recipePath = join(dir, 'full-coverage.json')
    writeRecipe(recipePath, REPRESENTATIVE)
    const { io, errors } = capture()
    assert.equal(await runRecipeCli(['pack', recipePath, '--name', '@acme/coverage', '--out', out], io), 0, errors.join('\n'))

    const bytes = readFileSync(join(out, '@acme__coverage-1.0.0.zip'))
    // The SDK is reached by RELATIVE PATH to its BUILT lib, so this round-trip
    // exercises the real install surface without depending on how the workspace
    // links packages into node_modules (the packed flows replace those links).
    const { createZipArchiveSource, stagedInstall } = await import('../../tool-mode-extension-sdk/lib/index.js')
    const storeDir = join(dir, 'store')
    const result = await stagedInstall({
      source: { kind: 'registry', requested: '@acme/coverage@1.0.0' },
      storeDir,
      expectedSha512: sha512(bytes),
      archive: createZipArchiveSource(async () => new Uint8Array(bytes)),
    })
    assert.equal(result.discovery.packageName, '@acme/coverage')
    assert.equal(result.discovery.manifest.execution.kind, 'declarative')
    const implementations = result.discovery.manifest.implementations ?? []
    assert.deepEqual(implementations.map(entry => entry.contractId), ['sample.full'])
    const recipes = readdirSync(join(result.installPath, 'recipes'))
    assert.deepEqual(recipes, ['full-coverage-sample.json'])
  })
})

describe('RCP-08 — create emits a static, runnable draft project', () => {
  it('create → validate → test --fixtures → pack → stagedInstall round-trips with no provider call', async () => {
    const dir = scratch()
    const project = join(dir, 'image-review')
    const { io, errors } = capture()
    assert.equal(await runRecipeCli(['create', '--template', 'image-description', '--out', project], io), 0, errors.join('\n'))

    // The static files exist, exactly the documented set.
    for (const path of ['recipes/image-review.json', 'schema/input.schema.json', 'schema/output.schema.json',
      'skills/image-review.skill.md', 'tests/fixtures.json', 'README.md']) {
      assert.ok(existsSync(join(project, path)), `${path} must be emitted`)
    }

    // The draft validates under BOTH authorities.
    const validateIo = capture()
    assert.equal(
      await runRecipeCli(['validate', join(project, 'recipes', 'image-review.json')], validateIo.io),
      0,
      validateIo.errors.join('\n'),
    )

    // The fixture suite runs the REAL broker over the SCRIPTED provider.
    const testIo = capture()
    assert.equal(
      await runRecipeCli(['test', project, '--fixtures', join(project, 'tests', 'fixtures.json')], testIo.io),
      0,
      testIo.errors.join('\n'),
    )
    assert.match(testIo.lines.join('\n'), /scripted provider, not a real model/)

    // And the packed artifact installs through the SDK's staged path.
    const dist = join(dir, 'dist')
    const packIo = capture()
    assert.equal(
      await runRecipeCli(['pack', project, '--name', '@acme/image-review', '--out', dist], packIo.io),
      0,
      packIo.errors.join('\n'),
    )
    const bytes = readFileSync(join(dist, '@acme__image-review-0.1.0.zip'))
    const { createZipArchiveSource, stagedInstall } = await import('../../tool-mode-extension-sdk/lib/index.js')
    const result = await stagedInstall({
      source: { kind: 'registry', requested: '@acme/image-review@0.1.0' },
      storeDir: join(dir, 'store'),
      expectedSha512: sha512(bytes),
      archive: createZipArchiveSource(async () => new Uint8Array(bytes)),
    })
    assert.equal(result.discovery.manifest.execution.kind, 'declarative')
  })

  it('create refuses an existing target and an installed-artifact path', async () => {
    const dir = scratch()
    const project = join(dir, 'draft')
    mkdirSync(project, { recursive: true })
    const { io, errors } = capture()
    assert.equal(await runRecipeCli(['create', '--template', 'text-title', '--out', project], io), 2)
    assert.match(errors.join('\n'), /already exists/)

    const installed = join(dir, 'installed')
    mkdirSync(installed, { recursive: true })
    writeFileSync(join(installed, 'tool-mode.extension.json'), '{}\n')
    const refusal = capture()
    assert.equal(await runRecipeCli(['create', '--template', 'text-title', '--out', join(installed, 'nested')], refusal.io), 2)
    assert.match(refusal.errors.join('\n'), /immutable/)
  })

  it('create with an unknown template or a bad id is refused with the usage reason', async () => {
    const dir = scratch()
    const bad = capture()
    assert.equal(await runRecipeCli(['create', '--template', 'nope', '--out', join(dir, 'x')], bad.io), 2)
    assert.match(bad.errors.join('\n'), /--template image-description/)

    const badId = capture()
    assert.equal(await runRecipeCli(['create', '--template', 'text-title', '--name', 'Not Kebab', '--out', join(dir, 'y')], badId.io), 2)
    assert.match(badId.errors.join('\n'), /lowercase kebab/)
  })
})

describe('RCP-08 — edit-draft is a bounded, validating mutation', () => {
  it('edits a safe field, writes atomically and keeps the draft valid', async () => {
    const dir = scratch()
    const project = join(dir, 'draft')
    await runRecipeCli(['create', '--template', 'text-title', '--out', project], capture().io)
    const recipePath = join(project, 'recipes', 'draft.json')
    const { io, errors } = capture()
    assert.equal(await runRecipeCli(['edit-draft', recipePath, '--set', 'description', '--value', 'A revised description.'], io), 0, errors.join('\n'))
    const edited = JSON.parse(readFileSync(recipePath, 'utf8')) as { description: string }
    assert.equal(edited.description, 'A revised description.')
    assert.equal(await runRecipeCli(['validate', recipePath], capture().io), 0)
  })

  it('refuses a value that would not validate, and leaves the file byte-identical', async () => {
    const dir = scratch()
    const project = join(dir, 'draft')
    await runRecipeCli(['create', '--template', 'text-title', '--out', project], capture().io)
    const recipePath = join(project, 'recipes', 'draft.json')
    const before = readFileSync(recipePath, 'utf8')
    const { io, errors } = capture()
    assert.equal(await runRecipeCli(['edit-draft', recipePath, '--set', 'maxOutputTokens', '--value', '4096'], io), 2)
    assert.match(errors.join('\n'), /between 1 and/)
    assert.equal(readFileSync(recipePath, 'utf8'), before, 'the refused edit must not touch the file')
  })

  it('refuses policy edits and immutable targets by name', async () => {
    const dir = scratch()
    const project = join(dir, 'draft')
    await runRecipeCli(['create', '--template', 'text-title', '--out', project], capture().io)
    const recipePath = join(project, 'recipes', 'draft.json')
    const policy = capture()
    assert.equal(await runRecipeCli(['edit-draft', recipePath, '--set', 'policy.record', '--value', 'false'], policy.io), 2)
    assert.match(policy.errors.join('\n'), /policy fields belong to the deployment policy/)

    const installed = join(dir, 'installed')
    mkdirSync(installed, { recursive: true })
    writeFileSync(join(installed, 'tool-mode.extension.json'), '{}\n')
    const target = join(installed, 'draft.json')
    writeFileSync(target, readFileSync(recipePath, 'utf8'))
    const immutable = capture()
    assert.equal(await runRecipeCli(['edit-draft', target, '--set', 'description', '--value', 'nope'], immutable.io), 2)
    assert.match(immutable.errors.join('\n'), /immutable/)
  })
})

describe('RCP-08 — test --fixtures failures are named, and --live is an honest refusal', () => {
  it('an invalid fixture expectation exits nonzero with the case named', async () => {
    const dir = scratch()
    const project = join(dir, 'draft')
    await runRecipeCli(['create', '--template', 'text-title', '--out', project], capture().io)
    const fixturesPath = join(project, 'tests', 'fixtures.json')
    const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8')) as { cases: { id: string; expect: { kind: string; code?: string } }[] }
    fixtures.cases[0]!.expect = { kind: 'failed', code: 'MODEL_REFUSED' }
    writeFileSync(fixturesPath, JSON.stringify(fixtures))
    const { io, errors } = capture()
    assert.equal(await runRecipeCli(['test', project, '--fixtures', fixturesPath], io), 1)
    assert.match(errors.join('\n'), /happy-path/)
  })

  it('--live is refused as unsupported, never faked', async () => {
    const { io, errors } = capture()
    assert.equal(await runRecipeCli(['test', 'anything', '--live'], io), 2)
    assert.match(errors.join('\n'), /--live is not provided/)
  })
})

describe('RCP-08 — task-35 hardening regressions', () => {
  it('HIGH-1: a CROSS-DRIVE target through a junction is refused with the full-root walk', async (t) => {
    if (process.platform !== 'win32') {
      t.skip('Windows junctions are the escape vector this regression pins')
      return
    }
    const dir = scratch()
    const real = join(dir, 'real')
    mkdirSync(real)
    const link = join(dir, 'link')
    const made = spawnSync('cmd', ['/c', 'mklink', '/J', link, real], { encoding: 'utf8' })
    assert.equal(made.status, 0, `junction creation failed: ${made.stderr}`)
    // The test process cwd is the repo (D:); the scratch dir is on the system
    // temp drive — the target is therefore CROSS-DRIVE relative to cwd, which
    // the old string-slice walk skipped.
    const target = join(link, 'sub')
    const { io, errors } = capture()
    assert.equal(await runRecipeCli(['create', '--template', 'text-title', '--out', target], io), 2, errors.join('\n'))
    assert.match(errors.join('\n'), /junction|symbolic link/)
    assert.equal(existsSync(join(real, 'sub', 'recipes')), false, 'no file may land through the junction')
  })

  it('HIGH-1: a tool-mode.extension.json at a GRANDPARENT ancestor is refused (full ancestor walk)', async () => {
    const dir = scratch()
    const artifact = join(dir, 'artifact')
    mkdirSync(join(artifact, 'nested'), { recursive: true })
    writeFileSync(join(artifact, 'tool-mode.extension.json'), '{}\n')
    const target = join(artifact, 'nested', 'deep')
    const { io, errors } = capture()
    assert.equal(await runRecipeCli(['create', '--template', 'text-title', '--out', target], io), 2)
    assert.match(errors.join('\n'), /immutable/)
    assert.equal(existsSync(join(target, 'recipes')), false)
  })

  it('HIGH-2: a junction flipped mid-run never lets a victim file survive (bounded race loop)', async (t) => {
    if (process.platform !== 'win32') {
      t.skip('Windows junctions are the flip primitive for this race')
      return
    }
    const dir = scratch()
    const victim = join(dir, 'victim')
    mkdirSync(victim)
    const out = join(dir, 'out')
    const real = join(dir, 'real')
    mkdirSync(real)
    // The flipper toggles a junction at `out` toward `victim` every few ms.
    const racer = new Worker(`
      const { workerData } = require('node:worker_threads')
      const { spawnSync } = require('node:child_process')
      let linked = false
      const timer = setInterval(() => {
        try {
          if (linked) { spawnSync('cmd', ['/c', 'rmdir', workerData.out], { stdio: 'ignore' }); linked = false }
          else { spawnSync('cmd', ['/c', 'mklink', '/J', workerData.out, workerData.victim], { stdio: 'ignore' }); linked = true }
        } catch { /* keep flipping */ }
      }, 2)
      process.on('message', () => clearInterval(timer))
    `, { eval: true, workerData: { out, victim } })
    let victimWrite = false
    for (let i = 0; i < 40; i += 1) {
      const { io } = capture()
      let code = -1
      try {
        code = await runRecipeCli(['create', '--template', 'text-title', '--out', out], io)
      } catch {
        code = -1
      }
      assert.notEqual(code, -1, 'create must never throw, even under a live junction flip')
      if (existsSync(join(victim, 'recipes'))) {
        victimWrite = true
        break
      }
      if (code === 0) {
        try { rmSync(out, { recursive: true, force: true }) } catch { /* the flipper owns it */ }
      }
    }
    await racer.terminate()
    spawnSync('cmd', ['/c', 'rmdir', out], { stdio: 'ignore' })
    assert.equal(victimWrite, false, 'no victim file may survive the race: every write is chain-verified')
  })

  it('MEDIUM-1: prototype-key edits are refused by name, never resolved through Object.prototype', async () => {
    const dir = scratch()
    const project = join(dir, 'draft')
    await runRecipeCli(['create', '--template', 'text-title', '--out', project], capture().io)
    const recipePath = join(project, 'recipes', 'draft.json')
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const { io, errors } = capture()
      let code = -1
      try {
        code = await runRecipeCli(['edit-draft', recipePath, '--set', key, '--value', 'x'], io)
      } catch (error) {
        assert.fail(`--set ${key} threw ${(error as Error).constructor.name}: ${(error as Error).message}`)
      }
      assert.equal(code, 2, `--set ${key} must refuse with the usage code`)
      assert.match(errors.join('\n'), /refused/)
    }
  })

  it('MEDIUM-2: a primitive imageInputs refuses by name instead of crashing in strict mode', async () => {
    const dir = scratch()
    const path = join(dir, 'draft.json')
    const broken = {
      id: 'draft', version: '0.1.0', description: 'x',
      tool: { name: 'text_title', contractId: 'text.title' },
      inputs: { text: { type: 'string', required: true, minLength: 1, maxLength: 1024 } },
      promptTemplate: 't {{text}}', maxOutputTokens: 512,
      imageInputs: 5,
      policy: { record: true, allowRemote: true },
    }
    writeFileSync(path, `${JSON.stringify(broken, null, 2)}\n`)
    const { io, errors } = capture()
    let code = -1
    try {
      code = await runRecipeCli(['edit-draft', path, '--set', 'imageInputs.max', '--value', '1'], io)
    } catch (error) {
      assert.fail(`the edit threw ${(error as Error).constructor.name}: ${(error as Error).message}`)
    }
    assert.equal(code, 2)
    assert.match(errors.join('\n'), /not an object/)
    assert.equal(readFileSync(path, 'utf8'), `${JSON.stringify(broken, null, 2)}\n`, 'the file must be untouched')
  })

  it('MEDIUM-3: an IO failure (nonexistent drive) exits 2, never a raw-stack exit 1', async () => {
    const { io, errors } = capture()
    let code = -1
    try {
      code = await runRecipeCli(['create', '--template', 'text-title', '--out', 'Q:/definitely/not/here'], io)
    } catch {
      assert.fail('create must not throw on an IO failure')
    }
    assert.equal(code, 2)
    assert.match(errors.join('\n'), /IO failure|create failed/)
  })

  it('MEDIUM-4: --live with a following value token is refused instead of silently downgraded', async () => {
    const { io, errors } = capture()
    assert.equal(await runRecipeCli(['test', 'anything', '--live', 'run-for-real'], io), 2)
    assert.match(errors.join('\n'), /takes no value/)
  })

  it('LOW-1: an oversized bytesBase64 is refused before decoding with the ceiling named', async () => {
    const dir = scratch()
    const project = join(dir, 'draft')
    await runRecipeCli(['create', '--template', 'image-description', '--out', project], capture().io)
    const fixturesPath = join(project, 'tests', 'fixtures.json')
    const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8')) as {
      cases: { id: string; args: Record<string, unknown> }[]
    }
    fixtures.cases[0]!.args = { image: { mediaType: 'image/png', bytesBase64: 'a'.repeat(12_000_001) } }
    writeFileSync(fixturesPath, JSON.stringify(fixtures))
    const { io, errors } = capture()
    // An unusable fixture is a usage/IO-class refusal (exit 2): the suite never
    // starts, and the refusal names the decode ceiling before any base64 work.
    assert.equal(await runRecipeCli(['test', project, '--fixtures', fixturesPath], io), 2)
    assert.match(errors.join('\n'), /decode ceiling/)
  })
})
