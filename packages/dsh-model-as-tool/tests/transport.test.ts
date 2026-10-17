/**
 * Transport and install-flow tests.
 *
 * The CLI runner and the HTTP poster are injected, so every path is exercised
 * without spawning a process or opening a socket — including the failure paths
 * that a real CLI only reaches on a machine that has one installed.
 *
 * Mounting always goes through the shared harness, which isolates the durable
 * state: the install-flow tests call `enable`/`disable`, and without isolation
 * those calls would edit the developer's real `DSH_HOME` configuration.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'

import * as plugin from '../src/index.ts'
import { loadCatalog } from '../src/catalog.ts'
import { resolveCapability } from '../src/capability.ts'
import { createAdapter } from '../src/adapters/index.ts'
import { cleanup, mountPlugin } from './helpers.ts'
import {
  buildArgv,
  createCliTransport,
  createRemoteTransport,
  parseBridgeResponse,
  parseCliOutcome,
  splitArguments,
  type CommandOutcome,
} from '../src/transport.ts'

const catalog = loadCatalog()
const entryOf = (id: string) => {
  const entry = catalog.find(item => item.id === id)
  if (entry === undefined) throw new Error(`no catalog entry "${id}"`)
  return entry
}
const withoutProvider = (id: string) => ({ ...entryOf(id), provider: undefined })

const signal = new AbortController().signal
let counter = 0

const setup = mountPlugin

function call(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({
    signal,
    callId: ToolCallId(`transport-${++counter}`),
    name,
    arguments: args,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('transport — argument mapping', () => {
  it('maps a text model to a positional input plus --option flags', () => {
    const argv = buildArgv(entryOf('redact'), {
      text: 'Email Anna at anna@example.hu',
      minimum_confidence: 0.7,
    })
    assert.deepEqual(argv, [
      'redact',
      'Email Anna at anna@example.hu',
      '--json',
      '--option',
      'minimum-confidence=0.7',
    ])
  })

  it('passes every file path positionally, then the remaining options', () => {
    const argv = buildArgv(entryOf('moderator'), { image_paths: ['a.jpg', 'b.jpg'] })
    assert.deepEqual(argv, ['moderator', 'a.jpg', 'b.jpg', '--json'])
  })

  it('rejects a missing primary input', () => {
    assert.throws(() => splitArguments(entryOf('tongue'), {}), /non-empty string or list of paths/)
  })

  it('rejects a model with no CLI verb', () => {
    // The closed-beta models have no verb and no SDK.
    const schemer = entryOf('schemer')
    assert.throws(() => buildArgv(schemer, { text: 'x' }), /no CLI verb/)
  })
})

describe('transport — CLI outcomes', () => {
  it('parses a successful JSON result', () => {
    const outcome: CommandOutcome = { code: 0, stdout: '{"redactedText":"Email [EMAIL_1]"}', stderr: '' }
    assert.deepEqual(parseCliOutcome(entryOf('redact'), outcome), { redactedText: 'Email [EMAIL_1]' })
  })

  it('wraps an array result so the object output contract still holds', () => {
    const outcome: CommandOutcome = { code: 0, stdout: '[{"index":1}]', stderr: '' }
    assert.deepEqual(parseCliOutcome(entryOf('clips'), outcome), { result: [{ index: 1 }] })
  })

  it('surfaces exit 1 and exit 64 as distinct failures carrying stderr', () => {
    assert.throws(
      () => parseCliOutcome(entryOf('voz'), { code: 1, stdout: '', stderr: 'model download failed' }),
      /failed \(exit 1\).*model download failed/s,
    )
    assert.throws(
      () => parseCliOutcome(entryOf('voz'), { code: 64, stdout: '', stderr: 'unknown flag' }),
      /rejected the call \(exit 64\).*unknown flag/s,
    )
  })

  it('rejects empty or non-JSON stdout', () => {
    assert.throws(
      () => parseCliOutcome(entryOf('gist'), { code: 0, stdout: '  ', stderr: '' }),
      /no JSON on stdout/,
    )
    assert.throws(
      () => parseCliOutcome(entryOf('gist'), { code: 0, stdout: 'not json', stderr: '' }),
      /was not JSON/,
    )
  })

  it('drives the command with the mapped argv', async () => {
    const seen: { command: string; argv: readonly string[] }[] = []
    const transport = createCliTransport(entryOf('redact'), {
      cliCommand: 'da',
      run: async (command, argv) => {
        seen.push({ command, argv })
        return { code: 0, stdout: '{"redactedText":"ok"}', stderr: '' }
      },
    })
    const value = await transport.invoke({
      entry: entryOf('redact'),
      args: { text: 'hi' },
      signal,
    })
    assert.deepEqual(seen, [{ command: 'da', argv: ['redact', 'hi', '--json'] }])
    assert.deepEqual(value, { redactedText: 'ok' })
  })
})

describe('transport — bridge responses', () => {
  it('accepts an ok envelope', () => {
    const value = parseBridgeResponse(entryOf('title'), {
      status: 200,
      body: JSON.stringify({ ok: true, result: { title: 'Fees', description: 'How fees work.' } }),
    })
    assert.deepEqual(value, { title: 'Fees', description: 'How fees work.' })
  })

  it('surfaces the bridge error message', () => {
    assert.throws(
      () => parseBridgeResponse(entryOf('title'), {
        status: 500,
        body: JSON.stringify({ ok: false, error: 'MLX trait not enabled' }),
      }),
      /MLX trait not enabled/,
    )
  })

  it('rejects a non-JSON body', () => {
    assert.throws(
      () => parseBridgeResponse(entryOf('title'), { status: 502, body: '<html>bad gateway</html>' }),
      /non-JSON body \(HTTP 502\)/,
    )
  })

  it('posts the documented envelope to /invoke with the bearer token', async () => {
    const seen: { url: string; body: unknown; headers: Readonly<Record<string, string>> }[] = []
    const transport = createRemoteTransport(entryOf('title'), {
      endpoint: 'http://mac.local:8787/',
      token: 'secret',
      post: async (url, body, headers) => {
        seen.push({ url, body, headers })
        return { status: 200, body: JSON.stringify({ ok: true, result: { title: 'T' } }) }
      },
    })
    const value = await transport.invoke({
      entry: entryOf('title'),
      args: { text: 'A passage about fees.', max_tokens: 96 },
      signal,
    })
    assert.deepEqual(seen, [{
      url: 'http://mac.local:8787/invoke',
      body: {
        model: 'title',
        verb: 'title',
        input: 'A passage about fees.',
        options: { 'max-tokens': '96' },
      },
      headers: { authorization: 'Bearer secret' },
    }])
    assert.deepEqual(value, { title: 'T' })
  })
})

describe('capability — transport routes', () => {
  it('uses the extension route for provider-bound models without requiring host model packages', () => {
    const verdict = resolveCapability(entryOf('tongue'), {
      platform: 'win32',
      resolve: specifier => specifier === '@try-works/extension-desert-ant-tongue/package.json',
      cliAvailable: false,
    })
    assert.equal(verdict.runnable, true)
    assert.equal(verdict.route, 'extension')
    assert.deepEqual(verdict.resolved, ['@try-works/extension-desert-ant-tongue/package.json'])
  })

  it('does not hide an extension-backed ONNX model when its runtime is not a host dependency', () => {
    const verdict = resolveCapability(entryOf('voz'), {
      platform: 'win32',
      resolve: specifier => specifier === '@try-works/extension-desert-ant-voz/package.json',
      cliAvailable: false,
    })
    assert.equal(verdict.runnable, true)
    assert.equal(verdict.route, 'extension')
    assert.deepEqual(verdict.resolved, ['@try-works/extension-desert-ant-voz/package.json'])
  })

  it('does not claim an extension-backed model is runnable when the extension is absent', () => {
    const verdict = resolveCapability(entryOf('tongue'), {
      platform: 'win32',
      resolve: () => false,
      cliAvailable: false,
    })
    assert.equal(verdict.runnable, false)
    assert.equal(verdict.route, 'unavailable')
    assert.deepEqual(verdict.missing, ['@try-works/extension-desert-ant-tongue/package.json'])
    assert.match(verdict.reason, /extension-desert-ant-tongue/)
  })

  it('offers the CLI route for a model whose npm prebuild is missing here', () => {
    const verdict = resolveCapability(entryOf('redact'), {
      platform: 'win32',
      resolve: () => false,
      cliAvailable: true,
    })
    assert.equal(verdict.runnable, true)
    assert.equal(verdict.route, 'cli')
  })

  it('offers the remote route for an Apple-only model', () => {
    const verdict = resolveCapability(entryOf('title'), {
      platform: 'win32',
      resolve: () => false,
      remoteEndpoint: 'http://mac.local:8787',
    })
    assert.equal(verdict.runnable, true)
    assert.equal(verdict.route, 'remote')
    assert.match(verdict.reason, /bridge at http:\/\/mac\.local:8787/)
  })

  it('prefers an in-process package over the CLI and the bridge for a non-provider catalog entry', () => {
    const verdict = resolveCapability(withoutProvider('tongue'), {
      platform: 'linux',
      resolve: () => true,
      cliAvailable: true,
      remoteEndpoint: 'http://mac.local:8787',
    })
    assert.equal(verdict.route, 'npm-native')
  })

  it('recommends installing onnxruntime-node when only the runtime is missing for a non-provider catalog entry', () => {
    const verdict = resolveCapability(withoutProvider('voz'), {
      platform: 'win32',
      // voz itself resolves; onnxruntime-node does not.
      resolve: specifier => specifier === '@desert-ant-labs/voz',
    })
    assert.equal(verdict.runnable, false)
    assert.match(verdict.reason, /onnxruntime-node/)
    assert.deepEqual(verdict.missing, ['onnxruntime-node'])
  })

  it('never routes a closed-beta model through the bridge', () => {
    const verdict = resolveCapability(entryOf('schemer'), {
      platform: 'win32',
      resolve: () => false,
      remoteEndpoint: 'http://mac.local:8787',
    })
    assert.equal(verdict.runnable, false)
    assert.match(verdict.reason, /closed beta/)
  })
})

describe('plugin — install flow', () => {
  const contexts: Context[] = []
  after(async () => {
    for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
    await cleanup()
  })
  const mount = async (config: plugin.Config = {}): Promise<Context> => {
    const ctx = await setup(config)
    contexts.push(ctx)
    return ctx
  }

  it('installs a model on request and removes it again', async () => {
    // Start with no model tools at all, so enable has real work to do.
    const ctx = await mount({ models: ['title'] })
    assert.equal(ctx.tools.schemas().some(entry => entry.name === 'lang_detect'), false)

    const enabled = await call(ctx, 'model_tools', { action: 'enable', model: 'tongue' })
    assert.equal(enabled.isError, false)
    if (enabled.isError) throw new Error('expected success')
    assert.equal((enabled.value as { changed: boolean }).changed, true)
    assert.ok(ctx.tools.schemas().some(entry => entry.name === 'lang_detect'))

    // The tool it just installed works.
    const detected = await call(ctx, 'lang_detect', { text: 'kann ich das haben' })
    if (detected.isError) throw new Error('expected success')
    assert.equal((detected.value as { language: string }).language, 'de')

    const disabled = await call(ctx, 'model_tools', { action: 'disable', model: 'tongue' })
    assert.equal(disabled.isError, false)
    assert.equal(ctx.tools.schemas().some(entry => entry.name === 'lang_detect'), false)
  })

  it('explains why an uninstallable model cannot be enabled', async () => {
    const ctx = await mount({ models: ['tongue'] })
    const result = await call(ctx, 'model_tools', { action: 'enable', model: 'title' })
    assert.equal(result.isError, true)
    if (!result.isError) throw new Error('expected failure')
    assert.match(result.error.message, /Apple-only/)
  })

  it('reports unknown model ids for enable and disable', async () => {
    const ctx = await mount()
    assert.equal((await call(ctx, 'model_tools', { action: 'enable', model: 'nope' })).isError, true)
    assert.equal((await call(ctx, 'model_tools', { action: 'disable', model: 'nope' })).isError, true)
  })

  it('marks installed state in the listing', async () => {
    const ctx = await mount({ models: ['tongue'] })
    const result = await call(ctx, 'model_tools', { action: 'list' })
    if (result.isError) throw new Error('expected success')
    const models = (result.value as { models: { id: string; installed: boolean }[] }).models
    assert.equal(models.find(model => model.id === 'tongue')?.installed, true)
    assert.equal(models.find(model => model.id === 'voz')?.installed, false)
  })

  it('does not use ProviderBridge for a provider-bound model on a non-extension route', async () => {
    const pushes: string[][] = []
    const bridge = { adapterFor: () => { throw new Error('bridge must not be used for cli route') } }
    const adapter = createAdapter(entryOf('tongue'), {
      route: 'cli',
      cliCommand: 'da',
      run: async (_command, argv) => {
        pushes.push([...argv])
        return { code: 0, stdout: '{"language":"de"}', stderr: '' }
      },
    }, undefined, bridge as never)
    assert.ok(adapter, 'a provider-bound entry may still use an explicit generic transport route')
    assert.deepEqual(await adapter.invoke({ args: { text: 'hallo' }, signal }), { language: 'de' })
    assert.deepEqual(pushes, [['tongue', 'hallo', '--json']])
  })

  it('adapter routes a CLI-capable model through the injected runner', async () => {
    // Wiring under test: createAdapter must build a transport adapter when the
    // resolved route is `cli`, and the tool it produces must reach the runner.
    // Redact has no hand-written adapter, so this is the generic path.
    const pushes: string[][] = []
    const adapter = createAdapter(entryOf('redact'), {
      route: 'cli',
      cliCommand: 'da',
      run: async (_command, argv) => {
        pushes.push([...argv])
        return { code: 0, stdout: '{"redactedText":"Email [EMAIL_1]"}', stderr: '' }
      },
    })
    assert.ok(adapter, 'a CLI route must produce an adapter')
    const value = await adapter.invoke({
      args: { text: 'Email Anna at anna@example.hu' },
      signal,
    })
    assert.deepEqual(pushes, [['redact', 'Email Anna at anna@example.hu', '--json']])
    assert.deepEqual(value, { redactedText: 'Email [EMAIL_1]' })
  })

  it('produces no adapter for a model with neither an adapter nor a transport', () => {
    assert.equal(createAdapter(entryOf('schemer'), { route: 'unavailable' }), undefined)
  })
})
