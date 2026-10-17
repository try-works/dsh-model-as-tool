/**
 * Authorized program bindings tests (CODE-03, SEC-03, ARCH-01).
 *
 * The assertion that matters most is that a refusal is ALL OR NOTHING. Binding the
 * reachable subset would produce a program that runs, quietly does something other than
 * what it declares, and reports success — which the caller cannot detect.
 *
 * Requirement links: CODE-03, SEC-03, ARCH-01, ARCH-05.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  authorizeProgramTools,
  describeRejections,
  isBindableName,
  type ToolBinding,
} from '../src/ptc-authority.ts'

/** A resolver that knows a fixed set of names. */
function resolverFor(names: readonly string[]) {
  const calls: string[] = []
  const resolve = (name: string): ToolBinding | undefined => {
    if (!names.includes(name)) return undefined
    return async args => {
      calls.push(name)
      return { called: name, args }
    }
  }
  return { resolve, calls }
}

const BOTH = { granted: ['fixture_echo', 'lang_detect'], visible: ['fixture_echo', 'lang_detect'] }

describe('CODE-03 — the bindable set is the INTERSECTION of grant and visibility', () => {
  it('binds a name that is both granted and visible', () => {
    const { resolve } = resolverFor(['fixture_echo'])
    const decision = authorizeProgramTools({ requested: ['fixture_echo'] }, BOTH, resolve)
    assert.equal(decision.ok, true)
    if (!decision.ok) return
    assert.deepEqual([...decision.bound], ['fixture_echo'])
  })

  it('REFUSES a registered tool the caller has no grant for', () => {
    const { resolve } = resolverFor(['fixture_echo', 'lang_detect'])
    const decision = authorizeProgramTools(
      { requested: ['lang_detect'] },
      { granted: ['fixture_echo'], visible: ['fixture_echo', 'lang_detect'] },
      resolve,
    )
    assert.equal(decision.ok, false)
    if (decision.ok) return
    assert.equal(decision.rejections[0]?.reason, 'forbidden')
  })

  it('REFUSES a granted tool that is not currently registered', () => {
    // A granted tool whose owning extension is deactivated is not available. Authorization
    // and availability are separate facts, and only the intersection is bindable.
    const { resolve } = resolverFor([])
    const decision = authorizeProgramTools(
      { requested: ['lang_detect'] },
      { granted: ['lang_detect'], visible: [] },
      resolve,
    )
    assert.equal(decision.ok, false)
    if (decision.ok) return
    assert.equal(decision.rejections[0]?.reason, 'unknown')
  })

  it('reports FORBIDDEN rather than UNKNOWN for an ungranted name', () => {
    // Telling a caller "unknown" for a name it may not use would let it infer the
    // difference between absent and forbidden, which it has not earned.
    const { resolve } = resolverFor(['secret_tool'])
    const decision = authorizeProgramTools(
      { requested: ['secret_tool'] },
      { granted: [], visible: ['secret_tool'] },
      resolve,
    )
    assert.equal(decision.ok, false)
    if (decision.ok) return
    assert.equal(decision.rejections[0]?.reason, 'forbidden')
  })
})

describe('CODE-07 — composition and management bindings are never exposed to a program', () => {
  for (const excluded of ['tool_mode_run', 'model_tools', 'tool_mode_list', 'tool_mode_describe']) {
    it(`refuses ${excluded} even when granted and visible`, () => {
      const { resolve } = resolverFor([excluded])
      const decision = authorizeProgramTools(
        { requested: [excluded] },
        { granted: [excluded], visible: [excluded] },
        resolve,
      )
      assert.equal(decision.ok, false, `${excluded} must never be a program binding`)
      if (decision.ok) return
      assert.equal(decision.rejections[0]?.reason, 'excluded')
      assert.match(decision.rejections[0]?.remedy ?? '', /CODE-07/)
    })
  }

  it('refuses the whole request when an excluded name is mixed with valid ones', () => {
    const { resolve } = resolverFor(['fixture_echo', 'tool_mode_run'])
    const decision = authorizeProgramTools(
      { requested: ['fixture_echo', 'tool_mode_run'] },
      { granted: ['fixture_echo', 'tool_mode_run'], visible: ['fixture_echo', 'tool_mode_run'] },
      resolve,
    )
    assert.equal(decision.ok, false)
    if (decision.ok) return
    assert.equal(decision.rejections[0]?.reason, 'excluded')
  })
})

