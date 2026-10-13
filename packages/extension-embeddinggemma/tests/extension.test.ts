/**
 * Extension contract tests (EXT-13, EXT-14, EXT-18, EXT-19, EXT-21, EXT-26; DECL-01..03;
 * LIC-01, LIC-04; MOD-01, MOD-02, MOD-05, MOD-09, MOD-10, MOD-20).
 *
 * Two kinds of assertion live here, and the difference matters.
 *
 * The first kind reads the package the way a HOST does — through `discoverExtension`, which
 * parses `package.json` and the manifest as DATA before importing any code. That is the
 * property EXT-13 is about: installation must be able to reject a package without running it.
 * The manifest's licences, its tools, its implementations and its declared limits are checked
 * that way, and the shipped schema documents are compiled and exercised.
 *
 * The second kind runs the extension and asserts it is HONEST. This build wires no ONNX
 * session, so the provider must report `unprepared`, must name what is missing, and must FAIL
 * an invocation rather than returning a plausible-looking vector. Those tests are the ones that
 * would catch the worst possible regression here: a provider that starts reporting `ready`.
 *
 * Requirement links: EXT-13, EXT-14, EXT-18, EXT-19, EXT-21, EXT-26, DECL-01, DECL-02,
 * DECL-03, LIC-01, LIC-04, MOD-01, MOD-02, MOD-05, MOD-09, MOD-10, MOD-20.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import {
  activateExtension,
  discoverExtension,
  EXTENSION_API_VERSION,
  LICENSE_LAYERS,
  loadExtensionModule,
  resolveExtensionEntry,
  type ExtensionContextV1,
  type InvocationContextV1,
  type ModelProviderV1,
} from '@try-works/tool-mode-extension-sdk'

import extension, { ASSET_GROUPS } from '../src/index.ts'
import { CALL_LIMITS, OWNED_TOOL_CONTRACTS } from '../src/contracts.ts'

/** This package's directory, resolved from this file rather than from a node_modules link. */
const PACKAGE_DIR = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/** The built entry, which exists only after `tsc -p tsconfig.build.json`. */
const BUILT_ENTRY = join(PACKAGE_DIR, 'lib', 'index.js')

/** A host-issued context, with nothing but what EXT-18 allows. */
function context(): ExtensionContextV1 {
  return {
    extensionId: '@try-works/extension-embeddinggemma',
    extensionVersion: '0.1.0',
    activationGeneration: 1,
    storage: { directory: '', async read() { return undefined }, async write() { /* no-op */ } },
    logger: { log: () => { /* silent */ } },
    signal: new AbortController().signal,
    configuration: {},
  }
}

/** A call-scoped context. The provider must never reach past it for authority it was not granted. */
function invocation(): InvocationContextV1 {
  return {
    invocationId: 'test-invocation',
    signal: new AbortController().signal,
    limits: { maxInputBytes: 1024 * 1024, maxAudioSeconds: 60, maxResultBytes: 1024 * 1024 },
    resolvePath: candidate => candidate,
  }
}

/** Create the provider under test. */
async function provider(): Promise<ModelProviderV1> {
  const instance = await extension.create(context())
  return instance.createProvider({ modelId: 'embeddinggemma-2', configuration: {} })
}

/** Read a decoded JSON file shipped in the package. */
function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(join(PACKAGE_DIR, relative), 'utf8')) as unknown
}

/** Read a nested value from a decoded JSON document; an absent path reads as undefined. */
function at(root: unknown, ...path: (string | number)[]): unknown {
  let current: unknown = root
  for (const step of path) {
    if (typeof step === 'number') {
      if (!Array.isArray(current)) return undefined
      current = current[step]
    } else {
      if (typeof current !== 'object' || current === null) return undefined
      current = (current as Record<string, unknown>)[step]
    }
  }
  return current
}

/** A compiled validator for one shipped schema. */
function compile(relative: string): ((value: unknown) => boolean) & { errors?: unknown } {
  // The 2020-12 dialect, because the schemas declare it: a draft-07 validator rejects the
  // `$schema` keyword itself, which would report every schema as uncompilable.
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  return ajv.compile(readJson(relative) as object) as ((value: unknown) => boolean) & { errors?: unknown }
}

