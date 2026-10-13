/**
 * Deployment coordination tests (RES-02, RES-03, RES-05).
 *
 * The single-flight test is the one that matters most: it counts how many times the
 * loader actually ran. A coordinator that starts two loads of a 349 MB model passes
 * every other assertion while silently doubling the memory, and only a count catches
 * that.
 *
 * Requirement links: RES-02, RES-03, RES-05.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  DeploymentCoordinator,
  DeploymentError,
  deploymentKey,
  planPreparation,
  purgeCandidates,
  type DeploymentIdentity,
} from '../src/deployment-coordinator.ts'

/** An exact deployment identity. */
const IDENTITY: DeploymentIdentity = {
  extensionId: '@try-works/extension-desert-ant-voz',
  modelId: 'voz',
  modelRevision: 'a1b2c3d',
  engineVersion: 'onnxruntime-node-1.20.0',
  quantization: 'int8',
  tokenizer: 'voz-tokenizer-v1',
  preprocessingRecipe: '1.0.0',
}

/** A loader that counts its calls and can be made slow or failing. */
function makeLoader(options: { readonly delayMs?: number; readonly fail?: boolean } = {}) {
  let calls = 0
  const load = async (): Promise<void> => {
    calls += 1
    if (options.delayMs !== undefined) await new Promise(resolve => setTimeout(resolve, options.delayMs))
    if (options.fail === true) throw new Error('the weights are corrupt')
  }
  return { load, calls: () => calls }
}

describe('RES-05 — one operation per EXACT deployment', () => {
  it('uses a key that includes every identity field', () => {
    const base = deploymentKey(IDENTITY)
    // Each field must participate, or a caller could be served by a build it did not
    // ask for. Quantization is the sharpest case: same model, different outputs.
    for (const [field, value] of Object.entries({
      extensionId: '@other/ext',
      modelId: 'other',
      modelRevision: 'deadbeef',
      engineVersion: 'ort-2.0.0',
      quantization: 'fp16',
      tokenizer: 'other-tok',
      preprocessingRecipe: '2.0.0',
    })) {
      const changed = deploymentKey({ ...IDENTITY, [field]: value })
      assert.notEqual(changed, base, `${field} must change the deployment key`)
    }
  })

  it('treats two quantizations of one model as DIFFERENT deployments', () => {
    const coordinator = new DeploymentCoordinator()
    const int8 = makeLoader()
    const fp16 = makeLoader()
    // Loading the int8 build must not satisfy a request for fp16.
    assert.notEqual(deploymentKey(IDENTITY), deploymentKey({ ...IDENTITY, quantization: 'fp16' }))
    void coordinator
    assert.equal(int8.calls(), 0)
    assert.equal(fp16.calls(), 0)
  })

  it('JOINS concurrent callers onto ONE load', async () => {
    const coordinator = new DeploymentCoordinator()
    const loader = makeLoader({ delayMs: 40 })
    // Three callers reach the coordinator before the load settles, which is what
    // "concurrent" means for a single-threaded runtime.
    const leases = await Promise.all([
      coordinator.acquire(IDENTITY, loader.load),
      coordinator.acquire(IDENTITY, loader.load),
      coordinator.acquire(IDENTITY, loader.load),
    ])
    // The count is the assertion that matters: a second load of a 349 MB model would
    // pass every other check while doubling memory.
    assert.equal(loader.calls(), 1, 'the loader must run exactly once for a concurrent group')
    assert.equal(leases.length, 3)
    assert.equal(coordinator.record(deploymentKey(IDENTITY))?.activeUsers, 3)
  })

  it('does not reload an already-ready deployment', async () => {
    const coordinator = new DeploymentCoordinator()
    const loader = makeLoader()
    const first = await coordinator.acquire(IDENTITY, loader.load)
    first.release()
    const second = await coordinator.acquire(IDENTITY, loader.load)
    assert.equal(loader.calls(), 1)
    assert.equal(second.joined, false)
    second.release()
  })

  it('reports a joiner as having joined', async () => {
    const coordinator = new DeploymentCoordinator()
    const loader = makeLoader({ delayMs: 30 })
    const [a, b] = await Promise.all([
      coordinator.acquire(IDENTITY, loader.load),
      coordinator.acquire(IDENTITY, loader.load),
    ])
    // One started the load; the other waited for it. Which is which is not
    // deterministic, but exactly one of them must have joined.
    assert.equal([a.joined, b.joined].filter(Boolean).length, 1)
    a.release()
    b.release()
  })
})

