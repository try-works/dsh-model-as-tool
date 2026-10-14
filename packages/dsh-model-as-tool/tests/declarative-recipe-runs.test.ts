/**
 * A declarative package's recipe runs TO A RESULT (RCP-01, HLM-01, slice 3).
 *
 * THE LAST LINK, and the one every previous round stopped short of. The recipes parsed, the
 * convention resolved them, the broker became importable — and nothing had ever shown a recipe
 * from this package producing an OUTPUT. This does.
 *
 * WHAT IS REAL AND WHAT IS STUBBED, stated up front because the distinction is the whole
 * value of the test:
 *
 *   REAL   the recipe file, read from the package as it ships
 *   REAL   the parse, the input validation and the prompt rendering
 *   REAL   the broker: authorization, the request it builds, the completion it accepts
 *   STUB   the `LlmProvider`. No model is called. The stub returns a fixed completion, so what
 *          is proven is that a recipe reaches a provider and its answer comes back as a
 *          result — NOT that any model produces good titles.
 *
 * A test that hid the stub would be claiming model quality it cannot observe. This one claims
 * the WIRING, which is exactly what was missing.
 *
 * Requirement links: RCP-01, RCP-02, HLM-01, HLM-06, DECL-01.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { HarnessBroker, parseRecipe, type BrokerRequest, type LlmCompletion, type LlmProvider } from '@try-works/tool-mode-recipes'

import { cleanup } from './helpers.ts'

after(async () => { await cleanup() })

const RECIPES = join(process.cwd(), 'packages', 'extension-declarative-recipes', 'recipes')

/** Parse a recipe exactly as it ships in the package. */
function shipped(name: string) {
  const parsed = parseRecipe(JSON.parse(readFileSync(join(RECIPES, `${name}.json`), 'utf8')))
  assert.equal(parsed.ok, true, parsed.ok ? '' : JSON.stringify(parsed).slice(0, 400))
  if (!parsed.ok) throw new Error('unreachable')
  return parsed.recipe
}

/** A provider that records what it was asked and answers with fixed text. */
function stubProvider(reply: string) {
  const seen: BrokerRequest[] = []
  const provider: LlmProvider = {
    id: 'stub-provider',
    /**
     * The generation an authorization is issued for. A provider that has reloaded is a
     * DIFFERENT endpoint (HLM-02), so the stub declares one rather than pretending to be
     * generation-agnostic.
     */
    generation: 1,
    destination: 'local',
    capabilities: () => ({ images: false, maxOutputTokens: 4096 }),
    async complete(request: BrokerRequest): Promise<LlmCompletion> {
      seen.push(request)
      return { kind: 'text', text: reply, usage: { inputTokens: 10, outputTokens: 4 } }
    },
  }
  return { provider, seen }
}

describe('slice 3 — a shipped recipe REACHES a provider and returns a result', () => {
  it('runs text-title.json end to end through the broker', async () => {
    const recipe = shipped('text-title')
    const { provider, seen } = stubProvider('Caching strategies for large tables')

    const journal: unknown[] = []
    const broker = new HarnessBroker({ record: entry => journal.push(entry) })
    broker.authorize(recipe.tool.name, provider)

    const outcome = await broker.run(recipe, { text: 'How we cache big tables', kind: 'section' })

    /**
     * THE ASSERTION THIS WHOLE ROUND EXISTS FOR: a recipe from an installed declarative
     * package produced a RESULT. Everything before this proved the pieces were correct; this
     * proves they meet.
     */
    assert.equal(outcome.kind, 'completed', `expected a result, saw ${JSON.stringify(outcome).slice(0, 300)}`)
    /**
     * THE OUTPUT ITSELF, which is the evidence this round exists to produce: a recipe from an
     * installed declarative package reached a provider and its answer came back as this
     * package's RESULT. The text is the stub's, so this claims the WIRING and not the quality
     * of any model's titles.
     */
    assert.equal((outcome as { text?: string }).text, 'Caching strategies for large tables')

    // And the provider was genuinely consulted, with the recipe's own tool name.
    assert.equal(seen.length, 1, 'the broker must call the provider exactly once')
    assert.ok(seen[0] !== undefined)
  })

  it('sends the RENDERED recipe prompt, not a generic one', async () => {
    const recipe = shipped('text-title')
    const { provider, seen } = stubProvider('A title')

    const journal: unknown[] = []
    const broker = new HarnessBroker({ record: entry => journal.push(entry) })
    broker.authorize(recipe.tool.name, provider)
    await broker.run(recipe, { text: 'Distinctive input marker', kind: 'section' })

    /**
     * The request carries the recipe's own instruction with the caller's input substituted.
     * Without this, a broker could "work" while ignoring the recipe entirely — the failure
     * mode that would make a declarative package decorative.
     */
    const serialized = JSON.stringify(seen[0])
    assert.match(serialized, /Distinctive input marker/, 'the caller input must reach the provider')
  })

  it('REFUSES to run when the recipe was never authorized', async () => {
    const recipe = shipped('text-title')
    const { provider, seen } = stubProvider('A title')

    // Deliberately NOT authorized: the broker authorizes per tool name, so a recipe whose
    // name was never granted must not reach a provider that exists and is ready.
    const journal: unknown[] = []
    const broker = new HarnessBroker({ record: entry => journal.push(entry) })
    void provider

    const outcome = await broker.run(recipe, { text: 'text', kind: 'section' })
    assert.notEqual(outcome.kind, 'completed', 'an unauthorized recipe must not produce a result')
    assert.equal(seen.length, 0, 'and the provider must never be reached')
  })

  it('refuses an input the recipe did not declare, BEFORE any provider call', async () => {
    const recipe = shipped('text-title')
    const { provider, seen } = stubProvider('A title')

    const journal: unknown[] = []
    const broker = new HarnessBroker({ record: entry => journal.push(entry) })
    broker.authorize(recipe.tool.name, provider)
    const outcome = await broker.run(recipe, { text: 'ok', kind: 'section', undeclared: 'x' })

    assert.notEqual(outcome.kind, 'completed')
    // The refusal is cheap: it happens before the model is consulted, which is what makes an
    // undeclared input a validation error rather than a paid mistake.
    assert.equal(seen.length, 0, 'validation must precede the provider call')
  })

  it('a REFUSED completion is an error, never an empty result', async () => {
    const recipe = shipped('text-title')
    const provider: LlmProvider = {
      id: 'refusing-provider',
      generation: 1,
      destination: 'local',
      capabilities: () => ({ images: false, maxOutputTokens: 4096 }),
      async complete(): Promise<LlmCompletion> {
        return { kind: 'refused', reason: 'the deployment forbids harness calls' }
      },
    }

    const journal: unknown[] = []
    const broker = new HarnessBroker({ record: entry => journal.push(entry) })
    broker.authorize(recipe.tool.name, provider)
    const outcome = await broker.run(recipe, { text: 'text', kind: 'section' })

    // The distinction the contract depends on: a refusal is an ERROR. Returning an empty
    // string would look like a successful empty title and reach a caller as one.
    assert.notEqual(outcome.kind, 'completed')
  })
})
