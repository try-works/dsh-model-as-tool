import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { callTool, cleanup, mountPlugin, tempDir } from './helpers.ts'

const BIN = join(process.cwd(), 'packages', 'dsh-model-as-tool', 'bin', 'dsh-tool-mode.mjs')

test('§12 config v3: the fixed-false flags REFUSE unsupported values (never accepted as ineffective)', async () => {
  await assert.rejects(
    mountPlugin({
      stateFile: join(tempDir(), 'state.json'),
      credentialsFile: join(tempDir(), 'credentials.json'),
      extensions: { automaticUpdates: true } as never,
    }),
    /extensions\.automaticUpdates is fixed false/,
  )
  await cleanup()
})

test('§12 config v3: the nested shape parses when the flags stay false', async () => {
  const ctx = await mountPlugin({
    stateFile: join(tempDir(), 'state.json'),
    credentialsFile: join(tempDir(), 'credentials.json'),
    schemaVersion: 3,
    mcpV3: { port: 3765, path: '/mcp', protocolVersions: ['2026-07-28'], legacyCompatibility: false },
    extensions: { automaticUpdates: false, runInstallScripts: false },
    recipesV3: { automaticActivation: false, allowExecutableTemplates: false },
    harnessExecutorV3: { inheritConversation: false, allowModelToolCalls: false },
  } as never)
  const result = await callTool(ctx, 'model_tools', { action: 'list' })
  assert.equal(result.isError, false)
  await cleanup()
})

test('DECL-07: tool_mode_list reports permitted tools + the catalog revision', async () => {
  const ctx = await mountPlugin({
    stateFile: join(tempDir(), 'state.json'),
    credentialsFile: join(tempDir(), 'credentials.json'),
  })
  const result = await callTool(ctx, 'tool_mode_list', {})
  assert.equal(result.isError, false, JSON.stringify(result))
  const value = result.value as { catalogRevision: string; tools: Array<{ name: string; readiness: string }> }
  assert.ok(value.catalogRevision.length > 0)
  assert.ok(value.tools.length > 0, 'the model catalog contributes tools')
  await cleanup()
})

test('DECL-07: tool_mode_describe returns schemas for a requested tool + refuses unknown names', async () => {
  const ctx = await mountPlugin({
    stateFile: join(tempDir(), 'state.json'),
    credentialsFile: join(tempDir(), 'credentials.json'),
  })
  const result = await callTool(ctx, 'tool_mode_describe', { tools: ['tool_mode_list'] })
  assert.equal(result.isError, false, JSON.stringify(result))
  const described = (result.value as { tools: Array<{ name: string; description: string }> }).tools[0]!
  assert.equal(described.name, 'tool_mode_list')
  assert.ok(described.description.length > 0)
  const unknown = await callTool(ctx, 'tool_mode_describe', { tools: ['no_such_tool_xyz'] })
  assert.equal(unknown.isError, true)
  await cleanup()
})

test('LIC-03: extensions-license-basis records the permission basis durably with the principal', async () => {
  const dir = tempDir()
  const ctx = await mountPlugin({
    stateFile: join(dir, 'state.json'),
    credentialsFile: join(dir, 'credentials.json'),
  })
  const result = await callTool(ctx, 'model_tools', {
    action: 'extensions-license-basis',
    model: '@try-works/extension-desert-ant-voz',
    licenseBasis: { native: true, export: true, distribution: false, telemetry: false },
    principal: 'operator-eve',
  })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal((result.value as { changed: boolean }).changed, true)
  const basisPath = join(dir, 'license-bases.json')
  assert.ok(existsSync(basisPath), 'the basis must be durable')
  const bases = JSON.parse(readFileSync(basisPath, 'utf8')) as Record<string, { principal: string; export: boolean }>
  assert.equal(bases['@try-works/extension-desert-ant-voz']!.principal, 'operator-eve')
  assert.equal(bases['@try-works/extension-desert-ant-voz']!.export, true)
  await cleanup()
})

test('P26-09: catalog transitions still settle after the notification wiring (emission side)', async () => {
  // The notifyCatalogChange hook fires on install/uninstall and update
  // commit/rollback; the delivery posture is recorded in
  // docs/tool-mode/OBS-04-subscriptions.md. This pins that the transitions the
  // hook rides on still succeed end to end.
  const ctx = await mountPlugin({
    stateFile: join(tempDir(), 'state.json'),
    credentialsFile: join(tempDir(), 'credentials.json'),
  })
  const listed = await callTool(ctx, 'model_tools', { action: 'list' })
  assert.equal(listed.isError, false)
  const models = (listed.value as { models: Array<{ id: string; runnable?: boolean }> }).models
  assert.ok(models.length > 0)
  const target = models.find(model => model.runnable !== false)?.id ?? models[0]!.id
  const disabled = await callTool(ctx, 'model_tools', { action: 'disable', model: target })
  assert.equal(disabled.isError, false, JSON.stringify(disabled))
  const enabled = await callTool(ctx, 'model_tools', { action: 'enable', model: target })
  assert.equal(enabled.isError, false, JSON.stringify(enabled))
  await cleanup()
})

test('RUN-04: the dsh-tool-mode launcher doctor works with --json and no secrets', () => {
  const run = spawnSync(process.execPath, [BIN, 'doctor', '--json'], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const doc = JSON.parse(run.stdout) as { ok: boolean; launcherSeam: string }
  assert.equal(doc.ok, true)
  assert.match(doc.launcherSeam, /headless/)
  assert.equal(run.stdout.includes('token'), false)
})

test('RUN-04: serve refuses a missing config with a named error; prepare without a store refuses', () => {
  // The serve seam is now a REAL composition entry (task-74): with no config
  // file it must fail fast with the named reason, never hang unattended.
  const serve = spawnSync(process.execPath, [BIN, 'serve', '--json'], { encoding: 'utf8', timeout: 60_000 })
  assert.notEqual(serve.status, 0)
  assert.match(serve.stdout, /"ok":false/)
  assert.match(serve.stdout, /could not be read/)
  const prepare = spawnSync(process.execPath, [BIN, 'prepare', '--tool', 'stt_transcribe', '--json'], { encoding: 'utf8' })
  assert.notEqual(prepare.status, 0)
  assert.match(prepare.stdout, /extension store/)
})

test('RUN-04: mcp-stdio fails fast without a credential (never hangs unattended)', () => {
  const run = spawnSync(process.execPath, [BIN, 'mcp-stdio'], {
    encoding: 'utf8',
    env: { ...process.env, DSH_TOOL_MODE_MCP_TOKEN: '' },
  })
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /no credential configured/)
})
