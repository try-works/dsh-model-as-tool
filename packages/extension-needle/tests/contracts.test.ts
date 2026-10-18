/**
 * Manifest, licence, pin and schema tests (EXT-13, EXT-14, EXT-18, EXT-21, LIC-01, LIC-04,
 * MOD-01, MOD-19, DECL-01..03).
 *
 * These read the package the way a HOST does, as DATA, before importing any of it. That
 * ordering is the property EXT-13 is about — installation must be able to reject a package
 * without running it — so the manifest's licences, tools, implementations and limits are all
 * checked through `discoverExtension`, and the shipped schemas are compiled with a real
 * 2020-12 validator rather than eyeballed.
 *
 * Requirement links: EXT-13, EXT-14, EXT-18, EXT-21, LIC-01, LIC-04, MOD-01, MOD-19,
 * DECL-01, DECL-02, DECL-03.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import {
  discoverExtension,
  LICENSE_LAYERS,
} from '@try-works/tool-mode-extension-sdk'

import {
  CALL_LIMITS,
  EXTRACTION_FUNCTION_NAME,
  OWNED_TOOL_CONTRACTS,
  STRUCTURED_EXTRACT_CONTRACT,
  TOOLS_PLAN_CONTRACT,
} from '../src/contracts.ts'
import {
  NEEDLE_ARTIFACTS,
  NEEDLE_CONFIG_ENGINE_VERSION,
  NEEDLE_ENGINE_VERSION,
  NEEDLE_INSPECTED_NOT_PINNED,
  NEEDLE_REPO,
  NEEDLE_REPO_REVISION,
  NEEDLE_RESOLVE_BASE,
} from '../src/artifacts.ts'

/** This package's directory, resolved from this file rather than from a node_modules link. */
const PACKAGE_DIR = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/** The built entry, which exists only after `tsc -p tsconfig.build.json`. */
const BUILT_ENTRY = join(PACKAGE_DIR, 'lib', 'index.js')

/** Read a decoded JSON file shipped in the package. */
function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(join(PACKAGE_DIR, relative), 'utf8')) as unknown
}

/** Read a nested value from a decoded document; an absent path reads as undefined. */
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
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  return ajv.compile(readJson(relative) as object) as ((value: unknown) => boolean) & { errors?: unknown }
}

/** The host-stamped envelope the output schemas require. */
const META = {
  contract: '@try-works/extension-needle/tools_plan',
  contractVersion: '1.0.0',
  implementationId: 'needle3-native-tools-plan',
  extension: '@try-works/extension-needle',
  extensionVersion: '0.1.2',
  activationGeneration: 1,
  executionLocation: 'device',
  receiptId: 'receipt-1',
  warnings: [],
}

describe('EXT-13/EXT-14 — the package is discoverable as data, before any of it runs', () => {
  it('declares a manifest whose identity matches the package exactly', () => {
    const discovery = discoverExtension(PACKAGE_DIR)
    assert.equal(discovery.packageName, '@try-works/extension-needle')
    assert.equal(discovery.packageVersion, '0.1.2')
    assert.equal(discovery.manifest.id, discovery.packageName)
    assert.equal(discovery.manifest.version, discovery.packageVersion)
    assert.equal(discovery.manifest.runtimeApi, 1)
    assert.equal(discovery.manifest.protocolVersion, '1.1.0')
  })

  it('resolves its entry from its own exports map', () => {
    const discovery = discoverExtension(PACKAGE_DIR)
    assert.equal(discovery.entryPath, join(PACKAGE_DIR, 'lib', 'index.js'))
    // The bridge is exported too, so a host or a reviewer can drive the process surface
    // directly without reaching into the package's internals.
    assert.ok(discovery.exports.includes('./process-bridge'))
    assert.ok(discovery.exports.includes('./tool-mode'))
  })

  it('declares the single model deployment with its asset lock present', () => {
    const discovery = discoverExtension(PACKAGE_DIR)
    assert.equal(discovery.manifest.models.length, 1)
    const model = discovery.manifest.models[0]
    assert.equal(model?.id, 'needle3')
    assert.equal(model?.assetSet, 'needle3-native')
    assert.equal(model?.assetLock, './models.lock.json')
    assert.ok(existsSync(join(PACKAGE_DIR, 'models.lock.json')))
    // Only the platform that was EXERCISED is declared. The upstream repository publishes
    // fifteen platform folders; a platform table is not proof of correct inference.
    assert.deepEqual(model?.platforms.map(platform => `${platform.os}/${platform.arch}`), ['win32/x64'])
  })

  it('declares the native code and input-file access it actually needs', () => {
    const discovery = discoverExtension(PACKAGE_DIR)
    // The engine is a downloaded executable, run as a child process.
    assert.equal(discovery.manifest.permissions.nativeCode, true)
    // `structured_extract` accepts a host-authorized file path.
    assert.equal(discovery.manifest.permissions.inputFiles, true)
    assert.equal(discovery.manifest.permissions.storage, 'extension-private')
    assert.deepEqual(discovery.manifest.permissions.secrets, [])
  })
})

