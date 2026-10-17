/**
 * SEC-01 credential GENERATION: high-entropy secrets, once-only discipline,
 * owner-only storage, independent revocation (SEC-01).
 *
 * The clauses this file pins now:
 * - generation is HUMAN-ONLY: the model-visible `model_tools credentials`
 *   surface REFUSES generate and carries no secret anywhere; the human CLI is
 *   the one place a secret is ever printed (once, to stdout);
 * - the secret is crypto-random (32 bytes, base64url) and never re-echoed;
 * - a generated credential authenticates IMMEDIATELY (both schemes) and
 *   revokes independently (401 after revocation, peers untouched);
 * - scheme separation: an OAuth resource-server secret NEVER matches the
 *   static-bearer lookup (scheme confusion);
 * - the OAuth registry is LIVE: delete-then-recreate with a new secret/scope
 *   invalidates old tokens, and a credential generated after the server was
 *   constructed issues without a restart;
 * - generation is FAIL-CLOSED: a credential that cannot be persisted is
 *   unusable, and a CORRUPT document refuses mutations without being
 *   overwritten "as if empty";
 * - the stored document is owner-only: POSIX 0600, and on Windows an EXPLICIT
 *   owner-only DACL applied before the document is published;
 * - concurrent writers cannot lose each other's entries, and the atomic
 *   temp+rename publish never follows a planted symlink at the target;
 * - the secret never appears in receipts, failure bodies, or redaction-
 *   protected text (including base64url secrets beginning/ending '-').
 *
 * Requirement links: SEC-01, BASE-05.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'

import {
  applyOwnerOnlyDacl,
  CorruptCredentialStoreError,
  createFileCredentialStore,
  generateCredential,
  removeCredentialStoreFile,
  type StoredClientCredential,
} from '../src/mcp/credential-store.ts'
import { runCredentialsCli } from '../src/mcp/credential-cli.ts'
import { createLocalOAuthServer } from '../src/mcp/oauth.ts'
import { createHttpHandler, type HttpRequestDescription } from '../src/mcp/http.ts'
import { META_KEYS, PROTOCOL_VERSION } from '../src/mcp/protocol.ts'
import { redactText } from '../src/receipt.ts'
import { cleanup, callTool, mountPlugin, tempDir } from './helpers.ts'
import type { McpHost } from '../src/mcp/server.ts'

after(async () => { await cleanup() })

const ISSUER = 'https://credentials.local'
const AUDIENCE = 'credentials-mcp'

/** A fake host surface with ONE real probe tool, so handler admission and the
 * official-v2 serving adapter can route a tools/call end to end. */
const host: McpHost = {
  serverInfo: { name: 'credentials-test', version: '1' },
  listTools: () => [{
    name: 'probe',
    description: 'a probe tool for credential tests',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
    outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: false },
    importedFromMcp: false,
  }],
  async callTool() {
    return { isError: false, structured: { ok: true }, text: 'probe ok' }
  },
}

function callBodyFor(name: string, args: Record<string, unknown>, id: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      _meta: {
        [META_KEYS.protocolVersion]: PROTOCOL_VERSION,
        [META_KEYS.clientCapabilities]: {},
      },
      name,
      arguments: args,
    },
  })
}

function requestFor(token: string): HttpRequestDescription {
  return {
    method: 'POST',
    path: '/mcp',
    remoteAddress: '127.0.0.1',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'mcp-protocol-version': PROTOCOL_VERSION,
      'mcp-method': 'tools/call',
      'mcp-name': 'probe',
    },
    body: callBodyFor('probe', { text: 'probe' }, 'c-1'),
  }
}

/** A static credential for store-level tests. */
function staticCredential(id: string, secret: string): StoredClientCredential {
  return { clientId: id, secret, scheme: 'static-token', scope: [], createdAt: new Date().toISOString() }
}

/** A blocking sleep for the lock-contention tests. */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

