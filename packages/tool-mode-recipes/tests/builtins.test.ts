/**
 * Built-in tool tests: `text_title` (TOOL-06, RCP-12) and `describe_image` (HLM-11,
 * HLM-12), both through the broker with a DETERMINISTIC FAKE PROVIDER.
 *
 * THE CENTRAL TEST, in the requirement's own words: **a refusal or an incomplete
 * generation must never become a valid empty title.** The response shapes that carry that
 * failure are tested in both directions — a provider-level refusal or truncation, and a
 * refusal or an empty title INSIDE otherwise valid JSON — because the second is the one
 * that looks like a result.
 *
 * A fake provider proves the REQUEST and the CONTRACT: what was sent, what was refused,
 * and that no empty result escaped. It proves nothing about model quality; no model ran.
 *
 * Requirement links: TOOL-06, RCP-04, RCP-11, RCP-12, HLM-07, HLM-11, HLM-12.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { HarnessBroker, type LlmCompletion } from '../src/broker.ts'
import {
  acceptTitle,
  createTextTitleTool,
  mayCallAnotherTool,
  parseTitleResponse,
  SECTION_TITLE_LIMITS,
  TEXT_TITLE_RECIPE,
  TEXT_TITLE_TOOL,
  type TextTitleTool,
  type TitleLimits,
} from '../src/titles.ts'
import { createDescribeImageTool, DESCRIBE_IMAGE_RECIPE, DESCRIBE_IMAGE_TOOL } from '../src/images.ts'
import {
  ACCEPTED_TITLE_JSON,
  FakeProvider,
  recordCollector,
  SOURCE_TEXT,
  typedImage,
} from './fake-provider.ts'

/** A `text_title` tool wired to a fake provider, with the journal captured. */
function titleHarness(
  completions: readonly LlmCompletion[],
  limits?: TitleLimits,
): { readonly provider: FakeProvider; readonly tool: TextTitleTool; readonly records: ReturnType<typeof recordCollector> } {
  const provider = new FakeProvider({ completions })
  const records = recordCollector()
  const broker = new HarnessBroker({ record: records.sink })
  broker.authorize(TEXT_TITLE_TOOL, provider)
  const tool = createTextTitleTool({ broker, ...(limits === undefined ? {} : { limits }) })
  return { provider, tool, records }
}

/** A `describe_image` tool wired to a fake provider. */
function imageHarness(
  completions: readonly LlmCompletion[],
  capabilities: { readonly images: 'supported' | 'unsupported' | 'unknown' } = { images: 'supported' },
): { readonly provider: FakeProvider; readonly tool: ReturnType<typeof createDescribeImageTool> } {
  const provider = new FakeProvider({ completions, images: capabilities.images })
  const records = recordCollector()
  const broker = new HarnessBroker({ record: records.sink })
  broker.authorize(DESCRIBE_IMAGE_TOOL, provider)
  return { provider, tool: createDescribeImageTool({ broker }) }
}