/** One minimal, valid item for the shared multimodal vocabulary. */
const TEXT_ITEM = { id: 'item-1', parts: [{ kind: 'text', text: 'a short passage' }] }

/** One minimal, valid output payload for the embed contract, meta envelope included. */
const EMBED_OUTPUT = {
  vectors: [{
    id: 'item-1',
    // A real unit vector: 128 copies of 1/sqrt(128). The schema can check the length but not the
    // norm, so the fixture is unit-norm for the same reason the implementation must be.
    values: Array.from({ length: 128 }, () => 1 / Math.sqrt(128)),
    dimensions: 128,
    normalized: true,
    embeddingSpaceId: 'embeddinggemma-2-onnx-q8-rev-a',
    purpose: 'retrieval',
    role: 'document',
  }],
  processing: [{
    id: 'item-1',
    modalities: ['text'],
    sourceRanges: [],
    sampledVideoFrames: [],
    observedAudioSampleRates: [],
    truncated: false,
  }],
  meta: {
    contract: '@try-works/extension-embeddinggemma/multimodal_embed',
    contractVersion: '1.0.0',
    implementationId: 'embeddinggemma2-onnx',
    extension: '@try-works/extension-embeddinggemma',
    extensionVersion: '0.1.0',
    activationGeneration: 1,
    executionLocation: 'device',
    receiptId: 'receipt-1',
    warnings: [],
  },
}

describe('EXT-13/EXT-14 — the package is discoverable as data, before any of it runs', () => {
  it('declares a manifest whose identity matches the package exactly', () => {
    const discovery = discoverExtension(PACKAGE_DIR)
    assert.equal(discovery.packageName, '@try-works/extension-embeddinggemma')
    assert.equal(discovery.packageVersion, '0.1.0')
    assert.equal(discovery.manifest.id, discovery.packageName)
    assert.equal(discovery.manifest.version, discovery.packageVersion)
    assert.equal(discovery.manifest.runtimeApi, 1)
    assert.equal(discovery.manifest.protocolVersion, '1.1.0')
  })

  it('resolves its entry from its own exports map', () => {
    const discovery = discoverExtension(PACKAGE_DIR)
    assert.equal(resolveExtensionEntry(discovery), discovery.entryPath)
    assert.ok(discovery.entryPath?.endsWith('index.js'))
    assert.ok(discovery.exports.includes('./vectors'))
  })

  it('declares the single model deployment with its asset lock present', () => {
    const discovery = discoverExtension(PACKAGE_DIR)
    assert.equal(discovery.manifest.models.length, 1)
    const model = discovery.manifest.models[0]
    assert.equal(model?.id, 'embeddinggemma-2')
    assert.equal(model?.assetSet, 'embeddinggemma-2-onnx')
    // The manifest validator proves the locked file EXISTS; that it names the artifact is this
    // package's assertion, so both halves are checked here.
    assert.equal(model?.assetLock, './models.lock.json')
    assert.ok(existsSync(join(PACKAGE_DIR, 'models.lock.json')))
    assert.deepEqual(model?.platforms.map(platform => platform.os), ['win32'])
  })

  it('declares the three asset groups MOD-02 requires, and the provider agrees', () => {
    // MOD-02 requires separately loadable text, vision and audio groups. The lock and the
    // provider both name them, and a drift between the two would make load() report a missing
    // group the lock never prepared — so they are compared rather than assumed equal.
    const lock = readJson('models.lock.json')
    const groupIds = (at(lock, 'assetSets', 'embeddinggemma-2-onnx', 'groups') as { id: string }[])
      .map(group => group.id)
    assert.deepEqual(groupIds, [...ASSET_GROUPS])
    for (const group of ['text-backbone', 'vision-encoder', 'audio-encoder']) {
      assert.ok(groupIds.includes(group), `${group} must be declared`)
    }
  })

  it('does not claim an artifact it has not measured', () => {
    // MOD-01 requires the lock to name the exact conversion and quantization. Nothing has been
    // downloaded or hashed here, so the lock records that state instead of a plausible value:
    // a fabricated digest is indistinguishable from a verified one to every later reader.
    const lock = readJson('models.lock.json')
    assert.equal(at(lock, 'assetSets', 'embeddinggemma-2-onnx', 'pinning', 'state'), 'unmeasured')
    assert.deepEqual(at(lock, 'assetSets', 'embeddinggemma-2-onnx', 'assets'), [])
    assert.match(
      String(at(lock, 'assetSets', 'embeddinggemma-2-onnx', 'conversion', 'quantizationProfile')),
      /UNRECORDED/,
    )
  })
})