describe('SEC-01 — the credential store persists owner-only and constant-time', () => {
  it('round-trips a credential and serves it by identity and by secret', () => {
    const file = join(tempDir(), 'credentials.json')
    const store = createFileCredentialStore(file)
    const credential = staticCredential('app-1', 'a-secret-that-is-long-enough-to-look-real')
    store.upsert(credential)
    assert.deepEqual(store.list().map(entry => entry.clientId), ['app-1'])
    assert.equal(store.get('app-1')?.secret, credential.secret)
    assert.equal(store.bySecret(credential.secret)?.clientId, 'app-1')
    assert.equal(store.bySecret('not-the-secret'), undefined, 'a wrong secret must miss')

    // A SECOND store instance over the same file sees the persisted credential.
    const reopened = createFileCredentialStore(file)
    assert.equal(reopened.bySecret(credential.secret)?.clientId, 'app-1', 'persistence must survive reopening')

    store.delete('app-1')
    assert.equal(store.get('app-1'), undefined)
    // The store is FILE-FRESH on every read, so even an instance created earlier sees
    // the deletion on its very next lookup — the property the revoke→401 path relies on.
    assert.equal(reopened.get('app-1'), undefined, 'a deletion must be visible to every reader immediately')
    assert.equal(createFileCredentialStore(file).get('app-1'), undefined, 'deletion is durable')
    removeCredentialStoreFile(file)
  })

  it('SCHEME SEPARATION: an OAuth resource-server secret never matches the static-bearer lookup', () => {
    const file = join(tempDir(), 'credentials.json')
    const store = createFileCredentialStore(file)
    const oauthSecret = 'a'.repeat(43)
    store.upsert({
      clientId: 'oauth-app', secret: oauthSecret, scheme: 'oauth-resource-server',
      scope: ['mcp:call'], createdAt: new Date().toISOString(),
    })
    store.upsert(staticCredential('static-app', 'b'.repeat(43)))
    assert.equal(store.bySecret(oauthSecret), undefined, 'an OAuth secret must never authenticate as a static bearer')
    assert.equal(store.bySecret('b'.repeat(43))?.clientId, 'static-app', 'the static credential matches under its own scheme')
    removeCredentialStoreFile(file)
  })

  it('writes the document owner-only: 0600 on POSIX, an explicit owner-only DACL on Windows', () => {
    const file = join(tempDir(), 'credentials.json')
    const store = createFileCredentialStore(file)
    store.upsert({
      clientId: 'app-2', secret: 'another-secret', scheme: 'oauth-resource-server',
      scope: ['mcp:call'], createdAt: new Date().toISOString(),
    })
    const mode = statSync(file).mode & 0o777
    if (process.platform === 'win32') {
      // The store applies the DACL BEFORE publishing: icacls reports the granted
      // entries, and only the owner may hold a grant. Inheritance is removed.
      const probe = spawnSync('icacls', [file], { encoding: 'utf8', windowsHide: true })
      assert.equal(probe.status, 0, `icacls must be able to read the published file: ${probe.stderr}`)
      const output = probe.stdout ?? ''
      assert.match(output, /:\(F\)/, `the owner must hold full control, saw: ${output}`)
      assert.ok(output.includes(process.env.USERNAME ?? ''), `the grant must name the current owner, saw: ${output}`)
      assert.doesNotMatch(
        output,
        /Everyone|BUILTIN\\Users|BUILTIN\\Administrators|Authenticated Users|NT AUTHORITY/i,
        `a non-owner ACE survived: ${output}`,
      )
    } else {
      assert.equal(mode, 0o600, `the credential document must be owner-only, saw ${mode.toString(8)}`)
    }
    removeCredentialStoreFile(file)
  })

  it('fails closed: an upsert that cannot persist rolls back and throws', () => {
    // The parent of the store file is a FILE, so mkdir/write must fail.
    const blocker = join(tempDir(), 'not-a-directory')
    writeFileSync(blocker, 'i block the directory')
    const store = createFileCredentialStore(join(blocker, 'credentials.json'))
    assert.throws(() => store.upsert(staticCredential('app-3', 'unpersistable')))
    assert.equal(store.get('app-3'), undefined, 'the failed upsert must leave nothing registered')
    assert.equal(store.list().length, 0)
  })

  it('FAILS CLOSED on a corrupt document: generation refuses and the bytes are untouched', () => {
    const file = join(tempDir(), 'credentials.json')
    writeFileSync(file, '{ this is not json')
    const store = createFileCredentialStore(file)
    const before = readFileSync(file, 'utf8')
    assert.throws(
      () => generateCredential(store, { clientId: 'fresh', scheme: 'static-token' }),
      CorruptCredentialStoreError,
      'a generation over a corrupt document must refuse, never overwrite it as if empty',
    )
    assert.equal(readFileSync(file, 'utf8'), before, 'the corrupt document must remain byte-identical')
    // Reads deny (fail-closed auth): nothing authenticates from an unvouched store.
    assert.equal(store.list().length, 0)
    assert.equal(store.get('fresh'), undefined)
    removeCredentialStoreFile(file)
  })

  it('a planted SYMLINK at the store path is replaced, never followed', (t) => {
    const dir = tempDir()
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'the victim must survive')
    const file = join(dir, 'credentials.json')
    try {
      symlinkSync(victim, file)
    } catch {
      t.skip('file symlinks are not permitted on this host (Windows without developer mode)')
      return
    }
    const store = createFileCredentialStore(file)
    store.upsert(staticCredential('app-4', 'secret-over-symlink'))
    assert.equal(readFileSync(victim, 'utf8'), 'the victim must survive', 'the rename must not write through the symlink')
    assert.equal(statSync(file).isFile(), true, 'the store path must now be a regular file')
    assert.ok(readFileSync(file, 'utf8').includes('app-4'), 'the document holds the credential')
  })

  it('REFUSES a junctioned credential home: no plaintext is written through an untrusted target', (t) => {
    const dir = tempDir()
    const real = join(dir, 'real-home')
    const link = join(dir, 'credential-home')
    mkdirSync(real)
    try {
      symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      t.skip('directory links/junctions are not permitted on this host')
      return
    }
    const store = createFileCredentialStore(join(link, 'credentials.json'))
    assert.throws(
      () => store.upsert(staticCredential('app-5', 'secret-through-junction')),
      /symbolic link or junction/,
      'a junctioned credential home must be refused, not written through',
    )
    assert.equal(existsSync(join(real, 'credentials.json')), false, 'no document may appear through the junction target')
  })

  it('a stale snapshot cannot resurrect a just-revoked credential', () => {
    const file = join(tempDir(), 'credentials.json')
    const store = createFileCredentialStore(file)
    store.upsert(staticCredential('revoked', 'old-secret'))
    store.delete('revoked')
    // A later upsert of a DIFFERENT client must persist from the CURRENT
    // document, not from any earlier snapshot — the revoked entry stays gone.
    store.upsert(staticCredential('later', 'new-secret'))
    const entries = store.list().map(entry => entry.clientId)
    assert.deepEqual(entries, ['later'], 'the revoked credential must not resurrect through a stale snapshot')
    assert.equal(readFileSync(file, 'utf8').includes('revoked'), false)
  })

  it('an unreadable store makes delete FAIL LOUDLY instead of silently keeping the credential', () => {
    // readFileSync on a DIRECTORY fails with EISDIR: the catch-all-empty-read
    // of the earlier design returned silently here while the credential stayed
    // live. The mutation must throw instead.
    const dir = tempDir()
    const storePath = join(dir, 'credentials.json')
    mkdirSync(storePath) // the "document" is a directory: unreadable as JSON
    const store = createFileCredentialStore(storePath)
    assert.throws(
      () => store.delete('anything'),
      CorruptCredentialStoreError,
      'a revocation the store cannot read must fail loudly, never pretend success',
    )
  })

  it('concurrent writers from TWO PROCESSES lose no entries', async () => {
    const dir = tempDir()
    const file = join(dir, 'credentials.json')
    const storeModuleUrl = new URL('../src/mcp/credential-store.ts', import.meta.url).href
    const writerScript = `
      import { createFileCredentialStore } from ${JSON.stringify(storeModuleUrl)}
      const store = createFileCredentialStore(process.argv[1])
      for (let i = 0; i < 10; i += 1) {
        store.upsert({
          clientId: process.argv[2] + '-' + i,
          secret: 's' + process.argv[2] + '-' + i,
          scheme: 'static-token',
          scope: [],
          createdAt: new Date().toISOString(),
        })
      }
    `
    // BOTH writers run CONCURRENTLY (async spawn, Promise.all) — spawnSync would
    // serialize them and the lock would never be contended.
    const run = (tag: string): Promise<{ tag: string; code: number | null; stderr: string }> => new Promise(resolve => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type', 'module', '-e', writerScript, file, tag],
        { windowsHide: true },
      )
      let stderr = ''
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.on('exit', code => resolve({ tag, code, stderr }))
      child.on('error', error => resolve({ tag, code: null, stderr: error.message }))
    })
    const [first, second] = await Promise.all([run('a'), run('b')])
    assert.equal(first.code, 0, `writer a failed: ${first.stderr}`)
    assert.equal(second.code, 0, `writer b failed: ${second.stderr}`)
    const entries = createFileCredentialStore(file).list().map(entry => entry.clientId)
    assert.equal(entries.length, 20, `both writers' entries must survive, saw ${entries.length}: ${entries.join(', ')}`)
  })

  it('real 2-PROCESS proof: a LIVE long-holder is never stolen from; the contender waits and nothing resurrects', async () => {
    // The reviewer's 31-second repro without the wait: writer A (a child process)
    // pauses INSIDE its critical section after the strict read; the lock looks
    // "stale" by AGE while A is demonstrably ALIVE — the contender must wait for
    // A's publish and then delete from the CURRENT document. The resurrection bug
    // was the reverse: a stolen lock let the delete run BEFORE the holder's
    // publish, after which the holder wrote its stale snapshot back.
    const dir = tempDir()
    const file = join(dir, 'credentials.json')
    const storeModuleUrl = new URL('../src/mcp/credential-store.ts', import.meta.url).href
    const holder = `
      import { createFileCredentialStore } from ${JSON.stringify(storeModuleUrl)}
      const store = createFileCredentialStore(process.argv[1], { holdLockAfterReadMs: 1200 })
      store.upsert({
        clientId: 'revoked', secret: 'old-secret', scheme: 'static-token',
        scope: [], createdAt: new Date().toISOString(),
      })
    `
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type', 'module', '-e', holder, file],
      { windowsHide: true },
    )
    // The exit is captured BEFORE any contention so an early exit can never be
    // missed by a late listener.
    const exited = new Promise<number | null>(resolve => {
      child.on('exit', code => resolve(code))
    })
    try {
      // Wait until the holder HAS the lock (otherwise this test would race the
      // holder's acquire and prove nothing).
      const lockPath = `${file}.lock`
      const lockDeadline = Date.now() + 10_000
      while (!existsSync(lockPath) && Date.now() < lockDeadline) {
        sleepMs(20)
      }
      assert.ok(existsSync(lockPath), 'the holder must acquire the lock within the window')

      const started = Date.now()
      const store = createFileCredentialStore(file, { staleLockMs: 100 })
      store.delete('revoked')
      const elapsed = Date.now() - started
      assert.ok(elapsed >= 800, `the delete must have waited for the live holder, but finished in ${elapsed} ms`)

      // The delete returned AFTER the holder published (it could only acquire
      // once the holder released). The holder's exit is collected before the
      // final state is read.
      const code = await exited
      assert.equal(code, 0, 'the holder must have exited cleanly')
      const entries = createFileCredentialStore(file).list().map(entry => entry.clientId)
      assert.equal(entries.includes('revoked'), false, 'nothing may resurrect through the stale snapshot')
    } finally {
      // Cleanup on any failure: never leave a live child behind.
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await exited.catch(() => undefined)
    }
  })

  it('fail-closed liveness: an UNKNOWN-liveness stale lock is never stolen, and release never removes a foreign lock', () => {
    const dir = tempDir()
    const file = join(dir, 'credentials.json')
    mkdirSync(dir, { recursive: true })
    // Plant a lock held by a live-ish record whose liveness the probe cannot
    // determine: the contender must wait out its (short) deadline and REFUSE,
    // leaving the foreign lock file byte-identical.
    const lockPath = `${file}.lock`
    const foreign = { token: 'foreign-token', pid: process.pid, at: Date.now() - 60_000 }
    writeFileSync(lockPath, JSON.stringify(foreign))
    const store = createFileCredentialStore(file, {
      staleLockMs: 100,
      lockDeadlineMs: 150,
      isProcessAlive: () => undefined,
    })
    assert.throws(
      () => store.upsert(staticCredential('blocked', 's')),
      /locked by another writer/,
      'unknown liveness must fail closed, never steal',
    )
    const after = readFileSync(lockPath, 'utf8')
    assert.equal(after, JSON.stringify(foreign), 'the foreign lock must remain byte-identical (no blind release)')
  })

  it('redacts a generated-secret-shaped span from free text (SEC-01)', () => {
    const secret = 'X'.repeat(43).replaceAll('X', () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'[Math.floor(Math.random() * 64)])
    const redacted = redactText(`the credential ${secret} was presented`)
    assert.equal(redacted.includes(secret), false, 'the secret-shaped span must be redacted')
    assert.match(redacted, /<redacted>/)
  })

  it('redacts base64url secrets that BEGIN with "-" (deterministic crypto shapes)', () => {
    // Deterministic real shapes: a 32-byte secret whose base64url begins with
    // '-' (first byte 0xFA → leading '-') or '_' (0xFD). The 43-char tail is
    // constrained to multiples of 4, so a TRAILING '-' is not a real 32-byte
    // shape — the leading '-' is the reviewer's demonstrated case. The
    // corrected pattern uses non-word lookarounds, so the leading '-' is still
    // fully redacted when the secret sits between non-base64url delimiters (the
    // contexts the receipt pipeline actually produces).
    const leadingDash = Buffer.from([0xfa, ...Array(31).fill(0x61)]).toString('base64url')
    const leadingUnderscore = Buffer.from([0xfd, ...Array(31).fill(0x61)]).toString('base64url')
    assert.equal(leadingDash[0], '-', 'the fixture must begin with -')
    assert.equal(leadingUnderscore[0], '_', 'the fixture must begin with _')
    for (const secret of [leadingDash, leadingUnderscore]) {
      assert.equal(secret.length, 43)
      assert.equal(Buffer.from(secret, 'base64url').length, 32)
      for (const wrapped of [`key=${secret}&next=1`, `"${secret}"`, `Bearer ${secret}`, `(${secret});`, `${secret},`]) {
        assert.equal(redactText(wrapped).includes(secret), false, `the secret must not survive ${JSON.stringify(wrapped.slice(0, 12) + '…')}`)
      }
    }
  })
})

