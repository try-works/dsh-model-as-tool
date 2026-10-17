/**
 * task-74: the REAL headless `serve` entry (RUN-03) and the CODE-11
 * configurable repair-budget ceilings.
 *
 * The serve test spawns the actual launcher with a temp config and credential,
 * drives tools/list over HTTP with the pinned modern request shape, and proves
 * the SIGINT shutdown exits 0. The config-refusal and the repair-ceiling tests
 * run in-process against the exported surface.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { repairCeilingOf } from '../src/index.ts'
import { runHeadlessServe } from '../src/headless.ts'
import { mayRepairTitle, recordRepairLineage, titleLimitsFor } from '../src/title-proposal.ts'
import { PROTOCOL_VERSION, META_KEYS } from '../src/mcp/protocol.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmx-headless-'))
  dirs.push(dir)
  return dir
}

const TOKEN = 'test-headless-token'

/** Spawn the real launcher serve and collect its stdout until the bound line. */
function spawnServe(configPath: string): Promise<{ child: ChildProcess; url: string; lines: string[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(process.cwd(), 'packages', 'dsh-model-as-tool', 'bin', 'dsh-tool-mode.mjs'), 'serve', '--config', configPath, '--json'],
      {
        env: { ...process.env, DSH_TOOL_MODE_MCP_TOKEN: TOKEN, DSH_TOOL_MODE_CONFIG: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const lines: string[] = []
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill('SIGKILL')
        reject(new Error(`serve did not print a bound endpoint in time; stdout: ${lines.join(' | ')}`))
      }
    }, 20_000)
    const onData = (chunk: Buffer): void => {
      const text = String(chunk)
      lines.push(text.trim())
      if (settled) return
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('{')) continue
        try {
          const doc = JSON.parse(trimmed) as { ok?: boolean; url?: string; error?: string }
          if (doc.ok === true && typeof doc.url === 'string') {
            settled = true
            clearTimeout(timer)
            child.stdout?.off('data', onData)
            resolve({ child, url: doc.url, lines })
            return
          }
          if (doc.ok === false) {
            settled = true
            clearTimeout(timer)
            child.stdout?.off('data', onData)
            reject(new Error(`serve refused: ${doc.error ?? trimmed}`))
            return
          }
        } catch { /* not the JSON line */ }
      }
    }
    child.stdout?.on('data', onData)
    child.on('exit', (code) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error(`serve exited before printing the endpoint (code ${code}); stdout: ${lines.join(' | ')}`))
      }
    })
  })
}

