/**
 * The operator-owned client credential store (SEC-01).
 *
 * SEC-01's generation clause: credentials are generated with high-entropy secrets,
 * stored with suitable host protection (owner-only), and revocable independently per
 * application. Before this module the OAuth client registry was in-memory only and the
 * static-token mode accepted exactly one configured token — nothing could GENERATE a
 * credential and nothing persisted it, so a restart lost every client and a generated
 * secret could not exist.
 *
 * This store is the durable half. The security properties it now holds, each pinned
 * by test:
 *
 * - one JSON document per deployment (`credentials.json`), written to a CRYPTO-RANDOM
 *   temp name opened EXCLUSIVELY (`wx`) — a predictable temp name is a hardlink target
 *   an attacker on the same account can pre-plant, so the name is unguessable and a
 *   pre-existing name FAILS instead of being overwritten — then fsync'd and atomically
 *   renamed over the document. A rename replaces a planted SYMLINK at the target rather
 *   than following it;
 * - Windows: an EXPLICIT owner-only DACL is applied to the temp file BEFORE the rename
 *   (inheritance removed, the owner alone granted full control) and the store fails
 *   closed when the ACL cannot be secured. POSIX mode 0600 alone is not sufficient on
 *   Windows, and "the profile directory inherits it" is not a control;
 * - MUTATIONS serialize through an in-process mutex AND an exclusive sidecar lock file,
 *   and re-read the document inside the critical section — two concurrent writers can
 *   no longer each persist a snapshot that silently drops the other's entry;
 * - a CORRUPT or unreadable document makes MUTATIONS fail closed (a generation refused,
 *   the bytes untouched) while READS deny: authentication cannot succeed on a store
 *   the host cannot vouch for, and a generation can never overwrite a malformed
 *   document "as if empty". A MISSING document is the only empty start;
 * - reads are served from the FILE, fresh on every lookup, so a revocation through any
 *   surface takes effect on the very next request;
 * - `bySecret` matches STATIC-TOKEN credentials only: an OAuth resource-server secret
 *   presented as a static bearer must never authenticate through this path (scheme
 *   confusion);
 * - the secret is compared CONSTANT-TIME (SHA-256 digests over equal-length input);
 * - every mutation throws when it cannot persist: a generation that cannot be written
 *   must leave nothing usable rather than an in-memory-only credential that a restart
 *   silently forgets (fail-closed, SEC-01).
 *
 * @module @try-works/dsh-model-as-tool/mcp/credential-store
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join, parse } from 'node:path'
import { homedir } from 'node:os'

/** The scheme a stored credential authenticates under. */
export type CredentialScheme = 'static-token' | 'oauth-resource-server'

/** One persisted client credential. */
export interface StoredClientCredential {
  /** The client identity, recorded in receipts and grants. */
  readonly clientId: string
  /** The secret: crypto-random, shown once at generation, never re-echoed. */
  readonly secret: string
  /** The scheme the secret is presented under. */
  readonly scheme: CredentialScheme
  /** The scope the client may be granted (OAuth); empty for static tokens. */
  readonly scope: readonly string[]
  /** ISO timestamp of generation. */
  readonly createdAt: string
}

/** The store a generation writes and an auth layer reads. */
export interface ClientCredentialStore {
  /** The file the credentials live in. */
  readonly file: string
  /** Every live credential, WITHOUT a way to re-echo secrets beyond what the file holds. */
  list(): readonly StoredClientCredential[]
  /** One credential by client identity. */
  get(clientId: string): StoredClientCredential | undefined
  /**
   * Resolve a PRESENTED secret to its credential, in constant time.
   *
   * STATIC-TOKEN SCHEME ONLY: this is the static-bearer lookup, and an OAuth
   * resource-server secret must never match here (scheme confusion). OAuth
   * credentials authenticate through the OAuth verifier, never by raw secret.
   */
  bySecret(secret: string): StoredClientCredential | undefined
  /** Write a credential; throws when persistence fails, registering nothing usable. */
  upsert(credential: StoredClientCredential): void
  /** Delete one credential; throws when the deletion cannot be persisted. */
  delete(clientId: string): void
}

