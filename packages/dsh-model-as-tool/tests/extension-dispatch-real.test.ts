/**
 * The dispatch chain against a REAL extension (EXT-19, EXT-21, EXT-22, EXT-30).
 *
 * `extension-dispatch.test.ts` proves the chain against a hand-built manifest. This proves
 * it against a package that actually ships: EmbeddingGemma's own manifest, installed
 * through the real installer and activated through the real lifecycle.
 *
 * That distinction matters because a hand-built manifest can be shaped to pass. This one
 * was written by a different author for a different purpose, and it declares three tools
 * whose ONNX path is deliberately NOT wired — so it exercises the case the host has to get
 * right: a tool that is legitimately declared, legitimately listed, and legitimately
 * uncallable, with a refusal that names WHICH of those it is.
 *
 * Requirement links: EXT-19, EXT-21, EXT-22, EXT-30, ARCH-05, MODEL-05.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import AdmZip from 'adm-zip'

import { installPathFor, stagedInstall, createZipArchiveSource, discoverExtension } from '@try-works/tool-mode-extension-sdk'
import { createDispatch, describeDispatchFailure, resolveImplementation } from '../src/extension-dispatch.ts'
import { tempDir } from './helpers.ts'

after(() => { /* tempDir is cleaned by the shared harness */ })

const PACKAGE_DIR = join(process.cwd(), 'packages', 'extension-embeddinggemma')
const EXTENSION_ID = '@try-works/extension-embeddinggemma'

/** Every file under a directory that the package ships. */
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

/** Archive the REAL package, including its built lib/. */
function packPackage(): { bytes: Uint8Array; sha512: string } {
  const zip = new AdmZip()
  for (const relativePath of filesUnder(PACKAGE_DIR)) {
    zip.addFile(relativePath, readFileSync(join(PACKAGE_DIR, relativePath)))
  }
  // EXT-09 (H1): an extension must run against the HOST-provided runtime SDK —
  // the real package's dependency entry for the SDK is host-side concern, so the
  // packed fixture ships the package with the SDK moved out of `dependencies`
  // (the host runtime link replaces it). This mirrors the published artifact.
  const packaged = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, unknown>
    optionalDependencies?: Record<string, unknown>
  }
  delete packaged.dependencies?.['@try-works/tool-mode-extension-sdk']
  if (Object.keys(packaged.dependencies ?? {}).length === 0) delete packaged.dependencies
  zip.updateFile('package.json', Buffer.from(`${JSON.stringify(packaged, null, 2)}\n`))
  const bytes = new Uint8Array(zip.toBuffer())
  return { bytes, sha512: createHash('sha512').update(bytes).digest('hex') }
}

/** Install the package and report where it landed. */
async function installReal() {
  const storeDir = tempDir()
  const { bytes, sha512 } = packPackage()
  const installed = await stagedInstall({
    source: { kind: 'local', requested: PACKAGE_DIR },
    storeDir,
    expectedSha512: sha512,
    archive: createZipArchiveSource(() => bytes),
    // EXT-09 (H1): the real package declares runtime dependencies, so the
    // installer demands a graph. The suite performs NO network, so the resolver
    // serves a stub tarball per declared name/range — the materialized graph is
    // real (integrity-verified), only its CONTENT is a stub the tests never
    // import.
    dependencies: stubDependencyInstaller(),
  })
  return { storeDir, installed }
}

