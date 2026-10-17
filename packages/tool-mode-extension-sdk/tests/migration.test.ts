/**
 * Legacy enable/disable migration tests (BASE-09, BASE-10, AT-18, EXT-30).
 *
 * The old world persisted ONE unversioned document — model-id era
 * `enabled`/`disabled` arrays, no version key (the host's legacy
 * `PersistedState`). These tests feed real-shaped fixtures through the
 * migration table and assert the two properties the requirements name hardest:
 * every preserved choice lands as a TOOL-level disable (never an install, never
 * an activation, never a preparation), and every unresolved or conflicting
 * mapping is REPORTED instead of silently enabling anything.
 *
 * Requirement links: BASE-09 (migration table clause), BASE-10, AT-18
 * (migration half), EXT-30 (update-era migration), AT-36 (disabled state
 * survives the upgrade).
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ExtensionStore,
  LEGACY_MODEL_MIGRATIONS,
  ManagementError,
  STATE_SCHEMA_VERSION,
  STATE_VERSION,
  admitsInvocation,
  applyLegacyChoices,
  installedInactive,
  parseLegacyModelState,
  summarize,
  type ExtensionState,
} from '../src/index.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(prefix = 'tmx-migration-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A legacy model-id era document, exactly as the old host persisted it. */
function legacyJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ enabled: [], disabled: [], ...overrides })
}

const TONGUE = '@try-works/extension-desert-ant-tongue'
const VOZ = '@try-works/extension-desert-ant-voz'
const RECIPES = '@try-works/extension-declarative-recipes'

describe('BASE-09 — the migration table is explicit and grounded', () => {
  it('lists exactly the legacy ids the new release tool set ships, in order', () => {
    // Explicit: a row exists for every mapped id and for nothing else; the ids
    // the old catalog shipped but the new world does not (align, uhm, ...) are
    // intentionally ABSENT so the lookup reports them unresolved by construction.
    assert.deepEqual(
      LEGACY_MODEL_MIGRATIONS.map(row => row.legacyModelId),
      ['tongue', 'voz', 'title'],
    )
    const rows = LEGACY_MODEL_MIGRATIONS
    assert.equal(new Set(rows.map(row => row.legacyModelId)).size, rows.length, 'legacy ids must be unique')
    assert.equal(new Set(rows.map(row => `${row.extensionId}/${row.toolName}`)).size, rows.length, 'destinations must be unique')
    // Every row names its new-world identity completely.
    for (const row of rows) {
      assert.ok(row.extensionId.length > 0)
      assert.ok(row.toolName.length > 0)
      assert.ok(row.contractId.length > 0)
    }
  })
})

