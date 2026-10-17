/**
 * The deterministic fixture provider for `tool-mode-recipe test` (RCP-08).
 *
 * The test command runs the REAL broker against a SCRIPTED fake provider — the
 * broker's binding, policy, budget and failure vocabulary are exercised
 * end-to-end without any real model, network or installation. Every fixture
 * declares its own expected outcome (kind and failure code), and the provider
 * counts every call against a declared ceiling so a recipe that silently
 * outgrows its budget fails the suite instead of passing quietly.
 *
 * This is a TEST CORPUS: a scripted provider, never a real model. A real
 * inference result is outside this module's claim by construction.
 *
 * @module @try-works/tool-mode-recipes/fixture-provider
 */

import type {
  BrokerErrorCode,
  BrokerHostPolicy,
  BrokerOutcome,
  BrokerRequest,
  CapabilityState,
  LlmCompletion,
  LlmProvider,
  ProviderCapabilities,
  ProviderDestination,
} from './broker.ts'
import { HarnessBroker } from './broker.ts'
import type { RecipeManifest } from './recipe-format.ts'
import { INITIAL_MAX_OUTPUT_TOKENS } from './recipe-format.ts'
import type { RecipeCliIo } from './cli.ts'

/** The scripted completions the fake provider can play. */
export type FixtureScript =
  | 'echo'
  | 'refuse'
  | 'truncate'
  | 'tool-call'
  | 'empty'
  | 'unused'

/** One expected outcome in a fixture case. */
export interface FixtureExpectation {
  readonly kind: 'completed' | 'failed' | 'cancelled'
  /** Required for a failed expectation: the exact code the broker must report. */
  readonly code?: BrokerErrorCode
}

/** One fixture case. */
export interface FixtureCase {
  readonly id: string
  readonly args: unknown
  readonly script: FixtureScript
  readonly expect: FixtureExpectation
}

/** The fixture document's provider stanza. */
export interface FixtureProvider {
  readonly id: string
  readonly destination: ProviderDestination
  readonly images: CapabilityState
  readonly maxCalls: number
}

/** The fixture document. */
export interface FixtureDocument {
  readonly provider: FixtureProvider
  readonly cases: readonly FixtureCase[]
}

/** Validate a decoded fixture document; a malformed fixture is a refusal. */
export function validateFixtureDocument(raw: unknown): { document?: FixtureDocument; error?: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'the fixture document must be a JSON object' }
  }
  const document = raw as Partial<FixtureDocument>
  const provider = document.provider as Partial<FixtureProvider> | undefined
  if (provider === undefined
    || typeof provider.id !== 'string'
    || (provider.destination !== 'local' && provider.destination !== 'remote')
    || (provider.images !== 'supported' && provider.images !== 'unsupported' && provider.images !== 'unknown')
    || typeof provider.maxCalls !== 'number' || !Number.isInteger(provider.maxCalls) || provider.maxCalls < 1) {
    return { error: 'the fixture document declares an invalid provider stanza' }
  }
  if (!Array.isArray(document.cases) || document.cases.length === 0) {
    return { error: 'the fixture document must carry at least one case' }
  }
  for (const entry of document.cases) {
    const fixtureCase = entry as Partial<FixtureCase>
    const kind = fixtureCase.expect?.kind
    if (typeof fixtureCase.id !== 'string'
      || !('args' in (entry as Record<string, unknown>))
      || (fixtureCase.script !== 'echo' && fixtureCase.script !== 'refuse' && fixtureCase.script !== 'truncate'
        && fixtureCase.script !== 'tool-call' && fixtureCase.script !== 'empty' && fixtureCase.script !== 'unused')
      || (kind !== 'completed' && kind !== 'failed' && kind !== 'cancelled')
      || (kind === 'failed' && typeof fixtureCase.expect?.code !== 'string')) {
      return { error: `fixture case ${JSON.stringify(fixtureCase.id ?? '(unnamed)')} is malformed` }
    }
  }
  return { document: document as FixtureDocument }
}

/** Raised when the scripted provider's call ceiling is exceeded. */
export class FixtureCeilingExceededError extends Error {
  override readonly name = 'FixtureCeilingExceededError'
}

/** A scripted fake provider: deterministic, counting, never a real model. */
export class ScriptedFixtureProvider implements LlmProvider {
  readonly id: string
  readonly generation = 1
  readonly destination: ProviderDestination
  #images: CapabilityState
  #maxCalls: number
  #calls = 0
  /** The active script; set by the runner before each dispatch. */
  #script: FixtureScript = 'unused'

  constructor(stanza: FixtureProvider) {
    this.id = stanza.id
    this.destination = stanza.destination
    this.#images = stanza.images
    this.#maxCalls = stanza.maxCalls
  }

  /** The number of provider calls made so far (the create-command guard reads this). */
  get callCount(): number {
    return this.#calls
  }

  get maxCalls(): number {
    return this.#maxCalls
  }

  /** Direct the next completion. */
  direct(script: FixtureScript): void {
    this.#script = script
  }