describe('CODE-03 — a refusal is ALL OR NOTHING', () => {
  it('binds NOTHING when one requested name is refused', () => {
    const { resolve } = resolverFor(['fixture_echo'])
    const decision = authorizeProgramTools(
      { requested: ['fixture_echo', 'lang_detect'] },
      { granted: ['fixture_echo'], visible: ['fixture_echo'] },
      resolve,
    )
    // A partial namespace would run a program that does not do what it declares.
    assert.equal(decision.ok, false)
    assert.equal('bindings' in decision, false, 'no bindings may be produced on refusal')
  })

  it('reports EVERY rejection, not just the first', () => {
    const { resolve } = resolverFor([])
    const decision = authorizeProgramTools(
      { requested: ['a_tool', 'b_tool', 'c_tool'] },
      { granted: [], visible: [] },
      resolve,
    )
    assert.equal(decision.ok, false)
    if (decision.ok) return
    // A program asking for three tools it cannot have learns all three in one round.
    assert.deepEqual(decision.rejections.map(entry => entry.name), ['a_tool', 'b_tool', 'c_tool'])
  })

  it('names a duplicate rather than binding it twice', () => {
    const { resolve } = resolverFor(['fixture_echo'])
    const decision = authorizeProgramTools({ requested: ['fixture_echo', 'fixture_echo'] }, BOTH, resolve)
    assert.equal(decision.ok, false)
    if (decision.ok) return
    assert.equal(decision.rejections[0]?.reason, 'duplicate')
  })

  it('gives every rejection a remedy', () => {
    const { resolve } = resolverFor([])
    const decision = authorizeProgramTools(
      { requested: ['nope', 'constructor', 'dup', 'dup'] },
      { granted: [], visible: [] },
      resolve,
    )
    assert.equal(decision.ok, false)
    if (decision.ok) return
    for (const rejection of decision.rejections) {
      assert.ok(rejection.remedy.length > 0, `${rejection.name} needs a remedy`)
    }
  })

  it('describes a refusal in a way an author can act on', () => {
    const { resolve } = resolverFor([])
    const decision = authorizeProgramTools({ requested: ['nope'] }, { granted: [], visible: [] }, resolve)
    if (decision.ok) throw new Error('expected a refusal')
    const text = describeRejections(decision.rejections)
    assert.match(text, /nope: forbidden/)
  })
})

describe('SEC-03 — a binding name cannot reach the prototype', () => {
  it('REJECTS __proto__ as a binding name', () => {
    // Assigning `bindings.__proto__` would change the map's prototype rather than add a
    // field, which is why the name is refused before a map is built at all.
    assert.equal(isBindableName('__proto__'), false)
    const { resolve } = resolverFor(['__proto__'])
    const decision = authorizeProgramTools({ requested: ['__proto__'] }, { granted: ['__proto__'], visible: ['__proto__'] }, resolve)
    assert.equal(decision.ok, false)
    if (decision.ok) return
    assert.equal(decision.rejections[0]?.reason, 'invalid-name')
  })

  it('REJECTS prototype members, reserved words and runtime globals', () => {
    for (const name of ['constructor', 'toString', 'prototype', 'await', 'class', 'process', 'require', 'console', 'eval', 'Function', 'globalThis']) {
      assert.equal(isBindableName(name), false, `${name} must not be bindable`)
    }
  })

  it('ACCEPTS ordinary identifiers', () => {
    for (const name of ['fixture_echo', 'lang_detect', '$x', '_private', 'stt_transcribe']) {
      assert.equal(isBindableName(name), true, `${name} must be bindable`)
    }
  })

  it('builds the map with a NULL prototype, so nothing is inherited', () => {
    const { resolve } = resolverFor(['fixture_echo'])
    const decision = authorizeProgramTools({ requested: ['fixture_echo'] }, BOTH, resolve)
    assert.equal(decision.ok, true)
    if (!decision.ok) return
    // A program referencing `toString()` must fail rather than reach Object.prototype.
    assert.equal(Object.getPrototypeOf(decision.bindings), null)
    assert.equal((decision.bindings as Record<string, unknown>).toString, undefined)
  })

  it('makes each binding NON-WRITABLE, so a program cannot swap an implementation', () => {
    const { resolve } = resolverFor(['fixture_echo'])
    const decision = authorizeProgramTools({ requested: ['fixture_echo'] }, BOTH, resolve)
    if (!decision.ok) throw new Error('expected bindings')
    assert.throws(
      () => {
        ;(decision.bindings as Record<string, unknown>).fixture_echo = () => 'hijacked'
      },
      TypeError,
      'a program must not be able to replace a binding',
    )
  })
})

describe('CODE-03 — a bound call reaches the tool it names', () => {
  it('resolves the named implementation and passes the arguments through', async () => {
    const { resolve, calls } = resolverFor(['fixture_echo'])
    const decision = authorizeProgramTools({ requested: ['fixture_echo'] }, BOTH, resolve)
    if (!decision.ok) throw new Error('expected bindings')
    const value = await decision.bindings.fixture_echo({ token: 'x' })
    assert.deepEqual(value, { called: 'fixture_echo', args: { token: 'x' } })
    assert.deepEqual(calls, ['fixture_echo'])
  })

  it('binds in REQUEST order, so the generated program is stable', () => {
    const { resolve } = resolverFor(['lang_detect', 'fixture_echo'])
    const decision = authorizeProgramTools({ requested: ['lang_detect', 'fixture_echo'] }, BOTH, resolve)
    if (!decision.ok) throw new Error('expected bindings')
    assert.deepEqual([...decision.bound], ['lang_detect', 'fixture_echo'])
  })

  it('an empty request produces empty bindings rather than a refusal', () => {
    const { resolve } = resolverFor([])
    const decision = authorizeProgramTools({ requested: [] }, { granted: [], visible: [] }, resolve)
    // A program that calls nothing is legitimate; refusing it would make every
    // computation-only program impossible.
    assert.equal(decision.ok, true)
    if (!decision.ok) return
    assert.deepEqual([...decision.bound], [])
  })
})
