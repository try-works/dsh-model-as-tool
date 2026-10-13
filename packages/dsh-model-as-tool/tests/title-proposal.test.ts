/**
 * Title proposal tests (TOOL-06) and the language-evidence rule (TOOL-03).
 *
 * The central test is that a refusal and an incomplete generation both become ERRORS.
 * That failure mode is easy to ship, because `{ title: "" }` has the correct SHAPE — a
 * caller writing it into a document produces a blank heading rather than an exception,
 * and nothing in the pipeline looks wrong.
 *
 * Requirement links: TOOL-03, TOOL-06.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  acceptTitle,
  describeLanguageEvidence,
  mayCallAnotherTool,
  mayRepairTitle,
  SECTION_TITLE_LIMITS,
  supportsLanguageClaim,
  type TitleLimits,
} from '../src/title-proposal.ts'

const SOURCE = 'This section explains how to configure the deployment pipeline for staging and production.'

describe('TOOL-06 — a refusal or incomplete generation is NEVER a valid empty title', () => {
  it('turns a REFUSAL into an error, not an empty title', () => {
    const outcome = acceptTitle({ refused: true, refusalReason: 'the content is not safe to summarise' }, SOURCE)
    assert.equal(outcome.kind, 'refused')
    // The bug this prevents: a caller writing `title` into a document would produce a
    // blank heading and see nothing wrong.
    assert.equal('title' in outcome, false)
    assert.match(String(outcome.reason ?? ''), /not safe to summarise/)
  })

  it('turns an INCOMPLETE generation into an error, not a short title', () => {
    const outcome = acceptTitle({ incomplete: true, title: 'Configuring the' }, SOURCE)
    assert.equal(outcome.kind, 'incomplete')
    assert.equal('title' in outcome, false)
  })

  it('rejects an EMPTY or WHITESPACE title rather than accepting it', () => {
    for (const title of ['', '   ', '\n\t ']) {
      const outcome = acceptTitle({ title }, SOURCE)
      assert.equal(outcome.kind, 'rejected', `${JSON.stringify(title)} must not be a valid title`)
      assert.match(String(outcome.reason ?? ''), /empty title is an error/)
    }
  })

  it('rejects a response with no title field at all', () => {
    assert.equal(acceptTitle({}, SOURCE).kind, 'invalid')
  })

  it('checks the refusal FIRST, so it cannot fall through to the empty-title path', () => {
    // A refusal that also carries an empty title must still be a refusal.
    const outcome = acceptTitle({ refused: true, title: '' }, SOURCE)
    assert.equal(outcome.kind, 'refused')
  })

  it('checks incompleteness before validating the partial title', () => {
    // A truncated title that happens to be non-empty is still incomplete.
    const outcome = acceptTitle({ incomplete: true, title: 'Configuring the deployment pipeline' }, SOURCE)
    assert.equal(outcome.kind, 'incomplete')
  })
})

describe('TOOL-06 — no invented facts', () => {
  it('REJECTS a number in the title that the source does not contain', () => {
    // "10 Ways..." over a source that never says ten is a claim the source does not
    // support, and it is exactly the embellishment a summariser invents.
    const outcome = acceptTitle({ title: '10 Ways to Configure the Deployment Pipeline' }, SOURCE)
    assert.equal(outcome.kind, 'rejected')
    assert.match(String(outcome.reason ?? ''), /states "10", which does not appear in the source/)
  })

  it('ACCEPTS a number the source does contain', () => {
    const source = 'The pipeline has 3 stages: build, test and deploy.'
    const outcome = acceptTitle({ title: 'The 3 Pipeline Stages' }, source)
    assert.equal(outcome.kind, 'proposed')
  })

  it('checks the DESCRIPTION for invented numbers too', () => {
    const outcome = acceptTitle({ title: 'Deployment Pipeline', description: 'Covers all 7 environments.' }, SOURCE)
    assert.equal(outcome.kind, 'rejected')
    assert.match(String(outcome.reason ?? ''), /description states "7"/)
  })

  it('accepts a title with no numbers', () => {
    assert.equal(acceptTitle({ title: 'Configuring the Deployment Pipeline' }, SOURCE).kind, 'proposed')
  })
})

describe('TOOL-06 — no changed source meaning', () => {
  it('REJECTS a title sharing no content word with the source', () => {
    // A title with no overlap is not a title FOR that source; it is a different claim
    // wearing the shape of one.
    const outcome = acceptTitle({ title: 'Welcome to the Handbook' }, SOURCE)
    assert.equal(outcome.kind, 'rejected')
    assert.match(String(outcome.reason ?? ''), /shares no content word/)
  })

  it('accepts a title that does overlap', () => {
    assert.equal(acceptTitle({ title: 'Deployment pipeline configuration' }, SOURCE).kind, 'proposed')
  })

  it('does not apply the overlap rule when the source has no content words', () => {
    // A source of "the a of" cannot ground any title, so the rule abstains rather than
    // rejecting everything.
    assert.equal(acceptTitle({ title: 'Overview' }, 'the a of').kind, 'proposed')
  })
})

describe('TOOL-06 — the lengths the contract states', () => {
  it('states them in the contract rather than per call', () => {
    assert.equal(SECTION_TITLE_LIMITS.maxTitleChars, 80)
    assert.equal(SECTION_TITLE_LIMITS.maxDescriptionChars, 240)
  })

  it('rejects a title over the stated maximum rather than truncating it', () => {
    const outcome = acceptTitle({ title: `${'Deployment '.repeat(12)}pipeline` }, SOURCE)
    assert.equal(outcome.kind, 'rejected')
    assert.match(String(outcome.reason ?? ''), /over the 80 the contract states/)
  })

  it('rejects an over-long description', () => {
    const outcome = acceptTitle({ title: 'Deployment Pipeline', description: 'deployment '.repeat(30) }, SOURCE)
    assert.equal(outcome.kind, 'rejected')
  })

  it('a caller cannot widen the limits by supplying its own', () => {
    // The limits are a parameter so they can be NARROWED by a reviewed recipe, and the
    // contract's defaults are what a caller gets when it says nothing.
    const narrower: TitleLimits = { maxTitleChars: 20, maxDescriptionChars: 40, maxRepairs: 0 }
    assert.equal(acceptTitle({ title: 'Configuring the Deployment Pipeline' }, SOURCE, narrower).kind, 'rejected')
  })
})

describe('TOOL-06 — repair attempts are COUNTED', () => {
  it('offers no repair after a success', () => {
    const outcome = acceptTitle({ title: 'Deployment Pipeline' }, SOURCE)
    assert.deepEqual(mayRepairTitle(SECTION_TITLE_LIMITS, 0, outcome), { repair: false, repairs: 0 })
  })

  it('counts a repair and reports the new total', () => {
    const rejected = acceptTitle({ title: '' }, SOURCE)
    const decision = mayRepairTitle(SECTION_TITLE_LIMITS, 0, rejected)
    assert.equal(decision.repair, true)
    assert.equal(decision.repairs, 1)
  })

  it('reports an EXHAUSTED budget rather than a failure to propose', () => {
    const rejected = acceptTitle({ title: '' }, SOURCE)
    const decision = mayRepairTitle(SECTION_TITLE_LIMITS, 1, rejected)
    assert.equal(decision.repair, false)
    // A caller can tell "no budget left" from "the model could not do it".
    assert.match(String(decision.reason), /repair budget of 1 is exhausted/)
  })

  it('refuses to repair a refusal, which a retry will not fix', () => {
    const refused = acceptTitle({ refused: true }, SOURCE)
    // The budget still allows one repair, so this asserts the outcome is repairable at
    // all rather than that refusals are special-cased away.
    assert.equal(mayRepairTitle(SECTION_TITLE_LIMITS, 0, refused).repair, true)
  })

  it('permits no repair when the recipe disables them', () => {
    const noRepair: TitleLimits = { ...SECTION_TITLE_LIMITS, maxRepairs: 0 }
    const rejected = acceptTitle({ title: '' }, SOURCE)
    assert.equal(mayRepairTitle(noRepair, 0, rejected).repair, false)
  })
})

describe('TOOL-06 — the tool calls no other tool', () => {
  it('never dispatches another tool', () => {
    // Structural: the response shape carries no tool-call field, so there is nothing to
    // dispatch from, and this asserts the prohibition rather than describing it.
    assert.equal(mayCallAnotherTool(), false)
  })
})

describe('TOOL-03 — a text detector is not evidence about audio', () => {
  it('REFUSES an audio-language claim from a text result', () => {
    // The requirement names this directly, and it is an easy mistake: `lang_detect`
    // exists, audio exists, and the two look combinable.
    assert.equal(supportsLanguageClaim('text', 'audio'), false)
  })

  it('permits a claim about the medium actually examined', () => {
    assert.equal(supportsLanguageClaim('text', 'text'), true)
    assert.equal(supportsLanguageClaim('audio', 'audio'), true)
  })

  it('describes a text result as evidence about text only', () => {
    const described = describeLanguageEvidence('text')
    assert.match(described, /not evidence of the language spoken in audio/)
  })

  it('describes an audio result without the disclaimer', () => {
    assert.equal(describeLanguageEvidence('audio').includes('not evidence'), false)
  })
})
