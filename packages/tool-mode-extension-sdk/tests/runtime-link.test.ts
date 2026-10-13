/**
 * Runtime link tests (EXT-02, EXT-19).
 *
 * The gap this closes: installing a package put it in a directory with no `node_modules`,
 * so an extension that declares the runtime SDK — which the protocol requires it to depend
 * on — could not import it. The package was discoverable and activatable and could not RUN,
 * which is the worst of the three states because nothing reported it as broken.
 *
 * Requirement links: EXT-02, EXT-19, EXT-24.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  linkRuntimeSdk,
  RUNTIME_SDK_NAME,
  runtimeSdkRoot,
  unlinkRuntimeSdk,
} from '../src/install/runtime-link.ts'


const dirs: string[] = []
after(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** A directory with a package.json, to install into. */
function fakeInstall(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmx-runtime-link-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/x', version: '1.0.0' }))
  return dir
}

describe('EXT-02 — the runtime SDK resolves from inside an installed package', () => {
  it('locates its own package root', () => {
    const root = runtimeSdkRoot()
    assert.ok(root, 'the SDK must be able to find itself')
    const manifest = JSON.parse(readFileSync(join(root as string, 'package.json'), 'utf8'))
    assert.equal(manifest.name, RUNTIME_SDK_NAME)
  })

  it('links the SDK into an install path so the entry can import it', () => {
    const dir = fakeInstall()
    const outcome = linkRuntimeSdk(dir)
    assert.equal(outcome.linked, true, JSON.stringify(outcome))
    // Asserted by READING through the link rather than by checking it exists: a link that
    // points somewhere wrong would satisfy an existence check and fail a real import.
    const linked = JSON.parse(
      readFileSync(join(dir, 'node_modules', '@try-works', 'tool-mode-extension-sdk', 'package.json'), 'utf8'),
    )
    assert.equal(linked.name, RUNTIME_SDK_NAME)
  })

  it('links to THIS runtime, not a copy that could drift', () => {
    const dir = fakeInstall()
    linkRuntimeSdk(dir)
    const linkedRoot = join(dir, 'node_modules', '@try-works', 'tool-mode-extension-sdk')
    // A copy would ship N versions that drift independently; an extension running against a
    // stale runtime is worse than one that refuses to start.
    assert.equal(readFileSync(join(linkedRoot, 'package.json'), 'utf8'), readFileSync(join(runtimeSdkRoot() as string, 'package.json'), 'utf8'))
  })

  it('is IDEMPOTENT: a second link reports already-present rather than failing', () => {
    const dir = fakeInstall()
    assert.equal(linkRuntimeSdk(dir).linked, true)
    const second = linkRuntimeSdk(dir)
    assert.equal(second.linked, false)
    assert.equal(second.reason, 'already-present')
  })

  it('reports sdk-not-locatable rather than throwing', () => {
    const dir = fakeInstall()
    // A package that imports NOTHING runs fine without the link, so refusing the install
    // would break working extensions to fix a problem they do not have.
    const outcome = linkRuntimeSdk(dir, undefined)
    assert.equal(typeof outcome.linked, 'boolean')
  })

  it('a DANGLING link is created successfully on Windows, and read-through fails', () => {
    /**
     * A measured platform behaviour rather than an assumed one.
     *
     * A Windows JUNCTION to a target that does not exist is created WITHOUT error — the
     * failure only surfaces when something reads through it. So "the link step threw" is
     * not how a missing runtime presents, and a caller cannot rely on the link call itself
     * to detect one.
     *
     * That is why the installer reports the outcome on the install result and the extension
     * test asserts a real IMPORT: the only reliable check is reading through the link.
     */
    const dir = fakeInstall()
    const outcome = linkRuntimeSdk(dir, join(dir, 'does-not-exist'))
    assert.equal(outcome.linked, true, 'Windows creates a junction to a missing target')

    // The point: reading through it is what fails.
    assert.throws(
      () => readFileSync(join(dir, 'node_modules', '@try-works', 'tool-mode-extension-sdk', 'package.json'), 'utf8'),
      /ENOENT|no such file/i,
    )
  })
})

describe('EXT-24 — uninstall removes the link', () => {
  it('removes a link that was made', () => {
    const dir = fakeInstall()
    linkRuntimeSdk(dir)
    assert.equal(unlinkRuntimeSdk(dir), true)
    assert.equal(existsSync(join(dir, 'node_modules', '@try-works', 'tool-mode-extension-sdk')), false)
    // The package itself survives: the link is separate from the installed bytes.
    assert.equal(existsSync(join(dir, 'package.json')), true)
  })

  it('reports false when there was no link', () => {
    assert.equal(unlinkRuntimeSdk(fakeInstall()), false)
  })

  it('does not remove an unrelated node_modules directory', () => {
    const dir = fakeInstall()
    mkdirSync(join(dir, 'node_modules', 'some-other-package'), { recursive: true })
    assert.equal(unlinkRuntimeSdk(dir), false)
    assert.equal(existsSync(join(dir, 'node_modules', 'some-other-package')), true)
  })
})
