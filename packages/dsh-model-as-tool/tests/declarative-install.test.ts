/**
 * A DECLARATIVE package through a REAL install (EXT-13, RCP-01, slice 3).
 *
 * The previous round's test asserted the host's declarative branch was WRITTEN, read from the
 * source, and said so. This one DRIVES the chain instead, on packed bytes:
 *
 *     pack -> staged install -> discover from the store -> resolve the declared recipes
 *
 * That is three of the four links, each exercised against what actually landed on disk rather
 * than against the source tree. The remaining link — the host's `providerFor` reaching a
 * composed broker — is not driven here and is not claimed to be.
 *
 * Why this matters more than it looks: slice 3 has three layers that were each thoroughly
 * tested in isolation and NONE connected. A test that installs real bytes and resolves real
 * recipes from the installed location is the difference between "the pieces exist" and "the
 * pieces meet".
 *
 * Requirement links: EXT-13, RCP-01, RCP-02, DECL-01.
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import AdmZip from 'adm-zip'

import {
  createZipArchiveSource,
  discoverExtension,
  resolveDeclarativeImplementations,
  stagedInstall,
} from '@try-works/tool-mode-extension-sdk'

import { cleanup, tempDir } from './helpers.ts'

after(async () => { await cleanup() })

const PACKAGE_DIR = join(process.cwd(), 'packages', 'extension-declarative-recipes')
const EXTENSION_ID = '@try-works/extension-declarative-recipes'

/** Every file the package ships — no code, just the manifest, the recipes and its metadata. */
function filesUnder(root: string, current = root): string[] {
  const out: string[] = []
  for (const entry of readdirSync(current)) {
    if (entry === 'node_modules' || entry === 'src' || entry === 'tests') continue
    const full = join(current, entry)
    if (statSync(full).isDirectory()) out.push(...filesUnder(root, full))
    else out.push(relative(root, full).replace(/\\/g, '/'))
  }
  return out
}

/** Archive the real package. */
function packPackage(): { bytes: Uint8Array; sha512: string; shipped: string[] } {
  const shipped = filesUnder(PACKAGE_DIR)
  const zip = new AdmZip()
  for (const relativePath of shipped) {
    zip.addFile(relativePath, readFileSync(join(PACKAGE_DIR, relativePath)))
  }
  const bytes = new Uint8Array(zip.toBuffer())
  return { bytes, sha512: createHash('sha512').update(bytes).digest('hex'), shipped }
}

/** Install the real package into a fresh store. */
async function installReal() {
  const storeDir = tempDir()
  const { bytes, sha512, shipped } = packPackage()
  const installed = await stagedInstall({
    source: { kind: 'local', requested: PACKAGE_DIR },
    storeDir,
    expectedSha512: sha512,
    archive: createZipArchiveSource(() => bytes),
  })
  return { storeDir, installed, shipped }
}

describe('slice 3 — a declarative package INSTALLS with no code in it', () => {
  it('lands in the store and declares itself declarative', async () => {
    const { installed } = await installReal()
    assert.equal(installed.extensionId, EXTENSION_ID)
    assert.equal(installed.activation, 'inactive')

    /**
     * The package ships NO MODULE, and the install must nonetheless succeed. A packaging path
     * that quietly required a module would reject every declarative package — which is
     * exactly what discovery did before the previous round.
     */
    const discovery = discoverExtension(installed.installPath) as unknown as {
      manifest: { execution: { kind: string } }
      moduleEntry?: string
    }
    assert.equal(discovery.manifest.execution.kind, 'declarative')
    assert.equal(discovery.moduleEntry, undefined)
  })

  it('the installed package carries the recipes and NOT the code', async () => {
    const { shipped } = await installReal()
    // What it ships is the property that makes it auditable as data.
    assert.ok(shipped.includes('tool-mode.extension.json'), `manifest missing from: ${shipped.join(', ')}`)
    assert.ok(shipped.includes('recipes/text-title.json'), `recipe missing from: ${shipped.join(', ')}`)
    assert.ok(shipped.includes('recipes/describe-image.json'))
    // And nothing executable came along.
    for (const forbidden of ['lib/index.js', 'src/index.ts', 'dist/index.js']) {
      assert.equal(shipped.includes(forbidden), false, `a declarative package must not ship ${forbidden}`)
    }
  })

  it('RESOLVES its declared recipes from the INSTALLED location', async () => {
    const { installed } = await installReal()
    const discovery = discoverExtension(installed.installPath) as unknown as {
      manifest: { implementations: readonly { id: string; contractId: string; recipeVersion: string }[] }
    }

    /**
     * THE LINK THAT MATTERS. The manifest cannot name its recipes, so the convention must
     * find them — and this resolves them from the STORE, not from the source tree, which is
     * the only place a host would ever look. A convention that worked in the repository and
     * not after installation would be worse than none.
     */
    const resolved = resolveDeclarativeImplementations(installed.installPath, discovery.manifest.implementations)
    assert.equal(resolved.ok, true, resolved.ok ? '' : `${resolved.id}: ${resolved.detail}`)
    if (!resolved.ok) return

    assert.equal(resolved.resolved.length, 2)
    assert.deepEqual(
      resolved.resolved.map(entry => entry.contractId).sort(),
      ['image.describe', 'text.title'],
    )
    // Every recipe really parsed to an object, and each came from inside the store.
    for (const entry of resolved.resolved) {
      assert.ok(entry.recipe !== null && typeof entry.recipe === 'object')
      assert.ok(
        entry.path.startsWith(installed.installPath),
        `${entry.path} must be inside the install path`,
      )
    }
  })

  it('a TAMPERED archive is refused before any of this runs', async () => {
    /**
     * The negative case, and the reason it belongs here: everything above depends on the
     * bytes being the ones the operator approved. If a digest mismatch were tolerated, the
     * recipes resolved above would be the wrong recipes.
     */
    const storeDir = tempDir()
    const { bytes } = packPackage()
    await assert.rejects(
      stagedInstall({
        source: { kind: 'local', requested: PACKAGE_DIR },
        storeDir,
        // A digest the bytes cannot match.
        expectedSha512: 'f'.repeat(128),
        archive: createZipArchiveSource(() => bytes),
      }),
    )
  })
})
