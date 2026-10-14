/**
 * Serving a declarative package through a DEPLOYMENT-SUPPLIED provider (RCP-01, HLM-01, slice 3).
 *
 * The gap this closes: the declarative path resolved its recipes and then always refused, so the
 * slice was proven end to end only in a test that assembled the broker itself. Here the HOST
 * does the joining, and the distinction that matters is that this module never constructs a
 * provider — a deployment supplies one, which is what keeps model-specific code out of the host.
 *
 * Requirement links: RCP-01, RCP-02, HLM-01, HLM-06, HLM-09, ARCH-03.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseRecipe, type BrokerRecord, type LlmCompletion, type LlmProvider } from '@try-works/tool-mode-recipes'

import { HarnessCancelledError, HarnessFailedError, prepareDeclarative, type HarnessComposition } from '../src/harness-serving.ts'
import { cleanup } from './helpers.ts'

after(async () => { await cleanup() })

const RECIPES = join(process.cwd(), 'packages', 'extension-declarative-recipes', 'recipes')

/** The resolved shape a declarative package produces. */
function resolvedRecipes() {
  return ['text-title', 'describe-image'].map(id => {
    const recipe = JSON.parse(readFileSync(join(RECIPES, `${id}.json`), 'utf8'))
    const parsed = parseRecipe(recipe)
    assert.equal(parsed.ok, true, parsed.ok ? '' : JSON.stringify(parsed).slice(0, 200))
    if (!parsed.ok) throw new Error('unreachable')
    return { id, contractId: (recipe as { tool: { contractId: string } }).tool.contractId, recipe }
  })
}

/** A provider that answers with fixed text. */
function provider(reply = 'A served title'): LlmProvider {
  return {
    id: 'deployment-provider',
    generation: 1,
    destination: 'local',
    capabilities: () => ({ images: false, maxOutputTokens: 4096 }),
    async complete(): Promise<LlmCompletion> {
      return { kind: 'text', text: reply }
    },
  }
}

/** A composition that records, so the broker will construct. */
function composition(overrides: Partial<HarnessComposition> = {}): { readonly value: HarnessComposition; readonly journal: BrokerRecord[] } {
  const journal: BrokerRecord[] = []
  return {
    journal,
    value: { provider: provider(), journal: record => journal.push(record), ...overrides },
  }
}

describe('slice 3 — the HOST serves a declarative package when a provider is supplied', () => {
  it('turns resolved recipes into CALLABLE tools', async () => {
    const { value } = composition()
    const outcome = prepareDeclarative(value, resolvedRecipes())
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.detail)
    if (!outcome.ok) return

    assert.equal(outcome.served.length, 2)
    // The tool names come from the RECIPES, so the host does not restate what the package declares.
    assert.deepEqual(outcome.served.map(entry => entry.toolName).sort(), ['describe_image', 'text_title'])
  })

  it('INVOKES one and returns the model text', async () => {
    const { value } = composition()
    const outcome = prepareDeclarative(value, resolvedRecipes())
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return

    const title = outcome.served.find(entry => entry.toolName === 'text_title')
    assert.ok(title !== undefined)
    const result = await title.invoke({ text: 'Caching strategies', kind: 'section' })
    // The join the whole module exists for: a recipe from an installed package, through the
    // broker, answered by a deployment's provider.
    assert.equal(result, 'A served title')
  })

  it('RECORDS the call, because a broker that records nothing cannot be audited', async () => {
    const { value, journal } = composition()
    const outcome = prepareDeclarative(value, resolvedRecipes())
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return

    await outcome.served[0]?.invoke({ text: 'x', kind: 'section' })
    assert.ok(journal.length > 0, 'the harness call must be recorded (HLM-09)')
  })
})

