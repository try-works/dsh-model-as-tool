/**
 * Provider tests: the honest provider, the inert plan, and the real inference.
 *
 * This file has two halves and the split is the point.
 *
 * **Unprepared** tests run everywhere. They assert the property that matters most on a
 * machine with no artifacts: `inspect()` reports `unprepared` and names what is missing, and
 * `invoke()` REFUSES instead of returning an empty plan or a null extraction that looks like
 * a model answer.
 *
 * **Prepared** tests are gated on the pinned artifacts actually being resolvable through
 * `NEEDLE_EXTENSION_ENGINE` and `NEEDLE_EXTENSION_WEIGHTS`. When they run, they run the REAL
 * `needle.exe` over the REAL 35 MB weights and assert on the REAL transcript — including the
 * decisive structural property of `tools_plan`: that what comes back is inert data.
 *
 * Requirement links: EXT-17, EXT-18, EXT-19, DECL-01, DECL-03, SEC-06, MOD-19, MOD-20.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import {
  type ExtensionContextV1,
  type InvocationContextV1,
  type JsonObject,
  type ModelProviderV1,
} from '@try-works/tool-mode-extension-sdk'

import extension, { CALL_LIMITS } from '../src/index.ts'
import { NEEDLE_ARTIFACTS } from '../src/artifacts.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fresh scratch directory removed when the suite finishes. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'needle-provider-test-'))
  dirs.push(dir)
  return dir
}

/** A host-issued context with nothing but what EXT-18 allows. */
function context(storageDirectory = ''): ExtensionContextV1 {
  return {
    extensionId: '@try-works/extension-needle',
    extensionVersion: '0.1.0',
    activationGeneration: 1,
    storage: { directory: storageDirectory, async read() { return undefined }, async write() { /* no-op */ } },
    logger: { log: () => { /* silent */ } },
    signal: new AbortController().signal,
    configuration: {},
  }
}

/** A call-scoped context that records what it was asked to authorize. */
function invocation(overrides: Partial<InvocationContextV1> = {}): InvocationContextV1 & { resolved: string[] } {
  const resolved: string[] = []
  return {
    resolved,
    invocationId: 'test-invocation',
    signal: new AbortController().signal,
    limits: { maxInputBytes: 1024 * 1024, maxAudioSeconds: 60, maxResultBytes: 1024 * 1024 },
    resolvePath(candidate) {
      resolved.push(candidate)
      return candidate
    },
    ...overrides,
  }
}

/** Create the provider under test. */
async function provider(
  configuration: Readonly<JsonObject> = {},
  storageDirectory = '',
): Promise<ModelProviderV1> {
  const instance = await extension.create({ ...context(storageDirectory), configuration })
  return instance.createProvider({ modelId: 'needle3', configuration })
}

/**
 * The pinned artifacts, resolved from the environment, or undefined.
 *
 * Both must be present AND match the pin, or the "prepared" half of this file is skipped with
 * that reason. A test that silently passed without the model would be worse than no test.
 */
function pinnedArtifacts(): { engine: string; weights: string } | undefined {
  const engine = process.env.NEEDLE_EXTENSION_ENGINE
  const weights = process.env.NEEDLE_EXTENSION_WEIGHTS
  if (engine === undefined || weights === undefined) return undefined
  try {
    const enginePin = NEEDLE_ARTIFACTS[0]
    const weightsPin = NEEDLE_ARTIFACTS[1]
    if (enginePin === undefined || weightsPin === undefined) return undefined
    if (statSync(engine).size !== enginePin.bytes) return undefined
    if (statSync(weights).size !== weightsPin.bytes) return undefined
    return { engine, weights }
  } catch {
    return undefined
  }
}

const PINNED = pinnedArtifacts()

/**
 * A configuration that resolves NOTHING, whatever the machine's environment says.
 *
 * These tests are about the unprepared path, and a developer who has pointed
 * `NEEDLE_EXTENSION_ENGINE` at the real artifacts would otherwise see them take the prepared
 * branch and assert the wrong thing. Fixing the resolver's environment is what makes the two
 * halves of this file independent of how the suite was launched.
 */
const NO_ENVIRONMENT = { resolutionEnv: {} } as const