describe('BASE-10 — disabled choices are preserved as tool-level disables', () => {
  it('migrates disabled model ids without installing, activating or preparing anything', async () => {
    const store = new ExtensionStore(scratch())
    const report = await store.migrateLegacyProfileState(
      'default',
      legacyJson({ disabled: ['tongue', 'voz'] }),
      '<DSH_HOME>/model-as-tool/state.json',
    )

    assert.equal(report.wroteState, true)
    assert.equal(report.alreadyCurrent, false)
    assert.equal(report.fromStateVersion, null)
    assert.equal(report.toStateVersion, STATE_VERSION)
    assert.equal(report.toSchemaVersion, STATE_SCHEMA_VERSION)

    const states = store.readProfileState('default')
    assert.equal(states.corrupt, false)
    assert.equal(states.value.length, 2)

    const tongue = states.value.find(state => state.extensionId === TONGUE)
    assert.ok(tongue !== undefined)
    assert.equal(tongue.installation, 'absent', 'migration must not claim the package is installed')
    assert.equal(tongue.desiredActivation, 'inactive', 'migration must not activate')
    assert.equal(tongue.observedActivation, 'inactive')
    assert.deepEqual(tongue.readiness, {}, 'migration must not claim any deployment prepared')
    assert.deepEqual(tongue.tools, [{ toolName: 'lang_detect', enabled: false }])
    assert.equal(tongue.export, 'not-exported')
    assert.equal(summarize(tongue), 'absent')

    const voz = states.value.find(state => state.extensionId === VOZ)
    assert.ok(voz !== undefined)
    assert.deepEqual(voz.tools, [{ toolName: 'stt_transcribe', enabled: false }])

    // The preserved facts are reported, not just applied.
    const preserved = report.entries.filter(entry => entry.kind === 'disabled-choice')
    assert.equal(preserved.length, 2)
    assert.ok(preserved.every(entry => entry.outcome === 'preserved'))
    assert.deepEqual(preserved.map(entry => entry.legacyModelId).sort(), ['tongue', 'voz'])

    // Nothing migrated is callable through the persisted-state predicate.
    for (const state of states.value) {
      assert.equal(admitsInvocation(state, state.tools[0]!.toolName), false)
    }
  })

  it('stages a legacy enable instead of granting it (an old enable is not consent)', async () => {
    const store = new ExtensionStore(scratch())
    const report = await store.migrateLegacyProfileState('default', legacyJson({ enabled: ['tongue'] }), 'legacy')

    const tongue = store.readProfileState('default').value.find(state => state.extensionId === TONGUE)
    assert.ok(tongue !== undefined)
    assert.equal(tongue.installation, 'absent')
    assert.equal(tongue.desiredActivation, 'inactive')
    assert.deepEqual(tongue.tools, [{ toolName: 'lang_detect', enabled: false }],
      'a legacy enable must NOT come back enabled')

    const staged = report.entries.filter(entry => entry.kind === 'enabled-choice')
    assert.equal(staged.length, 1)
    assert.equal(staged[0]?.outcome, 'staged')
    assert.match(String(staged[0]?.reason), /not consent/i)
  })

  it('treats an id in both lists as a conflict and keeps the disable', async () => {
    const store = new ExtensionStore(scratch())
    const report = await store.migrateLegacyProfileState('default', legacyJson({ enabled: ['voz'], disabled: ['voz'] }), 'legacy')

    const voz = store.readProfileState('default').value.find(state => state.extensionId === VOZ)
    assert.deepEqual(voz?.tools, [{ toolName: 'stt_transcribe', enabled: false }],
      'the disable must win (fail closed)')

    assert.equal(report.entries.some(entry => entry.kind === 'enabled-choice' && entry.outcome === 'conflicting'), true)
    assert.equal(report.entries.some(entry => entry.kind === 'disabled-choice' && entry.outcome === 'preserved'), true)
    assert.equal(report.entries.some(entry => entry.outcome === 'staged'), false, 'a conflict is never staged')
  })
})

describe('BASE-10 — unresolved mappings are reported, never silently enabled', () => {
  it('legacy ids with no table row produce report entries and no state', async () => {
    const store = new ExtensionStore(scratch())
    const report = await store.migrateLegacyProfileState(
      'default',
      legacyJson({ enabled: ['align', 'uhm'], disabled: ['ear'] }),
      'legacy',
    )

    // Three legacy ids, three unresolved entries, ZERO extensions: nothing to
    // attach a choice to means nothing is created, and nothing is enabled.
    assert.equal(report.entries.length, 3)
    for (const entry of report.entries) {
      assert.equal(entry.outcome, 'unresolved')
      assert.match(String(entry.reason), /no migration table row/i)
    }
    assert.deepEqual([...store.readProfileState('default').value], [])
  })

  it('a recorded provider with no mapping is reported and not substituted', async () => {
    const store = new ExtensionStore(scratch())
    const report = await store.migrateLegacyProfileState(
      'default',
      legacyJson({ disabled: ['voz'], providers: { voz: 'mystery-provider' } }),
      'legacy',
    )

    const entry = report.entries.find(candidate => candidate.kind === 'provider-selection')
    assert.ok(entry !== undefined)
    assert.equal(entry.outcome, 'unresolved')
    assert.match(String(entry.reason), /no mapping/i)

    const voz = store.readProfileState('default').value.find(state => state.extensionId === VOZ)
    assert.deepEqual(voz?.tools, [{ toolName: 'stt_transcribe', enabled: false }],
      'no implementation may be substituted for an unmapped provider')
  })
})

