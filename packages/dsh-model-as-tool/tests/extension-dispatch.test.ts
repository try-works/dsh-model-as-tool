/**
 * Extension dispatch tests (EXT-19, EXT-21, EXT-22, EXT-30).
 *
 * The correction this file encodes: the TMX runtime API has NO tool-invocation surface.
 * `ExtensionInstanceV1` exposes exactly `createProvider` and `dispose`. An extension's tool
 * is a caller-facing NAME whose contract is bound to an IMPLEMENTATION, and the
 * implementation is a model PROVIDER. An earlier host registrar registered a tool whose
 * `execute` simply refused — honest, but it left the name in the registry and permanently
 * uncallable.
 *
 * The distinction the `no-implementation` case draws is the one that matters most:
 * EmbeddingGemma legitimately DECLARES contracts whose ONNX path is not wired, so
 * "declared but unserved" and "not declared at all" are different answers a caller needs
 * to tell apart.
 *
 * Requirement links: EXT-19, EXT-21, EXT-22, EXT-30, ARCH-05.
 */

import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  createDispatch,
  describeDispatchFailure,
  resolveImplementation,
  type DispatchEnvironment,
  type DispatchManifest,
} from '../src/extension-dispatch.ts'

const MANIFEST: DispatchManifest = {
  tools: [
    { name: 'semantic_similarity', contractId: 'embeddinggemma.similarity', contractVersion: '1.0.0' },
    { name: 'multimodal_embed', contractId: 'embeddinggemma.embed', contractVersion: '1.0.0' },
  ],
  implementations: [
    { id: 'embeddinggemma2-similarity', contractId: 'embeddinggemma.similarity', modelId: 'embeddinggemma-2' },
  ],
}

/** An environment that records what was reached. */
function makeEnvironment(options: { readonly failInvoke?: boolean } = {}) {
  const events: string[] = []
  const environment: DispatchEnvironment = {
    getManifest: () => MANIFEST,
    async providerFor(modelId) {
      events.push(`providerFor:${modelId}`)
      return {
        async load() {
          events.push('load')
        },
        async invoke(request) {
          events.push(`invoke:${request.implementationId}`)
          if (options.failInvoke === true) throw new Error('the extension refused')
          return { similarity: 0.75, model: modelId }
        },
      }
    },
    contextFor(implementationId) {
      events.push(`context:${implementationId}`)
      return { implementationId }
    },
  }
  return { environment, events }
}

describe('EXT-21 — a declared tool resolves through contract to implementation', () => {
  it('resolves a tool whose contract an implementation serves', () => {
    const resolved = resolveImplementation(MANIFEST, 'semantic_similarity')
    assert.equal(resolved.ok, true)
    if (!resolved.ok) return
    assert.equal(resolved.implementation.modelId, 'embeddinggemma-2')
    assert.equal(resolved.tool.contractId, 'embeddinggemma.similarity')
  })

  it('reports NOT-DECLARED for a name the manifest does not carry', () => {
    const resolved = resolveImplementation(MANIFEST, 'never_heard_of_it')
    assert.equal(resolved.ok, false)
    if (resolved.ok) return
    assert.equal(resolved.failure.code, 'not-declared')
  })

  it('reports NO-IMPLEMENTATION when the contract is declared but unserved', () => {
    // `multimodal_embed` is declared with contract `embeddinggemma.embed`, and NOTHING
    // binds that contract. This is EmbeddingGemma's real state, and it must be
    // distinguishable from a typo.
    const resolved = resolveImplementation(MANIFEST, 'multimodal_embed')
    assert.equal(resolved.ok, false)
    if (resolved.ok) return
    assert.equal(resolved.failure.code, 'no-implementation')
    assert.match(resolved.failure.message, /no implementation serves/)
    assert.match(resolved.failure.remedy, /binds no model to it yet/)
  })

  it('the two failure codes are DISTINCT, not one generic error', () => {
    const undeclared = resolveImplementation(MANIFEST, 'nope')
    const unserved = resolveImplementation(MANIFEST, 'multimodal_embed')
    if (undeclared.ok || unserved.ok) throw new Error('expected both to fail')
    assert.notEqual(undeclared.failure.code, unserved.failure.code)
  })
})