describe('SEC-01 — the OAuth server generates, persists, rotates and revokes', () => {
  it('generates a crypto-random secret, immediately usable, shown exactly once', async () => {
    const file = join(tempDir(), 'credentials.json')
    const store = createFileCredentialStore(file)
    const server = createLocalOAuthServer({ issuer: ISSUER, audience: AUDIENCE, store })

    const generated = server.generateClient({ clientId: 'ops-client', scope: ['mcp:call'] })
    assert.equal(typeof generated.secret, 'string')
    assert.equal(generated.secret.length, 43, '32 base64url bytes is 43 characters')
    assert.equal(Buffer.from(generated.secret, 'base64url').length, 32, 'the secret must decode to exactly 32 bytes')

    // Immediately usable: an issued token verifies with the client's own identity.
    const token = await server.issueAccessToken('ops-client')
    assert.equal(typeof token, 'string')
    const verdict = await server.verify(token, ['mcp:call'])
    assert.equal(verdict.ok, true)
    if (verdict.ok) assert.equal(verdict.token.clientId, 'ops-client')

    // Persisted: a fresh server over the same store hydrates the client.
    const reopened = createLocalOAuthServer({ issuer: ISSUER, audience: AUDIENCE, store })
    const reissued = await reopened.issueAccessToken('ops-client')
    assert.equal(typeof reissued, 'string')
    removeCredentialStoreFile(file)
  })

  it('fails closed: a generation the store cannot persist registers nothing usable', async () => {
    const blocker = join(tempDir(), 'not-a-directory')
    writeFileSync(blocker, 'block')
    const store = createFileCredentialStore(join(blocker, 'credentials.json'))
    const server = createLocalOAuthServer({ issuer: ISSUER, audience: AUDIENCE, store })
    assert.throws(() => server.generateClient({ clientId: 'doomed' }))
    assert.equal(await server.issueAccessToken('doomed'), undefined)
    const verdict = await server.verify('forged', [])
    assert.equal(verdict.ok, false)
    if (!verdict.ok) assert.equal(verdict.error.code, 'invalid_request', 'a non-JWT is refused')
  })

  it('revokes ONE generated client; its tokens fail with the revoked vocabulary, peers survive', async () => {
    const file = join(tempDir(), 'credentials.json')
    const store = createFileCredentialStore(file)
    const server = createLocalOAuthServer({ issuer: ISSUER, audience: AUDIENCE, store })
    server.generateClient({ clientId: 'revoked-app', scope: ['mcp:call'] })
    server.generateClient({ clientId: 'peer-app', scope: ['mcp:call'] })
    const revokedToken = await server.issueAccessToken('revoked-app')
    const peerToken = await server.issueAccessToken('peer-app')

    server.revokeClient('revoked-app')
    const revoked = await server.verify(revokedToken, [])
    assert.equal(revoked.ok, false)
    if (!revoked.ok) assert.match(revoked.error.description, /revoked|unknown/, 'the credential must fail')
    const peer = await server.verify(peerToken, [])
    assert.equal(peer.ok, true, 'a peer client must be untouched')

    const reopened = createLocalOAuthServer({ issuer: ISSUER, audience: AUDIENCE, store })
    assert.equal(await reopened.issueAccessToken('revoked-app'), undefined, 'revocation must survive a restart')
    removeCredentialStoreFile(file)
  })

  it('ROTATION: delete + recreate with a NEW secret and scope invalidates the OLD token and honors the NEW grant', async () => {
    const file = join(tempDir(), 'credentials.json')
    const store = createFileCredentialStore(file)
    const server = createLocalOAuthServer({ issuer: ISSUER, audience: AUDIENCE, store })

    const first = generateCredential(store, { clientId: 'rotating', scheme: 'oauth-resource-server', scope: ['mcp:call'] })
    const oldToken = await server.issueAccessToken('rotating', ['mcp:call'])
    assert.equal((await server.verify(oldToken, ['mcp:call'])).ok, true)

    // The management/CLI path deletes from the store directly, then recreates
    // with a NEW secret and a READ-ONLY scope — the reviewer's exact sequence.
    store.delete('rotating')
    const second = generateCredential(store, { clientId: 'rotating', scheme: 'oauth-resource-server', scope: ['mcp:read'] })
    assert.notEqual(second.secret, first.secret, 'the recreation must use a fresh secret')

    // The OLD token (signed with the OLD secret) must fail: the live registry
    // judges it against the NEW secret.
    const oldVerdict = await server.verify(oldToken, [])
    assert.equal(oldVerdict.ok, false, 'the old token must not survive rotation')
    if (!oldVerdict.ok) {
      assert.match(oldVerdict.error.description, /signature|revoked|unknown/, `named refusal, saw: ${oldVerdict.error.description}`)
    }

    // The NEW credential issues and verifies under the NEW scope.
    const newToken = await server.issueAccessToken('rotating', ['mcp:read'])
    assert.equal((await server.verify(newToken, ['mcp:read'])).ok, true)
    // The OLD scope is gone: a token requested for mcp:call is issued without it
    // and therefore fails the mcp:call requirement.
    const narrowed = await server.issueAccessToken('rotating', ['mcp:call'])
    const narrowedVerdict = await server.verify(narrowed, ['mcp:call'])
    assert.equal(narrowedVerdict.ok, false)
    if (!narrowedVerdict.ok) assert.equal(narrowedVerdict.error.code, 'insufficient_scope')
    removeCredentialStoreFile(file)
  })

  it('a credential generated AFTER construction issues immediately (no restart)', async () => {
    const file = join(tempDir(), 'credentials.json')
    const store = createFileCredentialStore(file)
    const server = createLocalOAuthServer({ issuer: ISSUER, audience: AUDIENCE, store })
    // Generated through the STORE directly — the CLI/management path — after the
    // server already hydrated its registry.
    generateCredential(store, { clientId: 'late-comer', scheme: 'oauth-resource-server', scope: ['mcp:call'] })
    const token = await server.issueAccessToken('late-comer', ['mcp:call'])
    assert.equal(typeof token, 'string', 'the live registry must issue for a credential it did not hydrate')
    const verdict = await server.verify(token, ['mcp:call'])
    assert.equal(verdict.ok, true)
    removeCredentialStoreFile(file)
  })

  it('a WRONG-SCHEME store row is rejected — the hydrated map never resurrects it', async () => {
    const file = join(tempDir(), 'credentials.json')
    const store = createFileCredentialStore(file)
    const server = createLocalOAuthServer({ issuer: ISSUER, audience: AUDIENCE, store })
    server.generateClient({ clientId: 'scheme-flip', scope: ['mcp:call'] })
    const token = await server.issueAccessToken('scheme-flip', ['mcp:call'])
    assert.equal((await server.verify(token, ['mcp:call'])).ok, true)

    // The management/CLI surface rotates the row's SCHEME to static-token (with a
    // fresh secret). The durable store is the SOLE authority: the hydrated
    // in-memory OAuth entry must not serve this id any longer.
    store.upsert({
      clientId: 'scheme-flip', secret: 's'.repeat(43), scheme: 'static-token',
      scope: [], createdAt: new Date().toISOString(),
    })
    assert.equal(await server.issueAccessToken('scheme-flip'), undefined, 'a static-token row is not an OAuth client')
    const verdict = await server.verify(token, [])
    assert.equal(verdict.ok, false, 'the old OAuth token must not verify against a wrong-scheme row')
    removeCredentialStoreFile(file)
  })

  it('revokes a LATE client through the live store, and the same id can be re-generated with a fresh secret', async () => {
    const file = join(tempDir(), 'credentials.json')
    const store = createFileCredentialStore(file)
    const server = createLocalOAuthServer({ issuer: ISSUER, audience: AUDIENCE, store })
    // Late generation: through the store directly, AFTER the server hydrated.
    const first = generateCredential(store, { clientId: 'late-revoke', scheme: 'oauth-resource-server', scope: ['mcp:call'] })
    const token = await server.issueAccessToken('late-revoke', ['mcp:call'])
    assert.equal((await server.verify(token, ['mcp:call'])).ok, true)

    server.revokeClient('late-revoke')
    // The durable row is gone and the issued token fails immediately.
    assert.equal(store.get('late-revoke'), undefined, 'a late client\'s durable record must be deleted')
    assert.equal((await server.verify(token, [])).ok, false, 'the issued token must fail after revocation')
    assert.equal(await server.issueAccessToken('late-revoke'), undefined, 'a revoked late client cannot re-issue')

    // Legitimate re-generation of the SAME id with a FRESH secret is not blocked
    // by the old revocation (the fingerprint is secret-scoped, not id-scoped).
    const fresh = generateCredential(store, { clientId: 'late-revoke', scheme: 'oauth-resource-server', scope: ['mcp:call'] })
    assert.notEqual(fresh.secret, first.secret)
    const freshToken = await server.issueAccessToken('late-revoke', ['mcp:call'])
    assert.equal(typeof freshToken, 'string', 'a re-generated id with a fresh secret must issue again')
    const freshVerdict = await server.verify(freshToken, ['mcp:call'])
    assert.equal(freshVerdict.ok, true, 'the fresh credential must verify')
    // And the OLD token (signed with the old secret) stays dead.
    assert.equal((await server.verify(token, [])).ok, false)
    removeCredentialStoreFile(file)
  })
})