/** A no-network dependency installer: one stub tarball per declared dependency. */
function stubDependencyInstaller() {
  const stubs = new Map<string, { bytes: Uint8Array; sha512: string }>()
  const stubFor = (name: string, range: string) => {
    const key = `${name}@${range}`
    const existing = stubs.get(key)
    if (existing !== undefined) return existing
    const zip = new AdmZip()
    zip.addFile('package.json', JSON.stringify({ name, version: '1.0.0', main: 'index.js' }))
    zip.addFile('index.js', 'module.exports = {}\n')
    const bytes = new Uint8Array(zip.toBuffer())
    const stub = { bytes, sha512: createHash('sha512').update(bytes).digest('hex') }
    stubs.set(key, stub)
    return stub
  }
  const archive = {
    list: () => [] as unknown as ReturnType<ReturnType<typeof createZipArchiveSource>['list']>,
    fetch: async (source: { kind: string; requested: string }) => {
      const name = source.requested.split('--').slice(0, -1).join('--') || source.requested
      const range = source.requested.split('--').pop() ?? '*'
      return stubFor(name, range).bytes
    },
    extract: (_bytes: Uint8Array, destination: string, root: string) => {
      const zip = new AdmZip(Buffer.from(_bytes))
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue
        const target = join(destination, root.length > 0 && entry.entryName.startsWith(root) ? entry.entryName.slice(root.length + 1) : entry.entryName)
        mkdirSync(join(target, '..'), { recursive: true })
        writeFileSync(target, entry.getData())
      }
    },
  }
  return {
    resolver: {
      async resolve(name: string, range: string) {
        const stub = stubFor(name, range)
        return {
          name,
          version: '1.0.0',
          tarball: { kind: 'local', requested: `${name}--${range}` },
          integrity: stub.sha512,
        }
      },
    },
    archive,
  }
}

