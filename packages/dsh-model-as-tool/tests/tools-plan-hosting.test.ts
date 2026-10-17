/**
 * The HOST-side tools_plan discipline (NDL-02, NDL-03), proved two ways.
 *
 * The pure-function suite proves the planning module's three guarantees directly:
 * the snapshot is FROZEN at capture (later registry changes cannot reach it and nobody
 * can mutate it), the requested-name gate rejects unknown/excluded/duplicate/unsnapshotted
 * names all-or-nothing, and the re-check moves proposals that are outside the snapshot,
 * schema-invalid, or no longer registered into `rejected` with the reasons.
 *
 * The end-to-end suite drives the REAL host path with a deterministic planning fixture:
 * install through the real installer, activate through the real lifecycle, publish
 * through the real registrar into the real DSH registry, and invoke through
 * `ctx.tools.execute`. The fixture's provider is scenario-keyed on the request text and
 * performs NO inference — the pinned Needle artifacts are not on this machine and are
 * deliberately not needed: the host pipeline (snapshot, gate, re-checks, meta stamping)
 * is the subject under test, exactly as the extension's own real-engine tests skip for
 * the same reason.
 *
 * Requirement links: NDL-02, NDL-03, EXT-17, EXT-21, EXT-24, ARCH-05.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import AdmZip from 'adm-zip'

import { ExtensionStore, createZipArchiveSource, stagedInstall } from '@try-works/tool-mode-extension-sdk'

import {
  captureToolSchemaSnapshot,
  describePlanningRejections,
  hasPlanningInputShape,
  offerToolsFromSnapshot,
  PLANNING_EXCLUDED_TOOLS,
  PLANNING_TOOL_NAME,
  ProviderDefectError,
  recheckProposals,
  type RegistryToolSchema,
  type ToolSchemaSnapshot,
} from '../src/planning.ts'
import { EXCLUDED_BINDINGS } from '../src/ptc-authority.ts'
import { cleanup, callTool, mountPlugin, tempDir } from './helpers.ts'

after(async () => { await cleanup() })

const ALPHA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { left: { type: 'number' }, right: { type: 'number' } },
  required: ['left', 'right'],
}

const BETA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { left: { type: 'number' }, right: { type: 'number' } },
  required: ['left', 'right'],
}

const EXCLUDED = PLANNING_EXCLUDED_TOOLS

/** A hand-built registry view the capture can freeze, without a DSH context.
 * Fresh objects per call: a mutation test must not leak into the shared ALPHA_SCHEMA. */
function fakeSchemas(): readonly RegistryToolSchema[] {
  return [
    {
      name: 'alpha_add',
      description: 'Add two numbers.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { left: { type: 'number' }, right: { type: 'number' } },
        required: ['left', 'right'],
      },
    },
    {
      name: 'beta_mul',
      description: 'Multiply two numbers.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { left: { type: 'number' }, right: { type: 'number' } },
        required: ['left', 'right'],
      },
    },
  ]
}

function captureFake(): ToolSchemaSnapshot {
  return captureToolSchemaSnapshot(fakeSchemas(), { generation: 7, excluded: EXCLUDED })
}