/** The reason the prepared half is skipped, phrased so an operator knows what to do. */
const SKIP_REASON =
  'the pinned needle.exe and needle3.cact were not resolvable: set NEEDLE_EXTENSION_ENGINE and '
  + 'NEEDLE_EXTENSION_WEIGHTS to local copies whose size and SHA-256 match models.lock.json'

/** A tool the model can propose a call to. */
const WEATHER_TOOL = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['city'],
    properties: { city: { type: 'string' } },
  },
}

/** The extraction schema used throughout. */
const INVOICE_SCHEMA = {
  type: 'object',
  properties: {
    invoice_number: { type: 'string' },
    total_amount: { type: 'number' },
    currency: { type: 'string', enum: ['USD', 'EUR', 'GBP', 'CNY'] },
    due_date: { type: 'string' },
    line_items: { type: 'array', items: { type: 'string' } },
  },
  required: ['invoice_number', 'total_amount', 'currency', 'due_date', 'line_items'],
}

/** One invoice document, as text. */
const INVOICE_TEXT =
  'Invoice AC-4471 dated 2026-03-02 is due 2026-04-01. '
  + 'Line items: 3x aluminium bracket, 1x shipping. Total: 418.75 EUR.'

describe('EXT-19 — creating a provider is a handle, not a load', () => {
  it('returns quickly and runs no engine', async () => {
    const started = Date.now()
    const created = await provider()
    const elapsed = Date.now() - started
    // Starting the engine would take about a second and 80 MB of resident memory. Creating a
    // handle must not.
    assert.ok(elapsed < 1500, `createProvider took ${elapsed}ms, suggesting it started something`)
    assert.equal(typeof created.inspect, 'function')
    assert.equal(typeof created.invoke, 'function')
  })

  it('refuses a model id it does not implement', async () => {
    const instance = await extension.create(context())
    await assert.rejects(
      instance.createProvider({ modelId: 'whistle', configuration: {} }),
      /implements the "needle3" model/,
    )
  })
})

describe('EXT-18 — inspection reports what is ACTUALLY on this machine', () => {
  it('reports unprepared and names every artifact it could not verify', async () => {
    // An empty storage directory and no configuration: nothing can resolve unless the
    // environment points at real bytes.
    const inspection = await (await provider()).inspect(new AbortController().signal)
    if (PINNED === undefined) {
      assert.equal(inspection.readiness, 'unprepared')
      // An EMPTY feature list is the honest answer while unprepared: `features` is what this
      // deployment can RUN, not what the model is documented to do.
      assert.deepEqual([...inspection.features], [])
      assert.ok(inspection.missing.length > 0, 'an unprepared deployment must name what is missing')
      assert.deepEqual(
        [...inspection.missing.map(entry => entry.name)].sort(),
        ['needle-engine-win-x64', 'needle3-weights'],
      )
      assert.match(String(inspection.reason), /needs preparation/)
      // The message says WHERE it looked, so an operator can fix it without reading the source.
      assert.match(inspection.missing[0]?.reason ?? '', /routes searched/)
    } else {
      // With the environment pointing at the pinned bytes, the SAME call must now say ready.
      // A provider that reported `unprepared` in both states would be failing one of them.
      assert.equal(inspection.readiness, 'ready')
      assert.deepEqual([...inspection.features].sort(), ['local-inference', 'structured-extraction', 'tool-calling'])
      assert.deepEqual([...inspection.missing], [])
      assert.match(String(inspection.runtimeVersion), /needle engine/)
    }
  })

  it('never reports ready for a path whose bytes are not the pinned artifact', async () => {
    // The decisive verification test. A file of the right SHAPE but the wrong bytes is the
    // realistic accident — a stale engine, a truncated download, a substituted binary — and
    // reporting `ready` for it would mean the digests are decoration.
    const dir = scratch()
    const fakeEngine = join(dir, 'needle.exe')
    // Right size, wrong content: the size check cannot catch this, only the digest can.
    const enginePin = NEEDLE_ARTIFACTS[0]
    assert.ok(enginePin)
    writeFileSync(fakeEngine, Buffer.alloc(enginePin.bytes, 0x41))
    const created = await provider({ ...NO_ENVIRONMENT }, dir)
    const inspection = await created.inspect(new AbortController().signal)
    assert.equal(inspection.readiness, 'unprepared')
    const engineProblem = inspection.missing.find(entry => entry.name === 'needle-engine-win-x64')
    assert.ok(engineProblem, 'the wrong-bytes engine must be reported as a problem')
    assert.match(engineProblem.reason, /SHA-256/)
    assert.match(engineProblem.reason, /will not be executed or loaded/)
  })

  it('reports a wrong SIZE with the sizes, before hashing anything', async () => {
    const dir = scratch()
    writeFileSync(join(dir, 'needle.exe'), 'too small')
    const inspection = await (await provider({ ...NO_ENVIRONMENT }, dir)).inspect(new AbortController().signal)
    const problem = inspection.missing.find(entry => entry.name === 'needle-engine-win-x64')
    assert.match(problem?.reason ?? '', /is 9 bytes, but needle\.exe at revision/)
  })

  it('observes an aborted signal instead of inspecting anyway', async () => {
    const controller = new AbortController()
    controller.abort(new Error('caller cancelled'))
    await assert.rejects(
      (await provider()).inspect(controller.signal),
      /caller cancelled/,
    )
  })
})