describe('TOOL-06 — a refusal or an incomplete generation is NEVER a valid empty title', () => {
  it('turns a provider REFUSAL into an error with no title field at all', async () => {
    const { tool } = titleHarness([{ kind: 'refused', reason: 'the content is not safe to summarise' }])
    const result = await tool.invoke({ text: SOURCE_TEXT })
    assert.equal(result.kind, 'error')
    // The bug this prevents: a caller writing `result.title` into a document would have
    // produced a blank heading and seen nothing wrong.
    assert.equal('title' in result, false)
    assert.equal(result.kind === 'error' ? result.code : '', 'MODEL_REFUSED')
    assert.match(result.kind === 'error' ? result.reason : '', /not safe to summarise/)
  })

  it('turns TRUNCATION into an error, never a short title', async () => {
    const { tool } = titleHarness([{ kind: 'truncated', text: '{"title": "Configuring the' }])
    const result = await tool.invoke({ text: SOURCE_TEXT })
    assert.equal(result.kind === 'error' ? result.code : result.kind, 'MODEL_OUTPUT_TRUNCATED')
    assert.equal('title' in result, false)
  })

  it('turns an EMPTY completion into an error, not an empty title', async () => {
    const { tool } = titleHarness([{ kind: 'text', text: '' }])
    const result = await tool.invoke({ text: SOURCE_TEXT })
    assert.equal(result.kind === 'error' ? result.code : result.kind, 'INVALID_MODEL_OUTPUT')
    assert.equal('title' in result, false)
  })

  it('turns a refusal INSIDE otherwise valid JSON into an error', async () => {
    // This is the response shape that looks like a result, which is why it is tested
    // separately from the provider-level refusal.
    const { tool } = titleHarness([
      { kind: 'text', text: JSON.stringify({ refused: true, refusalReason: 'the text has no titleable subject' }) },
    ])
    const result = await tool.invoke({ text: SOURCE_TEXT })
    assert.equal(result.kind === 'error' ? result.code : result.kind, 'MODEL_REFUSED')
    assert.equal('title' in result, false)
    assert.match(result.kind === 'error' ? result.reason : '', /no titleable subject/)
  })

  it('refuses an EMPTY or WHITESPACE title in valid JSON rather than accepting it', async () => {
    for (const title of ['', '   ', '\n\t ']) {
      const { tool } = titleHarness([{ kind: 'text', text: JSON.stringify({ title, description: 'anything' }) }])
      const result = await tool.invoke({ text: SOURCE_TEXT })
      assert.equal(result.kind, 'error', `${JSON.stringify(title)} must not be a valid title`)
      assert.equal('title' in result, false)
      assert.match(result.kind === 'error' ? result.reason : '', /empty title is an error/)
    }
  })

  it('checks the refusal FIRST, so it cannot fall through to the empty-title path', () => {
    const outcome = acceptTitle({ refused: true, title: '' }, SOURCE_TEXT)
    assert.equal(outcome.kind, 'refused')
  })

  it('reports the exhausted repair budget as exhausted, not as a failure to title', async () => {
    const { tool, provider } = titleHarness([{ kind: 'text', text: JSON.stringify({ title: '' }) }])
    const result = await tool.invoke({ text: SOURCE_TEXT })
    assert.equal(result.kind, 'error')
    assert.equal(result.kind === 'error' ? result.repairs : -1, 0)
    assert.match(result.kind === 'error' ? result.reason : '', /repair budget of 0 is exhausted/)
    assert.equal(provider.calls, 1, 'the default budget permits exactly one attempt')
  })
})

describe('TOOL-06 — no invented facts, no changed meaning', () => {
  it('REJECTS a number in the title that the source does not contain', async () => {
    const { tool } = titleHarness([
      { kind: 'text', text: JSON.stringify({ title: '10 Ways to Configure the Deployment Pipeline' }) },
    ])
    const result = await tool.invoke({ text: SOURCE_TEXT })
    assert.equal(result.kind, 'error')
    assert.match(result.kind === 'error' ? result.reason : '', /states "10", which does not appear in the source/)
  })

  it('accepts a number the source does contain', async () => {
    const source = 'The pipeline has 3 stages: build, test and deploy.'
    const { tool } = titleHarness([{ kind: 'text', text: JSON.stringify({ title: 'The 3 Pipeline Stages' }) }])
    const result = await tool.invoke({ text: source })
    assert.equal(result.kind, 'proposed')
  })

  it('REJECTS a title sharing no content word with the source', async () => {
    const { tool } = titleHarness([
      { kind: 'text', text: JSON.stringify({ title: 'Welcome to the Handbook' }) },
    ])
    const result = await tool.invoke({ text: SOURCE_TEXT })
    assert.equal(result.kind, 'error')
    assert.match(result.kind === 'error' ? result.reason : '', /shares no content word/)
  })
})

describe('RCP-04 — the response is one JSON document, or it is an error', () => {
  it('refuses a code-fenced document instead of unwrapping it', () => {
    const read = parseTitleResponse(`\`\`\`json\n${ACCEPTED_TITLE_JSON}\n\`\`\``)
    assert.equal(read.ok, false)
    assert.match(read.ok ? '' : read.reason, /code fence/)
  })

  it('refuses prose with a JSON object inside it', () => {
    const read = parseTitleResponse(`Here you go: ${ACCEPTED_TITLE_JSON}`)
    assert.equal(read.ok, false)
    assert.match(read.ok ? '' : read.reason, /not a single JSON object/)
  })

  it('refuses a response carrying fields the recipe did not ask for', () => {
    // Silently dropping them would accept a response whose schema is not the one that was
    // requested.
    const read = parseTitleResponse(JSON.stringify({ title: 'Deployment Pipeline', confidence: 0.9 }))
    assert.equal(read.ok, false)
    assert.match(read.ok ? '' : read.reason, /fields the recipe did not ask for \(confidence\)/)
  })

  it('refuses a field of the wrong type rather than coercing it', () => {
    assert.equal(parseTitleResponse(JSON.stringify({ title: 42 })).ok, false)
    assert.equal(parseTitleResponse(JSON.stringify({ refused: 'yes' })).ok, false)
  })

  it('reads a valid document', () => {
    const read = parseTitleResponse(ACCEPTED_TITLE_JSON)
    assert.equal(read.ok, true)
    assert.equal(read.ok ? read.response.title : '', 'Deployment pipeline configuration')
  })

  it('surfaces an invalid document as INVALID_MODEL_OUTPUT through the tool', async () => {
    const { tool } = titleHarness([{ kind: 'text', text: 'Sure! Here is your title.' }])
    const result = await tool.invoke({ text: SOURCE_TEXT })
    assert.equal(result.kind === 'error' ? result.code : result.kind, 'INVALID_MODEL_OUTPUT')
  })
})