describe('LIC-01/LIC-04 — every licence layer and the network behaviour are declared', () => {
  it('declares all five layers with no gaps', () => {
    const discovery = discoverExtension(PACKAGE_DIR)
    // A gap is reported rather than defaulted, and a shipped package must have none.
    assert.deepEqual([...discovery.licenseGaps], [])
    assert.equal(discovery.licenses.layers.length, LICENSE_LAYERS.length)
  })

  it('records the weights as Apache-2.0: open source and redistributable', () => {
    // The CONTRAST with the Desert Ant packages is the point. Their weights are source-available
    // and must not be redistributed; EmbeddingGemma 2's are Apache-2.0, so a rule asserted as
    // "weights are never redistributable" would be wrong here and the declaration has to say so.
    const weights = discoverExtension(PACKAGE_DIR).licenses.layers.find(layer => layer.layer === 'weights')
    assert.ok(weights, 'the weights layer must be declared')
    assert.equal(weights.openSource, true)
    assert.equal(weights.redistribution, 'permitted')
    assert.match(weights.name, /Apache/)
    assert.match(weights.url, /^https:\/\//)
    assert.equal(weights.attributionRequired, true)
  })

  it('requires no telemetry and says the network is used for preparation', () => {
    const discovery = discoverExtension(PACKAGE_DIR)
    assert.equal(discovery.manifest.network?.requiredTelemetry, false)
    assert.equal(discovery.manifest.network?.otherNetworkUse, true)
    // The extension itself performs no network call: the host acquires the pinned bytes. So the
    // package asks for no origin, and the DEPLOYMENT is still honestly described as networked.
    assert.deepEqual(discovery.manifest.permissions.networkOrigins, [])
    assert.equal(discovery.noNetwork.eligible, false)
    assert.match(String(discovery.noNetwork.reason), /network calls unrelated to telemetry/)
    assert.equal(discovery.networkDescription.includes('runs without network access'), false)
  })

  it('declares the native code and input-file access it actually needs', () => {
    const discovery = discoverExtension(PACKAGE_DIR)
    // onnxruntime-node loads a prebuilt native binding, and the media contracts take file paths.
    assert.equal(discovery.manifest.permissions.nativeCode, true)
    assert.equal(discovery.manifest.permissions.inputFiles, true)
    assert.equal(discovery.manifest.permissions.storage, 'extension-private')
    assert.deepEqual(discovery.manifest.permissions.secrets, [])
  })
})

describe('EXT-21/DECL-01 — the package declares the contracts it OWNS', () => {
  it('declares exactly the three tools this build implements', () => {
    const discovery = discoverExtension(PACKAGE_DIR)
    // semantic_classify, semantic_deduplicate and media_find_moments belong to the same
    // requirement family but are NOT declared: a caller-facing tool name that nothing serves
    // would advertise a capability this build does not have (MOD-15, MOD-20).
    assert.deepEqual(discovery.manifest.tools.map(tool => tool.name).sort(), [
      'multimodal_embed',
      'semantic_rank',
      'semantic_similarity',
    ])
  })

  it('namespaces every owned contract with the extension id (EXT-21)', () => {
    for (const tool of discoverExtension(PACKAGE_DIR).manifest.tools) {
      assert.ok(
        tool.contractId.startsWith('@try-works/extension-embeddinggemma/'),
        `${tool.name} must namespace its contract with the extension id`,
      )
      assert.equal(tool.contractVersion, '1.0.0')
    }
  })

  it('agrees with the code, field for field, so the two cannot drift', () => {
    const manifest = discoverExtension(PACKAGE_DIR).manifest
    assert.equal(manifest.tools.length, OWNED_TOOL_CONTRACTS.length)
    for (const contract of OWNED_TOOL_CONTRACTS) {
      const tool = manifest.tools.find(candidate => candidate.name === contract.toolName)
      assert.ok(tool, `${contract.toolName} must be declared in the manifest`)
      assert.equal(tool.id, contract.toolId)
      assert.equal(tool.contractId, contract.contractId)
      assert.equal(tool.contractVersion, contract.contractVersion)
      assert.equal(tool.inputSchema, contract.inputSchema)
      assert.equal(tool.outputSchema, contract.outputSchema)
      // The description is caller-facing documentation, and the manifest is the copy a host
      // reads. Two versions of it would mean the published description is not the reviewed one.
      assert.equal(tool.description, contract.description)
      const implementation = manifest.implementations.find(
        candidate => candidate.id === contract.implementationId,
      )
      assert.ok(implementation, `${contract.implementationId} must be declared`)
      assert.equal(implementation.contractId, contract.contractId)
      assert.equal(implementation.modelId, 'embeddinggemma-2')
    }
  })

  it('states in every description what this build does NOT do (MOD-20)', () => {
    for (const contract of OWNED_TOOL_CONTRACTS) {
      assert.match(
        contract.description,
        /does not describe an image in words|not the cross-encoder text_rerank tool|refused by name/,
        `${contract.toolName} must say what it does not do`,
      )
      assert.match(contract.description, /text and code parts only|embedding ranking/)
    }
  })
})

describe('DECL-01/DECL-02/DECL-03 — the shipped schemas are closed and enforced', () => {
  const SCHEMAS = [
    ['multimodal-embed.input.json', 'input'],
    ['multimodal-embed.output.json', 'output'],
    ['semantic-similarity.input.json', 'input'],
    ['semantic-similarity.output.json', 'output'],
    ['semantic-rank.input.json', 'input'],
    ['semantic-rank.output.json', 'output'],
  ] as const

  it('ships an input and an output schema for every owned tool', () => {
    for (const [file] of SCHEMAS) {
      assert.ok(existsSync(join(PACKAGE_DIR, 'schema', file)), `${file} must be shipped`)
    }
  })

  it('compiles every schema and closes every root', () => {
    for (const [file, kind] of SCHEMAS) {
      const schema = readJson(`schema/${file}`)
      assert.equal(at(schema, 'type'), 'object', `${file} must have an object root`)
      // A schema that does not compile is not a contract, it is documentation.
      assert.doesNotThrow(() => compile(`schema/${file}`), `${file} must compile`)
      if (kind === 'output') {
        // DECL-02 and DECL-03: a closed object carrying the shared meta envelope, so a result
        // cannot reach a caller without provenance and an unlisted field is a rejection.
        assert.equal(at(schema, 'additionalProperties'), false, `${file} must be closed`)
        assert.equal(at(schema, 'properties', 'meta', 'type'), 'object', `${file} must require meta`)
        assert.ok(
          (at(schema, 'required') as string[]).includes('meta'),
          `${file} must require the meta envelope`,
        )
      } else {
        assert.equal(at(schema, 'additionalProperties'), false, `${file} must be closed`)
      }
    }
  })

  it('accepts a well-formed result and rejects one without provenance', () => {
    const validate = compile('schema/multimodal-embed.output.json')
    assert.equal(validate(EMBED_OUTPUT), true, JSON.stringify(validate.errors))
    // The host stamps meta; a result without it must not validate, or the envelope would be
    // decorative.
    const { meta: _omitted, ...withoutMeta } = EMBED_OUTPUT as Record<string, unknown>
    assert.equal(validate(withoutMeta), false)
    assert.equal(validate({ ...EMBED_OUTPUT, extra: 1 }), false)
    // `truncated: true` is deliberately NOT valid in v1: silent truncation needs a new schema,
    // not a quiet flag flip (MOD-08).
    assert.equal(
      validate({
        ...EMBED_OUTPUT,
        processing: [{ ...EMBED_OUTPUT.processing[0], truncated: true }],
      }),
      false,
    )
  })

  it('enforces the MOD-05 purpose/role rule in the SCHEMA as well as in code', () => {
    const validate = compile('schema/multimodal-embed.input.json')
    assert.equal(validate({ items: [TEXT_ITEM], purpose: 'retrieval', role: 'document' }), true)
    assert.equal(validate({ items: [TEXT_ITEM], purpose: 'retrieval', role: 'query' }), true)
    assert.equal(validate({ items: [TEXT_ITEM], purpose: 'similarity', role: 'symmetric' }), true)
    assert.equal(validate({ items: [TEXT_ITEM], purpose: 'retrieval', role: 'symmetric' }), false)
    assert.equal(validate({ items: [TEXT_ITEM], purpose: 'similarity', role: 'query' }), false)
    assert.equal(validate({ items: [TEXT_ITEM], purpose: 'retrieval', role: 'document', extra: 1 }), false)
    assert.equal(validate({ items: [{ id: 'x', parts: [] }], purpose: 'retrieval', role: 'document' }), false)
  })

  it('publishes the same limits in the schemas as in the code', () => {
    // A limit that exists in only one of the two places is a limit a caller can walk around.
    const embedInput = readJson('schema/multimodal-embed.input.json')
    assert.equal(at(embedInput, 'properties', 'items', 'maxItems'), CALL_LIMITS.maxItems)
    assert.equal(at(embedInput, '$defs', 'item', 'properties', 'parts', 'maxItems'), CALL_LIMITS.maxPartsPerItem)
    assert.equal(at(embedInput, '$defs', 'item', 'properties', 'id', 'maxLength'), CALL_LIMITS.maxIdCharacters)
    assert.equal(at(embedInput, '$defs', 'item', 'properties', 'title', 'maxLength'), CALL_LIMITS.maxTitleCharacters)
    assert.equal(
      at(embedInput, '$defs', 'mediaPart', 'oneOf', 0, 'properties', 'text', 'maxLength'),
      CALL_LIMITS.maxTextCharacters,
    )
    const rankInput = readJson('schema/semantic-rank.input.json')
    assert.equal(at(rankInput, 'properties', 'candidates', 'maxItems'), CALL_LIMITS.maxCandidates)
  })

  it('admits every modality the model supports, so the contract is not narrowed to this build', () => {
    // The CONTRACT is the long-lived public identity and the model does read images, audio and
    // video; which of those the ENABLED adapter reads is stated in the description and enforced
    // at invoke time (MOD-20). Narrowing the schema instead would make a later qualified build
    // need a new contract version for a capability it already had.
    const kinds = (at(readJson('schema/multimodal-embed.input.json'), '$defs', 'mediaPart', 'oneOf') as {
      properties: { kind: { const: string } }
    }[]).map(branch => branch.properties.kind.const)
    assert.deepEqual(kinds, ['text', 'code', 'image', 'audio', 'video'])
  })
})

describe('EXT-18/EXT-19 — the provider is a handle, and it is honest about what it cannot do', () => {
  it('creating a provider loads nothing and returns quickly', async () => {
    const started = Date.now()
    const instance = await extension.create(context())
    const created = await instance.createProvider({ modelId: 'embeddinggemma-2', configuration: {} })
    const elapsed = Date.now() - started
    // A model load here would import Transformers.js and build ONNX sessions over hundreds of
    // megabytes of weights. A handle must not.
    assert.ok(elapsed < 1500, `createProvider took ${elapsed}ms, suggesting it loaded something`)
    assert.equal(typeof created.inspect, 'function')
  })

  it('refuses a model id it does not implement', async () => {
    const instance = await extension.create(context())
    await assert.rejects(
      instance.createProvider({ modelId: 'some-other-model', configuration: {} }),
      /implements the "embeddinggemma-2" model/,
    )
  })

  it('reports unprepared, names the missing runtime, and claims NO feature', async () => {
    const inspection = await (await provider()).inspect(new AbortController().signal)
    // `unprepared` is the provider-level form of the lifecycle's `needs-preparation`: the
    // package is valid and its tools are describable, and nothing can run yet (EXT-26).
    assert.equal(inspection.readiness, 'unprepared')
    // An EMPTY feature list is the honest answer, not an omission. `features` is what this build
    // can actually run; listing a similarity feature before an ONNX session exists would be the
    // fabrication EXT-18 exists to forbid.
    assert.deepEqual([...inspection.features], [])
    assert.ok(inspection.missing.length > 0, 'an unprepared deployment must name what is missing')
    assert.ok(
      inspection.missing.some(entry => entry.name.includes('onnx')),
      'the unwired inference path must be named',
    )
    assert.ok(
      inspection.missing.some(entry => entry.name === '@huggingface/transformers'),
      'the absent ONNX client library must be named on this host',
    )
    assert.match(String(inspection.reason), /needs preparation/)
  })

  it('never reports ready before a load', async () => {
    // EXT-18: inspection reads approved local state only. Reporting "ready" here would be a
    // claim the provider has not earned — and in this build it cannot be earned at all, so the
    // answer must be the same on every call rather than converging as state accumulates.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const instance = await provider()
      assert.notEqual((await instance.inspect(new AbortController().signal)).readiness, 'ready')
    }
  })

  it('refuses to load, naming the group the host did not prepare', async () => {
    const assets = { get: () => undefined, assetIds: [] as string[] }
    await assert.rejects(
      (await provider()).load({ assets, signal: new AbortController().signal }),
      /not prepared: .*"text-backbone" asset group was not prepared/,
    )
  })

  it('never reports a successful load, even when every declared group is present', async () => {
    // The decisive honesty test. A host that prepared everything the manifest declares must not
    // be told the deployment is loaded, because this build creates no session — reporting a
    // successful load would make an unusable deployment look callable. On this host the ONNX
    // client library is also genuinely absent, so the failure may legitimately be either; what
    // it must NEVER be is a complaint about the assets that were just supplied.
    const assets = {
      get: (assetId: string) => ({ path: `/prepared/${assetId}`, digest: 'sha256-verified' }),
      assetIds: [...ASSET_GROUPS],
    }
    const instance = await provider()
    await assert.rejects(
      instance.load({ assets, signal: new AbortController().signal }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.doesNotMatch(message, /asset group/, 'a fully prepared asset map must not be blamed')
        assert.match(message, /not wired in this build|does not resolve on this host/)
        return true
      },
    )
  })
})

