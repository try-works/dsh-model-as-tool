#!/usr/bin/env node
/**
 * The `dsh-tool-mode` launcher (RUN-03/RUN-04): serve / doctor / prepare /
 * mcp-stdio.
 *
 * - `serve` boots the headless host composition. The host package ships no
 *   composition entry of its own (no src/host.ts — the recorded seam): serve
 *   attempts to resolve the DSH composition runtime and, when it is not
 *   resolvable from this artifact, exits non-zero with the exact missing seam
 *   rather than inventing service constructors.
 * - `doctor` reports configuration, package/runtime compatibility, platform
 *   readiness and the launcher seam WITHOUT secrets.
 * - `prepare --tool <name>` resolves the installed extension that serves the
 *   tool and runs the digest-verified prepared-assets acquisition (a REAL
 *   download is opt-in: the operator runs this command deliberately).
 * - `mcp-stdio` reuses the existing stdio relay (same env contract as the
 *   standalone binary).
 *
 * Every subcommand: `--json` emits structured JSON on stdout; failures exit
 * non-zero; an unattended launch never hangs (P26-16).
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createPreparedAssetRegistry, parseAssetLock, plannedAssets, lockGroups, identityFor } from '../lib/prepared-assets.js'
import { planPreparation } from '../lib/deployment-coordinator.js'
import { createHttpSource } from '../lib/http-acquisition.js'
import { createStdioBridge } from '../lib/mcp/stdio.js'
import { discoverExtension } from '@try-works/tool-mode-extension-sdk'

const args = process.argv.slice(2)
const command = args[0] ?? '--help'
const flag = name => {
  const index = args.indexOf(name)
  return index === -1 || index + 1 >= args.length ? undefined : args[index + 1]
}
const jsonOut = args.includes('--json')
const report = (value) => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  process.exit(0)
}
const fail = (message, code = 2) => {
  if (jsonOut) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`)
  else process.stderr.write(`dsh-tool-mode: ${message}\n`)
  process.exit(code)
}

/** Read the config document, tolerating its absence for the read-only commands. */
function readConfig(path) {
  const target = path ?? process.env.DSH_TOOL_MODE_CONFIG ?? './tool-mode.json'
  try {
    return JSON.parse(readFileSync(target, 'utf8'))
  } catch {
    return {}
  }
}

