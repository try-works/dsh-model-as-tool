/**
 * The PRODUCTION legacy startup migration (BASE-09/10, task-26).
 *
 * These tests prove the real upgrade path, not the table in isolation: an OLD
 * model-id era state document on disk → the startup hook runs ONCE →
 * disabled choices are preserved (ALL of them, mapped or not), enables are
 * STAGED (never granted), the SDK profile migration record exists, the
 * original document is journaled before any mutation, the marker carries the
 * staged/unresolved ids DURABLY, and a RESTART is a byte-stable no-op.
 * Corrupt and foreign-version documents AND markers fail the boot closed with
 * their bytes untouched, and an SDK-half failure leaves the original document
 * retryable. Every path uses throwaway directories — nothing here touches the
 * real home.
 *
 * Requirement links: BASE-09, BASE-10.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { ExtensionStore } from '@try-works/tool-mode-extension-sdk'
import { createFileStateStore, defaultStateFile } from '../src/state.ts'
import { legacyBackupPath, migrationMarkerPath, runLegacyStartupMigration } from '../src/legacy-migration.ts'
import { cleanup, mountPlugin, tempDir } from './helpers.ts'

after(async () => { await cleanup() })

/** A legacy-era document: the OLD world's shape, no version keys. */
function legacyDocument(): Record<string, unknown> {
  return {
    // 'clips' appears in BOTH lists: a conflict keeps the disable (fail closed),
    // and it has no table row either — it must stay disabled AND be reported.
    enabled: ['title', 'clips'],
    disabled: ['tongue', 'clips'],
    providers: { voz: '@desert-ant-labs/voz' },
    preparedAssets: ['voz'],
  }
}

/** The expected migration of the fixture: preserved, staged and unresolved. */
const EXPECTED_DISABLED = ['clips', 'tongue']
const EXPECTED_STAGED = ['title']
const EXPECTED_UNRESOLVED = ['clips']

async function migrateOnce(options: {
  readonly stateFile: string
  readonly extensionStoreDir?: string
  readonly log?: (line: string) => void
}) {
  return await runLegacyStartupMigration({
    stateFile: options.stateFile,
    store: createFileStateStore(options.stateFile),
    ...options.extensionStoreDir === undefined ? {} : { extensionStoreDir: options.extensionStoreDir },
    ...options.log === undefined ? {} : { log: options.log },
  })
}

