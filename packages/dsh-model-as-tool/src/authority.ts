/**
 * Caller authority: the grant a tool invocation runs under (SEC-03, SEC-06).
 *
 * The governing rule is BASE-05: an external request cannot supply or forge these
 * authorities. Everything here is constructed by the HOST from operator
 * configuration, never from a request body, a `clientInfo.name`, a requested tool
 * list, or a path a caller supplied. A caller's arguments are then checked
 * AGAINST the grant; they never expand it.
 *
 * Path handling is deliberately paranoid. SEC-06 requires resolving Windows drive
 * letters, separators, Unicode, junctions and symlinks safely, rejecting escapes,
 * unsupported UNC/device paths and unauthorized roots, and refusing when
 * authorization cannot be established. The resolver therefore returns the
 * CANONICAL path for the caller to open, rather than validating a string and
 * letting a later open re-resolve it — that gap is the classic check-then-open
 * race, and a symlink swapped between the two steps would win it.
 *
 * @module @try-works/dsh-model-as-tool/authority
 */

import { realpathSync } from 'node:fs'
import { isAbsolute, sep } from 'node:path'

/** The stable error codes a denied request reports (SPEC §4 error vocabulary). */
export type AuthorityErrorCode =
  /** The path was not absolute; SEC-06 admits absolute paths only. */
  | 'PATH_NOT_ABSOLUTE'
  /** A UNC or Windows device path, which v1 refuses outright. */
  | 'PATH_UNSUPPORTED'
  /** The path does not exist, so it cannot be authorized. */
  | 'PATH_NOT_FOUND'
  /** The path resolves outside every approved root. */
  | 'PATH_OUTSIDE_GRANT'
  /** The tool is not in the grant's allowed set. */
  | 'TOOL_NOT_GRANTED'
  /** The grant does not exist or was revoked. */
  | 'GRANT_REVOKED'

/** A refused invocation. Carries a recovery hint, not just a refusal. */
export class AuthorityError extends Error {
  override readonly name = 'AuthorityError'
  readonly code: AuthorityErrorCode
  /** Actionable next step for the caller or operator. */
  readonly hint: string
  constructor(code: AuthorityErrorCode, message: string, hint: string) {
    super(message)
    this.code = code
    this.hint = hint
  }
}

/** Absolute resource limits applied to every invocation under a grant. */
export interface GrantLimits {
  /** Largest admitted input, in bytes. */
  readonly maxInputBytes: number
  /** Largest admitted audio duration, in seconds. */
  readonly maxAudioSeconds: number
  /** Largest admitted inline result, in bytes. */
  readonly maxResultBytes: number
}

/** What a caller is permitted to do (SEC-03). */
export interface ToolGrant {
  /** Stable grant identity, recorded in receipts. */
  readonly grantId: string
  /** Tool names this caller may invoke. A requested list never extends it. */
  readonly allowedTools: readonly string[]
  /**
   * Filesystem roots the caller may read from, as absolute paths.
   * Canonicalized when the grant is built, so a symlinked root cannot be declared
   * one way and resolve another.
   */
  readonly approvedRoots: readonly string[]
  /** Remote destinations this caller may reach. Empty means none. */
  readonly remoteDestinations: readonly string[]
  /** Whether hosted code execution is permitted. */
  readonly hostedCode: boolean
  /** Whether receipts may be recorded. */
  readonly recordingPolicy: 'none' | 'receipts'
  /** Hard resource limits. */
  readonly limits: GrantLimits
}

/** Build a grant, canonicalizing its roots. */
export interface GrantInput {
  readonly grantId: string
  readonly allowedTools: readonly string[]
  readonly approvedRoots: readonly string[]
  readonly remoteDestinations?: readonly string[]
  readonly hostedCode?: boolean
  readonly recordingPolicy?: 'none' | 'receipts'
  readonly limits?: Partial<GrantLimits>
}

/** Conservative defaults: a grant that declares nothing permits almost nothing. */
export const DEFAULT_LIMITS: GrantLimits = {
  maxInputBytes: 64 * 1024 * 1024,
  maxAudioSeconds: 3600,
  maxResultBytes: 8 * 1024 * 1024,
}

/** Whether this process is on a case-insensitive filesystem. */
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'

/**
 * Canonicalize a root for containment comparison.
 *
 * A root that does not exist is still admitted, because an operator may declare a
 * root before creating it; it simply can never contain anything until it exists,
 * which fails closed.
 * @param root - the declared root.
 * @returns the canonical root, or undefined when it cannot be resolved yet.
 */
function canonicalizeRoot(root: string): string | undefined {
  if (!isAbsolute(root)) return undefined
  try {
    return realpathSync.native(root)
  } catch {
    return undefined
  }
}

/**
 * Build a grant from operator configuration.
 *
 * This is the only constructor: a request cannot reach it, and an approved root
 * that is not absolute or not resolvable is dropped rather than trusted.
 * @param input - the operator's declaration.
 * @returns the canonicalized grant.
 */
export function createGrant(input: GrantInput): ToolGrant {
  const roots: string[] = []
  for (const root of input.approvedRoots) {
    const canonical = canonicalizeRoot(root)
    // A root that cannot be canonicalized is dropped, not guessed at. Dropping
    // fails closed; keeping an unresolved string would fail open.
    if (canonical !== undefined) roots.push(canonical)
  }
  return {
    grantId: input.grantId,
    allowedTools: [...input.allowedTools],
    approvedRoots: roots,
    remoteDestinations: [...(input.remoteDestinations ?? [])],
    hostedCode: input.hostedCode ?? false,
    recordingPolicy: input.recordingPolicy ?? 'none',
    limits: { ...DEFAULT_LIMITS, ...input.limits },
  }
}

