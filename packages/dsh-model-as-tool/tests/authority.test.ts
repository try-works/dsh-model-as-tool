/**
 * Authority and path-authorization tests.
 *
 * These are the security-bearing tests for SEC-03 and SEC-06, and they are the
 * Windows-specific half of AT-13: "Windows traversal, absolute-path escape,
 * junction/symlink escape, device/UNC paths and unauthorized artifact/receipt IDs
 * are refused. Include Unicode and space-containing valid paths."
 *
 * They use REAL directories and REAL junctions on disk. A path check that passes
 * against a mocked filesystem proves nothing about the one that will run.
 *
 * Requirement links: BASE-05, SEC-03, SEC-06, SEC-10, AT-13.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import {
  AuthorityError,
  authorizeDestination,
  authorizePath,
  authorizeTool,
  createGrant,
  createInvocationAuthority,
  DEFAULT_LIMITS,
} from '../src/authority.ts'

const roots: string[] = []
after(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Create a scratch directory tree and return its root. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tm-authority-'))
  roots.push(dir)
  return dir
}

/** A grant over the given roots, allowing the named tools. */
function grantFor(approvedRoots: readonly string[], tools = ['stt_transcribe']) {
  return createGrant({ grantId: 'test-grant', allowedTools: tools, approvedRoots })
}

describe('SEC-06 — path authorization', () => {
  it('admits an absolute path under an approved root', () => {
    const root = scratch()
    const file = join(root, 'audio.wav')
    writeFileSync(file, 'x')
    const grant = grantFor([root])
    assert.equal(authorizePath(grant, file), file)
  })

  it('admits Unicode and space-containing valid paths (AT-13)', () => {
    const root = scratch()
    const file = join(root, 'møte innspilling 会議.wav')
    writeFileSync(file, 'x')
    const grant = grantFor([root])
    assert.equal(authorizePath(grant, file), file)
  })

  it('refuses a relative path rather than resolving it against the cwd', () => {
    const root = scratch()
    const grant = grantFor([root])
    assert.throws(() => authorizePath(grant, 'audio.wav'), (error: unknown) => {
      assert.ok(error instanceof AuthorityError)
      assert.equal(error.code, 'PATH_NOT_ABSOLUTE')
      return true
    })
  })

  it('refuses an absolute-path escape outside every root', () => {
    const root = scratch()
    const outside = join(scratch(), 'secret.wav')
    writeFileSync(outside, 'x')
    const grant = grantFor([root])
    assert.throws(() => authorizePath(grant, outside), (error: unknown) => {
      assert.ok(error instanceof AuthorityError)
      assert.equal(error.code, 'PATH_OUTSIDE_GRANT')
      // The refusal must not enumerate the operator's other roots.
      assert.equal(error.message.includes('secret'), false)
      return true
    })
  })

  it('refuses `..` traversal that resolves outside the root', () => {
    const parent = scratch()
    const root = join(parent, 'approved')
    mkdirSync(root)
    const outside = join(parent, 'outside.wav')
    writeFileSync(outside, 'x')
    const grant = grantFor([root])
    assert.throws(
      () => authorizePath(grant, join(root, '..', 'outside.wav')),
      /outside every root approved/,
    )
  })

  it('refuses a sibling directory sharing a name prefix', () => {
    // `/a/approved` must not admit `/a/approved-evil`: containment has to respect
    // a separator boundary, not a string prefix.
    const parent = scratch()
    const root = join(parent, 'approved')
    const sibling = join(parent, 'approved-evil')
    mkdirSync(root)
    mkdirSync(sibling)
    const file = join(sibling, 'x.wav')
    writeFileSync(file, 'x')
    assert.throws(() => authorizePath(grantFor([root]), file), /outside every root approved/)
  })

  it('refuses a directory link that escapes the root, though its path looks inside', () => {
    const root = scratch()
    const outside = scratch()
    writeFileSync(join(outside, 'secret.wav'), 'x')
    // A junction, not a symlink: on Windows creating a symlink needs elevation,
    // while a junction does not — so the junction is both the testable vector and
    // the one an unprivileged attacker actually has.
    const link = join(root, 'linked-dir')
    symlinkSync(outside, link, 'junction')
    // The path SPELLS an approved location; the file it reaches does not.
    assert.throws(
      () => authorizePath(grantFor([root]), join(link, 'secret.wav')),
      /outside every root approved/,
    )
  })

  it('admits a directory link that stays inside the root, via its canonical target', () => {
    const root = scratch()
    const realDir = join(root, 'real-dir')
    mkdirSync(realDir)
    const target = join(realDir, 'audio.wav')
    writeFileSync(target, 'x')
    const link = join(root, 'alias-dir')
    symlinkSync(realDir, link, 'junction')
    const resolved = authorizePath(grantFor([root]), join(link, 'audio.wav'))
    // The canonical path is returned so the caller opens the resolved file, not
    // the link: validating one path and opening another is the check-then-open race.
    assert.equal(resolved, target)
  })

  it('refuses a file symlink that escapes the root, where the platform allows one', (t) => {
    const root = scratch()
    const outside = scratch()
    const target = join(outside, 'secret.wav')
    writeFileSync(target, 'x')
    const link = join(root, 'innocent.wav')
    try {
      symlinkSync(target, link, 'file')
    } catch (error) {
      // Windows without Developer Mode refuses file symlinks; the junction case
      // above covers the same escape, so this is skipped rather than failed.
      t.skip(`file symlinks unavailable here: ${(error as NodeJS.ErrnoException).code}`)
      return
    }
    assert.throws(() => authorizePath(grantFor([root]), link), /outside every root approved/)
  })

  it('refuses a UNC path', () => {
    const root = scratch()
    const grant = grantFor([root])
    assert.throws(() => authorizePath(grant, `\\\\server\\share\\a.wav`), (error: unknown) => {
      assert.ok(error instanceof AuthorityError)
      assert.equal(error.code, 'PATH_UNSUPPORTED')
      return true
    })
  })

  it('refuses a Windows device path', () => {
    const grant = grantFor([scratch()])
    assert.throws(() => authorizePath(grant, `\\\\?\\C:\\Windows\\System32\\config`), /not admitted/)
  })

  it('refuses a NUL byte in the path', () => {
    const grant = grantFor([scratch()])
    assert.throws(() => authorizePath(grant, `${scratch()}${sep}a\0b.wav`), /NUL byte/)
  })

  it('refuses a path that does not exist, rather than authorizing a guess', () => {
    const root = scratch()
    assert.throws(() => authorizePath(grantFor([root]), join(root, 'absent.wav')), (error: unknown) => {
      assert.ok(error instanceof AuthorityError)
      assert.equal(error.code, 'PATH_NOT_FOUND')
      return true
    })
  })

  it('fails closed when no roots are approved', () => {
    const root = scratch()
    const file = join(root, 'audio.wav')
    writeFileSync(file, 'x')
    // The default deployment approves nothing, so every path-bearing call refuses.
    assert.throws(() => authorizePath(grantFor([]), file), /outside every root approved/)
  })

  it('drops an uncanonicalizable root rather than trusting it', () => {
    const grant = createGrant({
      grantId: 'g',
      allowedTools: ['t'],
      approvedRoots: ['relative/root', join(tmpdir(), 'definitely-not-here-xyz')],
    })
    assert.deepEqual([...grant.approvedRoots], [])
  })
})