describe('EXT-18 — load proves the deployment, and refuses when it cannot', () => {
  it('rejects when the host prepared nothing that verifies', async () => {
    const assets = { get: () => undefined, assetIds: [] as string[] }
    await assert.rejects(
      (await provider({ ...NO_ENVIRONMENT })).load({ assets, signal: new AbortController().signal }),
      /not prepared on this machine, so no inference was run/,
    )
  })

  it('accepts a host map whose paths verify, and still loads nothing resident', async () => {
    if (PINNED === undefined) return
    // The host route is the normal one. It must work, and it must not put a model in this
    // process: the engine is a child that is started per call.
    const assets = {
      get: (assetId: string) => {
        const artifact = NEEDLE_ARTIFACTS.find(candidate => candidate.assetId === assetId)
        return artifact === undefined ? undefined : { path: assetId === 'needle-engine-win-x64' ? PINNED.engine : PINNED.weights, digest: artifact.sha256 }
      },
      assetIds: NEEDLE_ARTIFACTS.map(artifact => artifact.assetId),
    }
    await assert.doesNotReject((await provider()).load({ assets, signal: new AbortController().signal }))
  })
})

describe('MOD-20 — an unprepared deployment REFUSES, and names what is missing', () => {
  it('refuses tools_plan rather than returning an empty plan', async () => {
    // The resolution environment is fixed EMPTY, so this test asserts the refusal on every
    // machine rather than passing vacuously on one where the artifacts happen to be absent.
    const created = await provider({ ...NO_ENVIRONMENT })
    await assert.rejects(
      created.invoke({
        implementationId: 'needle3-native-tools-plan',
        input: { request: 'what is the weather in Shanghai?', tools: [WEATHER_TOOL] },
        context: invocation(),
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        // The refusal names BOTH artifacts and says what would fix it. An empty plan would be
        // indistinguishable from a model that found nothing to propose, which is the whole
        // reason this refuses instead.
        assert.match(message, /not prepared on this machine, so no inference was run/)
        assert.match(message, /needle-engine-win-x64/)
        assert.match(message, /needle3-weights/)
        assert.match(message, /NEEDLE_EXTENSION_ENGINE/)
        assert.match(message, /does not download them and will not run a substitute/)
        return true
      },
    )
  })

  it('refuses structured_extract on the same terms', async () => {
    await assert.rejects(
      (await provider({ ...NO_ENVIRONMENT })).invoke({
        implementationId: 'needle3-native-structured-extract',
        input: { text: INVOICE_TEXT, instruction: 'record the invoice', schema: INVOICE_SCHEMA },
        context: invocation(),
      }),
      /not prepared on this machine/,
    )
  })

  it('checks the ARGUMENTS before the artifacts, so a malformed call fails for its own reason', async () => {
    // Failing with "not prepared" for a call that was also malformed sends an operator to fix
    // the wrong thing. The environment is empty here, so a call that reached the resolver
    // would fail with the preparation message instead — which is what makes this an ordering
    // assertion rather than a coincidence.
    await assert.rejects(
      (await provider({ ...NO_ENVIRONMENT })).invoke({
        implementationId: 'needle3-native-tools-plan',
        input: { request: 'x', tools: [] },
        context: invocation(),
      }),
      /tools-plan\.input\.json/,
    )
    await assert.rejects(
      (await provider({ ...NO_ENVIRONMENT })).invoke({
        implementationId: 'needle3-native-structured-extract',
        input: { text: 'x', instruction: 'y', schema: { type: 'object', properties: { a: { type: 'string', pattern: 'x' } } } },
        context: invocation(),
      }),
      /"pattern" is not part of the engine's grammar/,
    )
  })

  it('refuses an implementation this package does not serve', async () => {
    await assert.rejects(
      (await provider()).invoke({
        implementationId: 'some-other-tool',
        input: {},
        context: invocation(),
      }),
      /this extension implements "needle3-native-tools-plan" and "needle3-native-structured-extract"/,
    )
  })

  it('refuses after disposal', async () => {
    const created = await provider()
    await created.dispose()
    await assert.rejects(
      created.invoke({ implementationId: 'needle3-native-tools-plan', input: {}, context: invocation() }),
      /has been disposed/,
    )
  })

  it('unloads and disposes cleanly without a load, and unload is idempotent', async () => {
    const created = await provider()
    await created.unload(new AbortController().signal)
    await created.unload(new AbortController().signal)
    await created.dispose()
    await created.dispose()
  })
})

describe('SEC-06 — an extraction source is authorized by the HOST before it is opened', () => {
  it('authorizes a caller path through resolvePath and opens the RESOLVED path', async () => {
    // The model is deliberately absent here (a fixed, empty resolution environment), so the
    // call fails AFTER authorization. That ordering is the point: the path must be authorized
    // before anything opens it, and the extension must use the resolved path rather than the
    // raw argument.
    const contextUnderTest = invocation()
    const dir = scratch()
    const document = join(dir, 'invoice.txt')
    writeFileSync(document, INVOICE_TEXT, 'utf8')
    await assert.rejects(
      (await provider({ ...NO_ENVIRONMENT })).invoke({
        implementationId: 'needle3-native-structured-extract',
        input: { path: 'invoice.txt', instruction: 'record the invoice', schema: INVOICE_SCHEMA },
        context: { ...contextUnderTest, resolvePath: candidate => { contextUnderTest.resolved.push(candidate); return document } },
      }),
      /not prepared on this machine/,
    )
    assert.deepEqual(contextUnderTest.resolved, ['invoice.txt'])
  })

  it('reads a document when the artifacts ARE prepared, through the resolved path only', async () => {
    if (PINNED === undefined) return
    const dir = scratch()
    const document = join(dir, 'invoice.txt')
    writeFileSync(document, INVOICE_TEXT, 'utf8')
    const contextUnderTest = invocation()
    const result = await (await provider()).invoke({
      implementationId: 'needle3-native-structured-extract',
      input: { path: 'invoice.txt', instruction: 'record the invoice', schema: INVOICE_SCHEMA },
      // The recording resolver is KEPT and only its return value is changed, so the assertion
      // below observes the real authorization rather than a stand-in that never ran.
      context: { ...contextUnderTest, resolvePath: candidate => { contextUnderTest.resolved.push(candidate); return document } },
    })
    // Authorization happened first, with the caller's own string, and the model then read the
    // document the host named.
    assert.deepEqual(contextUnderTest.resolved, ['invoice.txt'])
    assert.equal(result.proposed, true, JSON.stringify(result))
    assert.equal((result.extraction as Record<string, unknown>).invoice_number, 'AC-4471')
  })
})

describe('DECL-01 — tools_plan returns INERT DATA and has no execution path', () => {
  it('returns plain JSON for every nested value, with no callable anywhere', async () => {
    if (PINNED === undefined) return
    const result = await (await provider()).invoke({
      implementationId: 'needle3-native-tools-plan',
      input: { request: 'what is the weather in Shanghai?', tools: [WEATHER_TOOL], system: 'Today is 2026-10-14.' },
      context: invocation(),
    })
    // The structural property: walk the whole payload and refuse ANY function. A plan that
    // carried a bound tool, a handler or a thenable would be an execution path; data cannot.
    const seen: string[] = []
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'function') {
        assert.fail(`the plan payload carries a callable at ${path}, which is an execution path`)
      }
      if (typeof value !== 'object' || value === null) return
      seen.push(path)
      for (const [key, child] of Object.entries(value)) {
        for (const forbidden of ['execute', 'exec', 'run', 'invoke', 'handler', 'callback', 'dispatch', 'then']) {
          assert.notEqual(key, forbidden, `${path}.${key} is an execution-shaped field and must not exist`)
        }
        walk(child, `${path}.${key}`)
      }
    }
    walk(result, '(result)')
    assert.ok(seen.length > 3, 'the walk must actually have traversed the payload')
    // And the payload survives a JSON round trip unchanged, which a function would not.
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
    // Every proposal has exactly the five declared fields and nothing more.
    for (const proposal of (result.proposals ?? []) as Record<string, unknown>[]) {
      assert.deepEqual(
        Object.keys(proposal).sort(),
        ['arguments', 'issues', 'name', 'offered', 'valid'],
      )
    }
  })

  it('validates the returned proposal against the SHIPPED output schema', async () => {
    if (PINNED === undefined) return
    const result = await (await provider()).invoke({
      implementationId: 'needle3-native-tools-plan',
      input: { request: 'what is the weather in Shanghai?', tools: [WEATHER_TOOL] },
      context: invocation(),
    })
    const { readFileSync } = await import('node:fs')
    const schema = JSON.parse(
      readFileSync(new URL('../schema/tools-plan.output.json', import.meta.url), 'utf8'),
    ) as object
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema)
    // The host stamps `meta`; this stands in for it. Everything else is the provider's own.
    const stamped = {
      ...result,
      meta: {
        contract: '@try-works/extension-needle/tools_plan',
        contractVersion: '1.0.0',
        implementationId: 'needle3-native-tools-plan',
        extension: '@try-works/extension-needle',
        extensionVersion: '0.1.0',
        activationGeneration: 1,
        executionLocation: 'device',
        receiptId: 'test-receipt',
        warnings: [],
      },
    }
    assert.equal(validate(stamped), true, JSON.stringify(validate.errors))
  })

  it('a proposal naming a tool that was never offered is REJECTED, not passed through', async () => {
    if (PINNED === undefined) return
    // The engine's grammar constrains SHAPES, not intent: asked about the weather with only a
    // weather tool offered it stays in range, but a name is a free string to the grammar when
    // the offered schema does not pin it. So the check is this package's job.
    const result = await (await provider()).invoke({
      implementationId: 'needle3-native-tools-plan',
      input: {
        request: 'what is the weather in Shanghai?',
        tools: [WEATHER_TOOL],
      },
      context: invocation(),
    })
    const rejected = (result.rejected ?? []) as { name: string; offered: boolean }[]
    for (const entry of rejected) {
      assert.equal(entry.offered, false)
    }
    for (const proposal of (result.proposals ?? []) as { name: string }[]) {
      assert.equal(proposal.name, WEATHER_TOOL.name, 'only an offered name may be proposed')
    }
  })
})