describe('TOOL-06/HLM-07 — a title that is accepted, and repairs that are COUNTED', () => {
  it('proposes the accepted title and reports zero repairs', async () => {
    const { tool, records } = titleHarness([{ kind: 'text', text: ACCEPTED_TITLE_JSON }])
    const result = await tool.invoke({ text: SOURCE_TEXT })
    assert.equal(result.kind, 'proposed')
    if (result.kind !== 'proposed') return
    assert.equal(result.title, 'Deployment pipeline configuration')
    assert.equal(result.description, 'How to configure the deployment pipeline for staging and production.')
    assert.equal(result.repairs, 0)
    assert.equal(result.provider.generation, 1)
    assert.equal(result.recorded, true)
    assert.equal(records.entries.length, 1)
    // A proposal is never an empty title.
    assert.ok(result.title.trim().length > 0)
  })

  it('counts a permitted repair and reports the count', async () => {
    const limits: TitleLimits = { ...SECTION_TITLE_LIMITS, maxRepairs: 1 }
    const { tool, provider } = titleHarness([
      { kind: 'text', text: JSON.stringify({ title: '' }) },
      { kind: 'text', text: ACCEPTED_TITLE_JSON },
    ], limits)

    const result = await tool.invoke({ text: SOURCE_TEXT })
    assert.equal(result.kind, 'proposed')
    assert.equal(result.kind === 'proposed' ? result.repairs : -1, 1)
    assert.equal(provider.calls, 2)
  })

  it('keeps the repair inside the frozen recipe: original input plus validation feedback', async () => {
    const limits: TitleLimits = { ...SECTION_TITLE_LIMITS, maxRepairs: 1 }
    const { tool, provider } = titleHarness([
      { kind: 'text', text: JSON.stringify({ title: '' }) },
      { kind: 'text', text: ACCEPTED_TITLE_JSON },
    ], limits)
    await tool.invoke({ text: SOURCE_TEXT })

    const first = provider.requests[0]?.prompt ?? ''
    const second = provider.requests[1]?.prompt ?? ''
    // The first attempt omits the optional feedback binding entirely; the repair carries
    // it, and both carry the AUTHORIZED original input (HLM-07).
    assert.equal(first.includes('Validation feedback'), false)
    assert.match(second, /Validation feedback from a previous attempt: The previous attempt was rejected/)
    assert.match(second, /This section explains how to configure the deployment pipeline/)
    // The repair is not a second conversation: one user message, no history.
    assert.equal(provider.wire[1]?.messages.length, 1)
    assert.equal(JSON.stringify(provider.wire[1]).includes('"tools"'), false)
  })

  it('the tool\'s input schema comes from the recipe, and it calls no other tool', () => {
    const { tool } = titleHarness([{ kind: 'text', text: ACCEPTED_TITLE_JSON }])
    assert.equal(tool.recipe.id, TEXT_TITLE_RECIPE.id)
    assert.deepEqual(tool.inputSchema['required'], ['text'])
    assert.equal(tool.inputSchema['additionalProperties'], false)
    const properties = tool.inputSchema['properties'] as Record<string, Record<string, unknown>>
    assert.deepEqual(Object.keys(properties).sort(), ['kind', 'repairFeedback', 'text'])
    // TOOL-06: "do not call another tool". The prohibition is asserted, not described.
    assert.equal(mayCallAnotherTool(), false)
  })
})