  capabilities(): ProviderCapabilities {
    // The scripted provider accepts images per the fixture and reports the
    // RES-10 initial output ceiling — a real provider's own ceiling, honest.
    return { images: this.#images, maxOutputTokens: INITIAL_MAX_OUTPUT_TOKENS }
  }

  async complete(request: BrokerRequest): Promise<LlmCompletion> {
    this.#calls += 1
    if (this.#calls > this.#maxCalls) {
      throw new FixtureCeilingExceededError(
        `the fixture provider exceeded its declared call ceiling of ${this.#maxCalls} calls`,
      )
    }
    switch (this.#script) {
      case 'echo': return { kind: 'text', text: `scripted output for "${request.prompt.slice(0, 40)}"`, usage: { known: true, inputTokens: 4, outputTokens: 8 } }
      case 'refuse': return { kind: 'refused', reason: 'scripted provider refusal' }
      case 'truncate': return { kind: 'truncated', text: 'scripted partial' }
      case 'tool-call': return { kind: 'tool_call', toolName: 'probe' }
      case 'empty': return { kind: 'text', text: '' }
      case 'unused': throw new Error('a fixture case dispatched a provider call without a script (fixture bug)')
    }
  }
}

/** One case's verdict. */
export interface FixtureVerdict {
  readonly caseId: string
  readonly pass: boolean
  readonly detail: string
}

/**
 * Decode the fixture document's JSON-safe image values: a `{ mediaType,
 * bytesBase64 }` record becomes the `{ mediaType, bytes: Uint8Array }` binding
 * the recipe validator admits. Applied recursively over the case arguments.
 *
 * The decode is BOUNDED: a bytesBase64 string over the ceiling is refused
 * BEFORE any base64 work happens, so an oversized fixture cannot inflate
 * memory through the decode path. The refusal is a thrown error the suite
 * reports as the case's failure — never a silent truncation.
 */
const FIXTURE_IMAGE_BASE64_CAP = 12_000_000 // ≈ an 8 MiB image once decoded
function decodeImageBytes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeImageBytes)
  if (typeof value !== 'object' || value === null) return value
  const record = value as Record<string, unknown>
  if (typeof record['mediaType'] === 'string' && typeof record['bytesBase64'] === 'string'
    && !('bytes' in record)) {
    const encoded = record['bytesBase64'] as string
    if (encoded.length > FIXTURE_IMAGE_BASE64_CAP) {
      throw new Error(
        `fixture image bytesBase64 is ${encoded.length} characters, over the decode ceiling of `
        + `${FIXTURE_IMAGE_BASE64_CAP}; the case is refused before decoding`,
      )
    }
    return { mediaType: record['mediaType'], bytes: Uint8Array.from(Buffer.from(encoded, 'base64')) }
  }
  const copy: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(record)) copy[key] = decodeImageBytes(entry)
  return copy
}

/**
 * Run one recipe against a fixture document through the REAL broker.
 * @param recipe - the recipe under test.
 * @param fixture - the validated fixture document.
 * @param io - the output sinks.
 * @param policy - the broker policy to run under (defaults to the initial policy with recording).
 * @returns the per-case verdicts, in fixture order.
 */
export async function runFixtureSuite(
  recipe: RecipeManifest,
  fixture: FixtureDocument,
  io: RecipeCliIo,
  policy: BrokerHostPolicy,
): Promise<readonly FixtureVerdict[]> {
  const provider = new ScriptedFixtureProvider(fixture.provider)
  const journal: unknown[] = []
  const broker = new HarnessBroker({
    policy,
    record: record => { journal.push(record) },
  })
  broker.authorize(recipe.tool.name, provider)

  const verdicts: FixtureVerdict[] = []
  for (const fixtureCase of fixture.cases) {
    provider.direct(fixtureCase.script)
    const args = decodeImageBytes(fixtureCase.args)
    let outcome: BrokerOutcome
    try {
      outcome = await broker.run(recipe, args)
    } catch (error) {
      verdicts.push({
        caseId: fixtureCase.id,
        pass: false,
        detail: `the broker threw instead of returning an outcome: ${error instanceof Error ? error.message : String(error)}`,
      })
      continue
    }
    const expectation = fixtureCase.expect
    const pass = outcome.kind === expectation.kind
      && (expectation.kind !== 'failed' || outcome.kind !== 'failed' || outcome.code === expectation.code)
    const detail = pass
      ? `${outcome.kind}${outcome.kind === 'failed' ? ` ${outcome.code}` : outcome.kind === 'completed' ? ` "${outcome.text.slice(0, 60)}"` : ''}`
      : `expected ${expectation.kind}${expectation.code === undefined ? '' : ` ${expectation.code}`}, got `
        + `${outcome.kind}${outcome.kind === 'failed' ? ` ${outcome.code}: ${outcome.reason}` : ''}`
    verdicts.push({ caseId: fixtureCase.id, pass, detail })
    io.out(`  [${fixtureCase.id}] ${pass ? 'PASS' : 'FAIL'}: ${detail}`)
  }
  io.out(`  provider calls: ${provider.callCount} of ${provider.maxCalls} allowed (scripted provider, not a real model)`)
  return verdicts
}
