import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { NEEDLE_TELEMETRY_ENV } from '../src/engine.ts'
import { buildScrubbedEnv, environmentNames } from '../src/process-bridge.ts'

test('NDL-06: the telemetry opt-outs are ALWAYS in the spawned child environment', () => {
  // The engine hands the posture to the bridge on every call; the bridge's
  // scrubbed env applies the caller's extras over the allow-list. The child
  // therefore receives NEEDLE_TELEMETRY=0 and DO_NOT_TRACK=1 regardless of the
  // parent environment.
  const childEnv = buildScrubbedEnv({ ...NEEDLE_TELEMETRY_ENV }, { PATH: 'C:/x', HOMEDRIVE: 'C:' })
  assert.equal(childEnv.NEEDLE_TELEMETRY, '0')
  assert.equal(childEnv.DO_NOT_TRACK, '1')
  assert.ok(environmentNames(childEnv).includes('DO_NOT_TRACK'))
  assert.ok(environmentNames(childEnv).includes('NEEDLE_TELEMETRY'))
  // The parent's secrets are never spread: only the allow-list + the extras.
  assert.equal(childEnv.TEST_SECRET, undefined)
})

test('NDL-06: the manifest claim matches the code posture (enforced, not assumed)', () => {
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), 'packages', 'extension-needle', 'tool-mode.extension.json'), 'utf8'),
  ) as { network: { requiredTelemetry: boolean; telemetryContent: string[]; otherNetworkUse: boolean } }
  assert.equal(manifest.network.requiredTelemetry, false)
  // The honest gap is recorded: the binary's honored set is NOT independently
  // verified, and the extension enforces the posture at the spawn boundary.
  assert.match(manifest.network.telemetryContent.join(' '), /NOT independently verified/)
  assert.match(manifest.network.telemetryContent.join(' '), /NEEDLE_TELEMETRY=0 and DO_NOT_TRACK=1/)
})