describe('BASE-09 — provider picks and prepared-asset mappings are preserved', () => {
  it('maps a recorded provider selection onto the disabled tool selection', async () => {
    const store = new ExtensionStore(scratch())
    const report = await store.migrateLegacyProfileState(
      'default',
      legacyJson({ disabled: ['tongue'], providers: { tongue: '@desert-ant-labs/tongue' } }),
      'legacy',
    )

    const entry = report.entries.find(candidate => candidate.kind === 'provider-selection')
    assert.equal(entry?.outcome, 'preserved')
    assert.equal(entry?.selectedImplementation, 'tongue-default')

    const tongue = store.readProfileState('default').value.find(state => state.extensionId === TONGUE)
    assert.deepEqual(tongue?.tools, [{
      toolName: 'lang_detect',
      enabled: false,
      selectedImplementation: 'tongue-default',
    }], 'the provider pick must ride on the disabled selection so re-enabling keeps it')
  })

  it('records prepared-asset mappings durably without claiming preparation', async () => {
    const store = new ExtensionStore(scratch())
    const report = await store.migrateLegacyProfileState(
      'default',
      legacyJson({ disabled: ['tongue'], preparedAssets: ['tongue'] }),
      'legacy',
    )

    const entry = report.entries.find(candidate => candidate.kind === 'prepared-asset')
    assert.equal(entry?.outcome, 'mapped')
    assert.equal(entry?.assetSet, 'tongue-bundled')
    assert.match(String(entry?.reason), /not claimed prepared/i)

    const tongue = store.readProfileState('default').value.find(state => state.extensionId === TONGUE)
    assert.deepEqual(tongue?.readiness, {}, 'a borrowed asset must not be reported as a prepared deployment')

    const document = JSON.parse(readFileSync(store.profileStatePath('default'), 'utf8')) as {
      migratedAssets?: { legacyAssetId: string; extensionId: string; modelId?: string; assetSet?: string }[]
    }
    assert.deepEqual(document.migratedAssets, [{
      legacyAssetId: 'tongue',
      extensionId: TONGUE,
      modelId: 'tongue',
      assetSet: 'tongue-bundled',
    }])
  })

  it('a prepared asset for a model-less tool is reported unresolved', async () => {
    const store = new ExtensionStore(scratch())
    const report = await store.migrateLegacyProfileState(
      'default',
      legacyJson({ enabled: ['title'], preparedAssets: ['title'] }),
      'legacy',
    )
    const entry = report.entries.find(candidate => candidate.kind === 'prepared-asset')
    assert.equal(entry?.outcome, 'unresolved')
    assert.match(String(entry?.reason), /no model deployment/i)
  })
})

describe('BASE-09 — the migrated state is versioned and idempotent', () => {
  it('stamps both version keys on the persisted state', async () => {
    const store = new ExtensionStore(scratch())
    await store.migrateLegacyProfileState('default', legacyJson({ disabled: ['tongue'] }), 'legacy')
    const document = JSON.parse(readFileSync(store.profileStatePath('default'), 'utf8')) as {
      stateVersion: unknown
      schemaVersion: unknown
    }
    assert.equal(document.stateVersion, 1)
    assert.equal(document.schemaVersion, STATE_SCHEMA_VERSION)
  })

  it('a second migration is a byte-identical no-op (double migration idempotent)', async () => {
    const store = new ExtensionStore(scratch())
    const input = legacyJson({ enabled: ['title'], disabled: ['tongue', 'voz'], providers: { tongue: 'tongue' } })
    const first = await store.migrateLegacyProfileState('default', input, 'legacy')
    assert.equal(first.wroteState, true)
    assert.ok(first.entries.length > 0)
    const bytes = readFileSync(store.profileStatePath('default'), 'utf8')
    const states = store.readProfileState('default').value

    const second = await store.migrateLegacyProfileState('default', input, 'legacy')
    assert.equal(second.alreadyCurrent, true)
    assert.equal(second.wroteState, false)
    assert.deepEqual([...second.entries], [], 'a no-op migration reports nothing to stage')
    assert.equal(readFileSync(store.profileStatePath('default'), 'utf8'), bytes, 'the file must not be rewritten')
    assert.deepEqual(store.readProfileState('default').value, states)
  })

  it('readProfileState round-trips the migrated states', async () => {
    const store = new ExtensionStore(scratch())
    await store.migrateLegacyProfileState('default', legacyJson({ disabled: ['voz'] }), 'legacy')
    const reopened = new ExtensionStore(store.rootDir)
    const read = reopened.readProfileState('default')
    assert.equal(read.corrupt, false)
    assert.equal(read.value[0]?.extensionId, VOZ)
  })

  it('still accepts a stateVersion-1 document from the pre-schemaVersion era', () => {
    const store = new ExtensionStore(scratch())
    mkdirSync(join(store.rootDir, 'profiles', 'default'), { recursive: true })
    // What the store wrote before the schemaVersion key was added: same era, no
    // schema key, no data change — reading it must not require a migration.
    writeFileSync(store.profileStatePath('default'), JSON.stringify({
      stateVersion: 1,
      profile: 'default',
      extensions: [installedInactive('@acme/tool-mode-topics')],
    }))
    const read = store.readProfileState('default')
    assert.equal(read.corrupt, false)
    assert.equal(read.value[0]?.extensionId, '@acme/tool-mode-topics')
  })

  it('readProfileState points a legacy-shaped file at the migration entry point', () => {
    const store = new ExtensionStore(scratch())
    mkdirSync(join(store.rootDir, 'profiles', 'default'), { recursive: true })
    writeFileSync(store.profileStatePath('default'), legacyJson({ disabled: ['tongue'] }))
    const read = store.readProfileState('default')
    assert.equal(read.corrupt, true)
    assert.deepEqual([...read.value], [])
    assert.match(String(read.diagnostic), /migrateLegacyProfileState/)
  })

  it('migrates a legacy-shaped document found at the profile path when no input is passed', async () => {
    const store = new ExtensionStore(scratch())
    mkdirSync(join(store.rootDir, 'profiles', 'default'), { recursive: true })
    writeFileSync(store.profileStatePath('default'), legacyJson({ disabled: ['tongue'] }))
    const report = await store.migrateLegacyProfileState('default')
    assert.equal(report.wroteState, true)
    assert.equal(report.legacySource, store.profileStatePath('default'))
    assert.deepEqual(
      store.readProfileState('default').value.find(state => state.extensionId === TONGUE)?.tools,
      [{ toolName: 'lang_detect', enabled: false }],
    )
  })

  it('reports a skip when there is nothing to migrate', async () => {
    const store = new ExtensionStore(scratch())
    const report = await store.migrateLegacyProfileState('default')
    assert.equal(report.wroteState, false)
    assert.equal(report.alreadyCurrent, false)
    assert.match(String(report.skippedReason), /no legacy document/i)
    assert.deepEqual([...report.entries], [])
  })
})

