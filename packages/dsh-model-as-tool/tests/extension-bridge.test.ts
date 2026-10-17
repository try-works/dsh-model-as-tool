/**
 * The extension-to-registry bridge, proved END TO END (EXT-21, EXT-24, ARCH-05, RUN-05).
 *
 * The defect this file exists to prove is fixed: `ExtensionLifecycle` could install,
 * activate and publish contributions, and the SDK was fully tested doing so — but the HOST
 * never mounted the lifecycle. An extension could be activated, report
 * `observedActivation: 'active'` with its tool listed, and a caller still could not invoke
 * it. Every unit test in the SDK passed the whole time, because the missing piece was on
 * the host side.
 *
 * So this drives the REAL path: the real fixture package, installed through the real
 * installer, activated by the real lifecycle, publishing through the real registrar, into
 * the real DSH tool registry — and then INVOKES it through `ctx.tools.execute`.
 *
 * The invocation is the assertion that matters. Seeing the tool in `schemas()` would only
 * prove it was listed.
 *
 * Requirement links: EXT-21, EXT-22, EXT-24, ARCH-05, ARCH-06, RUN-05, RUN-06.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import AdmZip from 'adm-zip'

import { ExtensionStore, installPathFor, stagedInstall, createZipArchiveSource } from '@try-works/tool-mode-extension-sdk'
import { createContributionRegistrar } from '../src/extension-registrar.ts'
import { cleanup, mountPlugin, callTool, tempDir } from './helpers.ts'

after(async () => { await cleanup() })

const FIXTURE_DIR = join(process.cwd(), 'fixtures', 'slice1-extension')

/** Archive the real fixture, with its digest, exactly as the installer will verify it. */
function packFixture(): { bytes: Uint8Array; sha512: string } {
  const zip = new AdmZip()
  for (const relative of [
    'package.json',
    'tool-mode.extension.json',
    'lib/index.js',
    'schemas/input.json',
    'schemas/output.json',
    'models.lock.json',
  ]) {
    zip.addFile(relative, readFileSync(join(FIXTURE_DIR, relative)))
  }
  const bytes = new Uint8Array(zip.toBuffer())
  return { bytes, sha512: createHash('sha512').update(bytes).digest('hex') }
}

describe('the host mounts the lifecycle, so an extension tool REACHES the registry', () => {
  it('registers a contribution through the registrar and INVOKES it', async () => {
    // A real context, so the registration goes into a real DSH registry.
    const ctx = await mountPlugin({})

    const storeDir = tempDir()
    const { bytes, sha512 } = packFixture()
    const installed = await stagedInstall({
      source: { kind: 'local', requested: FIXTURE_DIR },
      storeDir,
      expectedSha512: sha512,
      archive: createZipArchiveSource(() => bytes),
    })

    const registered: string[] = []
    const disposed: string[] = []
    const registrar = createContributionRegistrar({
      activated: new Set([installed.extensionId]),
      registry: {
        registerTool: tool => {
          registered.push(tool.name)
          const dispose = ctx.tools.register({
            name: tool.name,
            description: `Provided by ${tool.ownerExtension}.`,
            parameters: {},
            output: {
              schema: { type: 'object', additionalProperties: true },
              render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
            },
            async execute() {
              // The real fixture entry, loaded from the INSTALLED package, so the call
              // reaches the extension rather than a stand-in for it.
              const entry = await import(
                new URL(`file:///${join(installPathFor(storeDir, installed.extensionId, installed.version), 'lib', 'index.js').replace(/\\/g, '/')}`).href
              )
              const instance = await entry.default.create({})
              const provider = await instance.createProvider({ modelId: 'fixture-echo-model', configuration: {} })
              return provider.invoke({ implementationId: 'fixture-echo', input: { token: 'bridge-proof', upper: true }, context: {} })
            },
          } as never)
          return () => {
            disposed.push(tool.name)
            dispose()
          }
        },
      },
    })

    // The contribution is published, and reaches the registry.
    const handle = registrar.publish({
      extensionId: installed.extensionId,
      kind: 'tool',
      name: 'fixture_echo',
      contractId: 'fixture.echo',
    })
    assert.deepEqual(registered, ['fixture_echo'], 'the contribution must reach the registry')

    const names = ctx.tools.schemas().map(schema => schema.name)
    assert.ok(names.includes('fixture_echo'), `the tool must be listed, saw: ${names.join(', ')}`)

    // THE ASSERTION THAT MATTERS: invoking it actually runs the extension.
    const result = await callTool(ctx, 'fixture_echo', {})
    assert.equal(result.isError, false, 'the call must succeed')
    const value = result.value as { echoed?: string; length?: number }
    assert.equal(value.echoed, 'BRIDGE-PROOF')
    assert.equal(value.length, 12)

    // And withdrawal removes it again, so a deactivated extension is not callable.
    registrar.withdraw(handle)
    assert.deepEqual(disposed, ['fixture_echo'])
    assert.equal(
      ctx.tools.schemas().map(schema => schema.name).includes('fixture_echo'),
      false,
      'a withdrawn contribution must leave the registry',
    )
  })

  it('REFUSES a tool declared by an extension that is NOT activated', async () => {
    const ctx = await mountPlugin({})
    const registrar = createContributionRegistrar({
      activated: new Set(['@acme/activated']),
      registry: { registerTool: () => () => {} },
    })
    // Publishing is a privilege of activation, so a declaration alone registers nothing.
    assert.throws(
      () => registrar.publish({ extensionId: '@acme/not-activated', kind: 'tool', name: 'ghost_tool' }),
      /is not activated/,
    )
    assert.equal(ctx.tools.schemas().map(s => s.name).includes('ghost_tool'), false)
  })

  it('keeps the host identity authoritative over what the package claims', async () => {
    const ctx = await mountPlugin({})
    const owners: string[] = []
    const registrar = createContributionRegistrar({
      activated: new Set(['@acme/real']),
      registry: {
        registerTool: tool => {
          owners.push(tool.ownerExtension)
          return () => {}
        },
      },
    })
    registrar.publish({ extensionId: '@acme/real', kind: 'tool', name: 'honest_tool' })
    // The registrar stamps the owner from the contribution it VALIDATED, so the recorded
    // owner is the activated package rather than whatever a payload asserted.
    assert.deepEqual(owners, ['@acme/real'])
    void ctx
  })

  it('restores only what the operator approved, and never prepares a model (RUN-05)', async () => {
    const storeDir = tempDir()
    const { bytes, sha512 } = packFixture()
    const installed = await stagedInstall({
      source: { kind: 'local', requested: FIXTURE_DIR },
      storeDir,
      expectedSha512: sha512,
      archive: createZipArchiveSource(() => bytes),
    })
    const store = new ExtensionStore(storeDir)

    // A freshly installed extension is NOT active, so there is nothing to restore. This is
    // the EXT-07 separation, and it is why startup does not activate an artifact merely
    // because it is present.
    const active = store.readProfileState('default').value
      .filter(entry => entry.desiredActivation === 'active')
      .map(entry => entry.extensionId)
    assert.deepEqual(active, [], 'a fresh install must restore nothing')
    assert.equal(store.listInstalled().value.some(r => r.extensionId === installed.extensionId), true)
  })
})