if (command === 'mcp-stdio') {
  const url = process.env.DSH_TOOL_MODE_MCP_URL ?? 'http://127.0.0.1:3765/mcp'
  const token = process.env.DSH_TOOL_MODE_MCP_TOKEN
  if (token === undefined || token.length === 0) {
    process.stderr.write('dsh-tool-mode mcp-stdio: no credential configured (DSH_TOOL_MODE_MCP_TOKEN).\n')
    process.exit(2)
  }
  const bridge = createStdioBridge(
    {
      url,
      token,
      fetch: async (target, init) => {
        const response = await fetch(target, {
          method: init.method,
          headers: init.headers,
          body: init.body,
          signal: init.signal,
        })
        const headers = {}
        response.headers.forEach((value, key) => { headers[key] = value })
        return { status: response.status, headers, body: await response.text() }
      },
    },
    {
      protocol: line => process.stdout.write(`${line}\n`),
      diagnostic: line => process.stderr.write(`${line}\n`),
    },
  )
  bridge.start()
  process.on('SIGINT', () => process.exit(0))
} else if (command === 'doctor') {
  const config = readConfig(flag('--config'))
  const platform = `${process.platform} ${process.arch}`
  const nodeVersion = process.version
  const mcpPort = config.mcpV3?.port ?? config.mcp?.port ?? 3765
  const extensionStore = config.extensionStore ?? config.extensions?.registry ?? 'unset'
  const result = {
    ok: true,
    command: 'doctor',
    platform: { os: process.platform, arch: process.arch, node: nodeVersion, accelerator: 'cpu' },
    configuration: {
      schemaVersion: config.schemaVersion ?? 'legacy (v1/v2 flat shape)',
      mcp: { host: '127.0.0.1', port: mcpPort, path: config.mcpV3?.path ?? '/mcp' },
      extensionStore,
      fixedFalseFlags: {
        automaticUpdates: false,
        runInstallScripts: false,
        automaticActivation: false,
        allowExecutableTemplates: false,
        inheritConversation: false,
        allowModelToolCalls: false,
      },
    },
    launcherSeam:
      '`serve` boots the headless composition in lib/headless.js: config -> catalog -> contract bindings -> MCP host -> '
      + 'HTTP with credential authentication, without the DSH CLI or a browser (RUN-03). Harness-backed program '
      + 'execution (tool_mode_run) stays refused headless: it needs the DSH PtcHostContext (CODE-10).',
    serverStatus: 'not running (doctor does not start the listener)',
  }
  report(result)
} else if (command === 'prepare') {
  const tool = flag('--tool')
  if (tool === undefined) fail('prepare requires --tool <toolName> (RUN-04)')
  const config = readConfig(flag('--config'))
  const storeDir = config.extensionStore
  if (typeof storeDir !== 'string' || storeDir.length === 0) {
    fail('prepare requires the extension store (config.extensionStore); the store is not configured')
  }
  // Resolve the installed extension whose manifest serves the requested tool.
  const found = []
  if (existsSync(storeDir)) {
    for (const entry of readdirSync(storeDir)) {
      const root = join(storeDir, entry)
      if (!statSync(root).isDirectory()) continue
      for (const id of readdirSync(root)) {
        const scope = join(root, id)
        if (!statSync(scope).isDirectory()) continue
        for (const version of readdirSync(scope)) {
          const installPath = join(scope, version)
          if (!existsSync(join(installPath, 'tool-mode.extension.json'))) continue
          try {
            const discovery = discoverExtension(installPath)
            const serves = discovery.manifest.tools.some(t => t.name === tool)
              || discovery.manifest.implementations.some(impl => {
                const owner = discovery.manifest.tools.find(t => t.contractId === impl.contractId)
                return owner?.name === tool
              })
            if (serves) found.push({ discovery, installPath })
          } catch {
            // A broken package is skipped: prepare never guesses.
          }
        }
      }
    }
  }
  if (found.length === 0) fail(`no installed extension serves the tool ${JSON.stringify(tool)} (prepare never guesses)`)
  const { discovery, installPath } = found[0]
  const model = discovery.manifest.models[0]
  if (model === undefined) fail(`the extension serving ${tool} declares no model deployment`)
  const lockPath = join(dirname(discovery.manifestPath), model.assetLock)
  const lock = parseAssetLock(readFileSync(lockPath, 'utf8'))
  const groups = lockGroups(lock, model.assetSet)
  const plan = planPreparation(identityFor(discovery.manifest.id, model.id, lock), plannedAssets(lock, model.assetSet), lock.license)
  const statePath = config.stateFile ?? join(process.env.LOCALAPPDATA ?? process.env.TEMP ?? '.', 'dsh-model-as-tool', 'state.json')
  const registry = createPreparedAssetRegistry({ cacheRoot: join(dirname(resolve(statePath)), 'asset-cache') })
  const outcome = await registry.prepare(discovery.manifest.id, plan, groups, {
    source: createHttpSource(),
    allowExecutable: false,
    signal: new AbortController().signal,
  })
  if (!outcome.ok) fail(`the preparation failed: ${outcome.reason}`, 1)
  const transferred = outcome.groups.map(group => group.digests.map(digest => createHash('sha256').update(digest).digest('hex')))
  report({
    ok: true,
    command: 'prepare',
    tool,
    extension: discovery.manifest.id,
    model: model.id,
    revision: lock.revision,
    groups: outcome.groups.map(group => ({ groupId: group.groupId, path: group.path, digests: group.digests })),
    note: `transferred digests (${transferred.length} groups) are the content hashes; sizes are per-asset in the lock`,
  })
} else if (command === 'serve') {
  // The REAL headless composition (RUN-03, task-74): config load, catalog
  // resolution, contract bindings, the MCP HTTP listener, and a bounded
  // SIGINT/SIGTERM shutdown — composed from the host's own services, no DSH
  // CLI required.
  const { runHeadlessServe } = await import('../lib/headless.js')
  const exit = await runHeadlessServe(
    { configPath: flag('--config'), json: jsonOut },
    { out: line => process.stdout.write(`${line}\n`), err: line => process.stderr.write(`${line}\n`) },
  )
  process.exit(exit)
} else {
  process.stderr.write(
    'dsh-tool-mode: usage\n'
    + '  dsh-tool-mode serve [--config tool-mode.json] [--json]\n'
    + '  dsh-tool-mode doctor [--config tool-mode.json] [--json]\n'
    + '  dsh-tool-mode prepare --tool <toolName> [--config tool-mode.json] [--json]\n'
    + '  dsh-tool-mode mcp-stdio\n',
  )
  process.exit(command === '--help' || command === '-h' ? 0 : 2)
}