/** The on-disk document shape. */
interface CredentialDocument {
  readonly version: 1
  readonly clients: readonly StoredClientCredential[]
}

/** A document that EXISTS but cannot be vouched for. Mutations refuse; reads deny. */
export class CorruptCredentialStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CorruptCredentialStoreError'
  }
}

/** A generated credential for the human-only CLI and tests (SEC-01, shown once). */
export interface GeneratedCredential {
  readonly clientId: string
  readonly secret: string
  readonly scheme: CredentialScheme
  readonly scope: readonly string[]
  readonly createdAt: string
}

/**
 * Generate a fresh client credential directly over the store (the primitive
 * the human-only CLI and tests use — the model-visible `model_tools` surface
 * refuses generation entirely, SEC-01: the secret must never reach a model).
 * @param store - the durable store.
 * @param options - clientId (≤64 chars), scheme, scope.
 * @returns the credential with the secret exactly once.
 */
export function generateCredential(
  store: ClientCredentialStore,
  options: { readonly clientId: string; readonly scheme: CredentialScheme; readonly scope?: readonly string[] },
): GeneratedCredential {
  if (typeof options.clientId !== 'string' || options.clientId.length === 0 || options.clientId.length > 64) {
    throw new Error('clientId must be a non-empty string of at most 64 characters')
  }
  if (options.scheme !== 'static-token' && options.scheme !== 'oauth-resource-server') {
    throw new Error('scheme must be static-token or oauth-resource-server')
  }
  if (store.get(options.clientId) !== undefined) {
    throw new Error(`a credential for ${JSON.stringify(options.clientId)} already exists; revoke it first`)
  }
  const secret = randomBytes(32).toString('base64url')
  const scope = options.scope === undefined || options.scope.length === 0 ? ['mcp:call'] : [...options.scope]
  const createdAt = new Date().toISOString()
  store.upsert({ clientId: options.clientId, secret, scheme: options.scheme, scope, createdAt })
  return { clientId: options.clientId, secret, scheme: options.scheme, scope, createdAt }
}

/**
 * Derive the default credential-store file, next to the host's own state
 * (SEC-01: owner-only home protection).
 * @param env - the environment to read; defaults to the process environment.
 * @returns the absolute path.
 */
export function defaultCredentialStoreFile(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME.length > 0
    ? env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'model-as-tool', 'credentials.json')
}

/**
 * Apply an explicit owner-only DACL to one file on Windows (icacls: inheritance
 * removed, the current owner alone granted full control), and fail closed when
 * the ACL cannot be secured. On POSIX the caller's 0600 mode bits are the
 * control and this is a no-op.
 * @param file - the file to secure, BEFORE it is published (renamed) into place.
 */