describe('planning module: the snapshot is frozen at capture (NDL-02)', () => {
  it('is a deep copy that later registry changes cannot reach', () => {
    const source = fakeSchemas()
    const snapshot = captureToolSchemaSnapshot(source, { generation: 1, excluded: EXCLUDED })

    // The ORIGINAL registry moves on: a tool is added, another withdrawn, a description
    // rewritten, and the captured parameters object itself is mutated in place.
    ;(source as unknown as RegistryToolSchema[]).push({
      name: 'gamma_after',
      description: 'Registered after capture.',
      parameters: { type: 'object', properties: {} },
    })
    source[0].description = 'CHANGED AFTER CAPTURE'
    ;(source[0].parameters as Record<string, unknown>).properties = { forged: { type: 'string' } }

    assert.equal(snapshot.tools.size, 2, 'only the two captured tools may be in the snapshot')
    assert.equal(snapshot.tools.get('alpha_add')?.description, 'Add two numbers.', 'the description must be the captured one')
    const alphaParameters = snapshot.tools.get('alpha_add')?.parameters as {
      properties: Record<string, unknown>
    }
    assert.deepEqual(
      alphaParameters.properties,
      { left: { type: 'number' }, right: { type: 'number' } },
      'the captured parameters must not share structure with the live registry',
    )
    assert.equal(snapshot.tools.has('gamma_after'), false, 'a tool registered after capture must not enter the snapshot')
    assert.equal(snapshot.generation, 1)
  })

  it('is deep-frozen, so nobody holding it can mutate it', () => {
    const snapshot = captureFake()
    // F1: the OUTER record is frozen too — "the snapshot is frozen" includes the
    // container a caller holds, not only the map and the entries inside it.
    assert.equal(Object.isFrozen(snapshot), true, 'the outer snapshot record must be frozen')
    assert.equal(Object.isFrozen(snapshot.tools), true, 'the map itself must be frozen')
    const entry = snapshot.tools.get('alpha_add')
    assert.ok(entry !== undefined)
    assert.equal(Object.isFrozen(entry), true, 'the entry must be frozen')
    assert.equal(Object.isFrozen(entry.parameters), true, 'the parameters must be frozen')
    assert.equal(
      Object.isFrozen((entry.parameters as { properties: Record<string, unknown> }).properties),
      true,
      'nested parameter nodes must be frozen',
    )
    // ESM is strict: mutating a frozen object throws rather than silently failing.
    assert.throws(() => {
      entry.description = 'forged'
    }, TypeError)
    assert.throws(() => {
      (entry.parameters as { properties: Record<string, unknown> }).properties = {}
    }, TypeError)
    assert.throws(() => {
      ;(snapshot as unknown as { generation: number }).generation = 99
    }, TypeError)
  })

  it('freezes the exclusion sets, so the two surfaces cannot desync through mutation (F3)', () => {
    // Frozen ARRAYS rather than frozen Sets: freezing a Set does not stop add/delete
    // (internal-slot mutation bypasses extensibility), so a frozen Set would only look
    // sealed. A frozen array throws on every mutation in strict mode.
    assert.equal(Object.isFrozen(PLANNING_EXCLUDED_TOOLS), true, 'the planning exclusion list must be frozen')
    assert.equal(Object.isFrozen(EXCLUDED_BINDINGS), true, 'the program-binding exclusion list must be frozen')
    assert.throws(() => {
      ;(PLANNING_EXCLUDED_TOOLS as unknown as string[]).push('forged_tool')
    }, TypeError)
    assert.throws(() => {
      ;(EXCLUDED_BINDINGS as unknown as string[]).pop()
    }, TypeError)
    // The planning list is built FROM the authority list, so a reader can trust that
    // everything the program pipeline excludes is also excluded from planning.
    for (const name of EXCLUDED_BINDINGS) {
      assert.equal(PLANNING_EXCLUDED_TOOLS.includes(name), true, `${name} must be excluded from planning too`)
    }
    assert.equal(PLANNING_EXCLUDED_TOOLS.includes(PLANNING_TOOL_NAME), true, 'the planner must not plan planning')
  })

  it('skips excluded names and turns an empty description into a stated placeholder', () => {
    const snapshot = captureToolSchemaSnapshot([
      { name: PLANNING_TOOL_NAME, description: 'the planner itself', parameters: ALPHA_SCHEMA },
      { name: 'model_tools', description: 'management', parameters: ALPHA_SCHEMA },
      { name: 'plain_tool', description: '   ', parameters: ALPHA_SCHEMA },
    ], { generation: 3 })
    assert.equal(snapshot.tools.has(PLANNING_TOOL_NAME), false, 'the planner must not plan planning')
    assert.equal(snapshot.tools.has('model_tools'), false, 'management names must never enter the snapshot')
    assert.equal(
      snapshot.tools.get('plain_tool')?.description,
      'No host description is declared for this tool.',
      'an empty description is replaced with a stated placeholder, never captured empty',
    )
  })
})

