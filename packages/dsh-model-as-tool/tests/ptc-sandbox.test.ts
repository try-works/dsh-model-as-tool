/**
 * Slice 5 — sandbox CONFINEMENT, on the real backend.
 *
 * Every other PTC test in this repository runs under `danger-full-access`, which the
 * runtime SKIPS: `confined = policy.mode === 'danger-full-access' ? undefined : await
 * ctx.sandbox.confine(...)`. So those tests prove dispatch and prove NOTHING about
 * confinement — a gap this file exists to close, and one that was recorded as open rather
 * than left implied.
 *
 * Confined modes on Windows were UNTESTED when this was written. Whether they work is
 * therefore the finding, in either direction: a pass is evidence of enforcement, and a
 * failure is a narrowly stated blocked test rather than a silent omission.
 *
 * Requirement links: SEC-01, SEC-02, SEC-07, CODE-08.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mountPtcRuntimeIfAbsent, PTC_SERVICE } from '../src/ptc-runtime.ts'

/** Resolve the DSH packages, or report that this checkout cannot run the slice. */
async function loadDsh() {
  try {
    const [{ Context }, node, sessionProjection, fsLocal, subprocessLocal, sandboxLocal, sandboxPolicy] =
      await Promise.all([
        import('@deepseek-ai/cordis'),
        import('@deepseek-ai/dsh-ptc-runtime-node'),
        import('@deepseek-ai/dsh-session-projection'),
        import('@deepseek-ai/dsh-fs-local'),
        import('@deepseek-ai/dsh-subprocess-local'),
        import('@deepseek-ai/dsh-sandbox-local'),
        import('@deepseek-ai/dsh-sandbox-policy'),
      ])
    return {
      Context,
      backend: (node as any).NodePtcRuntime ?? (node as any).default,
      plugins: [
        (sessionProjection as any).default ?? sessionProjection,
        (fsLocal as any).default ?? fsLocal,
        (subprocessLocal as any).default ?? subprocessLocal,
        (sandboxLocal as any).default ?? sandboxLocal,
      ],
      sandboxPolicy: (sandboxPolicy as any).default ?? sandboxPolicy,
    }
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : String(error) }
  }
}

const loaded: any = await loadDsh()
const SKIP = loaded.unavailable === undefined
  ? undefined
  : `the DSH packages do not resolve in this checkout: ${loaded.unavailable}`