describe('EXT-19 — activation stays lightweight; the provider is created on first CALL', () => {
  it('creates no provider until execute is called', async () => {
    const { environment, events } = makeEnvironment()
    const dispatch = await createDispatch(environment, 'semantic_similarity')
    assert.equal(dispatch.ok, true)
    // Building the dispatch must not reach the extension at all: EXT-19 forbids loading
    // anything at activation.
    assert.deepEqual(events, [], 'no provider may be created just by resolving a dispatch')
  })

  it('creates the provider, loads, and invokes on the first call', async () => {
    const { environment, events } = makeEnvironment()
    const dispatch = await createDispatch(environment, 'semantic_similarity')
    if (!dispatch.ok) throw new Error(dispatch.failure.message)

    const value = await dispatch.execute({ items: [] }, new AbortController().signal)
    assert.deepEqual(value, { similarity: 0.75, model: 'embeddinggemma-2' })
    // The ORDER matters: the context is host-issued and built before the provider runs.
    assert.deepEqual(events, [
      'providerFor:embeddinggemma-2',
      'load',
      'context:embeddinggemma2-similarity',
      'invoke:embeddinggemma2-similarity',
    ])
  })

  it('resolves the provider PER CALL, so a deactivated extension is not served from a stale handle', async () => {
    const { environment, events } = makeEnvironment()
    const dispatch = await createDispatch(environment, 'semantic_similarity')
    if (!dispatch.ok) throw new Error(dispatch.failure.message)
    await dispatch.execute({}, new AbortController().signal)
    await dispatch.execute({}, new AbortController().signal)
    // Two calls, two resolutions: capturing the provider at build time would let a
    // reactivated extension keep serving through the old one.
    assert.equal(events.filter(event => event.startsWith('providerFor:')).length, 2)
  })

  it('propagates a FAILURE from the extension rather than returning an empty success', async () => {
    const { environment } = makeEnvironment({ failInvoke: true })
    const dispatch = await createDispatch(environment, 'semantic_similarity')
    if (!dispatch.ok) throw new Error(dispatch.failure.message)
    await assert.rejects(dispatch.execute({}, new AbortController().signal), /the extension refused/)
  })

  it('passes the caller ARGUMENTS through unchanged', async () => {
    const seen: unknown[] = []
    const environment: DispatchEnvironment = {
      getManifest: () => MANIFEST,
      async providerFor() {
        return {
          async load() {},
          async invoke(request) {
            seen.push(request.input)
            return {}
          },
        }
      },
      contextFor: () => ({}),
    }
    const dispatch = await createDispatch(environment, 'semantic_similarity')
    if (!dispatch.ok) throw new Error(dispatch.failure.message)
    await dispatch.execute({ query: 'a', candidates: [{ id: 'x' }] }, new AbortController().signal)
    assert.deepEqual(seen, [{ query: 'a', candidates: [{ id: 'x' }] }])
  })
})

describe('EXT-30 — a refusal is readable', () => {
  it('describes an unserved contract in a way an author can act on', async () => {
    const { environment } = makeEnvironment()
    const dispatch = await createDispatch(environment, 'multimodal_embed')
    assert.equal(dispatch.ok, false)
    if (dispatch.ok) return
    const text = describeDispatchFailure(dispatch.failure)
    assert.match(text, /no implementation serves/)
    assert.match(text, /not callable in this build/)
  })

  it('a failed dispatch produces NO execute function at all', async () => {
    const { environment } = makeEnvironment()
    const dispatch = await createDispatch(environment, 'multimodal_embed')
    // Not a function that throws — no function, so a caller cannot accidentally invoke a
    // tool the host could not bind.
    assert.equal('execute' in dispatch, false)
  })
})

/**
 * THE DECLARATIVE BRANCH IS NOT DRIVEN BY ANY TEST, AND AN EARLIER COMMENT HERE CLAIMED IT WAS.
 *
 * An earlier version of this block deleted a source-scraping test and justified the deletion with
 * three coverage claims. ALL THREE WERE FALSE, and an adversarial review falsified each:
 *
 *   - "DRIVEN by six tests in harness-serving.test.ts" — those tests call prepareDeclarative
 *     DIRECTLY. They never reach the host's branch, and `harnessProvider` appears in no test.
 *   - "DRIVEN end to end in declarative-install.test.ts" — that file says of ITSELF, at its
 *     lines 9-11, that it does NOT drive that link.
 *   - "declarative-recipe-runs.test.ts" — it assembles the broker itself and never exercises the
 *     host path either.
 *
 * WHY THIS MATTERED MORE THAN A DELETED TEST USUALLY WOULD. A false coverage claim is worse than
 * no coverage, because it stops the next person looking. Deleting the scraping test was defensible
 * on its own — it asserted WORDING, not behaviour — but the comment justifying it asserted
 * coverage that did not exist, and the host's declarative branch shipped BROKEN behind it: the
 * commit claiming "the HOST serves a declarative package" is false for every path that exists.
 *
 * WHAT IS ACTUALLY TRUE, and it is not a coverage claim:
 *   - prepareDeclarative IS exercised directly by harness-serving.test.ts. That is real coverage
 *     of the JOINING LOGIC and says nothing about whether the host reaches it;
 *   - the host's branch — providerFor returning something createDispatch can consume — has NO
 *     test, and the review reproduced two independent failures in it: no registered tool reaches
 *     it at all, and the object it returns lacks the `load` method createDispatch calls.
 *
 * The honest record of a gap is a gap, not a claim that somewhere else covers it.
 */