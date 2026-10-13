/**
 * Contribution registrar tests (EXT-21..EXT-30, ARCH-06).
 *
 * The defect this file exists to prevent is that the host never mounted the lifecycle, so
 * an extension could be activated, report `observedActivation: 'active'`, list its tool —
 * and a caller still could not invoke it. The registrar is the missing half, and these
 * tests are about the properties that make it safe to hand to extension code.
 *
 * Requirement links: EXT-21, EXT-22, EXT-24, EXT-30, ARCH-06.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  ContributionError,
  createContributionRegistrar,
  type RegistrableTool,
} from '../src/extension-registrar.ts'

/** A host registry that records what was registered. */
function makeRegistry() {
  const tools = new Map<string, RegistrableTool>()
  const disposed: string[] = []
  return {
    tools,
    disposed,
    registry: {
      registerTool(tool: RegistrableTool) {
        tools.set(tool.name, tool)
        return () => {
          tools.delete(tool.name)
          disposed.push(tool.name)
        }
      },
    },
  }
}

const ACTIVATED = new Set(['@acme/one', '@acme/two'])

describe('EXT-21 — a published contribution reaches the registry', () => {
  it('registers a tool when its extension is activated', () => {
    const { registry, tools } = makeRegistry()
    const registrar = createContributionRegistrar({ registry, activated: ACTIVATED })
    registrar.publish({ extensionId: '@acme/one', kind: 'tool', name: 'acme_tool', contractId: 'acme.tool' })

    const registered = tools.get('acme_tool')
    assert.ok(registered, 'the tool must reach the registry')
    // The HOST stamps the owner, so a package cannot claim another's provenance.
    assert.equal(registered.ownerExtension, '@acme/one')
    assert.equal(registered.contractId, 'acme.tool')
  })

  it('REFUSES a contribution from an extension that is not activated', () => {
    const { registry, tools } = makeRegistry()
    const refused: string[] = []
    const registrar = createContributionRegistrar({
      registry,
      activated: ACTIVATED,
      onRefused: (_c, error) => refused.push(error.code),
    })
    // Publishing is a privilege of activation; without the check, any code holding the
    // registrar could register a tool under a package that was never installed.
    assert.throws(
      () => registrar.publish({ extensionId: '@evil/x', kind: 'tool', name: 'evil_tool' }),
      (error: unknown) => error instanceof ContributionError && error.code === 'unknown-extension',
    )
    assert.equal(tools.size, 0)
    assert.deepEqual(refused, ['unknown-extension'])
  })

  it('REFUSES a name collision rather than overwriting', () => {
    const { registry, tools } = makeRegistry()
    const registrar = createContributionRegistrar({ registry, activated: ACTIVATED })
    registrar.publish({ extensionId: '@acme/one', kind: 'tool', name: 'shared_name' })

    // Letting the second win would silently change what an existing caller reaches: the
    // same name would resolve to a different tool with no signal.
    assert.throws(
      () => registrar.publish({ extensionId: '@acme/two', kind: 'tool', name: 'shared_name' }),
      (error: unknown) => error instanceof ContributionError && error.code === 'name-collision',
    )
    assert.equal(tools.get('shared_name')?.ownerExtension, '@acme/one', 'the first owner keeps the name')
  })

  it('registers an implementation as NOTHING, because it is not a caller-facing tool', () => {
    const { registry, tools } = makeRegistry()
    const registrar = createContributionRegistrar({ registry, activated: ACTIVATED })
    // The model catalogue binds implementations; creating a tool here would produce a
    // caller-facing name with no implementation behind it.
    registrar.publish({ extensionId: '@acme/one', kind: 'implementation', name: 'acme-impl' })
    assert.equal(tools.size, 0)
  })
})

