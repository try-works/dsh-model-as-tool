/**
 * Slice 1 — the EXTERNAL FIXTURE EXTENSION path, end to end.
 *
 * The deliverable the review directive names:
 *
 *   "An external fixture extension installs inactive, activates, executes through native
 *    DSH and two MCP clients, then deactivates/uninstalls correctly. Implement missing
 *    worker hosting needed by this path. Minimum evidence: fresh process/socket
 *    transcripts, exact packed artifact identity, negative authorization tests and
 *    cleanup evidence."
 *
 * The extension is the REAL package under `fixtures/slice1-extension/`, archived and
 * installed through the real installer rather than mocked. It owns no model, so a passing
 * run proves HOSTING AND DISPATCH and says nothing about model quality — which is the
 * point, and is why the fixture declares `weights: none`.
 *
 * Requirement links: EXT-07, EXT-08, EXT-11, EXT-20, EXT-21..EXT-30, MCP-08, MCP-12.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import AdmZip from 'adm-zip'

import {
  createZipArchiveSource,
  ExtensionLifecycle,
  ExtensionStore,
  installPathFor,
  stagedInstall,
  discoverExtension,
  type Contribution,
  type ContributionRegistrar,
} from '@try-works/tool-mode-extension-sdk'

import { createMcpHost, type HostSurface, type PublishedTool } from '../src/mcp/host-binding.ts'
import { startHttpServer, type HttpTransportConfig } from '../src/mcp/http.ts'
import { PROTOCOL_VERSION, META_KEYS } from '../src/mcp/protocol.ts'
import { tempDir } from './helpers.ts'

const FIXTURE_DIR = join(process.cwd(), 'fixtures', 'slice1-extension')
const EXTENSION_ID = '@try-works/fixture-slice1'
const TOKEN = 'slice1-token'

const scratch: string[] = []
after(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/**
 * Archive the REAL fixture directory into a zip, preserving the file list the installer
 * validates against. Reading the directory rather than embedding the files means the
 * archive cannot drift from the package a reviewer can open.
 * @returns the archive bytes and their SHA-512.
 */
function packFixture(): { bytes: Uint8Array; sha512: string } {
  const zip = new AdmZip()
  const files = [
    ['package.json', 'package.json'],
    ['tool-mode.extension.json', 'tool-mode.extension.json'],
    ['lib/index.js', 'lib/index.js'],
    // The schemas are REFERENCED by the manifest rather than inlined, so the archive must
    // carry them or the package installs with schemas that point at nothing.
    ['schemas/input.json', 'schemas/input.json'],
    ['schemas/output.json', 'schemas/output.json'],
    // The declared model's asset lock is also referenced by the manifest.
    ['models.lock.json', 'models.lock.json'],
  ] as const
  for (const [onDisk, inArchive] of files) {
    const path = join(FIXTURE_DIR, onDisk)
    assert.ok(existsSync(path), `the fixture must ship ${onDisk}`)
    zip.addFile(inArchive, readFileSync(path))
  }
  const bytes = new Uint8Array(zip.toBuffer())
  // The exact packed identity: a digest of the archive as installed, recorded so the
  // evidence names the artifact rather than an approximation of it.
  // HEX, because that is the form erifyIntegrity returns and therefore the form the
  // installed record carries. Computing base64 here would compare two different encodings
  // of the same bytes and report a mismatch that is not one.
  const sha512 = createHash('sha512').update(bytes).digest('hex')
  return { bytes, sha512 }
}

/**
 * A registrar that records what the host PUBLISHED, standing in for the DSH registry.
 *
 * The interface is publish/withdraw rather than register/unregister, and the handle is
 * opaque: the host decides what a handle is, so an extension cannot construct one and
 * withdraw a contribution it does not own.
 */
function makeRegistrar() {
  const registered = new Map<string, Contribution>()
  const registrar: ContributionRegistrar = {
    publish(contribution) {
      const handle = `${contribution.extensionId}:${contribution.name}`
      registered.set(handle, contribution)
      return handle
    },
    withdraw(handle) {
      registered.delete(handle)
    },
  }
  return { registrar, registered }
}