describe('planning module: the requested-name gate rejects rather than omits (NDL-02)', () => {
  it('refuses unknown, excluded and duplicate names all-or-nothing, naming every rejection', () => {
    const snapshot = captureFake()
    const live = new Set(['alpha_add', 'beta_mul'])

    const unknown = offerToolsFromSnapshot(snapshot, ['ghost_tool'], live)
    assert.equal(unknown.ok, false)
    assert.deepEqual(unknown.ok ? [] : unknown.rejections.map(rejection => rejection.reason), ['unknown'])

    const excluded = offerToolsFromSnapshot(snapshot, ['model_tools'], live)
    assert.equal(excluded.ok, false)
    assert.deepEqual(excluded.ok ? [] : excluded.rejections.map(rejection => rejection.reason), ['excluded'])

    const duplicate = offerToolsFromSnapshot(snapshot, ['alpha_add', 'alpha_add'], live)
    assert.equal(duplicate.ok, false)
    assert.deepEqual(duplicate.ok ? [] : duplicate.rejections.map(rejection => rejection.reason), ['duplicate'])

    // ALL-OR-NOTHING: one bad name refuses the whole request, and every rejection is
    // named in one round rather than one per retry.
    const mixed = offerToolsFromSnapshot(snapshot, ['alpha_add', 'ghost_tool', 'model_tools'], live)
    assert.equal(mixed.ok, false)
    assert.deepEqual(
      mixed.ok ? [] : mixed.rejections.map(rejection => `${rejection.name}:${rejection.reason}`),
      ['ghost_tool:unknown', 'model_tools:excluded'],
      'the offered subset must never be returned; the caller gets every rejection at once',
    )
  })

  it('refuses a live tool that was registered after the freeze, instead of offering a stale schema', () => {
    const snapshot = captureFake()
    const live = new Set(['alpha_add', 'gamma_after'])
    const decision = offerToolsFromSnapshot(snapshot, ['gamma_after'], live)
    assert.equal(decision.ok, false)
    const rejections = decision.ok ? [] : decision.rejections
    assert.deepEqual(rejections.map(rejection => rejection.reason), ['not-in-snapshot'])
    assert.match(rejections[0].remedy, /frozen snapshot/)
  })

  it('offers exactly the snapshot entries for every admitted name, in request order', () => {
    const snapshot = captureFake()
    const decision = offerToolsFromSnapshot(snapshot, ['beta_mul', 'alpha_add'], new Set(['alpha_add', 'beta_mul']))
    assert.equal(decision.ok, true)
    const offered = decision.ok ? decision.offered : []
    assert.deepEqual(offered.map(entry => entry.name), ['beta_mul', 'alpha_add'])
    // The offered entries ARE the frozen snapshot entries — a caller cannot edit them.
    assert.equal(offered[0], snapshot.tools.get('beta_mul'))
  })

  it('describes refusals readably', () => {
    const message = describePlanningRejections([{
      name: 'ghost_tool',
      reason: 'unknown',
      remedy: 'The tool is not currently registered.',
    }])
    assert.match(message, /ghost_tool: unknown/)
  })
})

