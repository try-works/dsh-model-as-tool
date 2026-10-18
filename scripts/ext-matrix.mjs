#!/usr/bin/env node
/**
 * The reproducible extension matrix harness (task-110).
 *
 * Against a LIVE DSH profile (base URL + launch token), over the gateway RPC:
 *   describe → install (registry if absent) → prepare → enable → assert active
 * then, because the live web profile exposes no browser-free tool-invocation
 * surface (see scripts/lib/ext-matrix-host.mjs for the evidence), invoke every
 * declared tool on the REAL host stack over a snapshot of the profile store and
 * judge each result with the task-111 output validators.
 *
 * Usage:
 *   npx tsx scripts/ext-matrix.mjs --base-url http://127.0.0.1:3097 \
 *     --token-file <path-with-token> [--only tongue] [--only needle] \
 *     [--input-dir <fixture dir>] [--out-dir verification/ext-matrix] \
 *     [--skip-invoke] [--dry-run]
 *
 * Exit code 0 only when every selected extension is verified working, or is
 * SKIPPED with an exact NAMED host blocker; any FAIL, un-named skip, harness
 * precondition failure or requirement-coherence issue exits 1.
 *
 * @module scripts/ext-matrix
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  aggregateMatrix,
  callModelTools,
  classifyRefusal,
  connectOperator,
  findPreparedArtifact,
  INVOCATION_ASSET_BLOCKER,
  invocationEnvironmentBlocker,
  isInvocationAssetHarnessSkip,
  isPlanningHarnessSkip,
  manifestToolNames,
  PLANNING_HARNESS_BLOCKER,
  parseArgs,
  renderMarkdown,
  requirementCoherence,
  resolveInvocationArgs,
  RpcRefusal,
  selectExtensions,
  UsageError,
  verdictFailed,
} from './lib/ext-matrix-lib.mjs'
import { ExtensionStore } from '@try-works/tool-mode-extension-sdk'
import { STANDARD_CONTRACTS } from '@try-works/tool-mode-contracts'

const REPO_ROOT = process.cwd()
const OUTPUTS_MODULE = join(REPO_ROOT, 'scripts', 'lib', 'ext-matrix-outputs.mjs')

/**
 * Resolve the tool names an installed extension ACTUALLY registers.
 *
 * The manifest's `tools` names are direct. Implementation-only extensions
 * (minilm text.embed/text.rerank, declarative recipes) register the CONTRACT's
 * standard tool name, not the contract id: `text_embed`, not `text.embed`.
 * @param {string} storeDir - the live extension store.
 * @param {readonly {id: string}[]} selected - matrix extensions.
 * @returns {Map<string, Set<string>>} tool names per extension id.
 */