export function applyOwnerOnlyDacl(file: string): void {
  if (process.platform !== 'win32') return
  const owner = process.env.USERNAME
  if (owner === undefined || owner.length === 0) {
    throw new Error('the credential file ACL cannot be secured: no Windows USERNAME to grant ownership to')
  }
  const result = spawnSync('icacls', [file, '/inheritance:r', '/grant:r', `${owner}:(F)`], {
    windowsHide: true,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(
      `the credential file ACL cannot be secured: icacls failed with status ${result.status ?? 'unknown'}`
      + `: ${(result.stderr ?? result.stdout ?? '').trim()}`,
    )
  }
}

/**
 * Refuse a reparse point (symlink or Windows junction) at a path the store is
 * about to write THROUGH: a junctioned credential home is an untrusted target,
 * and the store fails closed rather than persisting plaintext secrets into a
 * location the operator did not own by construction.
 * @param path - the directory (or file) to check.
 */
function assertNoReparsePoint(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`the credential store refuses ${path}: it is a symbolic link or junction (untrusted target)`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

/**
 * The trusted root the credential store lives under by default: DSH_HOME when
 * set, otherwise `~/.dsh`. Ancestor validation walks from HERE down to the
 * store directory — system junctions ABOVE the trusted root are never part of
 * the trust question. A store outside the trusted root (an explicit --store)
 * is validated from the filesystem root instead, and any reparse point in the
 * chain fails it closed.
 */
function trustedCredentialRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_HOME !== undefined && env.DSH_HOME.length > 0
    ? env.DSH_HOME
    : join(homedir(), '.dsh')
}

/**
 * Walk EVERY ancestor component from the bounded trusted root down to the
 * store directory and refuse any reparse point — not just the immediate parent:
 * a junction higher in the chain redirects the whole write just as surely.
 * @param file - the credential document path.
 */
function assertTrustedStoreAncestors(file: string): void {
  const dir = dirname(file)
  const root = trustedCredentialRoot()
  const start = dir === root || dir.startsWith(root + '\\') || dir.startsWith(root + '/')
    ? root
    : parse(dir).root
  // Collect the ancestor chain from `start` down to `dir` (bounded by the path
  // depth, which is small), then check each component that EXISTS.
  const chain: string[] = []
  let cursor = dir
  while (cursor !== start && cursor !== parse(cursor).root && cursor.length > 0) {
    chain.push(cursor)
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  chain.push(cursor)
  for (const component of chain.reverse()) {
    assertNoReparsePoint(component)
  }
}

/**
 * TEST-ONLY hooks for the store's lock machinery. Production callers pass
 * nothing: the hooks exist so the regressions can exercise a long-lived holder
 * and the fail-closed liveness paths without multi-second waits.
 */
export interface CredentialStoreTestHooks {
  /** Sleep INSIDE the critical section, after the strict read (simulates a paused writer). */
  readonly holdLockAfterReadMs?: number
  /** Override the stale-lock age threshold. */
  readonly staleLockMs?: number
  /** Override how long a contender waits for the lock before failing closed. */
  readonly lockDeadlineMs?: number
  /** Override the process-liveness probe. */
  readonly isProcessAlive?: (pid: number) => boolean | undefined
}

/** A held lock's record: who holds it and since when. No secrets, ever. */
interface LockRecord {
  readonly token: string
  readonly pid: number
  readonly at: number
}

/** Is the pid alive? `undefined` means "cannot tell" — callers fail closed. */
function isProcessAlive(pid: number): boolean | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    return undefined
  }
}

/** Read a lock record; undefined when the lock is unreadable or corrupt. */
function readLockRecord(lockPath: string): LockRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const candidate = parsed as Partial<LockRecord>
    if (typeof candidate.token !== 'string' || candidate.token.length === 0
      || typeof candidate.pid !== 'number' || typeof candidate.at !== 'number') {
      return undefined
    }
    return { token: candidate.token, pid: candidate.pid, at: candidate.at }
  } catch {
    return undefined
  }
}

/** A real blocking sleep, without burning the CPU. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Create (or open) the file-backed credential store.
 * @param file - the absolute path of the credentials document.
 * @param hooks - TEST-ONLY lock hooks; production passes nothing.
 * @returns the store.
 */