describe('planning module: proposals are re-checked against the snapshot, the offered set and live authorization (NDL-02/03)', () => {
  it('passes a proposal that names a snapshot tool with valid arguments', () => {
    const snapshot = captureFake()
    const { payload, warnings } = recheckProposals(snapshot, {
      proposals: [{ name: 'alpha_add', arguments: { left: 2, right: 3 }, offered: true, valid: true, issues: [] }],
      rejected: [],
    }, new Set(['alpha_add']), () => true)
    assert.deepEqual(payload.proposals, [
      { name: 'alpha_add', arguments: { left: 2, right: 3 }, offered: true, valid: true, issues: [] },
    ])
    assert.deepEqual(payload.rejected, [])
    assert.deepEqual(warnings, [])
  })

  it('moves a proposal naming a tool outside the frozen snapshot to rejected', () => {
    const snapshot = captureFake()
    const { payload, warnings } = recheckProposals(snapshot, {
      proposals: [{ name: 'ghost_tool', arguments: {}, offered: false, valid: false, issues: [] }],
      rejected: [],
    }, new Set(['alpha_add']), () => true)
    assert.deepEqual(payload.proposals, [])
    const rejected = payload.rejected as Array<Record<string, unknown>>
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0].name, 'ghost_tool')
    assert.equal(rejected[0].offered, false, 'a name outside the snapshot was never offered by the host')
    assert.equal(rejected[0].valid, false)
    assert.match((rejected[0].issues as string[]).join('\n'), /frozen host-approved snapshot/)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /ghost_tool/)
  })

  it('moves a proposal whose arguments violate the FROZEN schema to rejected with the violations named', () => {
    const snapshot = captureFake()
    const { payload, warnings } = recheckProposals(snapshot, {
      proposals: [{ name: 'alpha_add', arguments: {}, offered: true, valid: true, issues: [] }],
      rejected: [],
    }, new Set(['alpha_add']), () => true)
    assert.deepEqual(payload.proposals, [])
    const rejected = payload.rejected as Array<Record<string, unknown>>
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0].name, 'alpha_add')
    assert.equal(rejected[0].valid, false)
    const issues = (rejected[0].issues as string[]).join('\n')
    assert.match(issues, /left|right/, 'the missing required properties must be named')
    assert.equal(warnings.length, 1)
  })

  it('refuses at execution time a proposal whose tool was withdrawn after capture (NDL-03)', () => {
    const snapshot = captureFake()
    // beta_mul was live when the snapshot froze; the authorization predicate now
    // refuses it — which is what a deactivated or withdrawn tool looks like at
    // re-check time, and what a quarantined tool looks like too (F2).
    const { payload, warnings } = recheckProposals(snapshot, {
      proposals: [{ name: 'beta_mul', arguments: { left: 2, right: 3 }, offered: true, valid: true, issues: [] }],
      rejected: [],
    }, new Set(['beta_mul']), name => name === 'beta_mul' ? 'it was withdrawn or deactivated after the snapshot was captured' : true)
    assert.deepEqual(payload.proposals, [])
    const rejected = payload.rejected as Array<Record<string, unknown>>
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0].name, 'beta_mul')
    assert.equal(rejected[0].valid, false, 'a proposal for a withdrawn tool must never be presented as a valid plan step')
    assert.match((rejected[0].issues as string[]).join('\n'), /no longer authorized/)
    assert.match((rejected[0].issues as string[]).join('\n'), /withdrawn or deactivated/)
    assert.equal(warnings.length, 1)
  })

  it('refuses a proposal whose tool is registered but no longer ADMITTED, naming the quarantine (F2)', () => {
    const snapshot = captureFake()
    // Registry membership alone is not admission: a quarantined extension's tool can
    // still be registered, and the fresh check must consult lifecycle admission.
    const { payload } = recheckProposals(snapshot, {
      proposals: [{ name: 'beta_mul', arguments: { left: 2, right: 3 }, offered: true, valid: true, issues: [] }],
      rejected: [],
    }, new Set(['beta_mul']), name => name === 'beta_mul' ? 'its extension no longer admits it (deactivated or quarantined)' : true)
    assert.deepEqual(payload.proposals, [])
    const rejected = payload.rejected as Array<Record<string, unknown>>
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0].name, 'beta_mul')
    assert.equal(rejected[0].valid, false, 'a registered-but-quarantined tool must land in rejected, not valid')
    assert.match((rejected[0].issues as string[]).join('\n'), /no longer admits it/)
  })

  it('refuses a proposal for a tool the host NEVER OFFERED this turn, however snapshotted and live (F6)', () => {
    const snapshot = captureFake()
    const { payload, warnings } = recheckProposals(snapshot, {
      proposals: [{ name: 'beta_mul', arguments: { left: 2, right: 3 }, offered: true, valid: true, issues: [] }],
      rejected: [],
    }, new Set(['alpha_add']), () => true)
    assert.deepEqual(payload.proposals, [], 'a never-offered tool must not pass as a valid proposal')
    const rejected = payload.rejected as Array<Record<string, unknown>>
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0].name, 'beta_mul')
    assert.equal(rejected[0].offered, false, 'the provider claimed offered, but the HOST decides the offered set')
    assert.match((rejected[0].issues as string[]).join('\n'), /not offered for this turn/)
    assert.equal(warnings.length, 1)
  })

  it('reports an uncompilable frozen schema as an issue rather than crashing the call', () => {
    const snapshot = captureToolSchemaSnapshot(
      [{ name: 'broken_tool', description: 'broken', parameters: { type: 'not-a-type' } }],
      { generation: 1, excluded: EXCLUDED },
    )
    const { payload } = recheckProposals(snapshot, {
      proposals: [{ name: 'broken_tool', arguments: {}, offered: true, valid: true, issues: [] }],
      rejected: [],
    }, new Set(['broken_tool']), () => true)
    assert.deepEqual(payload.proposals, [])
    const rejected = payload.rejected as Array<Record<string, unknown>>
    assert.match((rejected[0].issues as string[]).join('\n'), /does not compile/)
  })

  it('surfaces a malformed provider record as a PROVIDER DEFECT instead of coercing it (F7)', () => {
    const snapshot = captureFake()
    const malformed = { noName: true }
    assert.throws(() => recheckProposals(snapshot, {
      proposals: [malformed],
      rejected: [],
    }, new Set(['alpha_add']), () => true), ProviderDefectError)
    // Non-object arguments must not be silently coerced into {}.
    assert.throws(() => recheckProposals(snapshot, {
      proposals: [{ name: 'alpha_add', arguments: 'not-an-object', offered: true, valid: true, issues: [] }],
      rejected: [],
    }, new Set(['alpha_add']), () => true), ProviderDefectError)
    // Undeclared fields on a name-bearing record are a contract violation, not noise.
    assert.throws(() => recheckProposals(snapshot, {
      proposals: [{ name: 'alpha_add', arguments: {}, offered: true, valid: true, issues: [], executor: 'smuggled' }],
      rejected: [],
    }, new Set(['alpha_add']), () => true), ProviderDefectError)
  })

  it('recognizes the planning contribution by name plus declared input shape', () => {
    assert.equal(hasPlanningInputShape({
      properties: { tools: { type: 'array' } },
    }), true)
    assert.equal(hasPlanningInputShape({
      properties: { tools: { type: ['array', 'null'] } },
    }), true)
    assert.equal(hasPlanningInputShape({ properties: { text: { type: 'string' } } }), false)
    assert.equal(hasPlanningInputShape(undefined), false)
    assert.equal(hasPlanningInputShape({}), false)
  })
})

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/planning-extension', import.meta.url))
const EXTENSION_ID = '@try-works/fixture-planner'
const EXTENSION_VERSION = '1.0.0'