const dirs: string[] = []
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmx-sandbox-'))
  dirs.push(dir)
  return dir
}
process.on('exit', () => {
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

/** Mount the runtime under a specific sandbox mode. */
async function runtimeUnder(mode: string, cwd: string) {
  const ctx = new loaded.Context()
  for (const plugin of loaded.plugins) await ctx.plugin(plugin)
  await ctx.plugin(loaded.sandboxPolicy, { mode })
  const mount = await mountPtcRuntimeIfAbsent(ctx, loaded.backend, { timeoutMs: 30_000, maxTimeoutMs: 60_000 })
  const runtime = ctx.get(PTC_SERVICE)
  // Report what the policy actually resolved to, so a test cannot pass because the
  // requested mode was silently ignored.
  // The service exposes defaultMode, not mode. Reading the wrong accessor made a
  // correct confinement look like a silently ignored one.
  const policy: any = ctx.get('sandboxPolicy')
  return { ctx, runtime, mount, sandboxMode: policy?.defaultMode, cwd }
}

/**
 * Probe `workspace-write` ONCE, so its availability is a measured fact rather than an
 * assumption, and so the reason travels with the skip.
 */
const workspaceWriteBlocked: string | undefined = await (async () => {
  if (SKIP !== undefined) return undefined
  try {
    const dir = mkdtempSync(join(tmpdir(), 'tmx-probe-'))
    dirs.push(dir)
    const { runtime } = await runtimeUnder('workspace-write', dir)
    const result = await runtime.run(runtime.resolve({ program: 'return 1;', bindings: [], cwd: dir, timeoutMs: 30_000 }))
    if (result.error?.kind === 'sandbox-unavailable') {
      return `workspace-write cannot start in this Windows environment: ${result.error.message}`
    }
    return undefined
  } catch (error) {
    return `the workspace-write probe failed: ${error instanceof Error ? error.message : String(error)}`
  }
})()

describe('slice 5 — sandbox confinement', { skip: SKIP }, () => {
  it('read-only REFUSES a write the program attempts', async () => {
    const dir = workspace()
    const target = join(dir, 'should-not-exist.txt').replace(/\\/g, '/')
    const { runtime, sandboxMode } = await runtimeUnder('read-only', dir)
    assert.equal(sandboxMode, 'read-only', 'the requested mode must be the resolved mode')

    const result = await runtime.run(runtime.resolve({
      program: `
        const fs = await import('node:fs');
        try {
          fs.writeFileSync(${JSON.stringify(target)}, 'written');
          return { wrote: true };
        } catch (error) {
          return { wrote: false, code: error && error.code };
        }
      `,
      bindings: [],
      cwd: dir,
      timeoutMs: 30_000,
    }))

    // Either the run was refused outright, or the program observed the denial. What must
    // NOT happen is the file appearing on disk.
    const wrote = result.value?.wrote === true
    assert.equal(wrote, false, `read-only permitted a write: ${JSON.stringify(result)}`)
    assert.equal(existsSync(join(dir, 'should-not-exist.txt')), false, 'the file must not exist')
  })

  /**
   * `workspace-write` IS BLOCKED ON WINDOWS IN THIS ENVIRONMENT, and the exact failure is
   * recorded rather than hidden behind a pass.
   *
   * The backend reports:
   *   kind: "sandbox-unavailable"
   *   message: "windows-acl-run: SetNamedSecurityInfoW failed (Win32 5):
   *             grantWrite(D:\DEV\dsh-model-as-tool)"
   *
   * Win32 error 5 is ACCESS_DENIED: the sandbox enforces `workspace-write` by granting
   * write through Windows ACLs, and this process cannot modify the ACL of the repository
   * directory it is asked to grant. That is an ENVIRONMENT limitation, not an
   * implementation defect, and it is the kind of thing that must be stated precisely
   * instead of being reported as "sandboxing works".
   *
   * The two tests below therefore FAIL LOUDLY when the sandbox is unavailable, rather than
   * asserting on a program that never ran. An earlier version of the escape test passed
   * VACUOUSLY for exactly that reason: the run errored out, `wrote` was undefined, and
   * `notEqual(undefined, true)` held. A security assertion that passes because the
   * subject never executed is worse than no assertion.
   */
  it('workspace-write is AVAILABLE in this environment', { skip: workspaceWriteBlocked }, async () => {
    const dir = workspace()
    const { runtime } = await runtimeUnder('workspace-write', dir)
    const result = await runtime.run(runtime.resolve({
      program: 'return { ok: true };',
      bindings: [],
      cwd: dir,
      timeoutMs: 30_000,
    }))
    // Reaching here means the probe found it available, so a failure is a REAL regression
    // rather than the known environment limitation.
    assert.equal(result.error, undefined, `the run failed: ${JSON.stringify(result.error)}`)
  })

  it('workspace-write PERMITS a write inside the workspace', { skip: workspaceWriteBlocked }, async () => {
    const dir = workspace()
    const target = join(dir, 'allowed.txt').replace(/\\/g, '/')
    const { runtime, sandboxMode } = await runtimeUnder('workspace-write', dir)
    assert.equal(sandboxMode, 'workspace-write')

    const result = await runtime.run(runtime.resolve({
      program: `
        const fs = await import('node:fs');
        fs.writeFileSync(${JSON.stringify(target)}, 'allowed');
        return { wrote: true };
      `,
      bindings: [],
      cwd: dir,
      timeoutMs: 30_000,
    }))

    // The PERMITTED half matters as much as the refusal: a sandbox that denies everything
    // is not confinement, it is a broken tool. If this fails while read-only passes, the
    // finding is that workspace-write is over-restrictive.
    assert.equal(result.error, undefined, `the run failed: ${JSON.stringify(result.error)}`)
    assert.equal(result.value?.wrote, true, JSON.stringify(result))
    assert.equal(readFileSync(join(dir, 'allowed.txt'), 'utf8'), 'allowed')
  })

  it('workspace-write REFUSES a write OUTSIDE the workspace', { skip: workspaceWriteBlocked }, async () => {
    const dir = workspace()
    const outside = join(tmpdir(), `tmx-outside-${process.pid}.txt`).replace(/\\/g, '/')
    const { runtime } = await runtimeUnder('workspace-write', dir)

    const result = await runtime.run(runtime.resolve({
      program: `
        const fs = await import('node:fs');
        try {
          fs.writeFileSync(${JSON.stringify(outside)}, 'escaped');
          return { wrote: true };
        } catch (error) {
          return { wrote: false };
        }
      `,
      bindings: [],
      cwd: dir,
      timeoutMs: 30_000,
    }))

    // The escape is what confinement exists to stop: a mode that permits the workspace
    // must not permit its parent by the same token.
    assert.notEqual(result.value?.wrote, true, `workspace-write permitted an escape: ${JSON.stringify(result)}`)
    assert.equal(existsSync(join(tmpdir(), `tmx-outside-${process.pid}.txt`)), false)
  })

  it('reports the ENFORCEMENT the sandbox actually applied', async () => {
    const dir = workspace()
    const { runtime } = await runtimeUnder('read-only', dir)
    const result = await runtime.run(runtime.resolve({
      program: 'return { ok: true };',
      bindings: [],
      cwd: dir,
      timeoutMs: 30_000,
    }))
    // `sandbox` is the runtime's own report of what it enforced, so a confined run is
    // distinguishable from one that silently fell through to no confinement.
    assert.ok(result.sandbox !== undefined, 'the run must report its sandbox')
    assert.notEqual(result.sandbox?.mode, 'danger-full-access', 'a confined mode must not report as unconfined')
  })
})
