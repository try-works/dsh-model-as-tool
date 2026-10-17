/**
 * Coherent publication tests (EXT-24).
 *
 * Each test targets a state EXT-24 says a consumer must never observe, or a rule it
 * states absolutely. The recurring theme is that the honest outcome is often to
 * publish LESS: a tool whose model is unprepared is withheld, and a skill whose
 * tool is absent is withheld, because a caller cannot distinguish "works" from
 * "will fail on first use" until it has already failed.
 *
 * Requirement links: EXT-24, EXT-32.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSurface,
  PublicationSurface,
  type ImplementationCandidate,
  type SkillCandidate,
  type ToolCandidate,
} from '../src/publication.ts'

/** An implementation that is prepared and callable. */
const ready = (modelId: string, extensionId = '@acme/ext'): ImplementationCandidate =>
  ({ extensionId, modelId, readiness: 'ready', runnable: true })

/** An implementation that is prepared but not resident in memory yet. */
const preparedCold = (modelId: string, extensionId = '@acme/ext'): ImplementationCandidate =>
  ({ extensionId, modelId, readiness: 'prepared-cold', runnable: true })

/** An implementation whose model is installed but not prepared. */
const unprepared = (modelId: string, extensionId = '@acme/ext'): ImplementationCandidate =>
  ({ extensionId, modelId, readiness: 'needs-preparation', runnable: true })

/** A tool candidate with one implementation, selected by default. */
function tool(name: string, implementations: ImplementationCandidate[], selected?: string): ToolCandidate {
  return {
    name,
    contractId: `tool-mode/${name}`,
    selectedModelId: selected ?? implementations[0]?.modelId ?? '',
    implementations,
  }
}

describe('EXT-24 — a tool is published only with an executable binding', () => {
  it('publishes a tool whose selected implementation is ready', () => {
    const surface = buildSurface({ generation: 2, tools: [tool('lang_detect', [ready('tongue')])], skills: [] })
    assert.equal(surface.tools.length, 1)
    assert.equal(surface.tools[0]?.name, 'lang_detect')
    assert.equal(surface.tools[0]?.extensionId, '@acme/ext')
    assert.equal(surface.generation, 2)
  })

  it('publishes a tool whose selected implementation is prepared but cold', () => {
    const surface = buildSurface({ generation: 2, tools: [tool('lang_detect', [preparedCold('tongue')])], skills: [] })
    assert.equal(surface.tools.length, 1)
    assert.equal(surface.tools[0]?.readiness, 'prepared-cold')
    assert.equal(surface.readiness[0]?.callable, true)
  })

  it('withholds a tool whose selected implementation cannot run here', () => {
    const surface = buildSurface({
      generation: 1,
      tools: [tool('stt_transcribe', [{ extensionId: '@acme/e', modelId: 'voz', readiness: 'ready', runnable: false }])],
      skills: [],
    })
    // A schema alone is a promise nothing can keep.
    assert.deepEqual([...surface.tools], [])
    assert.equal(surface.withheld[0]?.code, 'no-implementation')
    assert.equal(surface.readiness[0]?.callable, false)
  })

  it('withholds a tool whose selected implementation has failed', () => {
    const surface = buildSurface({
      generation: 1,
      tools: [tool('x', [{ extensionId: '@a', modelId: 'm', readiness: 'failed', runnable: true }])],
      skills: [],
    })
    assert.equal(surface.withheld[0]?.code, 'model-failed')
    // The message must say why waiting will not help.
    assert.match(surface.withheld[0]?.message ?? '', /will not become ready by waiting/)
  })
})

