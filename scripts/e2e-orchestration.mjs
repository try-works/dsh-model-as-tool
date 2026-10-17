/**
 * AT-40 / AT-90 — end-to-end orchestration over PACKED artifacts.
 *
 * Chains, against the real tarballs installed into a throwaway clean project
 * (the scripts/verify-packed-install.mjs discipline — no workspace junction, no
 * devDependencies, plain Node, import by package name):
 *
 *   AT-40: packed install -> preparation (list/describe) -> two MCP clients
 *          (one authenticated, one refused) -> composition (attempted, SKIPPED
 *          with a reason when the DSH PTC backend is not in the packed closure)
 *          -> lifecycle (disable/enable) -> evidence (receipts).
 *   AT-90: clean-user scenario — listing -> describe -> two REAL calls
 *          (lang_detect de + en, the bundled Tongue model; real inference,
 *          offline) -> disable/enable round-trip with the refusal path asserted
 *          -> receipts show the calls -> uninstall leaves no publications.
 *
 * Every stage prints one evidence line: `STAGE <name> <OK|SKIPPED|FAIL> <detail>`.
 * A FAIL (or a missing required stage) makes the script exit nonzero. SKIPPED is
 * the honest outcome for a stage that needs an artifact this offline run does
 * not have (a harness-model provider for text_title, a DSH PTC deployment for
 * hosted composition) — it is never dressed up as a pass.
 *
 * OPT-IN, not wired into `verify`: the pack/install stage reaches the configured
 * npm registry for third-party transitive deps (the same class of dependency
 * `verify:packed` already has), and running it doubles that work. It is
 * deterministic apart from that registry step: every model call here runs the
 * bundled offline Tongue model.
 *
 * Usage: node scripts/e2e-orchestration.mjs [--checkout <path>]
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHECKOUT = resolve(
  process.argv.includes('--checkout')
    ? process.argv[process.argv.indexOf('--checkout') + 1]
    : process.env.DSH_CHECKOUT ?? 'D:/deepseek-harness',
)

/** This repository's publishable packages (mirrored from scripts/verify-packed-install.mjs). */
const WORKSPACE = {
  '@try-works/tool-mode-contracts': 'packages/tool-mode-contracts',
  '@try-works/tool-mode-extension-sdk': 'packages/tool-mode-extension-sdk',
  '@try-works/tool-mode-recipes': 'packages/tool-mode-recipes',
  '@try-works/extension-desert-ant-tongue': 'packages/extension-desert-ant-tongue',
  '@try-works/extension-desert-ant-voz': 'packages/extension-desert-ant-voz',
}

const scratch = mkdtempSync(join(tmpdir(), 'e2e-orchestration-'))
const tarballs = join(scratch, 'tarballs')
const staging = join(scratch, 'staging')
const project = join(scratch, 'project')
mkdirSync(tarballs, { recursive: true })
mkdirSync(staging, { recursive: true })
mkdirSync(project, { recursive: true })

// On Windows the sandbox cannot spawn `npm.cmd` directly (EINVAL); route through
// the command processor (the verify-packed-install.mjs convention).
function npm(args, cwd, timeoutMs = 300_000) {
  const spawnArgs = process.platform === 'win32'
    ? { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', ['npm', ...args].join(' ')] }
    : { file: 'npm', args }
  return spawnSync(spawnArgs.file, spawnArgs.args, { cwd, encoding: 'utf8', timeout: timeoutMs })
}

/** Find a package directory in the checkout by its declared name. */
const NAME_INDEX = (() => {
  const index = new Map()
  for (const base of ['packages', 'vendor']) {
    const walk = (dir, depth) => {
      if (depth > 4 || index.size > 4000) return
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        if (entry.isDirectory()) walk(join(dir, entry.name), depth + 1)
        else if (entry.name === 'package.json') {
          try {
            const manifest = JSON.parse(readFileSync(join(dir, entry.name), 'utf8'))
            if (typeof manifest.name === 'string' && !index.has(manifest.name)) index.set(manifest.name, dir)
          } catch { /* not a package manifest */ }
        }
      }
    }
    walk(join(CHECKOUT, base), 0)
  }
  return index
})()