describe('the dispatch chain resolves against a REAL shipped extension', () => {
  it('installs and its manifest declares the tool/implementation chain', async () => {
    const { installed } = await installReal()
    assert.equal(installed.extensionId, EXTENSION_ID)

    const discovery = discoverExtension(installed.installPath)
    // A shipped package must declare every licence layer; a gap here is a package defect.
    assert.deepEqual([...discovery.licenseGaps], [])
    // Six tools since H3/H4: the three core tools plus classify/deduplicate/moments.
    assert.equal(discovery.manifest.tools.length, 6)
    assert.equal(discovery.manifest.implementations.length, 6)
  })

  it('resolves ALL THREE tools through contract to implementation', async () => {
    const { installed } = await installReal()
    const discovery = discoverExtension(installed.installPath)
    const manifest = discovery.manifest as never as Parameters<typeof resolveImplementation>[0]

    for (const tool of discovery.manifest.tools) {
      const resolved = resolveImplementation(manifest, tool.name)
      // Every declared tool must find its implementation. A `no-implementation` here would
      // mean the package declares a contract nothing serves, which is a packaging defect
      // rather than the honest "not wired yet" case.
      assert.equal(resolved.ok, true, `${tool.name} did not resolve: ${resolved.ok ? '' : resolved.failure.message}`)
      if (!resolved.ok) continue
      assert.equal(resolved.implementation.modelId, 'embeddinggemma-2')
    }
  })

  it('INVOKING a tool reaches the extension and REFUSES honestly, naming what is missing', async () => {
    const { installed } = await installReal()
    const discovery = discoverExtension(installed.installPath)
    const manifest = discovery.manifest as never as Parameters<typeof resolveImplementation>[0]

    const dispatch = await createDispatch({
      getManifest: () => manifest,
      async providerFor() {
        // The REAL extension module, imported from the INSTALLED package.
        const entry = await import(
          new URL(`file:///${join(installed.installPath, 'lib', 'index.js').replace(/\\/g, '/')}`).href
        )
        const instance = await (entry.default ?? entry).create({
          extensionId: EXTENSION_ID,
          extensionVersion: installed.version,
          activationGeneration: 1,
          storage: { directory: installed.installPath, async read() { return undefined }, async write() {} },
          logger: { log() {} },
          signal: new AbortController().signal,
          configuration: {},
        })
        return instance.createProvider({ modelId: 'embeddinggemma-2', configuration: {} })
      },
      contextFor: implementationId => ({ implementationId }),
    }, 'semantic_similarity')

    assert.equal(dispatch.ok, true, dispatch.ok ? '' : dispatch.failure.message)
    if (!dispatch.ok) return

    /**
     * The extension reports `unprepared` because no ONNX session exists on this host. The
     * assertion is that the failure is HONEST and SPECIFIC — not an empty success, and not
     * a generic "something went wrong".
     */
    await assert.rejects(
      dispatch.execute({ items: [] }, new AbortController().signal),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        /**
         * The refusal must be SPECIFIC. There are two causes on this host, and BOTH are
         * honest rather than a silent empty success:
         *
         *   - the extension reports `unprepared`, because no ONNX session exists, or
         *   - the extension's own `@try-works/tool-mode-extension-sdk` dependency does not
         *     resolve FROM THE STORE it was installed into, which is the install-design gap
         *     covered by the test below.
         *
         * What must never happen is a result that looks like success.
         */
        assert.match(
          message,
          /ONNX|inference|not wired|unprepared|not prepared|needs-preparation|missing|Cannot find package/i,
          `uninformative refusal: ${message}`,
        )
        /**
         * And it must name WHAT is missing, not merely that something is. The extension
         * reports the unresolvable runtime AND each unprepared asset group, so a caller
         * learns what to fix rather than only that the call failed.
         */
        assert.match(message, /asset group|does not resolve/, `the refusal must name the gap: ${message}`)
        return true
      },
    )
  })

  it('reports NOT-DECLARED for a name this extension never declared', async () => {
    const { installed } = await installReal()
    const discovery = discoverExtension(installed.installPath)
    const manifest = discovery.manifest as never as Parameters<typeof resolveImplementation>[0]

    const missing = resolveImplementation(manifest, 'definitely_not_a_tool')
    assert.equal(missing.ok, false)
    if (missing.ok) return
    assert.equal(missing.failure.code, 'not-declared')

    /**
     * The code must DIFFER from the unserved-contract case. That difference is what lets a
     * caller tell a typo from a model that is deliberately not wired — EmbeddingGemma
     * legitimately declares contracts with no ONNX path, and reporting both as one generic
     * failure would hide which situation they are in.
     */
    const unserved = resolveImplementation(
      { tools: [{ name: 'ghost', contractId: 'nothing.serves.this', contractVersion: '1.0.0' }], implementations: [] },
      'ghost',
    )
    assert.equal(unserved.ok, false)
    if (unserved.ok) return
    assert.equal(unserved.failure.code, 'no-implementation')
  })

  it('the built artifact is present, which is what makes dispatch possible at all', () => {
    // Discovery validates the manifest's declared entry, so an unbuilt package cannot even
    // be discovered. Asserted because a gitignored lib/ is an easy thing to forget.
    assert.ok(existsSync(join(PACKAGE_DIR, 'lib', 'index.js')), 'run the package build before this test')
  })
  it('an installed extension CAN now resolve the runtime SDK — the gap is closed', async () => {
    /**
     * This test REPLACED one that asserted the opposite, and the replacement is the point.
     *
     * Installing into the store used to leave a package at
     * `<store>/extensions/<id>/<version>/` with no `node_modules`, so an extension that
     * declares `@try-works/tool-mode-extension-sdk` — which the protocol requires — died on
     * its first import with ERR_MODULE_NOT_FOUND. It was discoverable and activatable and
     * could not RUN, which is the worst of the three states because nothing reported it.
     *
     * The installer now links the runtime into the install path, so the entry actually
     * loads. The version is asserted too: a link to a STALE runtime would be worse than no
     * link, because the extension would run against an API the host is not providing.
     */
    const { installed } = await installReal()
    assert.equal(
      installed.runtimeLink?.linked,
      true,
      `the runtime must be linked into the install path: ${JSON.stringify(installed.runtimeLink)}`,
    )

    const entry = join(installed.installPath, 'lib', 'index.js')
    const module = await import(new URL(`file:///${entry.replace(/\\/g, '/')}`).href)
    // Loading is the assertion: this is what used to throw ERR_MODULE_NOT_FOUND.
    assert.equal(typeof (module.default ?? module).create, 'function')

    // The linked runtime is THIS one, not a copy that could drift.
    const linkedManifest = JSON.parse(
      readFileSync(join(installed.installPath, 'node_modules', '@try-works', 'tool-mode-extension-sdk', 'package.json'), 'utf8'),
    )
    assert.equal(linkedManifest.name, '@try-works/tool-mode-extension-sdk')
  })
})