describe('BASE-09 — migration fails closed on documents it cannot interpret', () => {
  it('throws EXTENSION_FAULT and writes nothing when the input is not valid JSON', async () => {
    const store = new ExtensionStore(scratch())
    await assert.rejects(
      store.migrateLegacyProfileState('default', '{ this is not json', 'legacy'),
      (error: unknown) => {
        assert.ok(error instanceof ManagementError)
        assert.equal(error.code, 'EXTENSION_FAULT')
        assert.equal(error.operation, 'update')
        assert.match(error.message, /not valid JSON/)
        return true
      },
    )
    assert.equal(store.readProfileState('default').value.length, 0)
    assert.equal(store.readProfileState('default').corrupt, false)
  })

  it('throws when the input already carries a version key (not a legacy document)', async () => {
    const store = new ExtensionStore(scratch())
    await assert.rejects(
      store.migrateLegacyProfileState('default', JSON.stringify({ stateVersion: 1, enabled: [] }), 'legacy'),
      (error: unknown) => {
        assert.ok(error instanceof ManagementError)
        assert.match(error.message, /not a legacy model-id era document/)
        return true
      },
    )
  })

  it('refuses to overwrite state written by a different SDK', async () => {
    const store = new ExtensionStore(scratch())
    mkdirSync(join(store.rootDir, 'profiles', 'default'), { recursive: true })
    writeFileSync(store.profileStatePath('default'), JSON.stringify({
      stateVersion: STATE_VERSION + 1,
      schemaVersion: '9.9.9',
      profile: 'default',
      extensions: [installedInactive('@acme/future')],
    }))
    await assert.rejects(
      store.migrateLegacyProfileState('default', legacyJson({ disabled: ['tongue'] }), 'legacy'),
      (error: unknown) => {
        assert.ok(error instanceof ManagementError)
        assert.match(error.message, /different SDK/)
        return true
      },
    )
    const read = store.readProfileState('default')
    assert.equal(read.corrupt, true)
    assert.match(String(read.diagnostic), /different SDK/)
    // The newer document is untouched.
    const document = JSON.parse(readFileSync(store.profileStatePath('default'), 'utf8')) as { extensions: unknown[] }
    assert.equal(document.extensions[0]?.extensionId, '@acme/future')
  })

  it('throws when the profile path holds an unversioned document but a different legacy input was passed', async () => {
    const store = new ExtensionStore(scratch())
    mkdirSync(join(store.rootDir, 'profiles', 'default'), { recursive: true })
    writeFileSync(store.profileStatePath('default'), legacyJson({ disabled: ['tongue'] }))
    await assert.rejects(
      store.migrateLegacyProfileState('default', legacyJson({ disabled: ['voz'] }), 'legacy'),
      (error: unknown) => {
        assert.ok(error instanceof ManagementError)
        assert.match(error.message, /pass its content as the legacy input/i)
        return true
      },
    )
  })
})