describe('slice 3 — REFUSING is the default, and the refusal names the right thing', () => {
  it('refuses with no provider, and does NOT blame the package', () => {
    const journal: BrokerRecord[] = []
    const outcome = prepareDeclarative({ journal: record => journal.push(record) }, resolvedRecipes())
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.code, 'no-provider')
    /**
     * The refusal must point at the COMPOSITION. A reader told "the package is declarative" would
     * look in the wrong place — the package is complete and its recipes resolve.
     */
    assert.match(outcome.detail, /deployment composes no harness LlmProvider/)
    assert.match(outcome.detail, /recipes resolved and the broker is available/)
  })

  it('refuses at PREPARATION, not at the first call', () => {
    // A tool that is served and then fails at invocation presents as working until it is used.
    const journal: BrokerRecord[] = []
    const outcome = prepareDeclarative({ journal: record => journal.push(record) }, resolvedRecipes())
    assert.equal(outcome.ok, false)
  })

  it('a THROWN invocation is not returned as a value', async () => {
    const refusing: LlmProvider = {
      id: 'refusing-provider',
      generation: 1,
      destination: 'local',
      capabilities: () => ({ images: false, maxOutputTokens: 4096 }),
      async complete(): Promise<LlmCompletion> {
        return { kind: 'refused', reason: 'the deployment forbids harness calls' }
      },
    }
    const journal: BrokerRecord[] = []
    const outcome = prepareDeclarative({ provider: refusing, journal: record => journal.push(record) }, resolvedRecipes())
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return

    /**
     * A refusal is an ERROR. Returning an empty string would look like a successful empty title
     * and reach a caller as one — the distinction the contract depends on.
     */
    await assert.rejects(
      outcome.served[0]?.invoke({ text: 'x', kind: 'section' }) ?? Promise.resolve(),
      (error: unknown) => {
        /**
         * A provider REFUSAL becomes a broker `failed` outcome, which carries the machine-readable
         * code — so the assertion is on the TYPE and the CODE rather than on prose. Matching a
         * message would break on any rewording while proving nothing about the distinction.
         */
        assert.ok(error instanceof HarnessFailedError, `expected a failure, saw ${String(error)}`)
        assert.equal(error instanceof HarnessCancelledError, false, 'a refusal is not a cancellation')
        assert.equal(typeof error.code, 'string')
        return true
      },
    )
  })
})
describe('slice 3 — CANCELLATION is not a failure, and the two are distinguishable', () => {
  /**
   * Found by SELF-review against the broker's actual outcome type, after a commissioned review
   * failed to deliver. The comment here had named `refused`, `truncated` and `tool_call` — which
   * are variants of `LlmCompletion`, the PROVIDER's reply, not of `BrokerOutcome`, what `run`
   * returns. A reader trusting that comment would handle cases that cannot occur and miss the one
   * that can. Worse, `cancelled` was thrown as an indistinguishable `Error`, so every
   * cancellation a caller made would look like a malfunction.
   */
  it('throws HarnessCancelledError for a cancelled run, NOT a generic failure', async () => {
    const controller = new AbortController()
    const provider: LlmProvider = {
      id: 'cancelling-provider',
      generation: 1,
      destination: 'local',
      capabilities: () => ({ images: false, maxOutputTokens: 4096 }),
      async complete(): Promise<LlmCompletion> {
        // The caller walks away mid-call.
        controller.abort()
        return { kind: 'text', text: 'unused' }
      },
    }
    const journal: BrokerRecord[] = []
    const outcome = prepareDeclarative({ provider, journal: record => journal.push(record) }, resolvedRecipes())
    assert.equal(outcome.ok, true)
    if (!outcome.ok) return

    await assert.rejects(
      outcome.served[0]?.invoke({ text: 'x', kind: 'section' }, controller.signal) ?? Promise.resolve(),
      (error: unknown) => {
        // The distinction a caller needs in order not to inflate its error rate.
        assert.ok(error instanceof HarnessCancelledError, `expected a cancellation, saw ${String(error)}`)
        assert.equal(error instanceof HarnessFailedError, false)
        return true
      },
    )
  })
})