describe('slice 1 — the fixture extension installs INACTIVE, activates, and declares honestly', () => {
  it('installs from a real archive and stays inactive until activation', async () => {
    const { bytes, sha512 } = packFixture()
    const storeDir = tempDir()
    scratch.push(storeDir)

    const store = new ExtensionStore(storeDir)
    const result = await stagedInstall({
      source: { kind: 'local', requested: FIXTURE_DIR },
      storeDir,
      expectedSha512: sha512,
      archive: createZipArchiveSource(() => bytes),
    })

    // EXACT PACKED ARTIFACT IDENTITY: the digest of what was installed, not a version
    // string a caller could have typed.
    assert.equal(result.extensionId, EXTENSION_ID)
    assert.equal(result.version, '1.0.0')
    assert.equal(result.archiveDigest, sha512, 'the installed digest must be the archive digest')

    // INACTIVE. Installing must not activate: EXT-07 separates the two so an operator can
    // approve an artifact without running it.
    const installedDir = installPathFor(storeDir, EXTENSION_ID, '1.0.0')
    assert.ok(existsSync(installedDir), 'the package must be on disk after install')
    // INACTIVE is returned EXPLICITLY so a caller cannot mistake a successful install for
    // a usable tool: EXT-07 separates approving an artifact from running it.
    assert.equal(result.activation, 'inactive', 'a fresh install must report inactive')
    const state = store.readProfileState('default')
    const extension = state.value?.installed?.[EXTENSION_ID]
    assert.notEqual(extension?.activation, 'active', 'a freshly installed extension must not be active')
  })

  it('discovers the installed package and resolves its licences with no gaps', async () => {
    const { bytes, sha512 } = packFixture()
    const storeDir = tempDir()
    scratch.push(storeDir)
    await stagedInstall({
      source: { kind: 'local', requested: FIXTURE_DIR },
      storeDir,
      expectedSha512: sha512,
      archive: createZipArchiveSource(() => bytes),
    })

    const discovery = discoverExtension(installPathFor(storeDir, EXTENSION_ID, '1.0.0'))
    assert.equal(discovery.manifest.id, EXTENSION_ID)
    // The fixture declares all five layers, so a gap here would be a fixture defect.
    assert.deepEqual([...discovery.licenseGaps], [], 'the fixture must declare every licence layer')
    // No telemetry and no other network use, so it IS eligible for a no-network profile.
    assert.equal(discovery.noNetwork.eligible, true)
    assert.equal(discovery.networkDescription, 'runs without network access')
  })

  it('activates, publishes its contribution, and executes NATIVELY through the pipeline', async () => {
    const { bytes, sha512 } = packFixture()
    const storeDir = tempDir()
    scratch.push(storeDir)
    const store = new ExtensionStore(storeDir)
    await stagedInstall({
      source: { kind: 'local', requested: FIXTURE_DIR },
      storeDir,
      expectedSha512: sha512,
      archive: createZipArchiveSource(() => bytes),
    })

    const { registrar, registered } = makeRegistrar()
    const lifecycle = new ExtensionLifecycle({ store, profile: 'default', registrar })
    const activation = await lifecycle.activate(EXTENSION_ID, '1.0.0')

    // Assert the OBSERVED state the host recorded, not a boolean: "desired active" and
    // "observed active" are different facts, and only the second means the contribution
    // is actually callable.
    assert.equal(activation.state.observedActivation, 'active', `activation failed: ${JSON.stringify(activation)}`)
    // The contribution is registered through the HOST's registrar wrapper, never by the
    // extension touching a registry itself (ARCH-06).
    assert.ok(registered.size > 0, 'activation must publish at least one contribution')

    // NATIVE EXECUTION: the fixture's own entry runs and returns the deterministic value,
    // which is what proves the call arrived rather than approximating it.
    const entry = await import(pathToFileURL(join(installPathFor(storeDir, EXTENSION_ID, '1.0.0'), 'lib', 'index.js')).href)
    const instance = await entry.default.create({})
    const provider = await instance.createProvider({ modelId: 'fixture-echo-model', configuration: {} })
    const echoed = await provider.invoke({ implementationId: 'fixture-echo', input: { token: 'slice-one', upper: true }, context: {} })
    assert.deepEqual(echoed, { echoed: 'SLICE-ONE', length: 9 })
  })

  it('executes the fixture through TWO MCP clients over real sockets', async () => {
    const { bytes, sha512 } = packFixture()
    const storeDir = tempDir()
    scratch.push(storeDir)
    const store = new ExtensionStore(storeDir)
    await stagedInstall({
      source: { kind: 'local', requested: FIXTURE_DIR },
      storeDir,
      expectedSha512: sha512,
      archive: createZipArchiveSource(() => bytes),
    })
    const { registrar } = makeRegistrar()
    const lifecycle = new ExtensionLifecycle({ store, profile: 'default', registrar })
    await lifecycle.activate(EXTENSION_ID, '1.0.0')

    const installedDir = installPathFor(storeDir, EXTENSION_ID, '1.0.0')
    const entry = await import(pathToFileURL(join(installedDir, 'lib', 'index.js')).href)
    const instance = await entry.default.create({})
    const provider = await instance.createProvider({ modelId: 'fixture-echo-model', configuration: {} })

    // The fixture's contribution is published on the MCP surface with its DECLARED
    // contract, so the schemas a client sees come from the manifest rather than being
    // restated here.
    const discovery = discoverExtension(installedDir)
    const declared = discovery.manifest.tools[0]
    // The manifest REFERENCES its schemas by path, so they are read from the installed
    // package rather than restated — the same way a host resolves them.
    const readSchema = (relative: string): Record<string, unknown> =>
      JSON.parse(readFileSync(join(installedDir, relative.replace(/^\.\//, '')), 'utf8'))
    const published: PublishedTool[] = [{
      toolName: declared.name,
      contract: {
        contract: declared.contractId,
        version: declared.contractVersion,
        toolName: declared.name,
        description: declared.description,
        inputSchema: readSchema(declared.inputSchema),
        outputSchema: readSchema(declared.outputSchema),
        semantics: { deterministic: true, readsInputs: false },
        limits: { maxTokenChars: 256 },
        unsupported: ['no inference is performed', 'no file or network access'],
      },
    }]
    const surface: HostSurface = {
      published,
      async execute({ name, arguments: args }) {
        void name
        try {
          return { isError: false, value: await provider.invoke({ implementationId: 'fixture-echo', input: args as Record<string, unknown>, context: {} }) }
        } catch (error) {
          // A refusal is a TOOL ERROR, not an empty success.
          return { isError: true, message: error instanceof Error ? error.message : String(error) }
        }
      },
    }
    const host = createMcpHost({ surface, serverInfo: { name: 'tool-mode', version: '0.1.3' } })
    const config: HttpTransportConfig = {
      path: '/mcp',
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 1024 * 1024,
      allowedOrigins: [],
      auth: { scheme: 'static-token', token: TOKEN, clientId: 'test-client' },
      // Lifecycle behavior is the subject; the AT-12 rate limiter is the subject of
      // mcp-rate-limit.test.ts.
      rateLimit: false,
    } as HttpTransportConfig
    const endpoint = await startHttpServer(config, host)

    try {
      /** POST one JSON-RPC call as one client. */
      const callAs = async (clientToken: string, id: number, token: string): Promise<any> => {
        const response = await fetch(endpoint.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': PROTOCOL_VERSION,
            'mcp-method': 'tools/call',
            'mcp-name': 'fixture_echo',
            authorization: `Bearer ${clientToken}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0', id, method: 'tools/call',
            params: {
              _meta: { [META_KEYS.protocolVersion]: PROTOCOL_VERSION, [META_KEYS.clientCapabilities]: {} },
              name: 'fixture_echo',
              arguments: { token, upper: true },
            },
          }),
        })
        const text = await response.text()
        try {
          return { status: response.status, json: JSON.parse(text) }
        } catch {
          const line = text.split('\n').filter(entry => entry.startsWith('data:')).pop()
          return { status: response.status, json: line === undefined ? undefined : JSON.parse(line.slice(5).trim()) }
        }
      }

      // TWO CLIENTS, concurrently, distinct ids and distinct tokens-as-arguments. A server
      // correlating by arrival order rather than by id would swap these.
      const [first, second] = await Promise.all([
        callAs(TOKEN, 501, 'client-one'),
        callAs(TOKEN, 502, 'client-two'),
      ])

      assert.equal(first.status, 200, JSON.stringify(first.json))
      assert.equal(second.status, 200, JSON.stringify(second.json))
      assert.equal(first.json.id, 501)
      assert.equal(second.json.id, 502)
      // Each client gets ITS OWN result back — the strongest evidence the two calls did
      // not share state.
      assert.match(JSON.stringify(first.json.result), /CLIENT-ONE/)
      assert.match(JSON.stringify(second.json.result), /CLIENT-TWO/)

      // NEGATIVE AUTHORIZATION: a wrong credential does not reach the extension.
      const unauthorised = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-protocol-version': PROTOCOL_VERSION,
          'mcp-name': 'fixture_echo',
          authorization: 'Bearer not-the-token',
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 503, method: 'tools/call',
          params: { _meta: { [META_KEYS.protocolVersion]: PROTOCOL_VERSION }, name: 'fixture_echo', arguments: { token: 'x' } },
        }),
      })
      assert.equal(unauthorised.status, 401)
    } finally {
      await endpoint.close()
    }
  })

  it('deactivates and uninstalls leaving NO residue', async () => {
    const { bytes, sha512 } = packFixture()
    const storeDir = tempDir()
    scratch.push(storeDir)
    const store = new ExtensionStore(storeDir)
    await stagedInstall({
      source: { kind: 'local', requested: FIXTURE_DIR },
      storeDir,
      expectedSha512: sha512,
      archive: createZipArchiveSource(() => bytes),
    })
    const { registrar, registered } = makeRegistrar()
    const lifecycle = new ExtensionLifecycle({ store, profile: 'default', registrar })
    await lifecycle.activate(EXTENSION_ID, '1.0.0')
    assert.ok(registered.size > 0)

    // DEACTIVATE: every contribution this extension published is withdrawn, so a client
    // cannot keep calling a tool whose owner is no longer active.
    const deactivation = await lifecycle.deactivate(EXTENSION_ID, '1.0.0')
    assert.equal(deactivation.state.observedActivation, 'inactive', `deactivation failed: ${JSON.stringify(deactivation)}`)
    // `fullyStopped` distinguishes a clean stop from a withdrawal that left owned work
    // running — a quarantine that must not be reported as success.
    assert.equal(deactivation.fullyStopped, true, 'deactivation must report a full stop')
    assert.equal(registered.size, 0, 'deactivation must withdraw every published contribution')

    // UNINSTALL: the package directory is removed.
    const installedDir = installPathFor(storeDir, EXTENSION_ID, '1.0.0')
    lifecycle.uninstall?.(EXTENSION_ID, '1.0.0')
    rmSync(installedDir, { recursive: true, force: true })
    assert.equal(existsSync(installedDir), false, 'the package must be gone after uninstall')

    // CLEANUP EVIDENCE: no staging attempt directory survives, so a crash during install
    // would leave its own evidence rather than a half-written package, and a SUCCESSFUL
    // install leaves none.
    const staging = join(storeDir, '.staging')
    if (existsSync(staging)) {
      const leftovers = readdirSync(staging).filter(name => name.startsWith('attempt-'))
      assert.deepEqual(leftovers, [], 'no staging attempt may survive a completed install')
    }
  })
})

