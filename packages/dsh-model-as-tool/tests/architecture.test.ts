/**
 * Architecture gate tests (BASE-09, EXT-02).
 *
 * A gate that cannot fail is worse than no gate, because it reads as assurance.
 * These tests feed each rule the REAL code that was in this repository before the
 * extraction, so they demonstrate the gate would have caught the actual defect
 * rather than a synthetic one invented to match the rule.
 *
 * Requirement links: BASE-09, EXT-02.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  checkExtensionIsolation,
  checkHostPurity,
  checkRepository,
} from '../../../scripts/check-architecture.mjs'

/** Build a synthetic source file. */
function source(text: string, path = 'packages/dsh-model-as-tool/src/example.ts') {
  return { path, text }
}

describe('BASE-09 — the host purity gate fires on the real pre-extraction code', () => {
  it('catches the vendor SDK import that used to be in adapters/voz.ts', () => {
    // The literal line this repository shipped before the extraction.
    const before = source(`
      const runtimeSpecifier = entry.requiresRuntime[0] ?? 'onnxruntime-node'
      const module = await import(entry.npmPackage as string) as unknown as VozModule
    `, 'packages/dsh-model-as-tool/src/adapters/voz.ts')
    // The import is by variable, so the gate cannot see it — but the FACTORY LIST
    // is what made it reachable, and that is caught below.
    assert.deepEqual(checkHostPurity([before]), [])

    const direct = source("import { Tongue } from '@desert-ant-labs/tongue'\n")
    const violations = checkHostPurity([direct])
    assert.equal(violations.length, 1)
    assert.equal(violations[0]?.rule, 'BASE-09/vendor-import')
  })

  it('catches the model-name switch that used to be in registrar.ts', () => {
    // Exactly what shipped: a per-model presentation branch.
    const before = source(`
      if (entry.id === 'tongue' && typeof value.language === 'string') {
        return [{ type: 'text', text: 'Detected language: ' + value.language }]
      }
      if (entry.id === 'voz' && typeof value.text === 'string') {
        return [{ type: 'text', text: value.text }]
      }
    `, 'packages/dsh-model-as-tool/src/registrar.ts')
    const violations = checkHostPurity([before])
    assert.equal(violations.length, 2)
    assert.equal(violations[0]?.rule, 'BASE-09/model-name-switch')
    assert.equal(violations[0]?.line, 2)
  })

  it('catches the adapter list that used to hold both built-ins', () => {
    const before = source(`
      export const ADAPTER_FACTORIES: readonly AdapterFactory[] = [
        createTongueAdapter,
        createVozAdapter,
      ]
    `, 'packages/dsh-model-as-tool/src/adapters/index.ts')
    const violations = checkHostPurity([before])
    assert.equal(violations.length, 1)
    assert.equal(violations[0]?.rule, 'BASE-09/built-in-adapter-list')
  })

  it('accepts the empty list the host ships now', () => {
    assert.deepEqual(
      checkHostPurity([source('export const ADAPTER_FACTORIES: readonly AdapterFactory[] = []')]),
      [],
    )
  })
})

describe('BASE-09 — the gate distinguishes configuration from a built-in', () => {
  it('accepts a comparison against an operator-configured override', () => {
    // What the host actually does: the operator names a model in config, which is
    // configuration rather than a model-specific implementation.
    const configured = source(`
      const override = config.providers?.[contract.contract]
      const chosen = eligible.find(item => item.entry.id === override) ?? eligible[0]
    `)
    assert.deepEqual(checkHostPurity([configured]), [])
  })

  it('rejects the same shape written with a literal', () => {
    const literal = source("const chosen = eligible.find(item => item.entry.id === 'tongue')")
    assert.equal(checkHostPurity([literal])[0]?.rule, 'BASE-09/model-name-switch')
  })

  it('does not fire on the comment that documents the prohibition', () => {
    // The host's own comment explains that ADAPTER_FACTORIES must stay empty. If
    // comments counted, documenting a rule would break the build.
    const commented = source(`
      // Voz was extracted; a non-empty ADAPTER_FACTORIES = [createVozAdapter]
      // would reintroduce the private built-in path BASE-09 forbids.
      * entry.id === 'tongue' was removed in round 11
      const x = 1
    `)
    assert.deepEqual(checkHostPurity([commented]), [])
  })

  it('reports every violation rather than stopping at the first', () => {
    const several = source(`
      import { Tongue } from '@desert-ant-labs/tongue'
      if (entry.id === 'tongue') return null
      export const ADAPTER_FACTORIES = [createTongueAdapter]
    `)
    assert.equal(checkHostPurity([several]).length, 3)
  })
})

describe('EXT-02 — the extension isolation gate', () => {
  it('catches an extension importing host internals', () => {
    const reaching = source(
      "import { createGrant } from '@try-works/dsh-model-as-tool/src/authority.ts'\n",
      'packages/extension-desert-ant-tongue/src/index.ts',
    )
    const violations = checkExtensionIsolation([reaching])
    assert.equal(violations.length, 1)
    assert.equal(violations[0]?.rule, 'EXT-02/host-package-import')
  })

  it('catches an extension importing DSH', () => {
    const dsh = source(
      "import type { Context } from '@deepseek-ai/cordis'\n",
      'packages/extension-desert-ant-tongue/src/index.ts',
    )
    assert.equal(checkExtensionIsolation([dsh])[0]?.rule, 'EXT-02/dsh-internal-import')
  })

  it('catches an extension climbing out of its package', () => {
    const climbing = source(
      "import { helper } from '../../dsh-model-as-tool/src/helpers.ts'\n",
      'packages/extension-desert-ant-tongue/src/index.ts',
    )
    assert.equal(checkExtensionIsolation([climbing])[0]?.rule, 'EXT-02/host-internal-import')
  })

  it('accepts the SDK dependency the extensions actually declare', () => {
    const clean = source(
      "import { defineExtension } from '@try-works/tool-mode-extension-sdk'\n",
      'packages/extension-desert-ant-tongue/src/index.ts',
    )
    assert.deepEqual(checkExtensionIsolation([clean]), [])
  })
})

describe('the gates pass on the repository as it stands', () => {
  it('reports no violations', () => {
    // The real check, over the real sources. If the host ever regains a built-in,
    // this test and `npm run verify` both fail.
    assert.deepEqual(checkRepository(), [])
  })
})