describe('LIC-01/LIC-04 — every licence layer and the network behaviour are declared', () => {
  it('declares all five layers with no gaps', () => {
    const discovery = discoverExtension(PACKAGE_DIR)
    assert.deepEqual([...discovery.licenseGaps], [])
    assert.equal(discovery.licenses.layers.length, LICENSE_LAYERS.length)
  })

  it('records the ENGINE and the WEIGHTS as Apache-2.0: open source and redistributable', () => {
    const discovery = discoverExtension(PACKAGE_DIR)
    // The licence was READ, not guessed: GitHub's own licence detection on
    // cactus-compute/needle reports spdx_id Apache-2.0, and the repository's LICENSE blob is
    // the 11358-byte Apache-2.0 text. The URL below is that file.
    for (const layer of ['engine', 'weights'] as const) {
      const entry = discovery.licenses.layers.find(candidate => candidate.layer === layer)
      assert.ok(entry, `the ${layer} layer must be declared`)
      assert.equal(entry.openSource, true)
      assert.equal(entry.redistribution, 'permitted')
      assert.match(entry.name, /Apache/)
      assert.match(entry.url, /^https:\/\//)
    }
    // The weights declaration cites the MODEL repository, because that is where the bytes
    // are and where a reviewer reads the terms.
    const weights = discovery.licenses.layers.find(layer => layer.layer === 'weights')
    assert.match(String(weights?.url), /huggingface\.co\/Cactus-Compute\/needle3/)
  })

  it('records that no conversion artifact exists, because none is produced', () => {
    const discovery = discoverExtension(PACKAGE_DIR)
    const conversion = discovery.licenses.layers.find(layer => layer.layer === 'conversion-artifacts')
    assert.ok(conversion)
    // A layer that exists but describes a no-op is the honest record: the bytes are used as
    // Cactus Compute published them, so declaring a licence for a conversion would invent one.
    assert.match(conversion.name, /^none:/)
  })

  it('declares no required telemetry, and says the deployment still uses the network', () => {
    const discovery = discoverExtension(PACKAGE_DIR)
    // The native engine has NO telemetry: its import table is the UCRT, KERNEL32 and WS2_32,
    // and no string in it is an upstream endpoint. The controls documented for the Python
    // wrapper (`NEEDLE_TELEMETRY`, `DO_NOT_TRACK`) do not apply to this artifact.
    assert.equal(discovery.manifest.network?.requiredTelemetry, false)
    // preparationFetches is non-empty in the lock, so the DEPLOYMENT is honestly described as
    // networked even though the extension makes no call of its own.
    assert.equal(discovery.manifest.network?.otherNetworkUse, true)
    assert.deepEqual(discovery.manifest.permissions.networkOrigins, [])
    assert.equal(discovery.noNetwork.eligible, false)
    assert.match(discovery.networkDescription, /makes network calls/)
  })
})

describe('EXT-21/DECL-01 — the package declares the contracts it OWNS', () => {
  it('declares exactly the two tools this build implements', () => {
    const discovery = discoverExtension(PACKAGE_DIR)
    assert.deepEqual(discovery.manifest.tools.map(tool => tool.name).sort(), [
      'structured_extract',
      'tools_plan',
    ])
  })

  it('namespaces every owned contract with the extension id (EXT-21)', () => {
    for (const tool of discoverExtension(PACKAGE_DIR).manifest.tools) {
      assert.ok(
        tool.contractId.startsWith('@try-works/extension-needle/'),
        `${tool.name} must namespace its contract with the extension id`,
      )
      assert.equal(tool.contractVersion, '1.0.0')
      // The schemas are FILE PATHS, which is the manifest's real shape.
      assert.match(tool.inputSchema, /^\.\/schema\/.*\.input\.json$/)
      assert.match(tool.outputSchema, /^\.\/schema\/.*\.output\.json$/)
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
      // The description is caller-facing documentation and the manifest is the copy a host
      // reads. Two versions of it would mean the published description is not the reviewed one.
      assert.equal(tool.description, contract.description)
      const implementation = manifest.implementations.find(
        candidate => candidate.id === contract.implementationId,
      )
      assert.ok(implementation, `${contract.implementationId} must be declared`)
      assert.equal(implementation.contractId, contract.contractId)
      assert.equal(implementation.modelId, 'needle3')
    }
  })

  it('states in the tools_plan description that it executes nothing', () => {
    // DECL-01's rule is caller-facing, so it has to be in the text a caller reads, not only
    // in this package's internals.
    assert.match(TOOLS_PLAN_CONTRACT.description, /EXECUTES NOTHING/)
    assert.match(TOOLS_PLAN_CONTRACT.description, /does not call tools/)
    assert.match(STRUCTURED_EXTRACT_CONTRACT.description, /does not answer questions/)
  })
})

describe('DECL-01..03 — the shipped schemas are closed and enforced', () => {
  const SCHEMAS = [
    ['tools-plan.input.json', 'input'],
    ['tools-plan.output.json', 'output'],
    ['structured-extract.input.json', 'input'],
    ['structured-extract.output.json', 'output'],
  ] as const

  it('ships an input and an output schema for every owned tool', () => {
    for (const [file] of SCHEMAS) {
      assert.ok(existsSync(join(PACKAGE_DIR, 'schema', file)), `${file} must be shipped`)
    }
  })

  it('compiles every schema and closes every root', () => {
    for (const [file, kind] of SCHEMAS) {
      assert.equal(at(readJson(`schema/${file}`), 'type'), 'object', `${file} must have an object root`)
      // A schema that does not compile is not a contract, it is documentation.
      assert.doesNotThrow(() => compile(`schema/${file}`), `${file} must compile`)
      assert.equal(at(readJson(`schema/${file}`), 'additionalProperties'), false, `${file} must be closed`)
      if (kind === 'output') {
        assert.ok(
          (at(readJson(`schema/${file}`), 'required') as string[]).includes('meta'),
          `${file} must require the host-stamped meta envelope`,
        )
      }
    }
  })

  it('publishes the same limits in the schemas as in the code', () => {
    // A limit that exists in only one of the two places is a limit a caller can walk around.
    const planInput = readJson('schema/tools-plan.input.json')
    assert.equal(at(planInput, 'properties', 'request', 'maxLength'), CALL_LIMITS.maxRequestCharacters)
    assert.equal(at(planInput, 'properties', 'tools', 'maxItems'), CALL_LIMITS.maxTools)
    assert.equal(at(planInput, 'properties', 'tools', 'minItems'), 1)
    assert.equal(at(planInput, 'properties', 'system', 'maxLength'), CALL_LIMITS.maxSystemCharacters)
    assert.equal(at(planInput, 'properties', 'max_new_tokens', 'maximum'), CALL_LIMITS.maxNewTokens)
    assert.equal(at(planInput, '$defs', 'offeredTool', 'properties', 'name', 'maxLength'), CALL_LIMITS.maxToolNameCharacters)
    assert.equal(
      at(planInput, '$defs', 'offeredTool', 'properties', 'description', 'maxLength'),
      CALL_LIMITS.maxToolDescriptionCharacters,
    )
    const extractInput = readJson('schema/structured-extract.input.json')
    assert.equal(at(extractInput, 'properties', 'instruction', 'maxLength'), CALL_LIMITS.maxInstructionCharacters)
    assert.equal(at(extractInput, 'properties', 'text', 'maxLength'), CALL_LIMITS.maxRequestCharacters)
    const planOutput = readJson('schema/tools-plan.output.json')
    assert.equal(at(planOutput, 'properties', 'proposals', 'maxItems'), CALL_LIMITS.maxProposedCalls)
  })

  it('refuses an empty tool list, because an empty document is a REFUSAL to the engine', () => {
    // Measured behaviour: the engine answers `reasoning: "no tools declared"` and an empty
    // call list for an empty or unparseable tool document. A plan with no tool set therefore
    // looks exactly like a model that proposed nothing, so the schema forbids it.
    const validate = compile('schema/tools-plan.input.json')
    assert.equal(validate({ request: 'do a thing', tools: [] }), false)
    assert.equal(validate({
      request: 'do a thing',
      tools: [{ name: 'x', description: 'does x', parameters: { type: 'object' } }],
    }), true)
    assert.equal(validate({
      request: 'do a thing',
      tools: [{ name: 'x', description: 'does x', parameters: { type: 'object' }, extra: 1 }],
    }), false)
  })

  it('requires exactly ONE extraction source', () => {
    // Both would be ambiguous and neither would be empty. The `anyOf` branch is what
    // enforces it in the schema as well as in the code.
    const validate = compile('schema/structured-extract.input.json')
    const schema = { type: 'object', properties: { a: { type: 'string' } } }
    assert.equal(validate({ text: 'doc', instruction: 'extract', schema }), true)
    assert.equal(validate({ path: 'doc.txt', instruction: 'extract', schema }), true)
    assert.equal(validate({ instruction: 'extract', schema }), false)
    assert.equal(validate({ text: 'doc', path: 'doc.txt', instruction: 'extract', schema }), false)
    // A non-object root is not a record, so it is refused at the schema level too.
    assert.equal(validate({ text: 'doc', instruction: 'extract', schema: { type: 'string' } }), false)
  })

  it('accepts a well-formed plan result and rejects one that is not inert', () => {
    const validate = compile('schema/tools-plan.output.json')
    const plan = {
      proposals: [{ name: 'get_weather', arguments: { city: 'Shanghai' }, offered: true, valid: true, issues: [] }],
      rejected: [],
      reasoning: 'the query asks for weather',
      confidence: 0.9677,
      grounding: { ungrounded: [], negation: false },
      meta: META,
    }
    assert.equal(validate(plan), true, JSON.stringify(validate.errors))
    // THE POINT OF THE SCHEMA: there is no field an executor could travel in, so a payload
    // carrying one is rejected rather than quietly accepted and ignored.
    assert.equal(validate({
      ...plan,
      proposals: [{ ...plan.proposals[0], execute: () => undefined }],
    }), false)
    assert.equal(validate({ ...plan, executor: 'run-it' }), false)
    assert.equal(validate({ ...plan, proposals: [{ ...plan.proposals[0], extra: 1 }] }), false)
    // Provenance is not decorative: a result without the envelope must not validate.
    const { meta: _omitted, ...withoutMeta } = plan
    assert.equal(validate(withoutMeta), false)
  })

  it('accepts a reported "nothing matched" extraction and rejects an unprovenanced one', () => {
    const validate = compile('schema/structured-extract.output.json')
    const empty = {
      extraction: null,
      proposed: false,
      valid: false,
      issues: [],
      meta: { ...META, contract: '@try-works/extension-needle/structured_extract' },
    }
    // A document with none of the requested fields is a legitimate answer, not an error.
    assert.equal(validate(empty), true, JSON.stringify(validate.errors))
    assert.equal(validate({
      extraction: { invoice_number: 'AC-4471' },
      proposed: true,
      valid: true,
      issues: [],
      meta: empty.meta,
    }), true)
    const { meta: _omitted, ...withoutMeta } = empty
    assert.equal(validate(withoutMeta), false)
    assert.equal(validate({ ...empty, extraction: [] }), false)
  })

  it('requires the extraction function name to be the fixed one the package uses', () => {
    // The name is fixed so a caller cannot point this tool at a real tool name and receive
    // that tool's invocation. Asserted here as a value, and enforced where the tool is built.
    assert.equal(EXTRACTION_FUNCTION_NAME, 'record_extraction')
  })
})

describe('MOD-01/MOD-19 — the lock records MEASURED artifacts, and says what it did not measure', () => {
  it('records the pinning state as measured, with both artifact digests', () => {
    const lock = readJson('models.lock.json')
    assert.equal(at(lock, 'assetSets', 'needle3-native', 'pinning', 'state'), 'measured')
    const assets = at(lock, 'assetSets', 'needle3-native', 'assets') as {
      id: string
      bytes: number
      sha256: string
    }[]
    assert.equal(assets.length, 2)
    for (const asset of assets) {
      // A digest that was never computed is worse than an absent one, because it reads as
      // verification. These were computed from bytes received over HTTPS on this host.
      assert.match(asset.sha256, /^[0-9a-f]{64}$/, `${asset.id} needs a real SHA-256`)
      assert.ok(asset.bytes > 0)
    }
  })

  it('the lock and the code agree on every digest, so a pin cannot drift', () => {
    const lock = readJson('models.lock.json')
    const assets = at(lock, 'assetSets', 'needle3-native', 'assets') as { id: string }[]
    assert.deepEqual(
      assets.map(asset => asset.id).sort(),
      NEEDLE_ARTIFACTS.map(artifact => artifact.assetId).sort(),
    )
    for (const artifact of NEEDLE_ARTIFACTS) {
      const fromLock = assets.find(asset => asset.id === artifact.assetId) as
        | { bytes: number; sha256: string; url: string; fileName: string }
        | undefined
      assert.ok(fromLock, `${artifact.assetId} must be in the lock`)
      assert.equal(fromLock.sha256, artifact.sha256, `${artifact.assetId} digest must match the code`)
      assert.equal(fromLock.bytes, artifact.bytes)
      assert.equal(fromLock.url, artifact.url)
    }
  })

  it('pins an immutable revision, not a moving branch', () => {
    // A `main` URL would silently track upstream and make every digest meaningless.
    assert.match(NEEDLE_REPO_REVISION, /^[0-9a-f]{40}$/)
    assert.equal(NEEDLE_REPO, 'Cactus-Compute/needle3')
    for (const artifact of NEEDLE_ARTIFACTS) {
      assert.ok(
        artifact.url.includes(`/${NEEDLE_REPO_REVISION}/`),
        `${artifact.assetId} must resolve the pinned revision, not a branch`,
      )
      assert.equal(artifact.url.startsWith(NEEDLE_RESOLVE_BASE), true)
    }
  })

  it('records BOTH engine versions, because upstream declares two that disagree', () => {
    // fetch.py names 3.3.1 while the pinned revision's config.json says 3.1.0. Recording one
    // and dropping the other would make "the pinned engine revision" a single number it is not.
    assert.equal(NEEDLE_ENGINE_VERSION, '3.3.1')
    assert.equal(NEEDLE_CONFIG_ENGINE_VERSION, '3.1.0')
    const lock = readJson('models.lock.json')
    assert.equal(at(lock, 'assetSets', 'needle3-native', 'model', 'engineVersionDeclaredByFetchPy'), '3.3.1')
    assert.equal(at(lock, 'assetSets', 'needle3-native', 'model', 'engineVersionDeclaredByConfig'), '3.1.0')
  })

  it('records what was inspected but NOT pinned, so an omission is a stated fact', () => {
    const lock = readJson('models.lock.json')
    const notPinned = at(lock, 'assetSets', 'needle3-native', 'inspectedNotPinned') as unknown[]
    assert.ok(notPinned.length >= 4)
    assert.ok(NEEDLE_INSPECTED_NOT_PINNED.length >= 2)
    // The WASM route the directive calls ADDITIONAL is named, so a reader can see it was
    // found and set aside rather than missed.
    assert.ok(
      NEEDLE_INSPECTED_NOT_PINNED.some(artifact => artifact.fileName.startsWith('wasm/')),
      'the WASM alternative must be recorded as a known, unpinned route',
    )
  })

  it('records the engine\'s own listener capability, since a review must account for it', () => {
    const lock = readJson('models.lock.json')
    const abi = String(at(lock, 'assetSets', 'needle3-native', 'engine', 'abi'))
    // The capability is IN the artifact. The lock says so rather than describing the binary
    // as network-free, because the byte-level truth is that it links WS2_32.
    assert.match(abi, /WS2_32/)
    assert.match(abi, /--serve/)
    assert.match(abi, /never passes/)
  })

  it('requires the platform it declares to be a platform it exercised', () => {
    const lock = readJson('models.lock.json')
    const platforms = at(lock, 'assetSets', 'needle3-native', 'platforms') as { os: string; arch: string }[]
    assert.deepEqual(platforms.map(platform => `${platform.os}/${platform.arch}`), ['win32/x64'])
  })

  it('ships PINNING.md, which records the measurement and the open questions', () => {
    // The lock is JSON and cannot carry a narrative. The measurements, the two disagreeing
    // engine versions, the licence evidence and what is NOT yet done live here.
    const text = readFileSync(join(PACKAGE_DIR, 'PINNING.md'), 'utf8')
    assert.match(text, /93e88ede867e4311c39151285e74df513e4b835b/)
    assert.match(text, /47cd411a022d22e393d87ce091848fd446e6d25df2ce31b12a7328337557c85b/)
    assert.match(text, /c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38/)
    assert.match(text, /there are no releases/i)
    assert.match(text, /What is NOT yet done/)
  })
})

describe('EXT-19 — the built entry matches the source the manifest points at', () => {
  it('declares a build configuration whose output the manifest entry names', () => {
    assert.ok(existsSync(join(PACKAGE_DIR, 'tsconfig.build.json')))
    assert.equal(at(readJson('tool-mode.extension.json'), 'execution', 'entry'), './lib/index.js')
    // The manifest validator refuses a package whose entry is absent, so `discoverExtension`
    // above already proves the entry exists. This names the remedy for a fresh checkout, where
    // `lib/` is gitignored and the package must be built before these tests can run at all.
    assert.ok(
      existsSync(BUILT_ENTRY),
      'lib/index.js is absent: run `npx tsc -p packages/extension-needle/tsconfig.build.json` '
      + 'first, because the manifest entry must exist on disk before discovery accepts the package',
    )
  })
})