describe('BASE-11 — the newer world wins; migration never overwrites an existing choice', () => {
  const activeTongue = (): ExtensionState => ({
    ...installedInactive(TONGUE),
    installation: 'installed',
    desiredActivation: 'active',
    observedActivation: 'active',
    readiness: { tongue: 'ready' },
    tools: [{ toolName: 'lang_detect', enabled: true }],
  })

  it('leaves an existing tool choice untouched and reports standing back', () => {
    const legacy = parseLegacyModelState(JSON.parse(legacyJson({ enabled: ['tongue'], disabled: ['voz'] })), 'legacy')
    assert.ok(legacy.state !== undefined)
    const applied = applyLegacyChoices(legacy.state, [activeTongue()])

    const tongue = applied.extensions.find(state => state.extensionId === TONGUE)
    assert.equal(tongue?.installation, 'installed', 'no dimension may be clobbered')
    assert.equal(tongue?.desiredActivation, 'active')
    assert.equal(tongue?.tools[0]?.enabled, true, 'an operator enable is never overwritten by an older legacy enable')
    assert.equal(
      applied.entries.some(entry => entry.kind === 'enabled-choice' && entry.outcome === 'existing-state-preserved'),
      true,
    )
  })

  it('merges a new tool into an existing extension entry without touching its dimensions', () => {
    const legacy = parseLegacyModelState(JSON.parse(legacyJson({ disabled: ['voz'] })), 'legacy')
    assert.ok(legacy.state !== undefined)
    const existing: ExtensionState = {
      ...installedInactive(VOZ),
      desiredActivation: 'active',
      observedActivation: 'active',
      readiness: { voz: 'preparing' },
      tools: [{ toolName: 'unrelated_tool', enabled: true }],
    }
    const applied = applyLegacyChoices(legacy.state, [existing])

    const voz = applied.extensions.find(state => state.extensionId === VOZ)
    assert.equal(voz?.desiredActivation, 'active', 'the merged entry keeps its activation')
    assert.deepEqual(voz?.readiness, { voz: 'preparing' })
    assert.equal(voz?.tools.length, 2)
    assert.deepEqual(voz?.tools[1], { toolName: 'stt_transcribe', enabled: false },
      'the preserved disable rides beside the existing tool selections')
  })

  it('a legacy title enable maps to the declarative recipe package, staged', () => {
    const legacy = parseLegacyModelState(JSON.parse(legacyJson({ enabled: ['title'] })), 'legacy')
    assert.ok(legacy.state !== undefined)
    const applied = applyLegacyChoices(legacy.state)

    const recipes = applied.extensions.find(state => state.extensionId === RECIPES)
    assert.ok(recipes !== undefined)
    assert.equal(recipes.installation, 'absent')
    assert.deepEqual(recipes.tools, [{ toolName: 'text_title', enabled: false }])
    assert.equal(
      applied.entries.some(entry => entry.kind === 'enabled-choice' && entry.outcome === 'staged' && entry.toolName === 'text_title'),
      true,
    )
  })
})