/** Resolve the @deepseek-ai closure the host needs at runtime (mirrors verify-packed-install.mjs). */
function resolveClosure() {
  const host = JSON.parse(readFileSync(join(ROOT, 'packages', 'dsh-model-as-tool', 'package.json'), 'utf8'))
  const seen = new Map()
  const queue = [...Object.keys(host.peerDependencies ?? {}), ...Object.keys(host.dependencies ?? {})]
    .filter(name => name.startsWith('@deepseek-ai/') || name.startsWith('@try-works/'))
  while (queue.length > 0) {
    const name = queue.shift()
    if (seen.has(name)) continue
    const dir = name.startsWith('@try-works/') ? join(ROOT, WORKSPACE[name] ?? '') : NAME_INDEX.get(name)
    if (dir === undefined || dir === '') {
      console.warn(`  skipped ${name}: not found in the checkout`)
      continue
    }
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    seen.set(name, { dir, manifest })
    for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const dep of Object.keys(manifest[section] ?? {})) {
        if (dep.startsWith('@deepseek-ai/') && !seen.has(dep) && !queue.includes(dep)) queue.push(dep)
      }
    }
  }
  return seen
}

function rewriteWorkspaceRefs(manifest, closure) {
  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [dep, range] of Object.entries(manifest[section] ?? {})) {
      if (typeof range !== 'string' || !range.startsWith('workspace:')) continue
      const target = closure.get(dep)
      manifest[section][dep] = target ? `^${target.manifest.version}` : '*'
    }
  }
}

function stageAndPack(name, dir, closure) {
  const copy = join(staging, name.replaceAll('/', '__'))
  cpSync(dir, copy, { recursive: true, filter: source => !source.includes(join('node_modules')) })
  const manifestPath = join(copy, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  rewriteWorkspaceRefs(manifest, closure)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  const result = npm(['pack', '--pack-destination', tarballs], copy)
  if (result.status !== 0) throw new Error(`npm pack failed for ${name}: ${result.stderr}`)
  const filename = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1)
  if (!filename?.endsWith('.tgz')) throw new Error(`npm pack printed no tarball name for ${name}`)
  return join(tarballs, filename)
}

function packInPlace(name, dir) {
  const result = npm(['pack', '--pack-destination', tarballs], dir)
  if (result.status !== 0) throw new Error(`npm pack failed for ${name}: ${result.stderr}`)
  const filename = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1)
  if (!filename?.endsWith('.tgz')) throw new Error(`npm pack printed no tarball name for ${name}`)
  return join(tarballs, filename)
}

/** The stages this orchestration REQUIRES to pass; anything else may SKIP. */
const REQUIRED_STAGES = new Set([
  'boot', 'listing', 'describe', 'real-calls', 'receipts',
  'mcp-clients', 'recipe-creation', 'cancellation', 'disable', 'enable', 'uninstall',
])