describe('SEC-01 — the static-token transport accepts generated credentials under their own identity', () => {
  it('a generated credential authenticates and drives the client grant, then revokes to 401', async () => {
    const file = join(tempDir(), 'credentials.json')
    const store = createFileCredentialStore(file)
    store.upsert(staticCredential('gen-static', 'generated-static-secret'))
    const handler = createHttpHandler({
      path: '/mcp',
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 1024 * 1024,
      allowedOrigins: [],
      auth: { scheme: 'static-token', token: 'primary-token', clientId: 'primary', registry: store },
      rateLimit: false,
    }, host)

    const accepted = await handler(requestFor('generated-static-secret'))
    assert.equal(accepted.status, 200, `the generated credential must authenticate: ${accepted.body}`)
    assert.equal((await handler(requestFor('not-a-credential'))).status, 401)

    store.delete('gen-static')
    assert.equal((await handler(requestFor('generated-static-secret'))).status, 401, 'a revoked static credential must fail')
    assert.equal((await handler(requestFor('primary-token'))).status, 200)
    removeCredentialStoreFile(file)
  })

  it('an OAuth resource-server secret presented as a static bearer is REJECTED', async () => {
    const file = join(tempDir(), 'credentials.json')
    const store = createFileCredentialStore(file)
    const oauthSecret = 'c'.repeat(43)
    store.upsert({
      clientId: 'oauth-app', secret: oauthSecret, scheme: 'oauth-resource-server',
      scope: ['mcp:call'], createdAt: new Date().toISOString(),
    })
    const handler = createHttpHandler({
      path: '/mcp',
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 1024 * 1024,
      allowedOrigins: [],
      auth: { scheme: 'static-token', token: 'primary-token', clientId: 'primary', registry: store },
      rateLimit: false,
    }, host)
    assert.equal((await handler(requestFor(oauthSecret))).status, 401, 'scheme confusion must be refused')
    removeCredentialStoreFile(file)
  })
})

