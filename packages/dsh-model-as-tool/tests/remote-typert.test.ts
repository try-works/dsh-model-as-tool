/**
 * The `modelTools` Remote namespace: Host Loader artifact, Client artifact, and
 * the browser chunk must all be built from one contract and accepted by the
 * shipping harness validators.
 *
 * The mount test composes the REAL client halves — `@deepseek-ai/dsh-typert-registry`
 * (client face) and `@deepseek-ai/dsh-api-gateway` (client face) — with a fake
 * Connection carrier, mounts the contribution the browser chunk carries, and
 * drives `ctx.remote.modelTools`. That is the closest Node proof of the browser
 * path available without a running page.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader'
import { apply as applyTypertRegistry } from '@deepseek-ai/dsh-typert-registry/client'
import { apply as applyClientGateway } from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteResult } from '../src/extensions-api.ts'
import {
  bindModelToolsRemote,
  MODEL_TOOLS_NAMESPACE,
  MODEL_TOOLS_SERVICE,
  provideModelToolsService,
} from '../src/extensions-remote.ts'
import { TYPERT } from '../remote/typert.host.mjs'
import TYPERT_REMOTE, { TYPERT_REMOTE as NAMED_REMOTE } from '../remote/typert.remote-client.mjs'
import { METHOD_SPECS, PACKAGE } from '../remote/spec.mjs'
import { CHUNK_NAME, CHUNK_PATH, renderChunk } from '../scripts/gen-remote-artifacts.mjs'

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WIRE_ENDPOINTS = [
  'modelTools/describe',
  'modelTools/installExtension',
  'modelTools/enable',
  'modelTools/disable',
  'modelTools/prepare',
]

/** One extension row the host can report, with the preflight requirements model. */
const EXTENSION_ROW = {
  id: '@try-works/extension-laya',
  package: '@try-works/extension-laya',
  version: '1.2.3',
  installed: true,
  active: true,
  disabled: false,
  integrity: 'unchanged',
  tools: ['laya_detect'],
  reason: null,
  requirements: [
    { kind: 'store', satisfied: true, reason: 'the extension store is configured and readable', action: 'none' },
    { kind: 'dependencies', satisfied: true, reason: 'all declared runtime dependencies resolve', action: 'none' },
    { kind: 'assets', satisfied: true, reason: 'every deployment is prepared-cold', action: 'none' },
    { kind: 'activation', satisfied: true, reason: 'the extension is active', action: 'none' },
  ],
  blocked: false,
}

/** A source-only row: one unmet requirement does NOT block installing it. */
const SOURCE_ONLY_ROW = {
  id: '@try-works/extension-embeddinggemma',
  package: '@try-works/extension-embeddinggemma',
  version: '0.1.0',
  installed: false,
  active: false,
  disabled: false,
  integrity: 'unknown',
  tools: [],
  reason: null,
  requirements: [
    { kind: 'source', satisfied: true, reason: 'the first-party package is available', action: 'install' },
    { kind: 'assets', satisfied: false, reason: 'not installed; embeddinggemma-2 needs model assets prepared after installation', action: 'install' },
  ],
  blocked: false,
}

/** A row shaped like an older Host's describe(): no requirements, no blocked. */
const LEGACY_EXTENSION_ROW = {
  id: '@try-works/extension-needle',
  package: '@try-works/extension-needle',
  version: '0.1.0',
  installed: false,
  active: false,
  disabled: false,
  integrity: 'unknown',
  tools: ['tools_plan', 'structured_extract'],
  reason: 'not installed',
}

/** A blocked row: an unmet harness-model requirement prevents activation. */
const BLOCKED_ROW = {
  id: '@try-works/extension-declarative-recipes',
  package: '@try-works/extension-declarative-recipes',
  version: '0.1.0',
  installed: true,
  active: false,
  disabled: false,
  integrity: 'unchanged',
  tools: [],
  reason: 'the host could not report whether a harness model provider is available (provider status unknown)',
  requirements: [
    { kind: 'harness-model', satisfied: false, reason: 'the host could not report whether a harness model provider is available (provider status unknown); a declarative extension needs a composed provider, for example config.harnessModel', action: 'config' },
    { kind: 'assets', satisfied: false, reason: 'no model assets are prepared', action: 'prepare' },
  ],
  blocked: true,
}