/** Compare two paths for equality under this platform's case rules. */
function samePath(a: string, b: string): boolean {
  return CASE_INSENSITIVE ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Whether `child` is `root` itself or lies beneath it, on a separator boundary. */
function isWithin(child: string, root: string): boolean {
  if (samePath(child, root)) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return CASE_INSENSITIVE
    ? child.toLowerCase().startsWith(prefix.toLowerCase())
    : child.startsWith(prefix)
}

/**
 * Reject path shapes v1 does not admit, before any filesystem call.
 * @param candidate - the caller-supplied path.
 * @throws AuthorityError with `PATH_UNSUPPORTED` or `PATH_NOT_ABSOLUTE`.
 */
function assertAdmissibleShape(candidate: string): void {
  // Windows device namespaces bypass normal path handling entirely, and a UNC
  // path reaches another host that no approved root can describe.
  if (candidate.startsWith('\\\\') || candidate.startsWith('//')) {
    throw new AuthorityError(
      'PATH_UNSUPPORTED',
      'UNC and Windows device paths are not admitted',
      'Use an absolute path on a local drive that lies under an approved root.',
    )
  }
  if (candidate.includes('\0')) {
    throw new AuthorityError(
      'PATH_UNSUPPORTED',
      'the path contains a NUL byte',
      'Pass the path as a plain string without embedded control characters.',
    )
  }
  if (!isAbsolute(candidate)) {
    throw new AuthorityError(
      'PATH_NOT_ABSOLUTE',
      'relative paths are not admitted; v1 authorizes absolute paths only',
      'Resolve the path to an absolute path under an approved root before calling.',
    )
  }
}

/**
 * Authorize one caller-supplied path against a grant (SEC-06).
 *
 * Returns the CANONICAL path, which the caller must open. Validating the original
 * string and opening it later would leave a window in which a symlink could be
 * swapped; resolving once and returning the result closes it.
 * @param grant - the caller's grant.
 * @param candidate - the caller-supplied path.
 * @returns the canonical, authorized path.
 * @throws AuthorityError when the path is inadmissible, missing, or outside the grant.
 */
export function authorizePath(grant: ToolGrant, candidate: string): string {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new AuthorityError(
      'PATH_NOT_ABSOLUTE',
      'a path is required',
      'Supply an absolute path under an approved root.',
    )
  }
  assertAdmissibleShape(candidate)

  let canonical: string
  try {
    // Resolves junctions and symlinks, so containment is checked against what the
    // path actually IS rather than what it spells.
    canonical = realpathSync.native(candidate)
  } catch {
    throw new AuthorityError(
      'PATH_NOT_FOUND',
      'the path does not exist, so it cannot be authorized',
      'Check the path, or ask the operator to add its root to the grant.',
    )
  }

  for (const root of grant.approvedRoots) {
    if (isWithin(canonical, root)) return canonical
  }

  // The message names the grant, not the allowed roots: enumerating a caller's
  // permitted directories would disclose the operator's configuration.
  throw new AuthorityError(
    'PATH_OUTSIDE_GRANT',
    'the path resolves outside every root approved for this caller',
    'Ask the operator to add the containing root to this grant.',
  )
}

/**
 * Authorize a tool name against a grant (SEC-03).
 * @param grant - the caller's grant.
 * @param toolName - the requested tool.
 * @throws AuthorityError with `TOOL_NOT_GRANTED`.
 */
export function authorizeTool(grant: ToolGrant, toolName: string): void {
  if (!grant.allowedTools.includes(toolName)) {
    throw new AuthorityError(
      'TOOL_NOT_GRANTED',
      `tool "${toolName}" is not granted to this caller`,
      'Request access from the operator; a requested tool list does not extend a grant.',
    )
  }
}

/**
 * Authorize a remote destination against a grant (SEC-10).
 *
 * No silent local-to-remote fallback: if a destination was not explicitly
 * approved, the call is refused rather than downgraded or upgraded.
 * @param grant - the caller's grant.
 * @param destination - the destination origin.
 * @throws AuthorityError with `TOOL_NOT_GRANTED`.
 */
export function authorizeDestination(grant: ToolGrant, destination: string): void {
  if (!grant.remoteDestinations.includes(destination)) {
    throw new AuthorityError(
      'TOOL_NOT_GRANTED',
      `destination "${destination}" is not authorized for this caller`,
      'A remote destination requires explicit authorization; there is no silent fallback.',
    )
  }
}

/**
 * The trusted execution context handed to an implementation.
 *
 * An implementation receives resolved authority, never a raw path it must
 * re-check, and never anything a caller could have constructed.
 */
export interface InvocationAuthority {
  /** Grant identity, for the receipt. */
  readonly grantId: string
  /** Who is calling, as the host resolved it. */
  readonly callerKind: 'interactive' | 'external' | 'system'
  /** Resource limits in force. */
  readonly limits: GrantLimits
  /** Whether receipts may be recorded. */
  readonly recordingPolicy: 'none' | 'receipts'
  /**
   * Resolve a caller-supplied path to a canonical authorized path.
   * @param candidate - the caller-supplied path.
   * @returns the canonical path to open.
   */
  resolvePath(candidate: string): string
}

/**
 * Build the invocation authority for one call.
 *
 * The result is constructed by the host; a request body has no path to it.
 * @param grant - the caller's grant.
 * @param callerKind - how the host classified the caller.
 * @returns the authority handed to the implementation.
 */
export function createInvocationAuthority(
  grant: ToolGrant,
  callerKind: InvocationAuthority['callerKind'],
): InvocationAuthority {
  return {
    grantId: grant.grantId,
    callerKind,
    limits: grant.limits,
    recordingPolicy: grant.recordingPolicy,
    resolvePath: candidate => authorizePath(grant, candidate),
  }
}