try {
  console.log(`packing into ${scratch}`)
  const closure = resolveClosure()
  console.log(`resolved ${closure.size} packages from the DSH checkout`)
  const packages = []
  // The host carries contracts/sdk/recipes as bundledDependencies and its
  // prepack stages them from the workspace SIBLINGS; it is packed IN PLACE,
  // exactly as verify-packed-install.mjs does.
  packages.push(packInPlace('@try-works/dsh-model-as-tool', join(ROOT, 'packages', 'dsh-model-as-tool')))
  for (const [name, relative] of Object.entries(WORKSPACE)) {
    const dir = join(ROOT, relative)
    if (!existsSync(join(dir, 'lib', 'index.js'))) {
      console.warn(`  skipped ${name}: no built lib/`)
      continue
    }
    packages.push(stageAndPack(name, dir, closure))
  }
  for (const [name, { dir, manifest }] of closure) {
    if (manifest.private === true) continue
    packages.push(stageAndPack(name, dir, closure))
  }

  writeFileSync(join(project, 'package.json'), JSON.stringify({
    name: 'e2e-orchestration-probe', version: '1.0.0', private: true, type: 'module',
  }))
  console.log(`installing ${packages.length} tarballs into a clean project`)
  const install = npm(['install', '--no-audit', '--no-fund', '--ignore-scripts', ...packages], project)
  if (install.status !== 0) {
    console.error(install.stdout)
    console.error(install.stderr)
    throw new Error('npm install failed')
  }

  // The probe drives every stage INSIDE the clean project, through the packed
  // plugin's public surface. The MCP layer is not in the package exports map,
  // so it is reached by resolved file path — the same route verify-packed uses
  // for the confinement seam.
  const probe = `
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as plugin from '@try-works/dsh-model-as-tool'
import { STANDARD_CONTRACTS } from '@try-works/tool-mode-contracts'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join as pathJoin } from 'node:path'

const stage = (name, verdict, detail) => console.log('STAGE ' + name + ' ' + verdict + (detail ? ' ' + detail : ''))
const fail = (name, error) => { stage(name, 'FAIL', error instanceof Error ? error.message : String(error)); process.exitCode = 1 }

try {
  // Stage 1: boot the packed plugin with default configuration.
  // The DURABLE STATE IS ISOLATED: a verification harness must never read or
  // write the developer's real ~/.dsh/model-as-tool/state.json — this chain's
  // own disable/enable round-trip once left a persistent tongue disable there,
  // which silently removed lang_detect from every later default-config boot
  // (the round-67 packed regression). The throwaway project owns the state.
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(plugin, { stateFile: ${JSON.stringify(join(project, 'orchestration-state.json'))} })
  const names = new Set(ctx.tools.schemas().map(schema => schema.name))
  if (!names.has('lang_detect')) throw new Error('the packed plugin did not register lang_detect')
  if (!names.has('model_tools')) throw new Error('the packed plugin did not register model_tools')
  stage('boot', 'OK', 'tools=' + [...names].sort().join(','))

  let serial = 0
  const call = async (name, args) => ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('orch-' + (++serial)),
    name,
    arguments: args,
  })

  // Stage 2: preparation surface — listing and describing the model.
  const list = await call('model_tools', { action: 'list' })
  if (list.isError) throw new Error(list.error.message)
  const tongue = list.value.models.find(model => model.id === 'tongue')
  if (tongue === undefined) throw new Error('tongue is not in the catalog')
  stage('listing', 'OK', 'models=' + list.value.models.length + ' runnable=' + list.value.runnable + ' installed=' + list.value.installed)
  const describe = await call('model_tools', { action: 'describe', model: 'tongue' })
  if (describe.isError) throw new Error(describe.error.message)
  const described = describe.value.models[0]
  stage('describe', 'OK', 'tongue runnable=' + described.runnable + ' route=' + described.route)

  // Stage 3: two REAL calls — the bundled Tongue model, offline.
  const de = await call('lang_detect', { text: 'kann ich das haben' })
  if (de.isError) throw new Error('lang_detect de failed: ' + de.error.message)
  if (de.value.language !== 'de') throw new Error('expected de, got ' + de.value.language)
  const en = await call('lang_detect', { text: 'this is an ordinary English sentence' })
  if (en.isError) throw new Error('lang_detect en failed: ' + en.error.message)
  if (en.value.language !== 'en') throw new Error('expected en, got ' + en.value.language)
  stage('real-calls', 'OK', 'lang_detect de=' + de.value.language + ' en=' + en.value.language)

  // text_title exists only through the declarative broker, which needs a
  // harness-model provider this offline run does not configure. Honest SKIP.
  if (names.has('text_title')) {
    const title = await call('text_title', { text: 'a sample document to title' })
    if (title.isError) stage('title-tool', 'SKIPPED', 'refused offline: ' + title.error.message)
    else stage('title-tool', 'OK', 'title=' + JSON.stringify(title.value).slice(0, 80))
  } else {
    stage('title-tool', 'SKIPPED', 'text_title is not registered without a harness provider')
  }

  // Stage 4: evidence — receipts show the real calls.
  const receipts = await call('model_tools', { action: 'receipts' })
  if (receipts.isError) throw new Error(receipts.error.message)
  const mine = receipts.value.receipts.filter(
    receipt => receipt.contract === 'text.language_detect' || receipt.modelIdentity === 'tongue',
  )
  if (mine.length < 2) throw new Error('fewer than two lang_detect receipts: ' + receipts.value.receipts.length)
  stage('receipts', 'OK', 'total=' + receipts.value.receipts.length + ' lang_detect=' + mine.length + ' lastReceiptId=' + mine.at(-1).receiptId)

  // Stage 5: TWO MCP clients over a real socket — one authenticated, one not.
  // The MCP layer ships in the packed lib but is not in the exports map, so it
  // is imported by resolved file path, the same route verify-packed uses.
  {
    const require = createRequire(import.meta.url)
    const hostDir = fileURLToPath(new URL('.', pathToFileURL(require.resolve('@try-works/dsh-model-as-tool/package.json'))))
    const [{ startHttpServer }, { createMcpHost }, { PROTOCOL_VERSION, META_KEYS }] = await Promise.all([
      import(pathToFileURL(hostDir + 'lib/mcp/http.js').href),
      import(pathToFileURL(hostDir + 'lib/mcp/host-binding.js').href),
      import(pathToFileURL(hostDir + 'lib/mcp/protocol.js').href),
    ])
    const TOKEN = 'e2e-orchestration-token'
    const registered = new Set(ctx.tools.schemas().map(schema => schema.name))
    const published = STANDARD_CONTRACTS
      .filter(contract => registered.has(contract.toolName))
      .map(contract => ({ toolName: contract.toolName, contract }))
    if (published.length === 0) throw new Error('no standard contract is registered to publish')
    const surface = {
      published,
      // The HostSurface contract: the execute request carries the server-issued
      // callId and the caller's signal. A stale surface (the pre-SEC-04 shape)
      // silently mismatches the packed host-binding and tools/list 500s.
      async execute({ name, arguments: args, signal, callId }) {
        const result = await ctx.tools.execute({
          signal: signal ?? new AbortController().signal,
          callId: ToolCallId(callId ?? 'orch-mcp-' + (++serial)),
          name,
          arguments: args,
        })
        if (result.isError) return { isError: true, message: result.error ? result.error.message : 'the tool failed' }
        return { isError: false, value: result.value }
      },
    }
    const host = createMcpHost({ surface, serverInfo: { name: 'tool-mode', version: '0.1.3' } })
    const endpoint = await startHttpServer({
      path: '/mcp',
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 4 * 1024 * 1024,
      allowedOrigins: [],
      auth: { scheme: 'static-token', token: TOKEN, clientId: 'e2e-client-a' },
      rateLimit: false,
    }, host)
    const rpc = async (body, token, named) => {
      const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL_VERSION, 'mcp-method': String(body.method) }
      if (named) headers['mcp-name'] = String(body.params.name)
      if (token !== null) headers.authorization = 'Bearer ' + token
      const response = await fetch(endpoint.url, { method: 'POST', headers, body: JSON.stringify(body) })
      const text = await response.text()
      let json
      try { json = JSON.parse(text) } catch {
        const line = text.split('\\n').filter(entry => entry.startsWith('data:')).pop()
        json = line === undefined ? undefined : JSON.parse(line.slice(5).trim())
      }
      return { status: response.status, json }
    }
    try {
      const meta = () => ({ [META_KEYS.protocolVersion]: PROTOCOL_VERSION, [META_KEYS.clientCapabilities]: {} })
      const listed = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta() } }, TOKEN, false)
      if (listed.status !== 200) throw new Error('authenticated tools/list answered ' + listed.status + ': ' + JSON.stringify(listed.json).slice(0, 400))
      if (!Array.isArray(listed.json.result.tools)) throw new Error('tools/list result has no tools array: ' + JSON.stringify(listed.json).slice(0, 400))
      const viaMcp = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lang_detect', arguments: { text: 'kann ich das haben' }, _meta: meta() } }, TOKEN, true)
      if (viaMcp.status !== 200) throw new Error('authenticated tools/call answered ' + viaMcp.status)
      const refused = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: meta() } }, null, false)
      if (refused.status !== 401) throw new Error('an unauthenticated client was not refused: ' + refused.status)
      stage('mcp-clients', 'OK', 'authenticated=' + listed.status + ' unauthenticated=' + refused.status + ' publishedTools=' + listed.json.result.tools.length)
    } finally {
      await endpoint.close()
    }
  }

  // Stage 6: recipe creation — drive the PACKED tool-mode-recipe CLI (task-10's
  // bin) from this throwaway project, proving the authoring surface works from
  // the packed artifact (AT-90's recipe-creation remainder). The .bin shim is
  // checked FIRST, exactly as a user would resolve the command; the package's
  // own bin file is then executed with plain Node (cross-platform, no cmd shim).
  {
    const require = createRequire(import.meta.url)
    const shimPresent = existsSync(pathJoin(process.cwd(), 'node_modules', '.bin', 'tool-mode-recipe'))
      || existsSync(pathJoin(process.cwd(), 'node_modules', '.bin', 'tool-mode-recipe.cmd'))
    let binPath
    try {
      binPath = fileURLToPath(new URL('.', pathToFileURL(require.resolve('@try-works/tool-mode-recipes/package.json')))) + 'bin/tool-mode-recipe.mjs'
    } catch { binPath = undefined }
    if (shimPresent && binPath !== undefined && existsSync(binPath)) {
      const drafts = pathJoin(process.cwd(), 'recipe-drafts')
      mkdirSync(drafts, { recursive: true })
      const validDraft = pathJoin(drafts, 'valid.json')
      const invalidDraft = pathJoin(drafts, 'invalid.json')
      const draft = {
        id: 'orchestration-title',
        version: '1.0.0',
        description: 'A recipe drafted inside the orchestration chain.',
        tool: { name: 'orch_title', contractId: 'orch.title' },
        inputs: {
          text: { type: 'string', required: true, minLength: 1, maxLength: 1024, description: 'The text to title.' },
        },
        promptTemplate: 'Propose a short title for: {{text}}',
        maxOutputTokens: 128,
        imageInputs: { max: 0 },
        policy: { record: true, allowRemote: false },
      }
      writeFileSync(validDraft, JSON.stringify(draft))
      const run = args => spawnSync(process.execPath, [binPath, ...args], { encoding: 'utf8', timeout: 60_000 })
      const validated = run(['validate', validDraft])
      if (validated.status !== 0) throw new Error('the packed CLI rejected a valid draft: ' + validated.stderr)
      const packedOut = pathJoin(process.cwd(), 'recipe-dist')
      const packed = run(['pack', validDraft, '--name', '@acme/orchestration-recipe', '--out', packedOut])
      if (packed.status !== 0) throw new Error('the packed CLI failed to pack: ' + packed.stderr)
      const manifestPath = pathJoin(packedOut, '@acme__orchestration-recipe-1.0.0', 'tool-mode.extension.json')
      if (!existsSync(manifestPath)) throw new Error('the packed artifact has no manifest at ' + manifestPath)
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (manifest.execution.kind !== 'declarative') throw new Error('the packed manifest is not declarative')
      if ((manifest.implementations ?? []).length !== 1) throw new Error('the packed manifest must carry exactly one implementation')
      // The authoring-side refusal smoke: an invalid draft must exit 1 with a
      // NAMED refusal, never a silent acceptance.
      writeFileSync(invalidDraft, JSON.stringify({ ...draft, maxOutputTokens: 2048 }))
      const refused = run(['validate', invalidDraft])
      if (refused.status !== 1) throw new Error('the CLI accepted an invalid draft (exit ' + refused.status + ')')
      const refusalText = (refused.stderr ?? '') + (refused.stdout ?? '')
      if (!/violation|must|refus|invalid/i.test(refusalText)) throw new Error('the CLI refusal named nothing: ' + refusalText)
      stage('recipe-creation', 'OK', 'shim=yes validate=' + validated.status + ' pack=' + packed.status + ' invalidDraftExit=' + refused.status)
    } else {
      stage('recipe-creation', 'SKIPPED', 'the tool-mode-recipe bin is not resolvable in the packed project (shim=' + String(shimPresent) + ')')
    }
  }

  // Stage 7: cancellation — a call aborted after admission must report
  // cancelled/aborted (never success, never a hang), and the host must keep
  // serving the next call (AT-90's cancellation remainder).
  {
    const controller = new AbortController()
    const pending = ctx.tools.execute({
      signal: controller.signal,
      callId: ToolCallId('orch-cancel-' + (++serial)),
      name: 'lang_detect',
      arguments: { text: 'kann ich das haben' },
    })
    controller.abort()
    const aborted = await pending
    if (!aborted.isError) throw new Error('an aborted call reported success')
    const reason = aborted.error?.message ?? ''
    if (!/cancel|abort|signal/i.test(reason)) throw new Error('the aborted call named neither cancelled nor aborted: ' + reason)
    const after = await call('lang_detect', { text: 'kann ich das haben' })
    if (after.isError || after.value.language !== 'de') throw new Error('the host did not keep serving after the abort')
    stage('cancellation', 'OK', 'aborted call refused as "' + reason + '"; next call de=' + after.value.language)
  }

  // Stage 8: lifecycle round-trip — disable withdraws the tool and refuses the
  // call; enable restores both.
  const disable = await call('model_tools', { action: 'disable', model: 'tongue' })
  if (disable.isError || disable.value.changed !== true) throw new Error('disable did not change state')
  const afterDisable = new Set(ctx.tools.schemas().map(schema => schema.name))
  if (afterDisable.has('lang_detect')) throw new Error('lang_detect stayed published after disable')
  const refused = await call('lang_detect', { text: 'kann ich das haben' })
  if (!refused.isError) throw new Error('lang_detect answered after disable')
  stage('disable', 'OK', 'lang_detect withdrawn and its call refused')
  const enable = await call('model_tools', { action: 'enable', model: 'tongue' })
  if (enable.isError || enable.value.changed !== true) throw new Error('enable did not change state')
  const restored = await call('lang_detect', { text: 'kann ich das haben' })
  if (restored.isError || restored.value.language !== 'de') throw new Error('lang_detect did not come back')
  stage('enable', 'OK', 'lang_detect restored and inferring again')

  // Stage 9: uninstall leaves no publications.
  const uninstall = await call('model_tools', { action: 'disable', model: 'tongue' })
  if (uninstall.isError || uninstall.value.changed !== true) throw new Error('final disable did not change state')
  const afterUninstall = new Set(ctx.tools.schemas().map(schema => schema.name))
  if (afterUninstall.has('lang_detect')) throw new Error('lang_detect publication remains after uninstall')
  stage('uninstall', 'OK', 'no lang_detect publication remains')

  // Stage 10: hosted composition. Requires the DSH PTC backend, which the
  // packed closure of a bare plugin install does not carry.
  if (names.has('tool_mode_run')) {
    stage('composition', 'SKIPPED', 'tool_mode_run is registered but this offline probe does not wire a PTC program')
  } else {
    stage('composition', 'SKIPPED', 'tool_mode_run is not registered without the DSH PTC backend')
  }

  await ctx.fiber.dispose()
} catch (error) {
  fail('orchestration', error)
}
`
  writeFileSync(join(project, 'probe.mjs'), probe)
  const run = spawnSync(process.execPath, [join(project, 'probe.mjs')], {
    cwd: project, encoding: 'utf8', timeout: 240_000,
  })
  if (run.status !== 0) {
    console.error('--- probe stdout ---')
    console.error(run.stdout)
    console.error('--- probe stderr ---')
    console.error(run.stderr)
    throw new Error('the orchestration probe failed')
  }
  console.log(run.stdout.trim())

  const stages = new Map()
  for (const line of run.stdout.split(/\r?\n/)) {
    const match = /^STAGE (\S+) (OK|SKIPPED|FAIL)(?: (.*))?$/.exec(line)
    if (match !== null) stages.set(match[1], { verdict: match[2], detail: match[3] ?? '' })
  }
  for (const name of REQUIRED_STAGES) {
    const entry = stages.get(name)
    if (entry === undefined) throw new Error(`required stage ${name} produced no evidence line`)
    if (entry.verdict !== 'OK') throw new Error(`required stage ${name} was ${entry.verdict}: ${entry.detail}`)
  }
  const failed = [...stages.values()].some(entry => entry.verdict === 'FAIL')
  if (failed) throw new Error('a stage FAILED')

  console.log('\nOK — the packed artifacts ran the AT-40/AT-90 orchestration:')
  console.log('     install -> preparation -> two MCP clients -> recipe creation -> cancellation')
  console.log('     -> lifecycle -> receipts -> uninstall, with real offline inference and')
  console.log('     the refusal paths asserted.')
} finally {
  // Same insurance as verify-packed-install.mjs: a failure between the host's
  // prepack and postpack leaves the checkout staged.
  const cleanup = npm(['run', '--if-present', 'postpack'], join(ROOT, 'packages', 'dsh-model-as-tool'), 120_000)
  if (cleanup.status !== 0) {
    console.warn('bundle: postpack cleanup did not run; run `node packages/dsh-model-as-tool/scripts/stage-bundle.mjs --clean`')
  }
  rmSync(scratch, { recursive: true, force: true })
}