export function createFileCredentialStore(file: string, hooks: CredentialStoreTestHooks = {}): ClientCredentialStore {
  const staleLockMs = hooks.staleLockMs ?? 30_000
  const lockDeadlineMs = hooks.lockDeadlineMs ?? 10_000
  const probeAlive = hooks.isProcessAlive ?? isProcessAlive

  /**
   * The cross-process lock: an unguessable ownership token plus the holder's
   * pid, so a stale lock is only ever stolen from a holder PROVEN DEAD. A live
   * holder is never stolen from, unknown liveness fails closed (the contender
   * keeps waiting, then refuses), and release removes ONLY a token-owned lock
   * — a successor's lock is never touched.
   */
  const acquireFileLock = (): { token: string; release: () => void } => {
    const lockPath = `${file}.lock`
    const token = randomBytes(16).toString('hex')
    const deadline = Date.now() + lockDeadlineMs
    for (;;) {
      try {
        const fd = openSync(lockPath, 'wx')
        try {
          writeFileSync(fd, JSON.stringify({ token, pid: process.pid, at: Date.now() }), 'utf8')
        } finally {
          closeSync(fd)
        }
        const release = (): void => {
          // Release ONLY a token-owned lock: if the record no longer carries OUR
          // token, the lock is a successor's (or was removed) — never remove it.
          const held = readLockRecord(lockPath)
          if (held === undefined || held.token !== token) return
          try {
            rmSync(lockPath, { force: true })
          } catch {
            // Already gone: nothing to release.
          }
        }
        return { token, release }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST') throw error
        // A held lock: examine WHO holds it before even considering theft.
        const held = readLockRecord(lockPath)
        if (held !== undefined) {
          const age = Date.now() - held.at
          const alive = probeAlive(held.pid)
          if (alive === false && age > staleLockMs) {
            // The holder is PROVEN DEAD and the lock is stale: take it over.
            // (An unreadable/corrupt record is NOT this case — fail closed below.)
            try {
              rmSync(lockPath, { force: true })
            } catch {
              // Released between the read and the removal: retry the acquire.
            }
            continue
          }
          // A LIVE holder (or unknown liveness) is never stolen from — the
          // contender waits, then fails closed at the deadline.
        }
        if (Date.now() > deadline) {
          throw new Error('the credential store is locked by another writer; the mutation was not attempted')
        }
        sleep(25)
      }
    }
  }

  /** Read the CURRENT document. STRICT for mutations: corruption refuses them. */
  const read = (strict: boolean): Map<string, StoredClientCredential> => {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // A MISSING document is the only empty start. Nothing else is.
        return new Map()
      }
      if (strict) {
        throw new CorruptCredentialStoreError(
          `the credentials document cannot be read and no mutation will guess its contents: `
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      }
      return new Map()
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      if (strict) {
        throw new CorruptCredentialStoreError(
          `the credentials document is not valid JSON and will not be overwritten as if empty: `
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      }
      return new Map()
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      if (strict) throw new CorruptCredentialStoreError('the credentials document is not a JSON object')
      return new Map()
    }
    const document = parsed as { clients?: unknown }
    if (!Array.isArray(document.clients)) {
      if (strict) throw new CorruptCredentialStoreError('the credentials document has no clients array')
      return new Map()
    }
    const next = new Map<string, StoredClientCredential>()
    for (const entry of document.clients) {
      const candidate = entry as Partial<StoredClientCredential>
      if (
        typeof candidate.clientId !== 'string' || typeof candidate.secret !== 'string'
        || (candidate.scheme !== 'static-token' && candidate.scheme !== 'oauth-resource-server')
        || !Array.isArray(candidate.scope)
      ) {
        // A malformed ENTRY corrupts the document: a mutation would silently drop
        // it on the next persist, and authentication cannot vouch for it either.
        if (strict) {
          throw new CorruptCredentialStoreError(
            `the credentials document carries a malformed client entry (id ${JSON.stringify(candidate.clientId)})`,
          )
        }
        return new Map()
      }
      next.set(candidate.clientId, candidate as StoredClientCredential)
    }
    return next
  }

  const persist = (clients: ReadonlyMap<string, StoredClientCredential>, token: string): void => {
    const document: CredentialDocument = {
      version: 1,
      clients: [...clients.values()],
    }
    // SEC-01: the temp name is crypto-random and opened EXCLUSIVELY — a planted
    // hardlink/symlink at a predictable name cannot be overwritten, and a
    // pre-existing name fails the write instead of clobbering an unrelated file.
    const temp = join(dirname(file), `.${basename(file)}.tmp-${randomBytes(12).toString('hex')}`)
    const fd = openSync(temp, 'wx', 0o600)
    try {
      // The file WE created must be a regular file: 'wx' already excludes
      // pre-existing entries (hardlinks and junctions included); this is the
      // belt-and-braces check.
      const created = lstatSync(temp)
      if (!created.isFile() || created.isSymbolicLink()) {
        throw new Error(`the credential temp file is not a regular file: refusing to write plaintext secrets through it`)
      }
      // Owner-only BEFORE the first secret byte: the empty file's ACL is
      // secured while it holds NOTHING, so no plaintext ever exists under an
      // inherited broad ACL (the reviewer's inherited Everyone:R +
      // Authenticated Users:M finding).
      applyOwnerOnlyDacl(temp)
      writeFileSync(fd, JSON.stringify(document, null, 2), 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    // The publish is refused unless OUR token still owns the lock: a writer
    // that somehow lost its lock must never publish a stale snapshot over the
    // successor's state.
    const held = readLockRecord(`${file}.lock`)
    if (held === undefined || held.token !== token) {
      rmSync(temp, { force: true })
      throw new Error('the credential store lost its write lock; the publish is refused')
    }
    renameSync(temp, file)
  }

  /**
   * One serialized mutation: the ancestor chain is checked for reparse points
   * BEFORE anything (lock file included) is written through it, the parent
   * directory is created (a first-generation store starts from nothing), then
   * the file lock excludes other processes and the read-modify-write runs
   * fully SYNCHRONOUSLY inside it — Node's single thread makes the section
   * atomic for this process too, so two concurrent writers cannot each persist
   * a snapshot that drops the other's entry or resurrects a just-revoked
   * credential.
   */
  const mutation = <T>(body: (clients: Map<string, StoredClientCredential>, token: string) => T): T => {
    assertTrustedStoreAncestors(file)
    mkdirSync(dirname(file), { recursive: true })
    const { token, release } = acquireFileLock()
    try {
      const clients = read(true)
      // TEST-ONLY: simulate a writer paused after its strict read, holding the
      // lock while other processes contend (the reviewer's 31 s repro, without
      // the wait).
      if (hooks.holdLockAfterReadMs !== undefined) sleep(hooks.holdLockAfterReadMs)
      return body(clients, token)
    } finally {
      release()
    }
  }

  return {
    file,
    list() {
      // Reads DENY on corruption (empty list) rather than crash the auth path.
      return [...read(false).values()]
    },
    get(clientId) {
      return read(false).get(clientId)
    },
    bySecret(secret) {
      // CONSTANT-TIME over the STATIC-TOKEN entries: the digest equalizes lengths,
      // and the loop never exits early on a match. OAuth resource-server secrets
      // are NEVER matched here — scheme confusion would let an OAuth secret pass
      // as a static bearer.
      const digest = createHash('sha256').update(secret).digest()
      let found: StoredClientCredential | undefined
      for (const candidate of read(false).values()) {
        if (candidate.scheme !== 'static-token') continue
        const candidateDigest = createHash('sha256').update(candidate.secret).digest()
        if (timingSafeEqual(digest, candidateDigest)) found = candidate
      }
      return found
    },
    upsert(credential) {
      mutation((clients, token) => {
        // PERSIST FIRST inside the critical section: a credential that cannot be
        // written must never be registered as usable anywhere (SEC-01).
        clients.set(credential.clientId, credential)
        persist(clients, token)
      })
    },
    delete(clientId) {
      mutation((clients, token) => {
        if (!clients.has(clientId)) return
        clients.delete(clientId)
        persist(clients, token)
      })
    },
  }
}

/** Remove a credential store file, for tests that need a fresh deployment. */
export function removeCredentialStoreFile(file: string): void {
  rmSync(file, { force: true })
  rmSync(`${file}.lock`, { force: true })
}