/** A describe result carrying every wire field, valid and nullable. */
const DESCRIBE_VALUE = {
  store: '/tmp/extensions',
  writable: true,
  sourceDir: null,
  extensions: [EXTENSION_ROW],
}

/** A preparation result carrying the disclosure, readiness record and outcome. */
const PREPARE_VALUE = {
  id: '@try-works/extension-embeddinggemma',
  prepared: true,
  reason: null,
  plan: {
    modelId: 'embeddinggemma-2',
    modelRevision: '2026-06-01',
    assets: [
      { assetId: 'text-backbone/model.onnx', bytes: 1_172_750_848, source: 'https://example.invalid/model.onnx', executable: false },
    ],
    totalBytes: 1_172_750_848,
    storageBytes: 1_180_000_000,
    requiresExecutableApproval: false,
    license: { name: 'Gemma Terms', url: 'https://ai.google.dev/gemma/terms' },
  },
  readiness: { 'embeddinggemma-2': 'prepared-cold' },
  groups: ['text-backbone'],
  activationReady: true,
}

/** Compare descriptors by wire-visible data (codec parsers are per-artifact closures). */
function descriptorContract(contribution: { package: string; descriptors: readonly Record<string, unknown>[] }) {
  return {
    package: contribution.package,
    descriptors: contribution.descriptors.map(descriptor => ({
      id: descriptor.id,
      service: descriptor.service,
      namespace: descriptor.namespace,
      method: descriptor.method,
      implementation: descriptor.implementation,
      description: descriptor.description,
      invocation: descriptor.invocation,
      cancellation: descriptor.cancellation,
      parameters: (descriptor.parameters as readonly Record<string, unknown>[]).map(parameter => ({
        name: parameter.name,
        wire: parameter.wire,
        source: parameter.source,
        acceptsUndefined: parameter.acceptsUndefined,
        typeSymbol: (parameter.codec as { typeSymbol: string }).typeSymbol,
        strictTypeSymbol: (parameter.strictCodec as { typeSymbol: string }).typeSymbol,
        mode: (parameter.codec as { mode: string }).mode,
      })),
      result: {
        mode: (descriptor.result as { mode: string }).mode,
        typeSymbol: (descriptor.result as { typeSymbol: string }).typeSymbol,
        description: (descriptor.result as { description?: string }).description,
      },
    })),
  }
}

/** Resolve the codec a descriptor uses for one value. */
function descriptorCodec(contribution: typeof TYPERT_REMOTE, method: string) {
  const descriptor = contribution.descriptors.find(candidate => candidate.method === method)
  assert.ok(descriptor, `descriptor ${method} exists`)
  return descriptor
}

/** A client-side fake of the Connection carrier the Gateway needs to dispatch. */
function fakeConnection(calls: { endpoint: string; payload: unknown }[], reply: unknown, failure?: Error) {
  return {
    interactions: 'none' as const,
    isLoopback: true,
    rpc: {
      call: async (_route: string, endpoint: string, payload: unknown) => {
        calls.push({ endpoint, payload })
        if (failure !== undefined) throw failure
        return { ok: true, value: reply }
      },
    },
    generation: { getSnapshot: () => undefined },
    start: () => undefined,
    openWebSocket: () => ({
      addEventListener() {},
      removeEventListener() {},
      close() {},
      send() {},
      readyState: 0,
    }),
  }
}

