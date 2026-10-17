/**
 * Slice 2 — REAL PTC composition, on the actual DSH backend.
 *
 * The directive's minimum evidence, verbatim:
 *
 *   "A program calls two deterministic fixture tools, handles a dependency and branch,
 *    returns canonical output, and obeys cancellation/revocation. Run the actual DSH PTC
 *    backend, not a fake executor. Model weights are unnecessary for this slice."
 *
 * This runs the REAL `NodePtcRuntime` over the real composed services. It is not a fake
 * executor and it is not a stub: the program is compiled and executed in a subprocess by
 * the backend, and the two tools it calls go through `buildToolBindings`, which is the
 * SAME authorization path an external `tool_mode_run` must use.
 *
 * Model weights are absent by design. A passing run proves COMPOSITION AND DISPATCH and
 * says nothing about model quality — which is why the fixture tools compute rather than
 * infer.
 *
 * The DSH packages are imported DYNAMICALLY so that a checkout without them SKIPS this
 * file rather than failing the suite: the plugin must remain buildable by an author who
 * has not installed the host.
 *
 * Requirement links: CODE-01, CODE-02, CODE-03, CODE-05, CODE-08, ARCH-05.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { buildToolBindings, mountPtcRuntimeIfAbsent, PTC_SERVICE, type PtcHostContext } from '../src/ptc-runtime.ts'
import { createProgramRunner, serveProgram, type ProgramRuntime } from '../src/tool-mode-run.ts'
import type { ToolBinding } from '../src/ptc-authority.ts'

/** Resolve the DSH packages, or report that this checkout cannot run the slice. */
async function loadDsh(): Promise<{
  Context: any
  backend: unknown
  plugins: unknown[]
  sandboxPolicy: unknown
} | { unavailable: string }> {
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

const loaded = await loadDsh()
const SKIP = 'unavailable' in loaded
  ? `the DSH packages do not resolve in this checkout: ${loaded.unavailable}`
  : undefined

/** Build a live context with the backend mounted at most once. */
async function liveRuntime() {
  if ('unavailable' in loaded) throw new Error(loaded.unavailable)
  const ctx = new loaded.Context()
  for (const plugin of loaded.plugins) await ctx.plugin(plugin)
  await ctx.plugin(loaded.sandboxPolicy, { mode: 'danger-full-access' })
  // THE GUARDED MOUNT: inside a full DSH deployment the base bundle has already provided
  // this, and an unguarded ctx.plugin throws.
  const mount = await mountPtcRuntimeIfAbsent(ctx, loaded.backend, {
    timeoutMs: 30_000,
    maxTimeoutMs: 60_000,
  })
  const runtime = ctx.get(PTC_SERVICE)
  return { ctx, runtime, mount }
}

/** Two deterministic tools: one computes, the other depends on the first. */
function fixtureTools() {
  const calls: string[] = []
  const bindings: Record<string, ToolBinding> = {
    /** Doubles a number. */
    double_it: async args => {
      calls.push('double_it')
      const n = args.n
      if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error('double_it requires a finite number')
      return { value: n * 2 }
    },
    /** Depends on `double_it` having produced a positive value. */
    label_it: async args => {
      calls.push('label_it')
      const value = args.value
      if (typeof value !== 'number') throw new Error('label_it requires a number')
      // A BRANCH: the label depends on the value, so the program must handle both paths.
      return { label: value > 10 ? 'large' : 'small' }
    },
  }
  return { bindings, calls }
}

describe('slice 2 — REAL PTC composition', { skip: SKIP }, () => {
  it('mounts through the guard and exposes the service either way', async () => {
    const { mount, runtime } = await liveRuntime()
    // Inside a full deployment the base bundle provides the runtime, so `mounted` is
    // false and that is a SUCCESS — the service is present and usable.
    assert.ok(mount.service === PTC_SERVICE)
    assert.ok(runtime !== undefined, 'the service must be usable after the mount attempt')
  })

  it('runs a program that calls TWO tools, branches on a DEPENDENCY, and returns canonical output', async () => {
    const { runtime } = await liveRuntime()
    const { bindings, calls } = fixtureTools()

    // The program's requested names go through the SAME authorization path an external
    // tool_mode_run uses — that is the point of the single pipeline.
    const outcome = buildToolBindings({
      requested: ['double_it', 'label_it'],
      authority: { granted: ['double_it', 'label_it'], visible: ['double_it', 'label_it'] },
      resolve: name => bindings[name],
    })
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.message)
    if (!outcome.ok) return

    const result = await runtime.run(runtime.resolve({
      program: `
        const first = await tools.double_it({ n: 21 });
        const second = await tools.label_it({ value: first.value });
        return { doubled: first.value, label: second.label };
      `,
      bindings: [outcome.namespace],
      timeoutMs: 30_000,
    }))

    assert.equal(result.error, undefined, `the run failed: ${JSON.stringify(result.error)}`)
    // CANONICAL OUTPUT: the completion value, not a log line.
    assert.deepEqual(result.value, { doubled: 42, label: 'large' })
    // Both tools ran, in the order the program asked for them.
    assert.deepEqual(calls, ['double_it', 'label_it'])
  })

  it('takes the OTHER branch when the value is small', async () => {
    const { runtime } = await liveRuntime()
    const { bindings } = fixtureTools()
    const outcome = buildToolBindings({
      requested: ['double_it', 'label_it'],
      authority: { granted: ['double_it', 'label_it'], visible: ['double_it', 'label_it'] },
      resolve: name => bindings[name],
    })
    if (!outcome.ok) throw new Error(outcome.message)

    const result = await runtime.run(runtime.resolve({
      program: `
        const first = await tools.double_it({ n: 2 });
        const second = await tools.label_it({ value: first.value });
        return { doubled: first.value, label: second.label };
      `,
      bindings: [outcome.namespace],
      timeoutMs: 30_000,
    }))
    assert.deepEqual(result.value, { doubled: 4, label: 'small' })
  })

  it('ABORTS a running program rather than letting it finish', async () => {
    const { runtime } = await liveRuntime()
    const controller = new AbortController()
    const started = Date.now()
    // Abort shortly after the program starts a long loop.
    setTimeout(() => controller.abort(), 250)

    const result = await runtime.run(runtime.resolve({
      program: `
        let spins = 0;
        while (true) { spins += 1; }
        return { spins };
      `,
      bindings: [],
      timeoutMs: 30_000,
      signal: controller.signal,
    }))

    // A HARD stop: the runtime must not wait for the loop to end, because it never would.
    assert.equal(result.error?.kind, 'abort', `expected an abort, got ${JSON.stringify(result.error)}`)
    assert.ok(Date.now() - started < 20_000, 'the abort must stop the program, not time it out')
  })

  it('FAILS a program that calls a tool it was not granted, instead of omitting it', async () => {
    const { bindings } = fixtureTools()
    const outcome = buildToolBindings({
      requested: ['double_it', 'label_it'],
      authority: { granted: ['double_it'], visible: ['double_it', 'label_it'] },
      resolve: name => bindings[name],
    })
    // All-or-nothing: the program never runs against a smaller namespace than it declared.
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.match(outcome.message, /label_it: forbidden/)
  })

  it('reports a tool failure through the program rather than swallowing it', async () => {
    const { runtime } = await liveRuntime()
    const outcome = buildToolBindings({
      requested: ['double_it'],
      authority: { granted: ['double_it'], visible: ['double_it'] },
      resolve: () => async () => {
        throw new Error('the fixture refused')
      },
    })
    if (!outcome.ok) throw new Error(outcome.message)

    const result = await runtime.run(runtime.resolve({
      program: `
        try {
          await tools.double_it({ n: 1 });
          return { reached: false };
        } catch (error) {
          return { reached: true, message: String(error && error.message ? error.message : error) };
        }
      `,
      bindings: [outcome.namespace],
      timeoutMs: 30_000,
    }))
    // The program CAN observe the rejection; the runtime does not convert a failed call
    // into a successful value.
    assert.equal(result.value?.reached, true)
    assert.match(String(result.value?.message), /refused/)
  })

  it('serves a REAL program through serveProgram, the tool_mode_run path (CODE-02)', async () => {
    const { ctx, runtime } = await liveRuntime()
    const { bindings, calls } = fixtureTools()
    const runner = createProgramRunner({
      context: ctx as unknown as PtcHostContext,
      backend: loaded.backend,
      grant: () => ['double_it', 'label_it'],
      visible: () => ['double_it', 'label_it'],
      resolve: name => bindings[name],
      runtime: () => runtime as unknown as ProgramRuntime,
      operatorGranted: () => true,
    })

    const report = await serveProgram({
      description: 'compose two deterministic tools',
      code: `
        const first = await tools.double_it({ n: 21 });
        const second = await tools.label_it({ value: first.value });
        return { doubled: first.value, label: second.label };
      `,
      tools: ['double_it', 'label_it'],
    }, runner, { receiptId: 'rcpt_composition', catalogRevision: '1' })

    // THE SERVED PATH END TO END: the real backend ran the program, the two bindings
    // were called through the authorized namespace, and the report carries the
    // canonical value plus the real call count.
    assert.deepEqual(report.result, { doubled: 42, label: 'large' })
    assert.deepEqual(calls, ['double_it', 'label_it'])
    assert.equal(report.meta.toolCalls, 2, 'the served path must count real binding calls')
    assert.equal(report.meta.receiptId, 'rcpt_composition')
    assert.equal(report.meta.catalogRevision, '1')
    assert.ok(report.meta.elapsedMs >= 0)
  })

  it('refuses an input-bearing program through serveProgram (CODE-04)', async () => {
    const { ctx, runtime } = await liveRuntime()
    const { bindings } = fixtureTools()
    const runner = createProgramRunner({
      context: ctx as unknown as PtcHostContext,
      backend: loaded.backend,
      grant: () => ['double_it'],
      visible: () => ['double_it'],
      resolve: name => bindings[name],
      runtime: () => runtime as unknown as ProgramRuntime,
      operatorGranted: () => true,
    })
    await assert.rejects(
      serveProgram({ description: 'probe', code: 'return input.n;', input: { n: 1 }, tools: ['double_it'] }, runner, {
        receiptId: 'rcpt_input', catalogRevision: '1',
      }),
      /no structured-data path/,
    )
  })
})