/** Archive the fixture, with its digest, exactly as the installer will verify it.
 * Per-file overrides let one fixture source drive the refusal variants. */
function packFixture(overrides: Record<string, string | Buffer> = {}): { bytes: Uint8Array; sha512: string } {
  const zip = new AdmZip()
  for (const relative of [
    'package.json',
    'tool-mode.extension.json',
    'lib/index.js',
    'models.lock.json',
    'schemas/tools-plan.input.json',
    'schemas/tools-plan.output.json',
    'schemas/structured-extract.input.json',
    'schemas/structured-extract.output.json',
  ]) {
    zip.addFile(relative, overrides[relative] ?? readFileSync(join(FIXTURE_DIR, relative)))
  }
  const bytes = new Uint8Array(zip.toBuffer())
  return { bytes, sha512: createHash('sha512').update(bytes).digest('hex') }
}

/** Install the fixture, approve it as active (a previous process), and mount the host. */
async function mountWithPlanner(): Promise<ReturnType<typeof mountPlugin>> {
  const storeDir = tempDir()
  const { bytes, sha512 } = packFixture()
  await stagedInstall({
    source: { kind: 'local', requested: FIXTURE_DIR },
    storeDir,
    expectedSha512: sha512,
    archive: createZipArchiveSource(() => bytes),
  })
  const store = new ExtensionStore(storeDir)
  store.writeProfileState('default', [{
    extensionId: EXTENSION_ID,
    installation: 'installed',
    desiredActivation: 'active',
    observedActivation: 'active',
    ownerPid: 2147483647,
    export: 'not-exported',
    tools: [
      { toolName: 'tools_plan', enabled: true },
      { toolName: 'structured_extract', enabled: true },
    ],
    readiness: {},
  }])

  const ctx = await mountPlugin({ extensionStore: storeDir })

  // The restore chain is async, so poll the REAL registry until both tools appear.
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const names = ctx.tools.schemas().map(schema => schema.name)
    if (names.includes('tools_plan') && names.includes('structured_extract')) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  const names = ctx.tools.schemas().map(schema => schema.name)
  assert.ok(names.includes('tools_plan'), `tools_plan must be registered after restore, saw: ${names.join(', ')}`)
  assert.ok(names.includes('structured_extract'), 'structured_extract must be registered after restore')
  return ctx
}