/** Compose the shipping client registry + gateway with a fake carrier. */
async function mountInFakePage(
  calls: { endpoint: string; payload: unknown }[],
  reply: unknown,
  failure?: Error,
) {
  // SAFETY: the shipping client gateway registers `remote` on Context; this test narrows the same service it mounts.
  const ctx = new Context() as unknown as Context & { remote: Record<string, Function> }
  await ctx.plugin({ name: 'client-typert-registry', inject: [], apply: applyTypertRegistry })
  ctx.provide('connection', fakeConnection(calls, reply, failure))
  await ctx.plugin({ name: 'client-api-gateway', inject: ['typert', 'connection'], apply: applyClientGateway })
  const dispose = await ctx.remote.$mount(TYPERT_REMOTE)
  return { ctx, dispose }
}

describe('modelTools host artifact', () => {
  it('passes the shipping Typert loader validation', () => {
    const manifest = validateTypertManifest(PACKAGE, TYPERT)
    assert.equal(manifest.package, PACKAGE)
    assert.equal(manifest.face, 'host')
    assert.deepEqual(manifest.invocations.map(invocation => `${invocation.namespace}/${invocation.method}`), WIRE_ENDPOINTS)
    assert.deepEqual(manifest.invocations.map(invocation => invocation.service), [
      MODEL_TOOLS_SERVICE, MODEL_TOOLS_SERVICE, MODEL_TOOLS_SERVICE, MODEL_TOOLS_SERVICE, MODEL_TOOLS_SERVICE,
    ])
  })

  it('maps the wire installExtension to the host member install', () => {
    const manifest = validateTypertManifest(PACKAGE, TYPERT)
    const install = manifest.invocations.find(invocation => invocation.method === 'installExtension')
    assert.ok(install)
    assert.equal(install.implementation, 'install')
    assert.deepEqual(install.parameters.map(parameter => [parameter.wire, parameter.acceptsUndefined]), [
      ['id', undefined],
      ['source', true],
    ])
    assert.deepEqual(install.cancellation, { parameter: 'signal' })
  })

  it('exposes prepare as a direct id-only endpoint with the same Host member name', () => {
    const manifest = validateTypertManifest(PACKAGE, TYPERT)
    const prepare = manifest.invocations.find(invocation => invocation.method === 'prepare')
    assert.ok(prepare)
    assert.equal(prepare.implementation, undefined)
    assert.deepEqual(prepare.parameters.map(parameter => [parameter.wire, parameter.acceptsUndefined]), [['id', undefined]])
    assert.deepEqual(prepare.cancellation, { parameter: 'signal' })
  })

  it('declares strict codecs that enforce the wire schema', () => {
    const describe = descriptorCodec(TYPERT_REMOTE, 'describe')
    const resultCodec = describe.result as { mode: string; create: () => { parse: (value: unknown) => unknown } }
    assert.equal(resultCodec.mode, 'strict')
    assert.deepEqual(resultCodec.create().parse(DESCRIBE_VALUE), DESCRIBE_VALUE)
    assert.throws(() => resultCodec.create().parse({ ...DESCRIBE_VALUE, writable: 'yes' }), /boolean/)
    assert.throws(() => resultCodec.create().parse({ ...DESCRIBE_VALUE, extensions: [{ ...EXTENSION_ROW, integrity: 'maybe' }] }), /union/)
    assert.throws(() => resultCodec.create().parse({ store: null }), /missing field/)
  })

  it('validates the preparation disclosure, readiness record and outcome', () => {
    const prepare = descriptorCodec(TYPERT_REMOTE, 'prepare')
    const resultCodec = prepare.result as { mode: string; create: () => { parse: (value: unknown) => unknown } }
    assert.equal(resultCodec.mode, 'strict')
    assert.deepEqual(resultCodec.create().parse(PREPARE_VALUE), PREPARE_VALUE)
    assert.deepEqual(resultCodec.create().parse({ ...PREPARE_VALUE, plan: null, prepared: false, reason: 'digest mismatch', groups: [] }), {
      ...PREPARE_VALUE,
      plan: null,
      prepared: false,
      reason: 'digest mismatch',
      groups: [],
    })
    assert.throws(() => resultCodec.create().parse({ ...PREPARE_VALUE, readiness: { 'embeddinggemma-2': 'maybe' } }), /union/)
    assert.throws(() => resultCodec.create().parse({ ...PREPARE_VALUE, activationReady: 'yes' }), /boolean/)
    assert.throws(() => resultCodec.create().parse({
      ...PREPARE_VALUE,
      plan: { ...PREPARE_VALUE.plan, assets: [{ ...PREPARE_VALUE.plan.assets[0], bytes: '1GB' }] },
    }), /finite number/)
    assert.throws(() => {
      const { activationReady: _omitted, ...rest } = PREPARE_VALUE
      return resultCodec.create().parse(rest)
    }, /missing field "activationReady"/)
  })

  it('validates preflight requirements and tolerates older rows without them', () => {
    const describe = descriptorCodec(TYPERT_REMOTE, 'describe')
    const resultCodec = describe.result as { create: () => { parse: (value: unknown) => { extensions: Record<string, unknown>[] } } }
    const parseRow = (row: Record<string, unknown>) =>
      resultCodec.create().parse({ ...DESCRIBE_VALUE, extensions: [row] }).extensions[0]!

    // Satisfied + unsatisfied entries, blocked false and true.
    assert.deepEqual(parseRow(EXTENSION_ROW), EXTENSION_ROW)
    assert.deepEqual(parseRow(SOURCE_ONLY_ROW), SOURCE_ONLY_ROW)
    assert.deepEqual(parseRow(BLOCKED_ROW), BLOCKED_ROW)

    // An older Host: neither field present, and the parse must not invent them.
    const legacy = parseRow(LEGACY_EXTENSION_ROW)
    assert.deepEqual(legacy, LEGACY_EXTENSION_ROW)
    assert.equal(Object.hasOwn(legacy, 'requirements'), false)
    assert.equal(Object.hasOwn(legacy, 'blocked'), false)

    // Malformed entries are refused, not silently flattened.
    const requirement = EXTENSION_ROW.requirements[0]!
    assert.throws(() => parseRow({ ...EXTENSION_ROW, requirements: [{ ...requirement, kind: 'mystery' }] }), /union/)
    assert.throws(() => parseRow({ ...EXTENSION_ROW, requirements: [{ ...requirement, action: 'retry' }] }), /union/)
    assert.throws(() => parseRow({ ...EXTENSION_ROW, requirements: [{ ...requirement, satisfied: 'yes' }] }), /boolean/)
    assert.throws(() => {
      const { reason: _reason, ...withoutReason } = requirement
      return parseRow({ ...EXTENSION_ROW, requirements: [withoutReason] })
    }, /missing field "reason"/)
    assert.throws(() => {
      const { satisfied: _satisfied, ...withoutSatisfied } = requirement
      return parseRow({ ...EXTENSION_ROW, requirements: [withoutSatisfied] })
    }, /missing field "satisfied"/)
    assert.throws(() => parseRow({ ...EXTENSION_ROW, requirements: 'none' }), /array/)
    assert.throws(() => parseRow({ ...EXTENSION_ROW, blocked: 'yes' }), /boolean/)
  })

  it('validates the install source and resolved version, and tolerates an older result', () => {
    const install = descriptorCodec(TYPERT_REMOTE, 'installExtension')
    const resultCodec = install.result as { create: () => { parse: (value: unknown) => Record<string, unknown> } }
    const registry = {
      id: '@try-works/extension-needle',
      version: '0.1.0',
      active: false,
      source: 'registry',
      resolvedVersion: '0.1.0',
    }
    assert.deepEqual(resultCodec.create().parse(registry), registry)
    assert.deepEqual(resultCodec.create().parse({ ...registry, source: 'directory' }), { ...registry, source: 'directory' })

    // An older Host: neither additive field present; the parse must not invent them.
    const legacy = { id: '@try-works/extension-laya', version: '1.0.0', active: false }
    const parsed = resultCodec.create().parse(legacy)
    assert.deepEqual(parsed, legacy)
    assert.equal(Object.hasOwn(parsed, 'source'), false)
    assert.equal(Object.hasOwn(parsed, 'resolvedVersion'), false)

    // Present values are strict: the route is a two-literal union, the version a string.
    assert.throws(() => resultCodec.create().parse({ ...registry, source: 'npm' }), /union/)
    assert.throws(() => resultCodec.create().parse({ ...registry, resolvedVersion: 1 }), /string/)
    assert.throws(() => resultCodec.create().parse({ id: registry.id, version: registry.version }), /missing field "active"/)
  })

  it('declares METHOD_SPECS that match the descriptors one-for-one', () => {
    assert.deepEqual(
      TYPERT_REMOTE.descriptors.map(descriptor => descriptor.method),
      METHOD_SPECS.map((spec: { method: string }) => spec.method),
    )
    assert.equal(TYPERT_REMOTE.descriptors.length, 5)
    assert.equal(NAMED_REMOTE, TYPERT_REMOTE)
  })
})

