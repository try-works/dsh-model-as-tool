/**
 * Licensing tests for the SHIPPED extension packages (LIC-01, LIC-02, LIC-04).
 *
 * The licensing rules were correct but unexercised until a real manifest carried them.
 * These run against the two packages this repository actually ships, resolved through
 * the same `discoverExtension` a host uses, so the assertions are about what a consumer
 * receives rather than about a fixture built to satisfy them.
 *
 * Requirement links: LIC-01, LIC-02, LIC-04.
 */

import { after, describe, it } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import { discoverExtension } from '../src/discovery.ts'
import { LICENSE_LAYERS } from '../src/licensing.ts'

const dirs: string[] = []
after(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** The installed location of a package, resolved as a host would resolve it. */
function packageDir(name: string): string {
  const url = import.meta.resolve(`${name}/package.json`)
  return new URL('.', url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
}

const PACKAGES = [
  ['@try-works/extension-desert-ant-tongue', 'lang_detect'],
  ['@try-works/extension-desert-ant-voz', 'stt_transcribe'],
] as const

describe('LIC-01 — a SHIPPED package declares every licence layer', () => {
  for (const [name] of PACKAGES) {
    it(`${name} declares all five layers with no gaps`, () => {
      const discovery = discoverExtension(packageDir(name))
      // A gap is reported rather than defaulted, and a shipped package must have none.
      assert.deepEqual([...discovery.licenseGaps], [], `undeclared layers in ${name}`)
      assert.equal(discovery.licenses.layers.length, LICENSE_LAYERS.length)
    })

    it(`${name} records the weights as NOT redistributable`, () => {
      const discovery = discoverExtension(packageDir(name))
      const weights = discovery.licenses.layers.find(layer => layer.layer === 'weights')
      assert.ok(weights, 'the weights layer must be declared')
      // Packaging a model is not a redistribution grant.
      assert.equal(weights.redistribution, 'not-permitted')
      assert.equal(weights.openSource, false)
    })

    it(`${name} preserves the required attribution notice`, () => {
      const discovery = discoverExtension(packageDir(name))
      assert.ok(
        discovery.licenses.notices.includes('Powered by Desert Ant Labs'),
        'the vendor attribution notice must be collected',
      )
    })

    it(`${name} keeps the licence obligations readable`, () => {
      const discovery = discoverExtension(packageDir(name))
      const weights = discovery.licenses.layers.find(layer => layer.layer === 'weights')
      const obligations = (weights?.obligations ?? []).join(' | ')
      // Each of these constrains what this plugin may do, so each is asserted rather
      // than left to the licence text a deployer may never read.
      assert.match(obligations, /per-platform, per-model active-device threshold/i)
      assert.match(obligations, /do not redistribute the model, SDK or a hosted service/i)
      assert.match(obligations, /train a competing on-device model/i)
    })
  }
})

describe('LIC-02 — the vendor terms are recorded as source-available', () => {
  it('marks neither the weights nor the SDK as open source', () => {
    for (const [name] of PACKAGES) {
      const discovery = discoverExtension(packageDir(name))
      for (const layer of ['weights', 'sdk'] as const) {
        const entry = discovery.licenses.layers.find(candidate => candidate.layer === layer)
        // "Source-available, not open source" is the distinction most likely to be
        // lost by treating a licence file's presence as open-source status.
        assert.equal(entry?.openSource, false, `${name} ${layer} must not be marked open source`)
      }
    }
  })

  it('names the licence so a reviewer can read the terms', () => {
    for (const [name] of PACKAGES) {
      const weights = discoverExtension(packageDir(name)).licenses.layers.find(l => l.layer === 'weights')
      assert.match(String(weights?.name), /Source-Available/)
      assert.match(String(weights?.url), /^https:\/\//)
    }
  })
})

describe('LIC-04 — a shipped package declares its network behaviour', () => {
  for (const [name, tool] of PACKAGES) {
    it(`${name} declares telemetry rather than staying silent`, () => {
      const discovery = discoverExtension(packageDir(name))
      // Silence about telemetry cannot be read as an absence of telemetry, so the
      // declaration is present and explicit.
      assert.equal(discovery.manifest.network?.requiredTelemetry, true)
      void tool
    })

    it(`${name} is therefore INELIGIBLE for a strict no-network deployment`, () => {
      const discovery = discoverExtension(packageDir(name))
      assert.equal(discovery.noNetwork.eligible, false)
      // And the refusal offers a qualified alternative rather than being bare.
      assert.ok(discovery.noNetwork.alternative)
    })

    it(`${name} is never described as network-free`, () => {
      const discovery = discoverExtension(packageDir(name))
      assert.equal(discovery.networkDescription.includes('runs without network access'), false)
      // Naming what the telemetry carries is what makes the description accurate.
      assert.match(discovery.networkDescription, /monthly active-device count/)
    })
  }

  it('a package that declares NOTHING is treated as telemetry-bearing', () => {
    /**
     * The conservative default, tested against a synthetic package because no SHIPPED
     * package is silent — which is the point. A package with no `network` field must not
     * be read as network-free, and a package with no `licenses` field must report every
     * layer as a gap.
     */
    const dir = mkdtempSync(join(tmpdir(), 'tmx-silent-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: '@acme/silent',
      version: '1.0.0',
      type: 'module',
      exports: { './tool-mode': './index.js' },
      toolMode: { manifest: './tool-mode.extension.json' },
    }))
    writeFileSync(join(dir, 'tool-mode.extension.json'), JSON.stringify({
      protocolVersion: '1.1.0',
      id: '@acme/silent',
      version: '1.0.0',
      displayName: 'Silent',
      description: 'A package that declares neither licences nor network behaviour.',
      activation: { policy: 'operator' },
      runtimeApi: 1,
      compatibility: { hostApi: '^1.1.0', requiredFeatures: [] },
      execution: { kind: 'module' },
      permissions: { networkOrigins: [], inputFiles: false, storage: 'none', secrets: [], nativeCode: false },
      models: [], tools: [], implementations: [], skills: [],
    }))
    writeFileSync(join(dir, 'index.js'), 'export default {}')

    const silent = discoverExtension(dir)
    // Every layer is a gap, because silence is not a declaration.
    assert.deepEqual([...silent.licenseGaps], [...LICENSE_LAYERS])
    // And silence about telemetry is read as telemetry-bearing, not as network-free.
    assert.equal(silent.noNetwork.eligible, false)
    assert.equal(silent.networkDescription.includes('runs without network access'), false)
  })
})