describe('HLM-11/HLM-12 — describe_image transports typed media or refuses', () => {
  it('describes an image that reached the provider as typed media', async () => {
    const { tool, provider } = imageHarness([{ kind: 'text', text: 'A settings dialog with two fields.' }])
    const image = typedImage()
    const result = await tool.invoke({ image })

    assert.equal(result.kind, 'described')
    assert.equal(result.kind === 'described' ? result.description : '', 'A settings dialog with two fields.')
    const request = provider.requests[0]
    assert.deepEqual(request?.images?.[0]?.bytes, image.bytes)
    assert.equal(request?.images?.[0]?.mediaType, 'image/png')
    // The text part refers to the image; it never contains it.
    assert.match(request?.prompt ?? '', /\[image image\/png, \d+ bytes\]/)
  })

  it('REFUSES a text-only provider without calling it (HLM-11)', async () => {
    const { tool, provider } = imageHarness([{ kind: 'text', text: 'should never be produced' }], { images: 'unsupported' })
    const result = await tool.invoke({ image: typedImage() })
    assert.equal(result.kind, 'error')
    assert.equal(result.kind === 'error' ? result.code : '', 'IMAGE_INPUT_UNAVAILABLE')
    assert.equal(provider.calls, 0, 'the route must be rejected BEFORE any inference call')
  })

  it('refuses a non-image media type at the binding (UNSUPPORTED_MODALITY)', async () => {
    const { tool, provider } = imageHarness([{ kind: 'text', text: 'no' }])
    const result = await tool.invoke({ image: { mediaType: 'application/pdf', bytes: typedImage().bytes } })
    assert.equal(result.kind === 'error' ? result.code : result.kind, 'UNSUPPORTED_MODALITY')
    assert.equal(provider.calls, 0)
  })

  it('omits the optional focus line rather than sending undefined', async () => {
    const { tool, provider } = imageHarness([{ kind: 'text', text: 'A dialog.' }])
    await tool.invoke({ image: typedImage() })
    const prompt = provider.requests[0]?.prompt ?? ''
    assert.equal(prompt.includes('Requested focus'), false)
    assert.equal(prompt.includes('undefined'), false)
  })

  it('carries the focus when it is supplied', async () => {
    const { tool, provider } = imageHarness([{ kind: 'text', text: 'A dialog.' }])
    await tool.invoke({ image: typedImage(), focus: 'the button labels' })
    assert.match(provider.requests[0]?.prompt ?? '', /Requested focus: the button labels/)
  })

  it('carries no description on a failure', async () => {
    const { tool } = imageHarness([{ kind: 'refused', reason: 'the image is not readable' }])
    const result = await tool.invoke({ image: typedImage() })
    assert.equal(result.kind, 'error')
    assert.equal('description' in result, false)
  })
})

describe('RCP-12 — the built-ins are two recipes through one broker, not two code paths', () => {
  it('runs both built-ins against one broker instance with one policy', async () => {
    const text = new FakeProvider({ completions: [{ kind: 'text', text: ACCEPTED_TITLE_JSON }] })
    const vision = new FakeProvider({ images: 'supported', completions: [{ kind: 'text', text: 'A dialog.' }] })
    const records = recordCollector()
    const broker = new HarnessBroker({ record: records.sink })
    broker.authorize(TEXT_TITLE_TOOL, text)
    broker.authorize(DESCRIBE_IMAGE_TOOL, vision)

    const title = await createTextTitleTool({ broker }).invoke({ text: SOURCE_TEXT })
    const described = await createDescribeImageTool({ broker }).invoke({ image: typedImage() })

    assert.equal(title.kind, 'proposed')
    assert.equal(described.kind, 'described')
    // Two journal entries, one per invocation, and neither carries conversation.
    assert.equal(records.entries.length, 2)
    assert.deepEqual(records.entries.map(entry => entry.toolName), [TEXT_TITLE_TOOL, DESCRIBE_IMAGE_TOOL])
    // The requests differ only by what the recipes declare: images for one, none for the
    // other. Nothing in the broker's behaviour depends on the tool's NAME (RCP-12).
    assert.equal(text.requests[0]?.images, undefined)
    assert.equal(vision.requests[0]?.images?.length, 1)
    assert.deepEqual(
      Object.keys(text.requests[0] ?? {}).sort(),
      Object.keys(vision.requests[0] ?? {}).sort().filter(key => key !== 'images'),
    )
  })

  it('keeps both built-in recipes inside the format they are validated against', () => {
    assert.equal(TEXT_TITLE_RECIPE.policy.record, true)
    assert.equal(DESCRIBE_IMAGE_RECIPE.imageInputs.max, 1)
    assert.equal(typeof TEXT_TITLE_RECIPE.promptTemplate, 'string')
  })
})