describe('modelTools host service binding', () => {
  it('binds a plain service object for gateway dispatch and provides it once', () => {
    const ctx = new Context()
    const service = {
      describe: async () => DESCRIBE_VALUE,
      install: async (id: string) => ({ id, version: '1.0.0', active: false }),
      enable: async (id: string) => ({ id, active: true, disabled: false }),
      disable: async (id: string) => ({ id, active: false, disabled: true }),
      prepare: async (id: string) => ({ ...PREPARE_VALUE, id }),
    }
    provideModelToolsService(ctx, service)
    const binding = (service as { typertRemote?: { service: unknown; serviceKey: string; namespace: string } }).typertRemote
    assert.equal(binding?.service, service)
    assert.equal(binding?.serviceKey, MODEL_TOOLS_SERVICE)
    assert.equal(binding?.namespace, MODEL_TOOLS_NAMESPACE)
    assert.equal(ctx.get(MODEL_TOOLS_SERVICE), service)
  })

  it('refuses a service missing a wire member', () => {
    const service = { describe: async () => DESCRIBE_VALUE, install: async () => ({ id: 'x', version: '1', active: false }) }
    assert.throws(
      () => bindModelToolsRemote(service as never),
      /missing "enable", "disable", "prepare"/,
    )
  })
})

describe('modelTools client contribution', () => {
  it('is accepted by the shipping Typert client registry', async () => {
    const ctx = new Context()
    await ctx.plugin({ name: 'client-typert-registry', inject: [], apply: applyTypertRegistry })
    assert.deepEqual(ctx.typert.remotes.list(), [])
    const dispose = ctx.typert.remotes.register(TYPERT_REMOTE)
    assert.deepEqual(
      ctx.typert.remotes.list().map(descriptor => `${descriptor.namespace}/${descriptor.method}`),
      WIRE_ENDPOINTS,
    )
    await dispose()
    assert.deepEqual(ctx.typert.remotes.list(), [])
  })

  it('mounts through the shipping client gateway and dispatches describe()/enable()/prepare() over the carrier', async () => {
    const calls: { endpoint: string; payload: unknown }[] = []
    const { ctx, dispose } = await mountInFakePage(calls, DESCRIBE_VALUE)

    const namespace = ctx.remote.modelTools as Record<string, (...args: unknown[]) => Promise<RemoteResult<unknown>>>
    assert.deepEqual(Object.keys(namespace).filter(key => !['ctx', 'name', 'methods', 'namespace', 'invokeRemote'].includes(key)), [
      'describe', 'installExtension', 'enable', 'disable', 'prepare',
    ])

    const described = await namespace.describe!()
    assert.deepEqual(described, { ok: true, value: DESCRIBE_VALUE })
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), { endpoint: 'modelTools/describe', payload: { args: {} } })

    await namespace.enable!('@try-works/extension-laya')
    assert.deepEqual(JSON.parse(JSON.stringify(calls[1])), {
      endpoint: 'modelTools/enable',
      payload: { args: { id: '@try-works/extension-laya' } },
    })

    await namespace.installExtension!('@try-works/extension-laya', undefined)
    assert.deepEqual(JSON.parse(JSON.stringify(calls[2])), {
      endpoint: 'modelTools/installExtension',
      payload: { args: { id: '@try-works/extension-laya' } },
    })

    const prepared = await namespace.prepare!('@try-works/extension-embeddinggemma')
    assert.equal(prepared.ok, true)
    assert.deepEqual(JSON.parse(JSON.stringify(calls[3])), {
      endpoint: 'modelTools/prepare',
      payload: { args: { id: '@try-works/extension-embeddinggemma' } },
    })

    await dispose()
    assert.equal(ctx.remote.modelTools, undefined)
  })

  it('folds a carrier throw into the RemoteResult error branch', async () => {
    const calls: { endpoint: string; payload: unknown }[] = []
    const { ctx, dispose } = await mountInFakePage(calls, undefined, new Error('socket closed'))
    const result = await (ctx.remote.modelTools as Record<string, Function>).describe!() as RemoteResult<unknown>
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error.message, /modelTools\/describe failed: socket closed/)
    await dispose()
  })

  it('mounts installExtension rather than the harness-shadowed name install', async () => {
    const calls: { endpoint: string; payload: unknown }[] = []
    const { ctx, dispose } = await mountInFakePage(calls, DESCRIBE_VALUE)
    const mounted = (ctx.remote.modelTools as unknown as { methods: Map<string, unknown> }).methods
    assert.equal(mounted.has('installExtension'), true)
    assert.equal(mounted.has('install'), false)
    await dispose()
  })
})