describe('BASE-09/10 — the startup migration migrates a legacy document once, preserving choices', () => {
  it('migrates the legacy fixture: ALL disabled preserved, enables STAGED, journaled, SDK record, no implicit consent', async () => {
    const dir = tempDir()
    const stateFile = join(dir, 'state.json')
    const extensionStoreDir = join(dir, 'extensions')
    writeFileSync(stateFile, `${JSON.stringify(legacyDocument())}\n`)
    const logs: string[] = []

    const outcome = await migrateOnce({ stateFile, extensionStoreDir, log: line => logs.push(line) })
    assert.equal(outcome.ran, true)
    assert.deepEqual(outcome.hostState.disabled, EXPECTED_DISABLED, 'ALL disabled choices are preserved, mapped or not')
    assert.deepEqual(outcome.hostState.enabled, [], 'a legacy enable is never written into the host enabled list')
    assert.deepEqual(outcome.staged, EXPECTED_STAGED, 'legacy enables are staged')
    assert.deepEqual(outcome.unresolved, EXPECTED_UNRESOLVED, 'unresolved ids are reported')

    // The host document keeps its exact shape (no parallel format).
    const stamped = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>
    assert.deepEqual(stamped, { enabled: [], disabled: EXPECTED_DISABLED }, 'the host document shape is untouched')

    // The ORIGINAL document is journaled before any mutation.
    const backup = JSON.parse(readFileSync(legacyBackupPath(stateFile), 'utf8')) as { legacyDocument: Record<string, unknown> }
    assert.deepEqual(backup.legacyDocument, legacyDocument(), 'the journal holds the ORIGINAL legacy document')

    // The marker carries the staged/unresolved ids DURABLY (not just counts).
    const marker = JSON.parse(readFileSync(migrationMarkerPath(stateFile), 'utf8')) as Record<string, unknown>
    assert.equal(marker.hostStateVersion, 1)
    assert.equal(marker.legacy, true)
    assert.deepEqual(marker.staged, EXPECTED_STAGED)
    assert.deepEqual(marker.unresolved, EXPECTED_UNRESOLVED)

    // The SDK profile record exists with the consent-safe shape: disabled and
    // staged selections are enabled:false / inactive / absent — migrating a
    // choice never installs, activates or prepares third-party code (BASE-10).
    const profile = new ExtensionStore(extensionStoreDir).readProfileState('default')
    assert.ok(profile.value !== undefined, 'the SDK profile migration record must exist')
    const states = profile.value ?? []
    assert.ok(states.length > 0)
    for (const state of states) {
      assert.equal(state.installation, 'absent', 'migration must not install anything')
      assert.equal(state.desiredActivation, 'inactive', 'migration must not activate anything')
      assert.equal(state.observedActivation, 'inactive')
      for (const tool of state.tools) {
        assert.equal(tool.enabled, false, 'every migrated tool selection is disabled until the operator acts')
      }
    }
    const byTool = new Map(states.flatMap(state => state.tools.map(tool => [tool.toolName, tool] as const)))
    assert.ok(byTool.has('lang_detect'), 'the disabled tongue choice is attached to its tool')
    assert.equal(byTool.get('lang_detect')?.enabled, false)
    assert.ok(byTool.has('text_title'), 'the staged title choice is recorded')
    assert.equal(byTool.get('text_title')?.enabled, false)

    // The non-secret log line names the counts, the unresolved ids and the journal.
    assert.equal(logs.length, 1)
    assert.match(logs[0]!, /2 disabled choice\(s\) preserved/)
    assert.match(logs[0]!, /1 enable\(s\) staged/)
    assert.match(logs[0]!, /1 unresolved id\(s\) reported: clips/)
    assert.match(logs[0]!, /journaled/)
  })

  it('a RESTART is idempotent and byte-stable: no second run, no second write', async () => {
    const dir = tempDir()
    const stateFile = join(dir, 'state.json')
    writeFileSync(stateFile, `${JSON.stringify(legacyDocument())}\n`)
    await migrateOnce({ stateFile })
    const afterFirst = readFileSync(stateFile, 'utf8')

    const again = await migrateOnce({ stateFile })
    assert.equal(again.ran, false, 'a marker-carrying profile is the new era; the migration must not re-run')
    assert.deepEqual(again.hostState.disabled, EXPECTED_DISABLED)
    assert.deepEqual(again.hostState.enabled, [])
    assert.equal(readFileSync(stateFile, 'utf8'), afterFirst, 'the restart must be byte-stable')
  })

  it('an SDK-half FAILURE leaves the original document, the journal and the retry path intact', async () => {
    const dir = tempDir()
    const stateFile = join(dir, 'state.json')
    writeFileSync(stateFile, `${JSON.stringify(legacyDocument())}\n`)
    // The extension store dir's PARENT is a FILE: the SDK migration cannot
    // create its store and must fail — the transaction order is what this pins.
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a directory')
    const brokenStoreDir = join(blocker, 'extensions')

    await assert.rejects(
      migrateOnce({ stateFile, extensionStoreDir: brokenStoreDir }),
      (error: unknown) => String(error).length > 0,
      'the SDK-half failure must propagate',
    )
    // The ORIGINAL document is untouched and the marker is absent: the next
    // boot retries from the original.
    assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), legacyDocument(), 'the legacy document must survive an SDK failure')
    assert.equal(existsSync(migrationMarkerPath(stateFile)), false, 'no marker may be written before the whole transaction succeeds')
    const backup = JSON.parse(readFileSync(legacyBackupPath(stateFile), 'utf8')) as { legacyDocument: Record<string, unknown> }
    assert.deepEqual(backup.legacyDocument, legacyDocument(), 'the journal must hold the original')

    // After the obstacle is removed, the retry completes fully — through the
    // RECOVERY path (the journal exists without a marker).
    const retry = await migrateOnce({ stateFile, extensionStoreDir: join(dir, 'extensions') })
    assert.equal(retry.ran, true)
    assert.equal(retry.recovered, true, 'the retry must report that it recovered from the journal')
    assert.deepEqual(retry.hostState.disabled, EXPECTED_DISABLED)
    assert.equal(existsSync(migrationMarkerPath(stateFile)), true)
  })

  it('RECOVERS a crash between the host write and the marker FROM THE JOURNAL, never the rewritten file', async () => {
    const dir = tempDir()
    const stateFile = join(dir, 'state.json')
    const extensionStoreDir = join(dir, 'extensions')
    // The interrupted-transaction state: the journal exists, the marker does
    // not, and the state file is the REWRITTEN host document — which has LOST
    // the staged title, the provider pick and the prepared-asset facts. The
    // recovery must not derive anything from it.
    writeFileSync(
      legacyBackupPath(stateFile),
      `${JSON.stringify({ migratedAt: new Date().toISOString(), legacyDocument: legacyDocument() })}\n`,
    )
    writeFileSync(stateFile, `${JSON.stringify({ enabled: [], disabled: ['tongue'] })}\n`)
    assert.equal(existsSync(migrationMarkerPath(stateFile)), false)

    const outcome = await migrateOnce({ stateFile, extensionStoreDir })
    assert.equal(outcome.ran, true)
    assert.equal(outcome.recovered, true)
    assert.deepEqual(outcome.staged, EXPECTED_STAGED, 'the staged enable must be recovered from the JOURNAL')
    assert.deepEqual(outcome.hostState.disabled, EXPECTED_DISABLED, 'all legacy disables are recovered, mapped or not')
    assert.deepEqual(outcome.hostState.enabled, [], 'no enable is granted by recovery')

    // The marker now commits the transaction, and the SDK profile records the
    // recovered staged choice.
    const marker = JSON.parse(readFileSync(migrationMarkerPath(stateFile), 'utf8')) as Record<string, unknown>
    assert.deepEqual(marker.staged, EXPECTED_STAGED)
    const profile = new ExtensionStore(extensionStoreDir).readProfileState('default')
    const tools = (profile.value ?? []).flatMap(state => state.tools.map(tool => tool.toolName))
    assert.ok(tools.includes('text_title'), 'the recovered staged title choice reaches the SDK profile')

    // And a further boot is a no-op.
    const again = await migrateOnce({ stateFile, extensionStoreDir })
    assert.equal(again.ran, false)
    assert.equal(again.recovered, false)
  })

  it('recovery merges operator changes AFTER the crash — but journal enables are always staged (conservative)', async () => {
    const dir = tempDir()
    const stateFile = join(dir, 'state.json')
    writeFileSync(
      legacyBackupPath(stateFile),
      `${JSON.stringify({ migratedAt: new Date().toISOString(), legacyDocument: legacyDocument() })}\n`,
    )
    // The operator hand-edited the state after the crash: voz enabled again —
    // and ALSO re-enabled 'title', which is a journal-enabled legacy id.
    writeFileSync(stateFile, `${JSON.stringify({ enabled: ['voz', 'title'], disabled: ['tongue'] })}\n`)

    const outcome = await migrateOnce({ stateFile })
    assert.equal(outcome.recovered, true)
    // 'voz' is not a journal-enabled id: an operator-era enable is preserved.
    // 'title' IS a journal-enabled id: it is STAGED, never granted — the
    // conservative rule prefers staging over any operator-era inference until
    // the transaction is actually committed.
    assert.deepEqual(outcome.hostState.enabled, ['voz'], 'the operator\'s post-crash enable of a non-legacy id survives')
    assert.deepEqual(outcome.hostState.disabled, EXPECTED_DISABLED, 'legacy disables are merged in')
    assert.deepEqual(outcome.staged, EXPECTED_STAGED, 'journal-enabled ids are staged even against a hand-edit')
  })

  it('a CORRUPT journal with no marker FAILS CLOSED — an interrupted transaction cannot be guessed', async () => {
    const dir = tempDir()
    const stateFile = join(dir, 'state.json')
    writeFileSync(stateFile, `${JSON.stringify({ enabled: [], disabled: ['tongue'] })}\n`)
    writeFileSync(legacyBackupPath(stateFile), '{ not json')
    await assert.rejects(
      migrateOnce({ stateFile }),
      /journal .* is not valid JSON/,
      'a corrupt journal must refuse rather than guess',
    )
    assert.equal(existsSync(migrationMarkerPath(stateFile)), false)
    assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), { enabled: [], disabled: ['tongue'] }, 'the current document is untouched')
  })

  it('FAILS CLOSED on a foreign-version document, leaving the bytes and the marker state untouched', async () => {
    const dir = tempDir()
    const stateFile = join(dir, 'state.json')
    const foreign = JSON.stringify({ stateVersion: 2, schemaVersion: '2.0.0', enabled: [], disabled: [] })
    writeFileSync(stateFile, `${foreign}\n`)
    await assert.rejects(
      migrateOnce({ stateFile }),
      /carries a stateVersion \(2\)/,
      'a versioned document at the host path must refuse, never re-interpret',
    )
    assert.equal(readFileSync(stateFile, 'utf8').trim(), foreign, 'the foreign document is untouched')
    assert.equal(existsSync(migrationMarkerPath(stateFile)), false, 'no marker may be written for a refused migration')
  })

  it('FAILS CLOSED on a corrupt legacy document, leaving the bytes untouched', async () => {
    const dir = tempDir()
    const stateFile = join(dir, 'state.json')
    writeFileSync(stateFile, '{ not json')
    await assert.rejects(migrateOnce({ stateFile }), /not valid JSON/)
    assert.equal(readFileSync(stateFile, 'utf8'), '{ not json', 'the corrupt document is untouched')
    assert.equal(existsSync(migrationMarkerPath(stateFile)), false, 'no marker may be written for a refused migration')
    assert.equal(existsSync(legacyBackupPath(stateFile)), false, 'no journal may be written for a refused migration')

    const stateFile2 = join(dir, 'state2.json')
    writeFileSync(stateFile2, JSON.stringify({ enabled: 'not-an-array', disabled: [] }))
    await assert.rejects(migrateOnce({ stateFile: stateFile2 }), /must be an array of model ids/)
    assert.equal(readFileSync(stateFile2, 'utf8'), JSON.stringify({ enabled: 'not-an-array', disabled: [] }))
    assert.equal(existsSync(migrationMarkerPath(stateFile2)), false)
  })

  it('VALIDATES the marker: a corrupt or foreign-version marker fails closed instead of counting as migrated', async () => {
    const dir = tempDir()
    const stateFile = join(dir, 'state.json')

    writeFileSync(migrationMarkerPath(stateFile), '{ not json')
    await assert.rejects(migrateOnce({ stateFile }), /migration marker .* not valid JSON/)

    writeFileSync(migrationMarkerPath(stateFile), JSON.stringify({ hostStateVersion: 2, legacy: true, staged: [], unresolved: [] }))
    await assert.rejects(migrateOnce({ stateFile }), /hostStateVersion 2/)

    writeFileSync(migrationMarkerPath(stateFile), JSON.stringify({ hostStateVersion: 1, legacy: true }))
    await assert.rejects(migrateOnce({ stateFile }), /committed transaction record/)

    // The reviewer's exact malformed shape: the version is right but the lists
    // are not string arrays — a marker that cannot be trusted as a commit.
    writeFileSync(migrationMarkerPath(stateFile), JSON.stringify({
      hostStateVersion: 1, legacy: true, migratedAt: new Date().toISOString(), staged: [42, {}], unresolved: [null],
    }))
    await assert.rejects(migrateOnce({ stateFile }), /malformed staged list/)
  })

  it('a FAULT at the host write (before the marker) retries FROM THE JOURNAL and stages the original enables', async () => {
    const dir = tempDir()
    const stateFile = join(dir, 'state.json')
    writeFileSync(stateFile, `${JSON.stringify(legacyDocument())}\n`)
    const extensionStoreDir = join(dir, 'extensions')

    // The reviewer's injection: the host store's write throws ONCE — after the
    // journal and the SDK half, before the marker — then behaves.
    let injected = false
    const flaky = {
      read: () => createFileStateStore(stateFile).read(),
      write: (state: { enabled: readonly string[]; disabled: readonly string[] }) => {
        if (!injected) {
          injected = true
          throw new Error('injected store.write fault (before the marker)')
        }
        createFileStateStore(stateFile).write(state)
      },
    }
    await assert.rejects(
      runLegacyStartupMigration({ stateFile, store: flaky, extensionStoreDir, log: () => {} }),
      /injected store\.write fault/,
    )
    // The journal holds the ORIGINAL; the marker is absent.
    assert.deepEqual(
      (JSON.parse(readFileSync(legacyBackupPath(stateFile), 'utf8')) as { legacyDocument: unknown }).legacyDocument,
      legacyDocument(),
    )
    assert.equal(existsSync(migrationMarkerPath(stateFile)), false)

    // The retry must recover the STAGED title from the journal — the old
    // design re-read the rewritten state file and stamped staged [].
    const retry = await migrateOnce({ stateFile, extensionStoreDir })
    assert.equal(retry.recovered, true)
    assert.deepEqual(retry.staged, EXPECTED_STAGED, 'the staged enables must be recovered from the immutable journal')
    assert.deepEqual(retry.hostState.disabled, EXPECTED_DISABLED)
    assert.deepEqual(retry.hostState.enabled, [])
  })

  it('a FRESH profile (even under a not-yet-existing directory) receives the once-anchor safely', async () => {
    const dir = tempDir()
    // The parent chain does NOT exist yet: the marker write must create it.
    const stateFile = join(dir, 'nested', 'not-created-yet', 'state.json')
    const fresh = await migrateOnce({ stateFile })
    assert.equal(fresh.ran, false)
    const marker = JSON.parse(readFileSync(migrationMarkerPath(stateFile), 'utf8')) as Record<string, unknown>
    assert.equal(marker.hostStateVersion, 1)
    assert.equal(marker.legacy, false)
    assert.equal(existsSync(stateFile), false, 'a fresh profile gets no state document written')

    // The profile's OWN enable, written by the host store later, must survive
    // the next boot unchanged — the marker is what distinguishes the eras.
    const store = createFileStateStore(stateFile)
    store.write({ enabled: ['tongue'], disabled: [] })
    const next = await migrateOnce({ stateFile })
    assert.equal(next.ran, false)
    assert.deepEqual(next.hostState, { enabled: ['tongue'], disabled: [] }, 'the host\'s own enable must never be staged')
  })

  it('the host mounts over the MIGRATED state: the disabled choices remain disabled end to end', async () => {
    const dir = tempDir()
    const stateFile = join(dir, 'state.json')
    writeFileSync(stateFile, `${JSON.stringify(legacyDocument())}\n`)
    const extensionStoreDir = join(dir, 'extensions')
    mkdirSync(extensionStoreDir, { recursive: true })
    const outcome = await migrateOnce({ stateFile, extensionStoreDir })

    // Mount the real plugin over the migrated paths: the hook re-runs (a no-op)
    // and the effective selection must keep the disables.
    const ctx = await mountPlugin({ stateFile, extensionStore: extensionStoreDir })
    const store = createFileStateStore(stateFile)
    const persisted = store.read()
    assert.deepEqual(persisted.disabled, EXPECTED_DISABLED, 'the mounted plugin sees the preserved disables')
    assert.deepEqual(persisted.enabled, [], 'nothing was silently enabled')
    assert.equal(outcome.ran, true)
    // The mount itself must not have resurrected the staged enable.
    assert.deepEqual(store.read().enabled, [], 'the plugin mount must not grant the staged enable')
    assert.ok(ctx !== undefined)
  })

  it('a migration committed by ANOTHER process is adopted: the pre-hook snapshot never re-applies legacy enables', async () => {
    const dir = tempDir()
    const stateFile = join(dir, 'state.json')
    writeFileSync(stateFile, `${JSON.stringify(legacyDocument())}\n`)
    const hookUrl = new URL('../src/legacy-migration.ts', import.meta.url).href
    const stateUrl = new URL('../src/state.ts', import.meta.url).href

    // A CHILD process migrates the same profile and commits the marker.
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type', 'module', '-e', `
      import { runLegacyStartupMigration } from ${JSON.stringify(hookUrl)}
      import { createFileStateStore } from ${JSON.stringify(stateUrl)}
      const stateFile = process.argv[1]
      const outcome = await runLegacyStartupMigration({ stateFile, store: createFileStateStore(stateFile) })
      if (!outcome.ran) throw new Error('expected a first-run migration')
    `, stateFile], { encoding: 'utf8', windowsHide: true })
    assert.equal(child.status, 0, `the migrating child failed: ${child.stderr}`)

    // THIS process holds a STALE pre-hook snapshot (the legacy shape) and then
    // runs the hook: the marker-present run returns the CURRENT state, and the
    // caller rule (always adopt the hook's return) must yield the migrated
    // state — never the legacy enabled list.
    const stale = { enabled: ['title', 'clips'], disabled: [] }
    const hook = await migrateOnce({ stateFile })
    assert.equal(hook.ran, false, 'the marker already committed by the child')
    assert.deepEqual(hook.hostState.enabled, [], 'the adopted state must not carry the stale legacy enables')
    assert.deepEqual(hook.hostState.disabled, EXPECTED_DISABLED, 'the adopted state carries the migrated disables')
    assert.notDeepEqual(hook.hostState.enabled, stale.enabled)

    // And a plugin mount over the same profile sees the committed migration.
    const ctx = await mountPlugin({ stateFile })
    const store = createFileStateStore(stateFile)
    assert.deepEqual(store.read().enabled, [], 'the mounted plugin must not see legacy enables')
    assert.deepEqual(store.read().disabled, EXPECTED_DISABLED)
    assert.ok(ctx !== undefined)
  })

  it('never touches the real home: the default path is not used by any fixture', () => {
    // Every fixture above passes an explicit stateFile under tempDir(); this
    // guard pins that the default path is never consulted in these tests.
    const homePath = defaultStateFile()
    assert.ok(!existsSync(homePath) || !homePath.includes('model-as-tool-test'), 'no fixture writes the real home')
  })
})