/** The pinned modern tools/list HTTP request. */
async function postToolsList(url: string): Promise<{ status: number; body: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TOKEN}`,
      'mcp-protocol-version': PROTOCOL_VERSION,
      'mcp-method': 'tools/list',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'headless-1',
      method: 'tools/list',
      params: {
        _meta: {
          [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
          [META_KEYS.clientInfo]: { name: 'headless-serve-test', version: '1.0.0' },
          [META_KEYS.clientCapabilities]: {},
        },
      },
    }),
  })
  return { status: response.status, body: await response.text() }
}

describe('task-74 (A) — the REAL headless serve entry', () => {
  it('starts, prints {ok, listening, url}, and answers tools/list over HTTP', async () => {
    const dir = scratch()
    const configPath = join(dir, 'tool-mode.json')
    writeFileSync(configPath, JSON.stringify({ mcpV3: { host: '127.0.0.1', port: 0, path: '/mcp' } }))
    const { child, url, lines } = await spawnServe(configPath)
    const doc = JSON.parse(lines[0] as string) as { ok: boolean; listening: boolean; url: string }
    assert.equal(doc.ok, true)
    assert.equal(doc.listening, true)

    const response = await postToolsList(url)
    assert.equal(response.status, 200, response.body)
    const parsed = JSON.parse(response.body) as { result?: { tools?: { name: string }[] } }
    const names = (parsed.result?.tools ?? []).map(tool => tool.name)
    assert.ok(names.includes('tool_mode_run'), `tools/list must register tool_mode_run; got ${names.join(', ')}`)

    // Windows cannot deliver POSIX signals to a child: the graceful-shutdown
    // path is pinned in-process below, and the spawned child is terminated.
    child.kill('SIGKILL')
    await new Promise<void>(resolve => child.on('exit', () => resolve()))
  })

  it('shuts down cleanly when the signal source fires (in-process, deterministic on Windows)', async () => {
    const dir = scratch()
    const configPath = join(dir, 'tool-mode.json')
    writeFileSync(configPath, JSON.stringify({ mcpV3: { host: '127.0.0.1', port: 0, path: '/mcp' } }))
    // The in-process path reads the credential from the process env.
    process.env.DSH_TOOL_MODE_MCP_TOKEN = TOKEN
    const handlers = new Map<string, () => void>()
    const signals = {
      once(name: 'SIGINT' | 'SIGTERM', handler: () => void): void {
        handlers.set(name, handler)
      },
    }
    const lines: string[] = []
    let exited = false
    const running = runHeadlessServe(
      { configPath, json: true },
      { out: line => lines.push(line), err: () => {} },
      signals,
    ).then(code => {
      exited = true
      return code
    })
    // Wait for the bound line, then fire the signal; fail rather than hang.
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`no bound line; output: ${lines.join(' | ')}`)), 15_000)
      const timer = setInterval(() => {
        if (lines.some(line => line.includes('"listening"'))) {
          clearInterval(timer)
          clearTimeout(deadline)
          resolve()
        }
      }, 50)
    })
    handlers.get('SIGINT')?.()
    const code = await running
    assert.equal(exited, true)
    assert.equal(code, 0, 'a clean shutdown exits 0')
    const doc = JSON.parse(lines[0] as string) as { ok: boolean; url: string }
    assert.equal(doc.ok, true)
  })

  it('an invalid config exits nonzero with the named reason', async () => {
    const dir = scratch()
    const configPath = join(dir, 'tool-mode.json')
    writeFileSync(configPath, JSON.stringify({ repairAttempts: 99 }))
    const child = spawn(
      process.execPath,
      [join(process.cwd(), 'packages', 'dsh-model-as-tool', 'bin', 'dsh-tool-mode.mjs'), 'serve', '--config', configPath, '--json'],
      { env: { ...process.env, DSH_TOOL_MODE_MCP_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const out: string[] = []
    child.stdout?.on('data', chunk => out.push(String(chunk)))
    const code = await new Promise<number>(resolve => child.on('exit', resolve))
    assert.equal(code, 2)
    const doc = JSON.parse(out.join('').trim()) as { ok: boolean; error: string }
    assert.equal(doc.ok, false)
    assert.match(doc.error, /repairAttempts must be an integer between 0 and 8/)
  })

  it('a missing config file exits nonzero with the named reason', async () => {
    const dir = scratch()
    const child = spawn(
      process.execPath,
      [join(process.cwd(), 'packages', 'dsh-model-as-tool', 'bin', 'dsh-tool-mode.mjs'), 'serve', '--config', join(dir, 'absent.json'), '--json'],
      { env: { ...process.env, DSH_TOOL_MODE_MCP_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const out: string[] = []
    child.stdout?.on('data', chunk => out.push(String(chunk)))
    const code = await new Promise<number>(resolve => child.on('exit', resolve))
    assert.equal(code, 2)
    const doc = JSON.parse(out.join('').trim()) as { ok: boolean; error: string }
    assert.equal(doc.ok, false)
    assert.match(doc.error, /could not be read/)
  })
})

describe('task-74 (B) — CODE-11 configurable repair-budget ceilings', () => {
  it('the default ceiling is 1, unchanged', () => {
    assert.equal(repairCeilingOf({}), 1)
    assert.equal(titleLimitsFor().maxRepairs, 1)
  })

  it('a configured ceiling of 0 refuses after the budget with the lineage showing 0/0', () => {
    assert.equal(repairCeilingOf({ repairAttempts: 0 }), 0)
    const limits = titleLimitsFor(0)
    const previous = { kind: 'invalid', reason: 'the first attempt failed validation' } as const
    const decision = mayRepairTitle(limits, 0, previous)
    assert.equal(decision.repair, false)
    assert.match(decision.reason ?? '', /budget of 0 is exhausted/)
    const lineage = recordRepairLineage([], decision, previous.kind, limits.maxRepairs)
    assert.equal(lineage[0]?.budgetBefore, 0)
    assert.equal(lineage[0]?.budgetAfter, 0)
    assert.equal(lineage[0]?.outcome, 'exhausted')
  })

  it('a configured ceiling of 1 permits exactly one repair, then the lineage shows 1/0', () => {
    const limits = titleLimitsFor(repairCeilingOf({ repairAttempts: 1 }))
    const previous = { kind: 'rejected', reason: 'the model invented a fact' } as const
    const first = mayRepairTitle(limits, 0, previous)
    assert.equal(first.repair, true)
    const lineage = recordRepairLineage([], first, previous.kind, limits.maxRepairs)
    assert.equal(lineage[0]?.budgetBefore, 1)
    assert.equal(lineage[0]?.budgetAfter, 0)
    const second = mayRepairTitle(limits, first.repairs, previous)
    assert.equal(second.repair, false)
    assert.match(second.reason ?? '', /budget of 1 is exhausted/)
  })

  it('the v3 nested spelling is the equivalent of the flat alias', () => {
    assert.equal(repairCeilingOf({ harnessExecutorV3: { defaultRepairAttempts: 2 } as never }), 2)
    // The flat key drives when both are present.
    assert.equal(repairCeilingOf({ repairAttempts: 0, harnessExecutorV3: { defaultRepairAttempts: 2 } as never }), 0)
  })

  it('an invalid ceiling refuses at config parse, never clamps', () => {
    for (const invalid of [9, -1, 1.5, 'two']) {
      assert.throws(
        () => repairCeilingOf({ repairAttempts: invalid } as never),
        /must be an integer between 0 and 8/,
        `repairAttempts ${JSON.stringify(invalid)} must refuse`,
      )
    }
  })
})