describe('EXT-24 — an unprepared model does not advertise working inference', () => {
  it('withholds the tool but publishes readiness instead', () => {
    const surface = buildSurface({ generation: 1, tools: [tool('x', [unprepared('m')])], skills: [] })
    assert.deepEqual([...surface.tools], [])
    assert.equal(surface.withheld[0]?.code, 'needs-preparation')
    // Readiness IS published: the operator needs to know the package is active and
    // what is missing, which is different from being told a tool works.
    assert.equal(surface.readiness.length, 1)
    assert.equal(surface.readiness[0]?.callable, false)
    assert.match(surface.readiness[0]?.reason ?? '', /not advertised as working/)
  })

  it('publishes a preparation skill even when nothing is callable', () => {
    const surface = buildSurface({
      generation: 1,
      tools: [tool('x', [unprepared('m')])],
      skills: [{ name: 'acme-setup', extensionId: '@acme/ext', purpose: 'preparation' }],
    })
    // Its whole purpose is to explain what to do about the missing preparation, so
    // withholding it would leave the operator with nothing.
    assert.deepEqual(surface.skills.map(skill => skill.name), ['acme-setup'])
    assert.equal(surface.skills[0]?.purpose, 'preparation')
  })

  it('publishes the tool once the model becomes ready', () => {
    const before = buildSurface({ generation: 1, tools: [tool('x', [unprepared('m')])], skills: [] })
    const after = buildSurface({ generation: 2, tools: [tool('x', [ready('m')])], skills: [] })
    assert.equal(before.tools.length, 0)
    assert.equal(after.tools.length, 1)
    assert.equal(after.generation, 2)
  })
})

describe('EXT-24 — a usage skill appears only where its tool is visible', () => {
  it('withholds a usage skill whose required tool is absent', () => {
    const surface = buildSurface({
      generation: 1,
      tools: [tool('x', [unprepared('m')])],
      skills: [{ name: 'acme-usage', extensionId: '@acme/ext', requiresTools: ['x'] }],
    })
    assert.deepEqual([...surface.skills], [])
    // Found by SUBJECT, not by position: the tool's own withholding is also in this
    // list, and asserting on index 0 would pass or fail for the wrong reason.
    const withheldSkill = surface.withheld.find(entry => entry.subject === 'acme-usage')
    assert.equal(withheldSkill?.code, 'unregistered-contribution')
    // The message names the missing tool so an operator can act on it.
    assert.match(withheldSkill?.message ?? '', /required tool\(s\) x are not visible/)
  })

  it('publishes a usage skill when every required tool is visible', () => {
    const surface = buildSurface({
      generation: 1,
      tools: [tool('x', [ready('m')])],
      skills: [{ name: 'acme-usage', extensionId: '@acme/ext', requiresTools: ['x'] }],
    })
    assert.deepEqual(surface.skills.map(skill => skill.name), ['acme-usage'])
  })

  it('withholds a skill that requires two tools when only one is visible', () => {
    const surface = buildSurface({
      generation: 1,
      tools: [tool('x', [ready('m')]), tool('y', [unprepared('m2')])],
      skills: [{ name: 'both', extensionId: '@acme/ext', requiresTools: ['x', 'y'] }],
    })
    assert.deepEqual([...surface.skills], [])
    const withheldSkill = surface.withheld.find(entry => entry.subject === 'both')
    assert.match(withheldSkill?.message ?? '', /required tool\(s\) y are not visible/)
  })

  it('publishes a skill that depends on nothing', () => {
    const surface = buildSurface({
      generation: 1,
      tools: [],
      skills: [{ name: 'general', extensionId: '@acme/ext' }],
    })
    assert.deepEqual(surface.skills.map(skill => skill.name), ['general'])
  })
})