describe('EXT-24 — withdrawal is safe in every direction', () => {
  it('withdraws a published contribution and frees its name', () => {
    const { registry, tools } = makeRegistry()
    const registrar = createContributionRegistrar({ registry, activated: ACTIVATED })
    const handle = registrar.publish({ extensionId: '@acme/one', kind: 'tool', name: 'acme_tool' })
    assert.equal(tools.size, 1)

    registrar.withdraw(handle)
    assert.equal(tools.size, 0)
    // The name is free again, so a reinstall can take it.
    registrar.publish({ extensionId: '@acme/two', kind: 'tool', name: 'acme_tool' })
    assert.equal(tools.get('acme_tool')?.ownerExtension, '@acme/two')
  })

  it('is IDEMPOTENT: withdrawing twice does not throw', () => {
    const { registry } = makeRegistry()
    const registrar = createContributionRegistrar({ registry, activated: ACTIVATED })
    const handle = registrar.publish({ extensionId: '@acme/one', kind: 'tool', name: 'acme_tool' })
    registrar.withdraw(handle)
    registrar.withdraw(handle)
  })

  it('IGNORES a forged handle rather than treating it as a lookup', () => {
    const { registry, tools } = makeRegistry()
    const registrar = createContributionRegistrar({ registry, activated: ACTIVATED })
    registrar.publish({ extensionId: '@acme/one', kind: 'tool', name: 'acme_tool' })

    // A string, a number, an object that is not a handle: none may withdraw anything.
    registrar.withdraw('1')
    registrar.withdraw('acme_tool')
    registrar.withdraw(undefined as unknown as string)
    assert.equal(tools.size, 1, 'a forged handle must not withdraw a contribution')
  })

  it('does NOT let a reconstructed handle withdraw another extension tool', () => {
    const { registry, tools } = makeRegistry()
    const registrar = createContributionRegistrar({ registry, activated: ACTIVATED })
    registrar.publish({ extensionId: '@acme/one', kind: 'tool', name: 'first' })
    const second = registrar.publish({ extensionId: '@acme/two', kind: 'tool', name: 'second' })

    // An object with the right SHAPE and the right id is not the issued handle. Without
    // the identity check, an extension that guessed an id could withdraw a neighbour.
    const forged = { __contributionHandle: true, id: 1, extensionId: '@acme/one', name: 'first' }
    registrar.withdraw(forged as unknown as string)
    assert.ok(tools.has('first'), 'the real contribution must survive a forged handle')
    assert.ok(tools.has('second'))

    // And the genuine handle still works.
    registrar.withdraw(second)
    assert.equal(tools.has('second'), false)
  })

  it('withdraws only the contribution the handle belongs to', () => {
    const { registry, tools, disposed } = makeRegistry()
    const registrar = createContributionRegistrar({ registry, activated: ACTIVATED })
    const first = registrar.publish({ extensionId: '@acme/one', kind: 'tool', name: 'first' })
    registrar.publish({ extensionId: '@acme/two', kind: 'tool', name: 'second' })

    registrar.withdraw(first)
    assert.equal(tools.has('first'), false)
    assert.equal(tools.has('second'), true, 'the other contribution must be untouched')
    assert.deepEqual(disposed, ['first'])
  })
})

describe('EXT-30 — a second implementation joins rather than duplicating', () => {
  it('refuses two contributions of the same NAME from one extension', () => {
    const { registry } = makeRegistry()
    const registrar = createContributionRegistrar({ registry, activated: ACTIVATED })
    registrar.publish({ extensionId: '@acme/one', kind: 'tool', name: 'once' })
    assert.throws(
      () => registrar.publish({ extensionId: '@acme/one', kind: 'tool', name: 'once' }),
      (error: unknown) => error instanceof ContributionError && error.code === 'name-collision',
    )
  })

  it('allows the SAME name from a different extension after a withdrawal', () => {
    const { registry } = makeRegistry()
    const registrar = createContributionRegistrar({ registry, activated: ACTIVATED })
    const handle = registrar.publish({ extensionId: '@acme/one', kind: 'tool', name: 'relay' })
    registrar.withdraw(handle)
    // Reinstalling under a new owner is legitimate once the name is free.
    registrar.publish({ extensionId: '@acme/two', kind: 'tool', name: 'relay' })
  })
})