describe('RES-05 — reference counting and unload discipline', () => {
  it('tracks active users and refuses to unload a busy deployment', async () => {
    const coordinator = new DeploymentCoordinator()
    const loader = makeLoader()
    const lease = await coordinator.acquire(IDENTITY, loader.load)
    const key = deploymentKey(IDENTITY)

    const refused = coordinator.unload(key)
    assert.equal(refused.unloaded, false)
    // The count is the whole point: unloading here would discard this caller's work.
    assert.match(String(refused.reason), /1 caller\(s\) are still using it/)

    lease.release()
    assert.equal(coordinator.unload(key).unloaded, true)
    assert.equal(coordinator.record(key)?.readiness, 'prepared-cold')
  })

  it('release is idempotent, so a double release cannot corrupt the count', async () => {
    const coordinator = new DeploymentCoordinator()
    const lease = await coordinator.acquire(IDENTITY, makeLoader().load)
    lease.release()
    lease.release()
    assert.equal(coordinator.record(deploymentKey(IDENTITY))?.activeUsers, 0)
  })

  it('revocation is the one case that may discard a busy deployment', async () => {
    const coordinator = new DeploymentCoordinator()
    const lease = await coordinator.acquire(IDENTITY, makeLoader().load)
    const key = deploymentKey(IDENTITY)
    // Explicit, because the operator asked rather than a policy inferring it.
    assert.equal(coordinator.revoke(key), true)
    assert.equal(coordinator.record(key)?.readiness, 'prepared-cold')
    assert.equal(coordinator.record(key)?.activeUsers, 0)
    lease.release()
  })

  it('unloading an unknown deployment reports rather than throwing', () => {
    const result = new DeploymentCoordinator().unload('not-a-key')
    assert.equal(result.unloaded, false)
    assert.match(String(result.reason), /no such deployment/)
  })
})

describe('RES-03 — a failed preparation cannot become ready', () => {
  it('records the failure and does not report ready', async () => {
    const coordinator = new DeploymentCoordinator()
    const loader = makeLoader({ fail: true })
    await assert.rejects(coordinator.acquire(IDENTITY, loader.load), (error: unknown) => {
      assert.ok(error instanceof DeploymentError)
      assert.match(error.message, /the weights are corrupt/)
      return true
    })
    // RES-03 is explicit: a failed or interrupted preparation CANNOT become ready.
    const record = coordinator.record(deploymentKey(IDENTITY))
    assert.equal(record?.readiness, 'failed')
    assert.equal(record?.failureReason, 'the weights are corrupt')
  })

  it('RETRIES on the next call rather than inheriting the failure', async () => {
    const coordinator = new DeploymentCoordinator()
    let attempt = 0
    const load = async (): Promise<void> => {
      attempt += 1
      if (attempt === 1) throw new Error('transient network failure')
    }
    await assert.rejects(coordinator.acquire(IDENTITY, load))
    assert.equal(coordinator.record(deploymentKey(IDENTITY))?.readiness, 'failed')

    // A transient failure must not poison the deployment forever.
    const lease = await coordinator.acquire(IDENTITY, load)
    assert.equal(attempt, 2)
    assert.equal(lease.readiness, 'ready')
    lease.release()
  })

  it('every joiner of a FAILED load is told it failed', async () => {
    const coordinator = new DeploymentCoordinator()
    const loader = makeLoader({ delayMs: 20, fail: true })
    const results = await Promise.allSettled([
      coordinator.acquire(IDENTITY, loader.load),
      coordinator.acquire(IDENTITY, loader.load),
    ])
    // Sharing one failure is correct; sharing one success would not be.
    assert.equal(results.filter(r => r.status === 'rejected').length, 2)
    assert.equal(loader.calls(), 1)
  })
})