describe('EXT-24 — the surface is built whole, then switched', () => {
  it('refuses duplicate tool names rather than silently dropping one', () => {
    assert.throws(
      () => buildSurface({
        generation: 1,
        tools: [tool('dup', [ready('a')]), tool('dup', [ready('b')])],
        skills: [],
      }),
      (error: unknown) => {
        // A name identifies one tool, so this cannot be resolved by withholding.
        assert.match((error as Error).message, /two contracts publish the tool name "dup"/)
        return true
      },
    )
  })

  it('hands consumers the whole change at once', () => {
    const swaps: { tools: number; previousTools: number }[] = []
    const surface = new PublicationSurface({
      onSwap: (next, previous) => swaps.push({ tools: next.tools.length, previousTools: previous.tools.length }),
    })
    assert.equal(surface.current.tools.length, 0)

    surface.publish(buildSurface({ generation: 2, tools: [tool('x', [ready('m')])], skills: [] }))
    // The callback saw BOTH sides, so a consumer never has to infer the difference
    // from a partially-updated view.
    assert.deepEqual(swaps, [{ tools: 1, previousTools: 0 }])
    assert.equal(surface.current.generation, 2)
  })

  it('never exposes a tool without its binding, across a swap', () => {
    const surface = new PublicationSurface()
    surface.publish(buildSurface({ generation: 2, tools: [tool('x', [ready('m')])], skills: [] }))
    // The published tool carries the extension and model that will actually serve
    // it, so there is no window in which the name is visible but the binding is not.
    for (const published of surface.current.tools) {
      assert.ok(published.extensionId.length > 0)
      assert.ok(published.modelId.length > 0)
    }
  })

  it('reports alternatives without making them the route', () => {
    const surface = buildSurface({
      generation: 1,
      tools: [tool('lang_detect', [ready('tongue'), ready('other')], 'tongue')],
      skills: [],
    })
    // EXT-22: a second implementation joins the candidate list, not the default
    // route. The operator's selection is what is published.
    assert.equal(surface.tools[0]?.modelId, 'tongue')
    assert.deepEqual([...surface.tools[0]?.alternatives ?? []], ['other'])
  })
})

describe('EXT-24 — skill provenance', () => {
  it('names the orphaned skills when an extension goes away', () => {
    const surface = new PublicationSurface()
    surface.publish(buildSurface({
      generation: 1,
      tools: [tool('x', [ready('m', '@acme/one')])],
      skills: [
        { name: 'one-skill', extensionId: '@acme/one', requiresTools: ['x'] },
        { name: 'two-skill', extensionId: '@acme/two' },
      ],
    }))
    // EXT-24: the host tracks provenance and removes a skill with its owner, rather
    // than leaving guidance that refers to a package nobody has.
    const orphaned = surface.orphanedSkills(['@acme/two'])
    assert.deepEqual(orphaned.map(skill => skill.name), ['one-skill'])
  })

  it('reports nothing orphaned while every owner is live', () => {
    const surface = new PublicationSurface()
    surface.publish(buildSurface({
      generation: 1,
      tools: [tool('x', [ready('m', '@acme/one')])],
      skills: [{ name: 'one-skill', extensionId: '@acme/one', requiresTools: ['x'] }],
    }))
    assert.deepEqual([...surface.orphanedSkills(['@acme/one'])], [])
  })
})

describe('EXT-24 — withholding is reported, never silent', () => {
  it('explains every contribution that did not reach the surface', () => {
    const skills: SkillCandidate[] = [{ name: 'needs-y', extensionId: '@acme/ext', requiresTools: ['y'] }]
    const surface = buildSurface({
      generation: 1,
      tools: [tool('x', [unprepared('m')]), tool('y', [unprepared('m2')])],
      skills,
    })
    // Two tools withheld (unprepared) and one skill withheld (its tool is absent).
    assert.equal(surface.withheld.length, 3)
    for (const entry of surface.withheld) {
      assert.ok(entry.message.length > 0, 'every withholding needs a reason')
      assert.ok(entry.subject.length > 0, 'every withholding needs a subject')
      assert.ok(entry.extensionId.length > 0, 'every withholding needs an owner')
    }
  })

  it('an empty candidate set publishes an empty surface rather than failing', () => {
    const surface = buildSurface({ generation: 1, tools: [], skills: [] })
    assert.deepEqual([...surface.tools], [])
    assert.deepEqual([...surface.skills], [])
    assert.deepEqual([...surface.withheld], [])
  })
})