describe('SEC-03 — the grant is the authority, not the request', () => {
  it('refuses a tool outside the grant', () => {
    const grant = grantFor([scratch()], ['lang_detect'])
    assert.throws(() => authorizeTool(grant, 'stt_transcribe'), (error: unknown) => {
      assert.ok(error instanceof AuthorityError)
      assert.equal(error.code, 'TOOL_NOT_GRANTED')
      // The refusal must tell the caller that asking harder will not help.
      assert.match(error.hint, /does not extend a grant/)
      return true
    })
  })

  it('permits a granted tool', () => {
    authorizeTool(grantFor([scratch()], ['lang_detect']), 'lang_detect')
  })

  it('requires explicit authorization for a remote destination (SEC-10)', () => {
    const grant = grantFor([scratch()])
    assert.throws(
      () => authorizeDestination(grant, 'https://example.invalid'),
      /not authorized for this caller/,
    )
    const permitted = createGrant({
      grantId: 'g',
      allowedTools: ['t'],
      approvedRoots: [],
      remoteDestinations: ['https://example.invalid'],
    })
    authorizeDestination(permitted, 'https://example.invalid')
  })

  it('defaults to refusing hosted code and recording nothing', () => {
    const grant = grantFor([scratch()])
    assert.equal(grant.hostedCode, false)
    assert.equal(grant.recordingPolicy, 'none')
  })

  it('applies conservative limits by default', () => {
    const grant = grantFor([scratch()])
    assert.equal(grant.limits.maxInputBytes, DEFAULT_LIMITS.maxInputBytes)
    assert.ok(grant.limits.maxAudioSeconds > 0)
  })

  it('lets an operator narrow limits but not widen past the override', () => {
    const grant = createGrant({
      grantId: 'g',
      allowedTools: ['t'],
      approvedRoots: [],
      limits: { maxAudioSeconds: 30 },
    })
    assert.equal(grant.limits.maxAudioSeconds, 30)
    // An unspecified limit keeps its conservative default rather than becoming
    // unlimited.
    assert.equal(grant.limits.maxInputBytes, DEFAULT_LIMITS.maxInputBytes)
  })
})

describe('BASE-05 — the invocation authority handed to implementations', () => {
  it('carries the grant identity, caller kind and limits', () => {
    const grant = grantFor([scratch()], ['lang_detect'])
    const authority = createInvocationAuthority(grant, 'external')
    assert.equal(authority.grantId, 'test-grant')
    assert.equal(authority.callerKind, 'external')
    assert.equal(authority.recordingPolicy, 'none')
    assert.deepEqual(authority.limits, grant.limits)
  })

  it('resolves paths through the grant rather than trusting the caller', () => {
    const root = scratch()
    const inside = join(root, 'ok.wav')
    writeFileSync(inside, 'x')
    const outside = join(scratch(), 'no.wav')
    writeFileSync(outside, 'x')

    const authority = createInvocationAuthority(grantFor([root]), 'external')
    assert.equal(authority.resolvePath(inside), inside)
    assert.throws(() => authority.resolvePath(outside), AuthorityError)
  })

  it('exposes no way for a caller to widen the grant', () => {
    // The authority is a frozen-by-shape value: it offers a resolve function, not
    // a mutable roots list a request could extend.
    const authority = createInvocationAuthority(grantFor([scratch()]), 'external')
    assert.deepEqual(Object.keys(authority).sort(), [
      'callerKind', 'grantId', 'limits', 'recordingPolicy', 'resolvePath',
    ])
  })
})