describe('BASE-09 — migrated prepared-asset mappings survive later lifecycle writes', () => {
  it('preserves migratedAssets through a writeProfileState that does not pass them', async () => {
    const store = new ExtensionStore(scratch())
    await store.migrateLegacyProfileState(
      'default',
      legacyJson({ disabled: ['tongue'], preparedAssets: ['tongue'] }),
      'legacy',
    )

    const recorded = store.readMigratedAssets('default')
    assert.equal(recorded.corrupt, false)
    assert.deepEqual(recorded.value, [{
      legacyAssetId: 'tongue',
      extensionId: TONGUE,
      modelId: 'tongue',
      assetSet: 'tongue-bundled',
    }])

    // The lifecycle writes states through writeProfileState WITHOUT the asset
    // parameter (lifecycle.ts #writeState); the store must keep the record
    // itself, or the first lifecycle toggle would silently drop it.
    const current = store.readProfileState('default').value
    store.writeProfileState('default', [
      ...current,
      installedInactive('@acme/other-extension'),
    ])
    assert.deepEqual(store.readMigratedAssets('default').value, recorded.value,
      'a later profile-state write must not drop the prepared-asset mappings')

    // An explicit empty array is the deliberate clear.
    store.writeProfileState('default', current, [])
    assert.deepEqual([...store.readMigratedAssets('default').value], [])
  })

  it('keeps readProfileState free of the asset record so writers cannot drop it silently', async () => {
    const store = new ExtensionStore(scratch())
    await store.migrateLegacyProfileState(
      'default',
      legacyJson({ disabled: ['tongue'], preparedAssets: ['tongue'] }),
      'legacy',
    )
    // The states array is the lifecycle's working surface; the asset record
    // travels beside it, not inside it.
    const states = store.readProfileState('default').value
    assert.equal(states.length, 1)
    assert.ok(!('migratedAssets' in (states[0] as unknown as Record<string, unknown>)))
  })
})

describe('BASE-09 — the read gate accepts exactly the stateVersion this SDK writes', () => {
  it('refuses a stateVersion 0 document instead of reading it as current', () => {
    const store = new ExtensionStore(scratch())
    mkdirSync(join(store.rootDir, 'profiles', 'default'), { recursive: true })
    writeFileSync(store.profileStatePath('default'), JSON.stringify({
      stateVersion: 0,
      profile: 'default',
      extensions: [installedInactive('@acme/wrong-era')],
    }))
    const read = store.readProfileState('default')
    assert.equal(read.corrupt, true)
    assert.deepEqual([...read.value], [])
    assert.match(String(read.diagnostic), /different SDK/)
  })

  it('refuses a non-number stateVersion', () => {
    const store = new ExtensionStore(scratch())
    mkdirSync(join(store.rootDir, 'profiles', 'default'), { recursive: true })
    writeFileSync(store.profileStatePath('default'), JSON.stringify({
      stateVersion: '1',
      profile: 'default',
      extensions: [],
    }))
    const read = store.readProfileState('default')
    assert.equal(read.corrupt, true)
    assert.match(String(read.diagnostic), /different SDK/)
  })

  it('the migration refuses to overwrite a stateVersion 0 document', async () => {
    const store = new ExtensionStore(scratch())
    mkdirSync(join(store.rootDir, 'profiles', 'default'), { recursive: true })
    writeFileSync(store.profileStatePath('default'), JSON.stringify({
      stateVersion: 0,
      profile: 'default',
      extensions: [],
    }))
    await assert.rejects(
      store.migrateLegacyProfileState('default', legacyJson({ disabled: ['tongue'] }), 'legacy'),
      (error: unknown) => {
        assert.ok(error instanceof ManagementError)
        assert.match(error.message, /different SDK/)
        return true
      },
    )
  })
})

describe('BASE-09 — a providers-only record preserves the pick durably', () => {
  it('attaches a resolved provider pick to a disabled tool selection and reports it truthfully', async () => {
    const store = new ExtensionStore(scratch())
    // The id appears ONLY in providers — no enable, no disable. The pick must
    // still land somewhere durable, or the report's 'preserved' would describe
    // a mapping that was never persisted.
    const report = await store.migrateLegacyProfileState(
      'default',
      legacyJson({ providers: { tongue: '@desert-ant-labs/tongue' } }),
      'legacy',
    )

    const tongue = store.readProfileState('default').value.find(state => state.extensionId === TONGUE)
    assert.deepEqual(tongue?.tools, [{
      toolName: 'lang_detect',
      enabled: false,
      selectedImplementation: 'tongue-default',
    }], 'the pick rides on a DISABLED selection; nothing is enabled by a pick alone')
    assert.equal(tongue?.installation, 'absent')

    const providerEntries = report.entries.filter(entry => entry.kind === 'provider-selection')
    assert.equal(providerEntries.length, 1)
    assert.equal(providerEntries[0]?.outcome, 'preserved')
    assert.equal(
      report.entries.some(entry => entry.kind === 'enabled-choice' || entry.kind === 'disabled-choice'),
      false,
      'a pick alone is neither an enable nor a disable and must not be reported as one',
    )
  })
})