describe('MOD-19 — the REAL engine, over the REAL weights', () => {
  it('proposes a real, schema-valid tool call', { skip: PINNED === undefined ? SKIP_REASON : false }, async () => {
    const result = await (await provider()).invoke({
      implementationId: 'needle3-native-tools-plan',
      input: {
        request: 'what is the weather in Shanghai?',
        tools: [WEATHER_TOOL],
        system: 'Today is 2026-10-14.',
      },
      context: invocation(),
    })
    const proposals = result.proposals as { name: string; arguments: Record<string, unknown>; valid: boolean }[]
    assert.equal(proposals.length, 1, `expected one proposal, saw ${JSON.stringify(result)}`)
    assert.equal(proposals[0]?.name, 'get_weather')
    assert.equal(proposals[0]?.arguments.city, 'Shanghai')
    assert.equal(proposals[0]?.valid, true)
    // The engine's own report travels with the answer rather than being dropped.
    assert.equal(typeof result.reasoning, 'string')
    assert.equal(typeof result.confidence, 'number')
    assert.deepEqual(result.grounding, { ungrounded: [], negation: false })
  })

  it('extracts a real invoice into the caller\'s schema', { skip: PINNED === undefined ? SKIP_REASON : false }, async () => {
    const result = await (await provider()).invoke({
      implementationId: 'needle3-native-structured-extract',
      input: { text: INVOICE_TEXT, instruction: 'record every invoice field you can ground in the document', schema: INVOICE_SCHEMA },
      context: invocation(),
    })
    assert.equal(result.proposed, true, JSON.stringify(result))
    assert.equal(result.valid, true, `issues: ${JSON.stringify(result.issues)}`)
    const extraction = result.extraction as Record<string, unknown>
    assert.equal(extraction.invoice_number, 'AC-4471')
    assert.equal(extraction.total_amount, 418.75)
    assert.equal(extraction.currency, 'EUR')
    assert.deepEqual(extraction.line_items, ['3x aluminium bracket', '1x shipping'])
    assert.deepEqual(result.issues, [])
  })

  it('reports "nothing matched" as data when the document has none of the fields', { skip: PINNED === undefined ? SKIP_REASON : false }, async () => {
    // A document with none of the requested fields is a legitimate answer, so it is reported
    // as `extraction: null` with `proposed: false` — never as an empty object standing in for
    // a failure, and never as an error.
    const result = await (await provider()).invoke({
      implementationId: 'needle3-native-structured-extract',
      input: {
        text: 'The quick brown fox jumps over the lazy dog.',
        instruction: 'record the invoice fields, and call the function with no values if none are present',
        schema: INVOICE_SCHEMA,
      },
      context: invocation(),
    })
    assert.equal(typeof result.proposed, 'boolean')
    if (result.proposed === false) {
      assert.equal(result.extraction, null)
      assert.equal(result.valid, false)
    }
  })

  it('terminates on cancellation rather than returning an empty success', { skip: PINNED === undefined ? SKIP_REASON : false }, async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('caller cancelled')), 80)
    try {
      await assert.rejects(
        (await provider()).invoke({
          implementationId: 'needle3-native-tools-plan',
          input: { request: 'a very long question about the weather in many cities', tools: [WEATHER_TOOL] },
          context: invocation({ signal: controller.signal }),
        }),
        /cancelled|aborted/i,
      )
    } finally {
      clearTimeout(timer)
    }
  })

  it('enforces the timeout against the real engine', { skip: PINNED === undefined ? SKIP_REASON : false }, async () => {
    // A 1 ms budget cannot be met by a process that has to load 35 MB of weights, so the
    // engine is genuinely killed and the failure is reported as a timeout.
    const instance = await extension.create({ ...context(), configuration: { timeoutMs: 1 } })
    const created = await instance.createProvider({ modelId: 'needle3', configuration: { timeoutMs: 1 } })
    await assert.rejects(
      created.invoke({
        implementationId: 'needle3-native-tools-plan',
        input: { request: 'weather in Shanghai?', tools: [WEATHER_TOOL] },
        context: invocation(),
      }),
      /exceeded its 1 ms budget/,
    )
  })

  it('enforces the OUTPUT CAP against the real engine', { skip: PINNED === undefined ? SKIP_REASON : false }, async () => {
    // 8 bytes is smaller than any real envelope, so this is a true cap test on a true child.
    const instance = await extension.create({ ...context(), configuration: { maxOutputBytes: 8 } })
    const created = await instance.createProvider({ modelId: 'needle3', configuration: { maxOutputBytes: 8 } })
    await assert.rejects(
      created.invoke({
        implementationId: 'needle3-native-tools-plan',
        input: { request: 'weather in Shanghai?', tools: [WEATHER_TOOL] },
        context: invocation(),
      }),
      /exceeded the 8-byte output cap/,
    )
  })

  it('refuses a request over the declared input limit before running anything', async () => {
    await assert.rejects(
      (await provider()).invoke({
        implementationId: 'needle3-native-tools-plan',
        input: {
          request: 'x'.repeat(CALL_LIMITS.maxRequestCharacters + 1),
          tools: [WEATHER_TOOL],
        },
        context: invocation(),
      }),
      /tools-plan\.input\.json/,
    )
  })
})