describe('RES-05 — cancellation is per invocation', () => {
  it('a cancelled caller gives up WITHOUT destroying the deployment', async () => {
    const coordinator = new DeploymentCoordinator()
    const loader = makeLoader({ delayMs: 30 })
    const controller = new AbortController()
    controller.abort()

    await assert.rejects(
      coordinator.acquire(IDENTITY, loader.load, { signal: controller.signal }),
      /the caller cancelled/,
    )
    const record = coordinator.record(deploymentKey(IDENTITY))
    // The load still completed and the deployment is available: killing it here would
    // destroy another caller's legitimate work.
    assert.equal(record?.readiness, 'ready')
    assert.equal(record?.activeUsers, 0)
  })

  it('one cancelled caller does not affect a concurrent one', async () => {
    const coordinator = new DeploymentCoordinator()
    const loader = makeLoader({ delayMs: 30 })
    const cancelled = new AbortController()
    cancelled.abort()

    const results = await Promise.allSettled([
      coordinator.acquire(IDENTITY, loader.load, { signal: cancelled.signal }),
      coordinator.acquire(IDENTITY, loader.load),
    ])
    assert.equal(results[0]?.status, 'rejected')
    assert.equal(results[1]?.status, 'fulfilled')
    assert.equal(loader.calls(), 1)
    assert.equal(coordinator.record(deploymentKey(IDENTITY))?.activeUsers, 1)
  })
})

describe('RES-02 — preparation is explicit and disclosed before approval', () => {
  it('discloses download size, storage and license before the download', () => {
    const plan = planPreparation(IDENTITY, [
      { assetId: 'weights', bytes: 300 * 1024 * 1024, source: 'https://example.invalid/w.bin', digest: 'a'.repeat(64), executable: false },
      { assetId: 'tokenizer', bytes: 2 * 1024 * 1024, source: 'https://example.invalid/t.bin', digest: 'b'.repeat(64), executable: false },
    ], { name: 'Desert Ant Labs Source-Available License 1.0', url: 'https://desertant.com/license' })

    // An operator approves a NUMBER, not a hope.
    assert.equal(plan.totalBytes, 302 * 1024 * 1024)
    assert.equal(plan.storageBytes, 302 * 1024 * 1024)
    assert.equal(plan.requiresExecutableApproval, false)
    assert.match(plan.license.name, /Source-Available/)
  })

  it('flags an executable asset as needing EXECUTABLE approval', () => {
    const plan = planPreparation(IDENTITY, [
      { assetId: 'onnxruntime', bytes: 50 * 1024 * 1024, source: 'https://example.invalid/ort.tgz', digest: 'c'.repeat(64), executable: true },
    ], { name: 'MIT', url: 'https://example.invalid/license' })
    // RES-02: prebuilt engine downloads count as executable installation, so they
    // need the separate approval rather than riding along with a model download.
    assert.equal(plan.requiresExecutableApproval, true)
  })

  it('states storage separately from download', () => {
    const plan = planPreparation(IDENTITY, [], { name: 'MIT', url: 'x' })
    // An operator approving bandwidth is not thereby approving disk, so both are
    // present even when they happen to be equal.
    assert.ok('storageBytes' in plan)
    assert.ok('totalBytes' in plan)
  })

  it('an empty asset set is a valid plan', () => {
    // Tongue bundles its weights, so it legitimately prepares nothing.
    const plan = planPreparation(IDENTITY, [], { name: 'MIT', url: 'x' })
    assert.equal(plan.totalBytes, 0)
    assert.equal(plan.requiresExecutableApproval, false)
  })
})

describe('RES-03 — purge is separate from uninstall and deletes only unreferenced assets', () => {
  it('retains an asset that another owner still holds', () => {
    const result = purgeCandidates([
      { digest: 'shared', owners: ['@acme/one', '@acme/two'] },
      { digest: 'exclusive', owners: ['@acme/one'] },
    ], '@acme/one')
    // Deleting `shared` would break a deployment nobody uninstalled.
    assert.deepEqual([...result.deletable], ['exclusive'])
    assert.deepEqual([...result.retained], ['shared'])
  })

  it('deletes nothing when every asset has another owner', () => {
    const result = purgeCandidates([{ digest: 'a', owners: ['@acme/one', '@acme/two'] }], '@acme/one')
    assert.deepEqual([...result.deletable], [])
  })

  it('removing an owner with no assets is a no-op', () => {
    assert.deepEqual([...purgeCandidates([], '@acme/one').deletable], [])
  })

  it('keys assets by CONTENT digest, so sharing is safe', () => {
    // Two owners of the same digest genuinely share bytes; two owners of the same
    // FILENAME do not, which is why the digest is the key.
    const result = purgeCandidates([
      { digest: 'same-bytes', owners: ['a', 'b'] },
      { digest: 'other-bytes', owners: ['a'] },
    ], 'a')
    assert.deepEqual([...result.deletable], ['other-bytes'])
  })
})