describe('browser chunk', () => {
  it('is current with remote/spec.mjs', () => {
    assert.equal(readFileSync(CHUNK_PATH, 'utf8'), renderChunk(), 'run node packages/dsh-model-as-tool/scripts/gen-remote-artifacts.mjs')
    assert.equal(CHUNK_NAME, 'client.model-tools.js')
    assert.ok(CHUNK_PATH.endsWith(join('client', CHUNK_NAME)))
  })

  it('registers the contribution under the package row and mounts the same descriptors', async () => {
    const registrations: {
      id: string
      chunk?: string
      factory: (require: (specifier: string) => unknown) => {
        contribution: { package: string; descriptors: readonly Record<string, unknown>[] }
        mount: (ctx: unknown) => Promise<{ remote: unknown; dispose: () => Promise<void> } | null>
      }
    }[] = []
    ;(globalThis as { window?: unknown }).window = {
      __ModuleLoader__: { load: (registration: (typeof registrations)[number]) => { registrations.push(registration) } },
    }
    try {
      // Run the committed script the way the browser module system evaluates a chunk.
      await import(`../client/${CHUNK_NAME}?probe=${String(Date.now())}`)
      assert.equal(registrations.length, 1)
      const registration = registrations[0]!
      assert.equal(registration.id, PACKAGE)
      assert.equal(registration.chunk, CHUNK_NAME)
      const chunk = registration.factory(() => {
        throw new Error('the model-tools chunk requests no modules')
      })
      assert.deepEqual(descriptorContract(chunk.contribution), descriptorContract(TYPERT_REMOTE))

      const mounted: unknown[] = []
      const fakeRemote = {
        $mount: async (contribution: unknown) => {
          mounted.push(contribution)
          return async () => {}
        },
      }
      const pageCtx = { get: (name: string) => (name === 'remote' ? fakeRemote : undefined) }
      const status = await chunk.mount(pageCtx)
      assert.equal(status?.remote, fakeRemote)
      assert.equal(mounted.length, 1)
      assert.deepEqual(descriptorContract(mounted[0] as typeof TYPERT_REMOTE), descriptorContract(TYPERT_REMOTE))

      assert.equal(await chunk.mount({ get: () => undefined }), null)
      assert.equal(await chunk.mount({}), null)
    } finally {
      delete (globalThis as { window?: unknown }).window
    }
  })
})

after(() => {
  // Contexts in these tests are left to process exit: they own no timers, and
  // disposing the fake-carrier gateway parks on a stream loop.
  assert.ok(PACKAGE_DIR.length > 0)
})