describe('MOD-05/MOD-10/MOD-20 — a call fails for its own reason, never with an invented vector', () => {
  /** Invoke one implementation and return the rejection for inspection. */
  async function invoke(implementationId: string, input: Record<string, unknown>): Promise<Error> {
    const instance = await provider()
    try {
      await instance.invoke({ implementationId, input, context: invocation() })
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error))
    }
    throw new Error(`${implementationId} resolved, but this build must never produce a result`)
  }

  it('rejects an implementation this package does not serve', async () => {
    const error = await invoke('not-ours', {})
    assert.match(error.message, /this extension implements "embeddinggemma2-onnx"/)
  })

  it('fails a well-formed call with the reason, and says nothing was computed', async () => {
    const error = await invoke('embeddinggemma2-onnx', {
      items: [TEXT_ITEM],
      purpose: 'retrieval',
      role: 'document',
    })
    // Not "unavailable" alone: the message names the build so an operator can tell an
    // unimplemented path from a broken one.
    assert.match(error.message, /ONNX inference path is not wired in this build/)
    assert.match(error.message, /No vector was computed and no result is reported/)
  })

  it('refuses a media part BY NAME rather than embedding the remaining text', async () => {
    const error = await invoke('embeddinggemma2-onnx', {
      items: [{ id: 'with-image', parts: [{ kind: 'text', text: 'caption' }, { kind: 'image', path: 'C:/photo.jpg' }] }],
      purpose: 'retrieval',
      role: 'document',
    })
    // The failure mode this prevents: silently embedding the text and returning a vector the
    // caller believes includes the image. That answer is plausible, so the caller cannot notice.
    assert.match(error.message, /this build reads text and code parts only/)
    assert.match(error.message, /"image" part is refused/)
  })

  it('rejects duplicate item ids and an unknown purpose/role pair before any model work', async () => {
    const duplicate = await invoke('embeddinggemma2-onnx', {
      items: [TEXT_ITEM, { id: 'item-1', parts: [{ kind: 'code', text: 'x = 1' }] }],
      purpose: 'retrieval',
      role: 'document',
    })
    assert.match(duplicate.message, /duplicate item id "item-1"/)

    const badPair = await invoke('embeddinggemma2-onnx', {
      items: [TEXT_ITEM],
      purpose: 'retrieval',
      role: 'symmetric',
    })
    assert.match(badPair.message, /role "symmetric" is not admitted for the purpose "retrieval"/)
  })

  it('refuses a width EmbeddingGemma 2 does not produce', async () => {
    const error = await invoke('embeddinggemma2-onnx', {
      items: [TEXT_ITEM],
      purpose: 'retrieval',
      role: 'document',
      dimensions: 384,
    })
    // 384 is MiniLM's width: accepting it would let a caller store vectors that look like an
    // existing index's and are not comparable with it (BASE-12).
    assert.match(error.message, /"dimensions" must be one of 768, 512, 256, 128/)
  })

  it('refuses dimensions and item counts beyond the declared limits', async () => {
    const tooMany = await invoke('embeddinggemma2-onnx', {
      items: Array.from({ length: CALL_LIMITS.maxItems + 1 }, (_unused, index) => ({
        id: `item-${index}`,
        parts: [{ kind: 'text', text: 'x' }],
      })),
      purpose: 'retrieval',
      role: 'document',
    })
    assert.match(tooMany.message, /over the 64-item limit/)

    const longText = await invoke('embeddinggemma2-onnx', {
      items: [{ id: 'long', parts: [{ kind: 'text', text: 'x'.repeat(CALL_LIMITS.maxTextCharacters + 1) }] }],
      purpose: 'retrieval',
      role: 'document',
    })
    // MOD-08: an over-context input is refused, not silently shortened.
    assert.match(longText.message, /over the 4096-character limit/)
  })

  it('bounds semantic_rank top_k by the candidate count', async () => {
    const error = await invoke('embeddinggemma2-rank', {
      query: TEXT_ITEM,
      candidates: [{ id: 'candidate-1', parts: [{ kind: 'text', text: 'other' }] }],
      top_k: 5,
    })
    assert.match(error.message, /"top_k" 5 exceeds the 1 candidate\(s\) supplied/)
  })

  it('accepts a well-formed similarity and rank call, and then refuses for the honest reason', async () => {
    // Both shapes pass validation, so the failure that follows is the model, not the arguments —
    // which is exactly the distinction the messages have to preserve.
    const similarity = await invoke('embeddinggemma2-similarity', { left: TEXT_ITEM, right: TEXT_ITEM })
    assert.match(similarity.message, /semantic_similarity cannot run on this deployment/)
    const rank = await invoke('embeddinggemma2-rank', {
      query: TEXT_ITEM,
      candidates: [{ id: 'candidate-1', parts: [{ kind: 'text', text: 'other' }] }],
      top_k: 1,
    })
    assert.match(rank.message, /semantic_rank cannot run on this deployment/)
  })

  it('unloads and disposes without claiming work it never did', async () => {
    const instance = await provider()
    await instance.unload(new AbortController().signal)
    await instance.dispose()
    // A disposed provider must not accept more work.
    await assert.rejects(
      instance.invoke({ implementationId: 'embeddinggemma2-onnx', input: {}, context: invocation() }),
      /has been disposed/,
    )
  })

  it('observes cancellation', async () => {
    const controller = new AbortController()
    controller.abort(new Error('caller cancelled'))
    const instance = await provider()
    await assert.rejects(
      instance.invoke({
        implementationId: 'embeddinggemma2-onnx',
        input: { items: [TEXT_ITEM], purpose: 'retrieval', role: 'document' },
        context: { ...invocation(), signal: controller.signal },
      }),
      /caller cancelled/,
    )
  })
})

describe('EXT-17 — the published entry behaves like the source it was built from', () => {
  it(
    'loads and activates through the built module',
    {
      skip: existsSync(BUILT_ENTRY)
        ? false
        : 'lib/index.js is not built yet; run tsc -p packages/extension-embeddinggemma/tsconfig.build.json',
    },
    async () => {
      const discovery = discoverExtension(PACKAGE_DIR)
      const loaded = await loadExtensionModule(resolveExtensionEntry(discovery))
      assert.equal(loaded.apiVersion, EXTENSION_API_VERSION)
      const instance = await activateExtension(loaded, context())
      const created = await instance.createProvider({ modelId: 'embeddinggemma-2', configuration: {} })
      // The built artifact must be exactly as honest as the source: a stale or differently
      // configured build that reported `ready` would be the one a user actually runs.
      assert.equal((await created.inspect(new AbortController().signal)).readiness, 'unprepared')
      await instance.dispose('deactivate')
    },
  )
})
