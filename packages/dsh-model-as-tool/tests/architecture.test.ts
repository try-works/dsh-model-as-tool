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

import { after, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dirs: string[] = []
after(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
import assert from 'node:assert/strict'

import {
  checkExtensionIsolation,
  checkHostPurity,
  checkExtensionReleaseIndependence,
  checkHostPackageModelDependencySplit,
  checkNoHardcodedPrompt,
  checkRepository,
  checkSingleDispatchAuthority,
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

describe('AT-25 / BASE-09 — the host install stays model-runtime-free', () => {
  it('reports no violation for the host manifest as it stands', () => {
    assert.deepEqual(checkHostPackageModelDependencySplit(process.cwd()), [])
  })

  it('catches a host optional dependency on a first-party model runtime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arch-at25-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'packages', 'dsh-model-as-tool'), { recursive: true })
    writeFileSync(
      join(dir, 'packages', 'dsh-model-as-tool', 'package.json'),
      JSON.stringify({
        name: '@try-works/dsh-model-as-tool',
        version: '0.1.0',
        optionalDependencies: { '@desert-ant-labs/tongue': '^3.6.0' },
      }),
    )
    const violations = checkHostPackageModelDependencySplit(dir)
    assert.equal(violations[0]?.rule, 'AT-25/host-installs-model-runtime')
  })

  it('catches a host dependency on a native model engine', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arch-at25-engine-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'packages', 'dsh-model-as-tool'), { recursive: true })
    writeFileSync(
      join(dir, 'packages', 'dsh-model-as-tool', 'package.json'),
      JSON.stringify({
        name: '@try-works/dsh-model-as-tool',
        version: '0.1.0',
        dependencies: { 'onnxruntime-node': '^1.20.0' },
      }),
    )
    const violations = checkHostPackageModelDependencySplit(dir)
    assert.equal(violations[0]?.rule, 'AT-25/host-installs-model-runtime')
  })

  it('catches a stale lockfile entry for a model runtime even when the manifest is clean', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arch-at25-lock-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'packages', 'dsh-model-as-tool'), { recursive: true })
    writeFileSync(
      join(dir, 'packages', 'dsh-model-as-tool', 'package.json'),
      JSON.stringify({ name: '@try-works/dsh-model-as-tool', version: '0.1.0' }),
    )
    writeFileSync(
      join(dir, 'packages', 'dsh-model-as-tool', 'package-lock.json'),
      JSON.stringify({
        name: '@try-works/dsh-model-as-tool',
        lockfileVersion: 3,
        packages: {
          '': { name: '@try-works/dsh-model-as-tool', version: '0.1.0' },
          'node_modules/@desert-ant-labs/tongue': { version: '3.6.0', optional: true },
        },
      }),
    )
    const violations = checkHostPackageModelDependencySplit(dir)
    assert.equal(violations[0]?.rule, 'AT-25/host-lock-installs-model-runtime')
  })
})

describe('ARCH-01 / ARCH-05 — one dispatch authority', () => {
  it('catches a definition being executed directly', () => {
    // The shape the requirement names: running a tool without the registry pipeline.
    for (const call of [
      'const r = await definition.execute(args)',
      'const r = await tool.execute(args)',
      'const r = await resolved.execute(args)',
    ]) {
      const violations = checkSingleDispatchAuthority([source(call, 'packages/dsh-model-as-tool/src/mcp/server.ts')])
      assert.equal(violations[0]?.rule, 'ARCH-01/second-dispatch-path', `${call} must be flagged`)
    }
  })

  it('catches ctx.tools.get(), whose execute would bypass the pipeline', () => {
    const violations = checkSingleDispatchAuthority([
      source("const def = ctx.tools.get('lang_detect')", 'packages/dsh-model-as-tool/src/mcp/server.ts'),
    ])
    assert.equal(violations[0]?.rule, 'ARCH-01/registry-bypass')
  })

  it('ACCEPTS ctx.tools.execute, which IS the authority', () => {
    assert.deepEqual(checkSingleDispatchAuthority([
      source('const r = await ctx.tools.execute({ name, arguments: args })', 'packages/dsh-model-as-tool/src/mcp/server.ts'),
    ]), [])
  })

  it('ACCEPTS an INJECTED executor, which is dependency injection not a bypass', () => {
    // The MCP binding is handed the authority through `surface` rather than importing
    // it. Flagging this produced a false positive that would have taught a reader to
    // ignore the rule.
    assert.deepEqual(checkSingleDispatchAuthority([
      source('const outcome = await options.surface.execute({ name, arguments: args })', 'packages/dsh-model-as-tool/src/mcp/host-binding.ts'),
    ]), [])
  })
})

describe('ARCH-06 — no hardcoded model-specific prompt', () => {
  it('catches an instruction literal naming a model', () => {
    const violations = checkNoHardcodedPrompt(source(
      "const prompt = 'You are a transcription assistant. Transcribe the audio with Voz and return the text.'",
      'packages/dsh-model-as-tool/src/bindings.ts',
    ))
    assert.equal(violations[0]?.rule, 'ARCH-06/hardcoded-prompt')
  })

  it('ACCEPTS an error message that merely mentions a tool', () => {
    // Documentation is not a prompt, and flagging it made this rule report three things
    // that were not prompts.
    assert.deepEqual(checkNoHardcodedPrompt(source(
      "throw new Error('the transcription contract requires a non-empty audio path for the tool')",
      'packages/dsh-model-as-tool/src/bindings.ts',
    )), [])
  })

  it('ACCEPTS a parameter description naming example models', () => {
    assert.deepEqual(checkNoHardcodedPrompt(source(
      "description: 'Model id, required for describe and enable (for example \"tongue\" or \"title\").',",
      'packages/dsh-model-as-tool/src/index.ts',
    )), [])
  })

  it('ACCEPTS a warning template naming a transcript', () => {
    assert.deepEqual(checkNoHardcodedPrompt(source(
      "const partial = `\\n[warnings] partial transcript: ${covered}s covered\\n`",
      'packages/dsh-model-as-tool/src/bindings.ts',
    )), [])
  })
})
describe('ARCH-02 — installing an extension must not require releasing the host', () => {
  it('reports no violation for the packages as they stand', () => {
    // The property holds today: no extension depends on the host package, which is what
    // makes an extension installable without rebuilding it.
    assert.deepEqual(checkExtensionReleaseIndependence(process.cwd()), [])
  })

  it('catches an extension that declares the host as a dependency', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arch-arch02-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'packages', 'extension-desert-ant-tongue'), { recursive: true })
    writeFileSync(
      join(dir, 'packages', 'extension-desert-ant-tongue', 'package.json'),
      JSON.stringify({
        name: '@try-works/extension-desert-ant-tongue',
        version: '0.1.0',
        dependencies: { '@try-works/dsh-model-as-tool': '^0.1.0' },
      }),
    )
    const violations = checkExtensionReleaseIndependence(dir)
    // Declaring the host would couple the extension to a host release, making
    // "installing one extension must not require rebuilding the host" false.
    assert.equal(violations[0]?.rule, 'ARCH-02/extension-depends-on-host')
  })
})