function resolveRegisteredToolNames(storeDir, selected) {
  const contractToolNames = new Map(STANDARD_CONTRACTS.map(contract => [contract.contract, contract.toolName]))
  const names = new Map()
  const store = new ExtensionStore(storeDir)
  const installed = store.listInstalled()
  for (const extension of selected) {
    const record = installed.value.find(candidate => candidate.extensionId === extension.id)
    const resolved = new Set()
    if (record !== undefined) {
      try {
        const manifest = JSON.parse(readFileSync(join(record.installPath, 'tool-mode.extension.json'), 'utf8'))
        for (const name of manifestToolNames(manifest, contractToolNames)) resolved.add(name)
      } catch (error) {
        log(`could not read ${extension.name}'s manifest for tool names: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    names.set(extension.id, resolved)
  }
  return names
}

function now() { return new Date().toISOString() }
function log(message) { process.stderr.write(`[matrix] ${message}\n`) }

/** Resolve the launch token from --token or --token-file. */
function resolveToken(options) {
  if (options.token !== '') return options.token
  const text = readFileSync(options.tokenFile, 'utf8').trim()
  const match = /token=([A-Za-z0-9_-]+)/.exec(text)
  return match === null ? text : match[1]
}

/** Load the validator module, or return the named reason it is unavailable. */
async function loadOutputs() {
  try {
    return { module: await import(pathToFileURL(OUTPUTS_MODULE).href), problem: null }
  } catch (error) {
    return {
      module: null,
      problem: `the task-111 validator module is unavailable at ${OUTPUTS_MODULE}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** Refresh the describe snapshot and return it (extensions + store). */
async function describe(transport) {
  const snapshot = await callModelTools(transport, 'describe', {})
  return {
    extensions: Array.isArray(snapshot?.extensions) ? snapshot.extensions : [],
    store: typeof snapshot?.store === 'string' ? snapshot.store : '',
  }
}

/**
 * Run the lifecycle phase for one extension.
 * @returns {Promise<object>} a matrix entry (without tool verdicts yet).
 */
async function lifecycleEntry(transport, extension, describeStore) {
  const started = Date.now()
  const base = { id: extension.id, name: extension.name, status: 'FAIL', durationMs: 0, blocker: null, detail: null, tools: extension.tools }
  let row = describeStore.rows.find(candidate => candidate.id === extension.id)
  try {
    if (row === undefined || row.installed !== true) {
      log(`${extension.name}: installing ${extension.id} from the configured route`)
      const installed = await callModelTools(transport, 'installExtension', { id: extension.id })
      base.detail = `installed ${installed?.version ?? '?'} via ${installed?.source ?? '?'} (resolved ${installed?.resolvedVersion ?? '?'})`
      describeStore.snapshot = await describe(transport)
      describeStore.rows = describeStore.snapshot.extensions
      row = describeStore.rows.find(candidate => candidate.id === extension.id)
    } else {
      /**
       * REFRESH toward the published latest: an installed-but-stale version must
       * not make the matrix exercise old bytes. A host refusal that already has the
       * current version is a no-op, not a failure.
       */
      try {
        const refreshed = await callModelTools(transport, 'installExtension', { id: extension.id })
        base.detail = `refreshed ${refreshed?.version ?? '?'} via ${refreshed?.source ?? '?'}`
        describeStore.snapshot = await describe(transport)
        describeStore.rows = describeStore.snapshot.extensions
        row = describeStore.rows.find(candidate => candidate.id === extension.id)
      } catch (error) {
        if (!(error instanceof RpcRefusal && /already recorded as installed|already installed|current version|not newer/i.test(error.message))) throw error
      }
    }
    if (row === undefined) throw new Error('the host still does not list the extension after install')

    const unmet = (row.requirements ?? []).filter(requirement => requirement.satisfied === false)
    const needsPreparation = unmet.some(requirement => requirement.kind === 'assets' || requirement.kind === 'executable')
    if (needsPreparation) {
      log(`${extension.name}: preparing declared assets (may download a large asset set)`)
      const prepared = await callModelTools(transport, 'prepare', { id: extension.id })
      base.detail = `prepare: ${prepared?.prepared === true ? 'prepared' : String(prepared?.reason ?? 'not prepared')}`
      describeStore.snapshot = await describe(transport)
      describeStore.rows = describeStore.snapshot.extensions
      row = describeStore.rows.find(candidate => candidate.id === extension.id)
    }
    if (row === undefined) throw new Error('the host no longer lists the extension after prepare')

    if (row.active !== true) {
      if (row.blocked === true) {
        // A describe-blocked row names its own host blocker; never invent a skip.
        return { ...base, status: 'SKIPPED', blocker: String(row.reason ?? 'blocked with no reason'), durationMs: Date.now() - started, tools: row.tools ?? extension.tools }
      }
      log(`${extension.name}: enabling`)
      const enabled = await callModelTools(transport, 'enable', { id: extension.id })
      if (enabled?.active !== true) throw new Error('enable returned active:false')
      describeStore.snapshot = await describe(transport)
      describeStore.rows = describeStore.snapshot.extensions
      row = describeStore.rows.find(candidate => candidate.id === extension.id)
      if (row?.active !== true) throw new Error('the post-enable describe still reports the extension inactive')
    } else {
      base.detail = `${base.detail === null ? '' : `${base.detail}; `}already active`
    }
    return {
      ...base,
      status: 'PASS',
      detail: base.detail ?? `active (${row.version ?? '?'})`,
      durationMs: Date.now() - started,
      tools: row.tools ?? extension.tools,
    }
  } catch (error) {
    if (error instanceof RpcRefusal) {
      const classified = classifyRefusal(error)
      return {
        ...base,
        status: classified.outcome,
        blocker: classified.blocker ?? null,
        detail: classified.outcome === 'FAIL' ? `${error.code}: ${error.message}` : null,
        durationMs: Date.now() - started,
      }
    }
    return { ...base, status: 'FAIL', detail: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started }
  }
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`ext-matrix: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
    return
  }
  if (options.help) {
    process.stdout.write('usage: npx tsx scripts/ext-matrix.mjs --base-url <url> (--token <t> | --token-file <f>) [--only name|id|tool] [--input-dir <dir>] [--out-dir <dir>] [--skip-invoke] [--dry-run]\n')
    return
  }
  const selected = selectExtensions(options.only)
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ baseUrl: options.baseUrl, selected: selected.map(entry => entry.name), skipInvoke: options.skipInvoke }, null, 2)}\n`)
    return
  }
  options.token = resolveToken(options)
  log(`connecting to ${options.baseUrl}`)
  const transport = await connectOperator(options)
  log('operator cookie acquired')

  const initial = await describe(transport)
  const describeStore = { rows: initial.extensions, snapshot: initial }
  const coherenceIssues = requirementCoherence(describeStore.rows)
  for (const issue of coherenceIssues) log(`coherence: ${issue}`)

  const entries = []
  for (const extension of selected) {
    entries.push(await lifecycleEntry(transport, extension, describeStore))
    const latest = entries[entries.length - 1]
    log(`${extension.name}: ${latest.status}${latest.blocker === null ? '' : ` — ${latest.blocker}`}`)
  }

  // Tool-invocation phase: the task-111 module owns the tool→fixture map and the verdicts.
  let tools = []
  let hostServices = {}
  let preconditionError
  let invocationRan = false
  if (!options.skipInvoke) {
    const { module, problem } = await loadOutputs()
    if (problem !== null) {
      preconditionError = problem
      log(problem)
    } else {
      /**
       * The live matrix exercises the DEPLOYED plugin build. This CLI opt-in is
       * explicit here; importing the host module directly (the hermetic test suite)
       * has no such env and uses the repository source. Override the profile with
       * EXT_MATRIX_PROFILE, or the module with EXT_MATRIX_PLUGIN.
       */
      process.env.EXT_MATRIX_PROFILE ??= process.env.EXT_MATRIX_PLUGIN === undefined ? 'ext-matrix' : ''
      const all = await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'lib', 'ext-matrix-host.mjs')).href)
      const storeDir = describeStore.snapshot.store
      const calls = []
      const unmapped = []
      if (typeof storeDir === 'string' && storeDir !== '') {
        // Resolve the REAL registered tool names from the LIVE manifests: manifest
        // `tools` plus each implementation's standard-contract tool name
        // (text.embed -> text_embed). Never assume a matrix id IS a tool name.
        const registeredNames = resolveRegisteredToolNames(storeDir, selected)
        for (const entry of module.MATRIX_TOOLS) {
          const extension = selected.find(candidate =>
            candidate.id === entry.extension || candidate.name === entry.extension)
          if (extension === undefined) continue
          const names = registeredNames.get(extension.id) ?? new Set()
          if (!names.has(entry.toolName)) {
            unmapped.push(`${entry.id} (${extension.name}) has no registered tool name; the manifest declares ${[...names].join(', ') || 'none'}`)
            continue
          }
          let args
          try {
            args = resolveInvocationArgs(module.loadInput(entry.input, options.inputDir), module.FIXTURE_DIR)
          } catch (error) {
            preconditionError = `the fixture for ${entry.id} is unusable: ${error instanceof Error ? error.message : String(error)}`
            continue
          }
          calls.push({ extension: extension.id, extensionName: extension.name, id: entry.id, toolName: entry.toolName, contractId: entry.contractId, args })
        }
      }
      if (unmapped.length > 0) {
        preconditionError = `the harness invocation map is stale: ${unmapped.join('; ')}`
        log(preconditionError)
      }
      if (typeof storeDir !== 'string' || storeDir === '') {
        preconditionError = 'describe reported no extension store, so the invocation host cannot read the installed bytes'
      } else if (preconditionError === undefined) {
        /**
         * The invocation host is a separate process: an extension that resolves its
         * native artifacts from the private store directory (needle) would look in
         * the SNAPSHOT. Point it at the LIVE prepared bytes read-only via the
         * documented environment overrides; the artifact digests are still verified
         * by the extension itself before loading.
         */
        const cacheRoot = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'model-as-tool', 'asset-cache')
        const needleEngine = findPreparedArtifact(cacheRoot, 'needle.exe')
        const needleWeights = findPreparedArtifact(cacheRoot, 'needle3.cact')
        if (needleEngine !== undefined && needleWeights !== undefined) {
          process.env.NEEDLE_EXTENSION_ENGINE = needleEngine
          process.env.NEEDLE_EXTENSION_WEIGHTS = needleWeights
          log(`needle artifacts resolved from the live prepared cache: ${needleEngine}`)
        }
        log(`invoking ${calls.length} tool/contract calls on the shipping host over a store snapshot`)
        const passEntries = entries.filter(entry => entry.status === 'PASS')
        const passIds = new Set(passEntries.map(entry => entry.id))
        const batchOptions = { storeDir, approvedRoots: [module.FIXTURE_DIR, ...(options.inputDir === undefined ? [] : [options.inputDir])], extensions: passEntries.map(entry => entry.id), calls: calls.filter(call => passIds.has(call.extension)) }
        const batch = await all.runToolBatch(batchOptions)
        hostServices = batch.services ?? {}
        if (batch.missingTools.length > 0) {
          preconditionError = `the invocation host registered no tool for: ${batch.missingTools.map(missing => `${missing.id} -> ${missing.toolName}`).join(', ')}`
          log(preconditionError)
        }
        for (const call of batch.calls) {
          if (call.ok !== true) {
            tools.push({ id: call.id, extension: call.extensionName, ok: false, detail: call.error, failures: ['host-call'] })
            continue
          }
          const verdict = module.validateToolOutput(call.id, call.result)
          /**
           * task-122: the in-process host invokes tools outside an Agent turn, so
           * tools_plan's host-adapter snapshot differs from the live agent's and the
           * extension correctly rejects the empty plan. A NAMED harness skip, never a
           * fabricated product FAIL.
           */
          if (isPlanningHarnessSkip(call.id, verdict, call.result)) {
            tools.push({
              id: call.id,
              extension: call.extensionName,
              ok: false,
              skipped: true,
              planningLimitation: true,
              detail: PLANNING_HARNESS_BLOCKER,
              failures: verdict.failures ?? [],
              raw: call.result,
            })
            continue
          }
          if (isInvocationAssetHarnessSkip(verdict)) {
            tools.push({
              id: call.id,
              extension: call.extensionName,
              ok: false,
              skipped: true,
              assetLimitation: true,
              detail: INVOCATION_ASSET_BLOCKER,
              failures: verdict.failures ?? [],
              raw: call.result,
            })
            continue
          }
          // task-111: a tool may honestly report a NAMED refusal (media_find_moments
          // without video support, structured_extract without a harness model). That
          // is an allowable, recorded outcome — not an unexplained failure.
          const failed = verdictFailed(verdict)
          tools.push({
            id: call.id,
            extension: call.extensionName,
            ok: verdict.ok === true,
            allowedRefusal: verdict.ok !== true && !failed,
            refusal: verdict.refusal ?? null,
            detail: verdict.note ?? (verdict.ok !== true ? verdict.refusal ?? null : null),
            failures: verdict.failures ?? [],
            // Raw result on failure only: the JSON report is diagnostic evidence,
            // not a dump of every successful embedding.
            ...failed || verdict.ok !== true ? { raw: call.result } : {},
            verdict,
          })
        }
        for (const activation of batch.activation) {
          if (activation.ok !== true) {
            const entry = entries.find(candidate => candidate.id === activation.extension)
            if (entry === undefined || entry.status !== 'PASS') continue
            /**
             * The invocation host mounts no LLM provider, while the live host serves
             * declarative recipes. ONLY that exact environment blocker is skippable;
             * any other activation failure stays a FAIL so a product defect cannot
             * hide behind the skip.
             */
            const environmentBlocker = invocationEnvironmentBlocker(String(activation.detail ?? ''))
            if (environmentBlocker !== null) {
              entry.status = 'SKIPPED'
              entry.blocker = environmentBlocker
              entry.detail = null
              // Its tool rows were attempted under the activation failure; report
              // them as SKIPPED with the named blocker, not as product FAILs.
              for (const tool of tools) {
                if (tool.extension !== entry.name && tool.extension !== entry.id) continue
                tool.skipped = true
                tool.detail = environmentBlocker
                tool.failures = []
              }
              continue
            }
            entry.status = 'FAIL'
            entry.detail = `activation in the invocation host failed: ${activation.detail}`
          }
        }
        invocationRan = true
        for (const entry of entries) {
          if (entry.status !== 'PASS') continue
          const verdicts = tools.filter(tool => tool.extension === entry.name || tool.extension === entry.id)
          if (verdicts.length === 0) continue
          const failed = verdicts.filter(verdict => verdict.ok !== true && verdict.allowedRefusal !== true && verdict.skipped !== true)
          if (failed.length > 0) {
            entry.status = 'FAIL'
            entry.detail = failed.map(verdict => `${verdict.id}: ${verdict.detail ?? verdict.failures?.join(', ')}`).join('; ')
          }
        }
      }
    }
  }

  const { summary, exitCode } = aggregateMatrix(entries, { coherenceIssues, preconditionError, invocationRan })
  const report = {
    generatedAt: now(),
    baseUrl: options.baseUrl,
    exitCode,
    skipInvoke: options.skipInvoke,
    rows: entries,
    tools,
    summary,
    hostServices,
    surface: {
      lifecycle: 'gateway RPC: GET /connect?token=… then POST /api/modelTools/<installExtension|describe|prepare|enable> with {type:"client-request",rpcId,method,payload:{args}}',
      invocation: 'in-process shipping host (plugin apply + tool runtime + extension dispatch) over a snapshot of the profile store; the live web profile exposes no MCP/tool-execute endpoint',
    },
  }
  mkdirSync(options.outDir, { recursive: true })
  const jsonPath = join(options.outDir, 'ext-matrix.json')
  const markdownPath = join(options.outDir, 'ext-matrix.md')
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  const markdown = renderMarkdown(report)
  writeFileSync(markdownPath, markdown, 'utf8')
  process.stdout.write(markdown)
  process.stdout.write(`\nreports: ${jsonPath} , ${markdownPath}\n`)
  process.exitCode = exitCode
}

await main()