describe('SEC-01 — the model_tools credentials action is SECRET-FREE, and the human CLI prints once', () => {
  it('the model-visible surface REFUSES generate: no secret anywhere in the result', async () => {
    const storeDir = tempDir()
    const credentialsFile = join(storeDir, 'credentials.json')
    const ctx = await mountPlugin({
      stateFile: join(storeDir, 'state.json'),
      credentialsFile,
    })

    const generated = await callTool(ctx, 'model_tools', {
      action: 'credentials', sub: 'generate', scheme: 'static-token', clientId: 'ops-1',
    })
    assert.equal(generated.isError, false, 'the refusal guidance is a NOTE, not an error')
    const value = generated.value as { credentialNote?: string; credential?: unknown; secret?: unknown }
    assert.match(value.credentialNote ?? '', /refused on this model-visible surface/, 'the note must name the refusal')
    const serialized = JSON.stringify(generated)
    assert.equal(serialized.includes('"secret"'), false, 'no "secret" KEY may appear in the result')
    assert.equal(/"credential"\s*:/.test(serialized), false, 'no credential object may appear in the result')
    assert.equal(/[A-Za-z0-9_-]{43}/.test(serialized), false, 'no secret-shaped span may appear in the result')

    // Nothing was persisted by the refused generation.
    const store = createFileCredentialStore(credentialsFile)
    assert.equal(store.get('ops-1'), undefined)

    // The management list still works and still echoes nothing.
    const listed = await callTool(ctx, 'model_tools', { action: 'credentials', sub: 'list' })
    assert.equal(listed.isError, false)
  })

  it('the human CLI generates, prints the secret EXACTLY ONCE to stdout, and never to stderr', () => {
    const storeDir = tempDir()
    const storeFile = join(storeDir, 'credentials.json')
    const out: string[] = []
    const err: string[] = []
    const code = runCredentialsCli(
      ['generate', '--scheme', 'static-token', '--client-id', 'cli-1', '--store', storeFile],
      { out: line => out.push(line), err: line => err.push(line) },
    )
    assert.equal(code, 0, `the CLI must succeed: ${err.join(' | ')}`)
    const stdout = out.join('\n')
    const secretLine = out.find(line => line.startsWith('secret: '))
    assert.ok(secretLine !== undefined, 'the secret is printed exactly once')
    const secret = secretLine.slice('secret: '.length)
    assert.equal(secret.length, 43, 'the CLI secret is 32 base64url bytes')
    assert.equal(stdout.split(secret).length, 2, 'the secret appears EXACTLY once in stdout')
    assert.equal(err.join('\n').includes(secret), false, 'the secret never appears on stderr')

    // Persisted owner-only and usable.
    const store = createFileCredentialStore(storeFile)
    assert.equal(store.bySecret(secret)?.clientId, 'cli-1')

    // A later list invocation never re-echoes it.
    const listOut: string[] = []
    const listErr: string[] = []
    const listCode = runCredentialsCli(['list', '--store', storeFile], { out: line => listOut.push(line), err: line => listErr.push(line) })
    assert.equal(listCode, 0, `list must succeed: ${listErr.join(' | ')}`)
    assert.equal(listOut.join('\n').includes(secret), false, 'list must never echo the secret')
  })

  it('the human CLI refuses generation over a corrupt document without touching it', () => {
    const storeDir = tempDir()
    const storeFile = join(storeDir, 'credentials.json')
    writeFileSync(storeFile, 'not json at all')
    const before = readFileSync(storeFile, 'utf8')
    const out: string[] = []
    const err: string[] = []
    const code = runCredentialsCli(
      ['generate', '--scheme', 'oauth-resource-server', '--client-id', 'cli-2', '--store', storeFile],
      { out: line => out.push(line), err: line => err.push(line) },
    )
    assert.equal(code, 1, 'generation over a corrupt store must fail')
    assert.match(err.join(' '), /corrupt|not valid JSON|cannot/, `the refusal must be named: ${err.join(' ')}`)
    assert.equal(readFileSync(storeFile, 'utf8'), before, 'the corrupt document stays byte-identical')
  })

  it('generated CLI credentials authenticate BOTH schemes and revoke through the management surface', async () => {
    const storeDir = tempDir()
    const credentialsFile = join(storeDir, 'credentials.json')
    const ctx = await mountPlugin({
      stateFile: join(storeDir, 'state.json'),
      credentialsFile,
    })
    const realHost = ctx.get('model-tools.mcp-host') as McpHost | undefined
    assert.ok(realHost !== undefined, 'the host must expose its own MCP surface')

    // Generate through the CLI (the ONLY secret-bearing surface).
    const generate = (clientId: string, scheme: string, scope?: string[]): string => {
      const out: string[] = []
      const err: string[] = []
      const args = ['generate', '--scheme', scheme, '--client-id', clientId, '--store', credentialsFile]
      if (scope !== undefined) args.push('--scope', scope.join(','))
      const code = runCredentialsCli(args, { out: line => out.push(line), err: line => err.push(line) })
      assert.equal(code, 0, `generation must succeed: ${err.join(' | ')}`)
      const secretLine = out.find(line => line.startsWith('secret: '))
      assert.ok(secretLine !== undefined)
      return secretLine.slice('secret: '.length)
    }

    const staticSecret = generate('ops-1', 'static-token')
    const oauthSecret = generate('ops-2', 'oauth-resource-server', ['mcp:call'])

    const callBody = (id: string): string => callBodyFor('lang_detect', { text: 'kann ich das haben' }, id)
    const langRequest = (token: string): HttpRequestDescription => ({
      method: 'POST',
      path: '/mcp',
      remoteAddress: '127.0.0.1',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'mcp-protocol-version': PROTOCOL_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': 'lang_detect',
      },
      body: callBody('lang-1'),
    })

    // The generated static credential reaches REAL inference.
    const store = createFileCredentialStore(credentialsFile)
    const staticHandler = createHttpHandler({
      path: '/mcp',
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 1024 * 1024,
      allowedOrigins: [],
      auth: { scheme: 'static-token', token: 'primary', clientId: 'primary', registry: store },
      rateLimit: false,
    }, realHost)
    const staticCall = await staticHandler(langRequest(staticSecret))
    assert.equal(staticCall.status, 200, `the generated credential must reach the tool: ${staticCall.body}`)
    assert.match(staticCall.body, /"de"/, 'the generated credential must reach REAL inference')

    // The generated OAuth credential issues IMMEDIATELY (no restart) and reaches the tool.
    const oauthServer = createLocalOAuthServer({ issuer: ISSUER, audience: AUDIENCE, store })
    const oauthToken = await oauthServer.issueAccessToken('ops-2', ['mcp:call'])
    assert.equal(typeof oauthToken, 'string')
    const oauthHandler = createHttpHandler({
      path: '/mcp',
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 1024 * 1024,
      allowedOrigins: [],
      auth: { scheme: 'oauth-resource-server', server: oauthServer, requiredScope: ['mcp:call'] },
      rateLimit: false,
    }, realHost)
    const oauthCall = await oauthHandler(langRequest(oauthToken))
    assert.equal(oauthCall.status, 200, `the generated OAuth credential must reach the tool: ${oauthCall.body}`)
    assert.match(oauthCall.body, /"de"/)

    // LIST: identity only, never the secret.
    const listed = await callTool(ctx, 'model_tools', { action: 'credentials', sub: 'list' })
    assert.equal(listed.isError, false)
    const entries = (listed.value as { credentials?: Array<Record<string, unknown>> }).credentials ?? []
    assert.deepEqual(entries.map(entry => entry.clientId), ['ops-1', 'ops-2'])
    const serialized = JSON.stringify(entries)
    assert.equal(serialized.includes(staticSecret), false, 'the list must never echo the secret')
    assert.equal(serialized.includes(oauthSecret), false, 'the list must never echo the OAuth secret')

    // RECEIPTS: the secret never reaches the receipt surface.
    const receipts = await callTool(ctx, 'model_tools', { action: 'receipts' })
    const receiptText = JSON.stringify(receipts)
    assert.equal(receiptText.includes(staticSecret), false, 'the secret must never appear in receipts')
    assert.equal(receiptText.includes(oauthSecret), false, 'the OAuth secret must never appear in receipts')

    // REVOKE through the management surface; both credentials fail at their transports.
    const revokedStatic = await callTool(ctx, 'model_tools', { action: 'credentials', sub: 'revoke', clientId: 'ops-1' })
    assert.equal(revokedStatic.isError, false)
    assert.equal((await staticHandler(langRequest(staticSecret))).status, 401, 'a revoked static credential must fail immediately')
    const revokedOauth = await callTool(ctx, 'model_tools', { action: 'credentials', sub: 'revoke', clientId: 'ops-2' })
    assert.equal(revokedOauth.isError, false)
    assert.equal((await oauthHandler(langRequest(oauthToken))).status, 401, 'a revoked OAuth credential must fail immediately')
    const afterList = await callTool(ctx, 'model_tools', { action: 'credentials', sub: 'list' })
    assert.deepEqual((afterList.value as { credentials?: unknown[] }).credentials, [], 'revocation removes the credential')
  })

  it('fails closed when persistence is impossible or disabled', async () => {
    // (1) The store cannot persist — now exercised at the CLI, the ONLY
    // secret-bearing generation surface (the model-visible action refuses
    // generate before any store work, so it cannot be the persistence probe).
    const blockerDir = tempDir()
    const blocker = join(blockerDir, 'blocker')
    writeFileSync(blocker, 'block')
    const cliOut: string[] = []
    const cliErr: string[] = []
    const cliCode = runCredentialsCli(
      ['generate', '--scheme', 'static-token', '--client-id', 'doomed', '--store', join(blocker, 'credentials.json')],
      { out: line => cliOut.push(line), err: line => cliErr.push(line) },
    )
    assert.equal(cliCode, 1, 'a CLI generation that cannot persist must fail')
    assert.equal(cliOut.join('\n').includes('secret:'), false, 'no secret may be printed for an unpersistable generation')

    // (2) The MODEL-visible surface never touches the store for generate: even
    // with an unpersistable store path it returns the refusal NOTE (no error,
    // no persistence attempted, no secret anywhere).
    const ctx = await mountPlugin({
      stateFile: join(blockerDir, 'state.json'),
      credentialsFile: join(blocker, 'credentials.json'),
    })
    const noted = await callTool(ctx, 'model_tools', {
      action: 'credentials', sub: 'generate', scheme: 'static-token', clientId: 'doomed',
    })
    assert.equal(noted.isError, false, 'the refusal guidance is a note, not an error')
    assert.match(JSON.stringify(noted), /refused on this model-visible surface/)
    const listed = await callTool(ctx, 'model_tools', { action: 'credentials', sub: 'list' })
    assert.deepEqual((listed.value as { credentials?: unknown[] }).credentials, [], 'nothing usable remains')

    // (3) Persistence disabled entirely: generation refuses with the reason.
    const ephemeral = await mountPlugin({ persist: false })
    const refused = await callTool(ephemeral, 'model_tools', {
      action: 'credentials', sub: 'generate', scheme: 'static-token', clientId: 'ephemeral',
    })
    assert.equal(refused.isError, true)
    assert.match(JSON.stringify(refused), /requires persistence/)
  })

  it('a duplicate clientId is refused by the generation primitive rather than overwriting', () => {
    const storeDir = tempDir()
    const store = createFileCredentialStore(join(storeDir, 'credentials.json'))
    const first = generateCredential(store, { clientId: 'dupe', scheme: 'oauth-resource-server' })
    assert.throws(() => generateCredential(store, { clientId: 'dupe', scheme: 'oauth-resource-server' }), /already exists/)
    assert.equal(store.bySecret(first.secret), undefined, 'the OAuth secret must not match the static lookup')
    assert.equal(store.get('dupe')?.secret, first.secret, 'the ORIGINAL credential is untouched')
  })

  it('the owner-only DACL helper applies on Windows and fails closed when it cannot', (t) => {
    if (process.platform !== 'win32') {
      t.skip('the DACL helper is Windows-only; POSIX relies on 0600')
      return
    }
    const dir = tempDir()
    const secured = join(dir, 'secured.json')
    writeFileSync(secured, '{}')
    applyOwnerOnlyDacl(secured)
    const probe = spawnSync('icacls', [secured], { encoding: 'utf8', windowsHide: true })
    assert.equal(probe.status, 0)
    const output = probe.stdout ?? ''
    assert.match(output, /\(F\)/, 'the owner must hold full control')
    assert.doesNotMatch(output, /Everyone|BUILTIN\\Users|Authenticated Users/i, 'no non-owner grant may survive')
  })
})