/** Register one deterministic leaf tool the planner may be asked about. */
function registerLeaf(ctx: ReturnType<typeof mountPlugin>, name: string, schema: Record<string, unknown>): () => void {
  const dispose = ctx.tools.register({
    name,
    description: `Fixture leaf tool ${name}.`,
    parameters: schema,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: Record<string, unknown>) {
      const left = (args as { left?: unknown }).left
      const right = (args as { right?: unknown }).right
      return { result: (left as number) + (right as number) }
    },
  } as never)
  return dispose
}

describe('the host serves tools_plan through the frozen-snapshot pipeline, end to end', () => {
  it('captures the snapshot on first use, offers snapshot entries, and stamps the meta envelope', async () => {
    const ctx = await mountWithPlanner()
    registerLeaf(ctx, 'alpha_add', ALPHA_SCHEMA)
    const betaDispose = registerLeaf(ctx, 'beta_mul', BETA_SCHEMA)

    const first = await callTool(ctx, 'tools_plan', { request: 'propose-first', tools: ['alpha_add'] })
    assert.equal(first.isError, false, `a valid plan must succeed: ${JSON.stringify(first)}`)
    const value = first.value as {
      proposals?: Array<Record<string, unknown>>
      rejected?: unknown[]
      meta?: Record<string, unknown>
    }
    assert.deepEqual(value.proposals, [
      { name: 'alpha_add', arguments: { left: 2, right: 3 }, offered: true, valid: true, issues: [] },
    ])
    assert.deepEqual(value.rejected, [])

    // EXT-17: the meta envelope is HOST-authored, and its identity comes from the
    // manifest facts the host resolved — not from anything the caller supplied.
    assert.ok(value.meta !== undefined, 'the meta envelope must be stamped')
    assert.equal(value.meta.contract, '@try-works/fixture-planner/tools_plan')
    assert.equal(value.meta.contractVersion, '1.0.0')
    assert.equal(value.meta.implementationId, 'fixture-planner-tools-plan')
    assert.equal(value.meta.extension, EXTENSION_ID)
    assert.equal(value.meta.extensionVersion, EXTENSION_VERSION)
    assert.equal(value.meta.executionLocation, 'device')
    assert.equal(typeof value.meta.receiptId, 'string')
    assert.ok((value.meta.receiptId as string).length > 0)
    assert.deepEqual(value.meta.warnings, [])

    // THE SNAPSHOT IS FROZEN AT CAPTURE: a tool registered after the first call has no
    // schema in the snapshot, and asking for it refuses with the exact reason.
    registerLeaf(ctx, 'gamma_after', ALPHA_SCHEMA)
    const late = await callTool(ctx, 'tools_plan', { request: 'propose-first', tools: ['gamma_after'] })
    assert.equal(late.isError, true, 'a tool registered after capture must be refused')
    assert.match(JSON.stringify(late), /not-in-snapshot/, 'the refusal must name the frozen snapshot')

    // The receipt is recorded, so the receipts action can answer for the call (EXT-35).
    const receipts = await callTool(ctx, 'model_tools', { action: 'receipts' })
    assert.equal(receipts.isError, false)
    const list = (receipts.value as { receipts?: Array<{ contract?: string; implementationId?: string }> }).receipts ?? []
    assert.ok(
      list.some(entry => entry.contract === '@try-works/fixture-planner/tools_plan' && entry.implementationId === 'fixture-planner-tools-plan'),
      'the planning call must be recorded as an invocation receipt',
    )

    betaDispose()
  })

  it('refuses unknown, excluded and duplicate requested names outright, never reaching the planner', async () => {
    const ctx = await mountWithPlanner()
    registerLeaf(ctx, 'alpha_add', ALPHA_SCHEMA)

    const unknown = await callTool(ctx, 'tools_plan', { request: 'propose-first', tools: ['ghost_tool'] })
    assert.equal(unknown.isError, true)
    assert.match(JSON.stringify(unknown), /ghost_tool: unknown/, 'an unregistered name must be rejected as unknown')

    const excluded = await callTool(ctx, 'tools_plan', { request: 'propose-first', tools: ['model_tools'] })
    assert.equal(excluded.isError, true)
    assert.match(JSON.stringify(excluded), /model_tools: excluded/, 'a management name must be rejected as excluded')

    const duplicate = await callTool(ctx, 'tools_plan', { request: 'propose-first', tools: ['alpha_add', 'alpha_add'] })
    assert.equal(duplicate.isError, true)
    assert.match(JSON.stringify(duplicate), /alpha_add: duplicate/)
  })

  it('moves proposals outside the snapshot or with invalid arguments to rejected, with warnings', async () => {
    const ctx = await mountWithPlanner()
    registerLeaf(ctx, 'alpha_add', ALPHA_SCHEMA)

    // A proposal for a name the host never offered: the engine cannot invent a plannable tool.
    const ghost = await callTool(ctx, 'tools_plan', { request: 'propose-ghost', tools: ['alpha_add'] })
    assert.equal(ghost.isError, false, `the call itself is well-formed: ${JSON.stringify(ghost)}`)
    const ghostValue = ghost.value as {
      proposals?: unknown[]
      rejected?: Array<Record<string, unknown>>
      meta?: { warnings?: string[] }
    }
    assert.deepEqual(ghostValue.proposals, [])
    assert.equal(ghostValue.rejected?.length, 1)
    assert.equal(ghostValue.rejected[0].name, 'ghost_tool')
    assert.equal(ghostValue.rejected[0].offered, false)
    assert.match((ghostValue.rejected[0].issues as string[]).join('\n'), /frozen host-approved snapshot/)
    assert.equal(ghostValue.meta?.warnings?.length, 1, 'the refusal must be reported as a warning')

    // Arguments that violate the frozen schema: the host reaches the verdict itself,
    // independently of the provider's own `valid: false`.
    const bad = await callTool(ctx, 'tools_plan', { request: 'propose-bad-args', tools: ['alpha_add'] })
    assert.equal(bad.isError, false)
    const badValue = bad.value as {
      proposals?: unknown[]
      rejected?: Array<Record<string, unknown>>
    }
    assert.deepEqual(badValue.proposals, [])
    assert.equal(badValue.rejected?.length, 1)
    assert.equal(badValue.rejected[0].name, 'alpha_add')
    assert.match((badValue.rejected[0].issues as string[]).join('\n'), /left|right/, 'the schema violations must be named')
  })

  it('refuses a proposal for a tool the host NEVER OFFERED this turn, over the real pipeline (F6)', async () => {
    const ctx = await mountWithPlanner()
    registerLeaf(ctx, 'alpha_add', ALPHA_SCHEMA)
    const betaDispose = registerLeaf(ctx, 'beta_mul', BETA_SCHEMA)

    // First call captures the snapshot while beta_mul is live.
    const first = await callTool(ctx, 'tools_plan', { request: 'propose-first', tools: ['alpha_add'] })
    assert.equal(first.isError, false)

    // beta_mul leaves the live registry — the same shape a deactivation has. The
    // REQUEST names only alpha_add (still live), so the gate admits it, but the
    // fixture proposes beta_mul: the host's per-call OFFERED set is exactly
    // [alpha_add], so the proposal is refused as never-offered for this turn. The
    // withdrawn-after-capture half of the fresh check is pinned at the module level
    // (the predicate is the host's own planningAuthorized wiring).
    betaDispose()
    assert.equal(ctx.tools.schemas().some(schema => schema.name === 'beta_mul'), false)

    const second = await callTool(ctx, 'tools_plan', { request: 'propose-beta', tools: ['alpha_add'] })
    assert.equal(second.isError, false, `the call itself is well-formed: ${JSON.stringify(second)}`)
    const value = second.value as {
      proposals?: unknown[]
      rejected?: Array<Record<string, unknown>>
      meta?: { warnings?: string[] }
    }
    assert.deepEqual(value.proposals, [], 'a proposal for a never-offered tool must not be returned')
    assert.equal(value.rejected?.length, 1)
    assert.equal(value.rejected[0].name, 'beta_mul')
    assert.equal(value.rejected[0].offered, false, 'the HOST decides the offered set, whatever the provider believed')
    assert.equal(value.rejected[0].valid, false)
    assert.match((value.rejected[0].issues as string[]).join('\n'), /not offered for this turn/)
    assert.equal(value.meta?.warnings?.length, 1, 'the refusal must be reported as a warning')
  })

  it('refuses at publication a tools_plan contribution WITHOUT the planning input shape (F5)', async () => {
    const storeDir = tempDir()
    // The manifest keeps the reserved name, but the declared input no longer
    // declares a `tools` array: the name without the shape must be refused.
    const { bytes, sha512 } = packFixture({
      'schemas/tools-plan.input.json': JSON.stringify({
        type: 'object',
        additionalProperties: false,
        required: ['request'],
        properties: { request: { type: 'string', minLength: 1 }, text: { type: 'string' } },
      }),
    })
    await stagedInstall({
      source: { kind: 'local', requested: FIXTURE_DIR },
      storeDir,
      expectedSha512: sha512,
      archive: createZipArchiveSource(() => bytes),
    })
    const store = new ExtensionStore(storeDir)
    store.writeProfileState('default', [{
      extensionId: EXTENSION_ID,
      installation: 'installed',
      desiredActivation: 'active',
      observedActivation: 'active',
      ownerPid: 2147483647,
      export: 'not-exported',
      tools: [
        { toolName: 'tools_plan', enabled: true },
        { toolName: 'structured_extract', enabled: true },
      ],
      readiness: {},
    }])

    const ctx = await mountPlugin({ extensionStore: storeDir })

    // Give the restore chain time to attempt publication and record the refusal.
    await new Promise(resolve => setTimeout(resolve, 600))
    assert.equal(
      ctx.tools.schemas().some(schema => schema.name === 'tools_plan'),
      false,
      'a tools_plan contribution without the planning shape must never reach the registry',
    )
    assert.equal(
      ctx.tools.schemas().some(schema => schema.name === 'structured_extract'),
      false,
      'the narrow rollback must withdraw the whole extension, not leave a half-published set',
    )
    const state = store.readProfileState('default').value[0]
    assert.ok(
      state?.observedActivation === 'failed' || state?.observedActivation === 'quarantined',
      `the extension must be failed or quarantined, not ${state?.observedActivation}`,
    )
  })

  it('refuses a provider-supplied reserved meta envelope on BOTH dispatch paths (F4)', async () => {
    const ctx = await mountWithPlanner()
    registerLeaf(ctx, 'alpha_add', ALPHA_SCHEMA)

    // The GENERIC path (structured_extract): a forged meta must never reach a caller.
    const extract = await callTool(ctx, 'structured_extract', { schema: { type: 'object' }, text: '__meta__' })
    assert.equal(extract.isError, true, 'a provider-authored meta must be refused')
    assert.match(JSON.stringify(extract), /reserved root/, 'the refusal must name the reservation')
    assert.match(JSON.stringify(extract), /host authors that metadata/)

    // The PLANNING path: the same boundary guards it, before any host stamping.
    const plan = await callTool(ctx, 'tools_plan', { request: 'propose-meta', tools: ['alpha_add'] })
    assert.equal(plan.isError, true, 'a forged meta on the planning path must be refused')
    assert.match(JSON.stringify(plan), /reserved root/)
  })

  it('serves structured_extract through the generic path with the same host-stamped envelope', async () => {
    const ctx = await mountWithPlanner()
    const result = await callTool(ctx, 'structured_extract', { schema: { type: 'object' }, text: 'hello' })
    assert.equal(result.isError, false, `a valid extraction must succeed: ${JSON.stringify(result)}`)
    const value = result.value as { extraction?: { title?: string }; meta?: Record<string, unknown> }
    assert.equal(value.extraction?.title, 'fixture title')
    assert.ok(value.meta !== undefined, 'the meta envelope must be stamped on the generic path too')
    assert.equal(value.meta.contract, '@try-works/fixture-planner/structured_extract')
    assert.equal(value.meta.implementationId, 'fixture-planner-structured-extract')
    assert.equal(value.meta.executionLocation, 'device')
  })
})
