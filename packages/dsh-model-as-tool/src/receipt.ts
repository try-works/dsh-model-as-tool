/**
 * Invocation receipts and lifecycle records (EXT-35).
 *
 * EXT-35 asks for two different things, recorded SEPARATELY, and the separation is
 * the point:
 *
 * - An **invocation receipt** says what ran: the extension, its version and content
 *   digest, the model/recipe identity, and the activation generation. It travels
 *   with the result.
 * - A **lifecycle record** says who changed the installation: install, activate,
 *   deactivate, update and uninstall outcomes together with the approving
 *   principal. It does not travel with a result, because it describes an operator
 *   action rather than a call.
 *
 * Mixing them would mean a caller reading a receipt learns about operator actions
 * it has no business seeing, and an audit trail becomes indistinguishable from
 * execution metadata.
 *
 * The metadata-only rule is enforced by CONSTRUCTION rather than by remembering to
 * be careful. Nothing here accepts a request body, a token, or a full skill text,
 * and a path is reduced before it can enter a receipt at all — so a future caller
 * cannot leak one by passing it in.
 *
 * @module @try-works/dsh-model-as-tool/receipt
 */

import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { ExecutionLocation } from '@try-works/tool-mode-contracts'

/** Provenance attached to one invocation. All fields are host-authored. */
export interface InvocationReceipt {
  /** Opaque receipt identity, unique per call. */
  readonly receiptId: string
  /** The contract that was invoked. */
  readonly contract: string
  /** The contract version, so a receipt is interpretable after a schema change. */
  readonly contractVersion: string
  /** The implementation selected by the host. */
  readonly implementationId: string
  /** The extension package that provided it. */
  readonly extension: string
  /** The extension package version. */
  readonly extensionVersion: string
  /**
   * The installed content digest of the extension.
   *
   * Recorded because a version alone does not identify bytes: a package can be
   * replaced at the same version, and a receipt that only names the version could
   * not distinguish the two runs.
   */
  readonly extensionContentDigest: string | null
  /** The resolved dependency-lock digest, when the store recorded one. */
  readonly dependencyLockDigest: string | null
  /** The model or recipe identity that actually ran. */
  readonly modelIdentity: string
  /** The recipe version, which pins preprocessing and postprocessing. */
  readonly recipeVersion: string | null
  /** The catalog generation this invocation was served from. */
  readonly activationGeneration: number
  /**
   * Where inference happened.
   *
   * The shared vocabulary from the contracts package, reused rather than restated:
   * a second definition would drift, and a receipt whose location field disagreed
   * with its own envelope's would be worse than one without the field.
   */
  readonly executionLocation: ExecutionLocation
  /** Non-fatal notes, already free of caller content. */
  readonly warnings: readonly string[]
}

/** The lifecycle operations EXT-35 requires recorded. */
export type LifecycleOperation = 'install' | 'activate' | 'deactivate' | 'update' | 'uninstall' | 'prepare'

/** The outcome of a lifecycle operation. */
export type LifecycleOutcome = 'succeeded' | 'failed' | 'refused' | 'rolled-back'

/** Who approved an operator action. */
export type ApprovingPrincipal =
  /** The interactive operator at the console. */
  | { readonly kind: 'operator'; readonly identity: string }
  /** A management grant presented by an external client. */
  | { readonly kind: 'client-grant'; readonly grantId: string }
  /** An automated policy, named so it can be audited. */
  | { readonly kind: 'policy'; readonly policyId: string }

/** One operator action, recorded apart from execution metadata. */
export interface LifecycleRecord {
  /** What was attempted. */
  readonly operation: LifecycleOperation
  /** The extension it concerned. */
  readonly extensionId: string
  /** The version, when the operation concerned one. */
  readonly version: string | null
  /** The content digest, when known. */
  readonly contentDigest: string | null
  /** The profile, for the profile-scoped operations. */
  readonly profile: string | null
  /** What happened. */
  readonly outcome: LifecycleOutcome
  /** Why it did not succeed, when it did not. */
  readonly reason: string | null
  /** Who approved it. Never inferred from the request. */
  readonly approvedBy: ApprovingPrincipal
  /** When it happened, ISO 8601. */
  readonly at: string
}

/** Raised when a value cannot be admitted to a receipt. */
export class ReceiptRedactionError extends Error {
  override readonly name = 'ReceiptRedactionError'
}

/**
 * Reduce a caller-supplied path to something safe to record.
 *
 * EXT-35 forbids unrestricted file paths in default receipts, and the reason is
 * that a path discloses the operator's layout: directory names, a username, a
 * project name. The basename is enough to correlate a receipt with a call, and a
 * short digest makes two references to the same path comparable without revealing
 * where it is.
 * @param path - the caller-supplied path.
 * @returns the basename plus a short digest, or null.
 */
export function redactPath(path: string | undefined): string | null {
  if (typeof path !== 'string' || path.length === 0) return null
  const digest = createHash('sha256').update(path).digest('hex').slice(0, 8)
  // `basename` on either separator: a receipt must not leak a Windows path shape
  // merely because the host runs on Windows.
  const leaf = basename(path.replace(/\\/g, '/'))
  return `${leaf}#${digest}`
}

/**
 * Redact anything token-shaped from a free-text note.
 *
 * Notes are authored by the host, but a note that embedded a value read from the
 * environment would leak it. This is a guard against that, not a substitute for
 * not putting secrets in notes.
 * @param text - the note.
 * @returns the note with credential-shaped spans removed.
 */
export function redactText(text: string): string {
  return text
    .replace(/\b(?:npm_|ghp_|gho_|ghs_|sk-|xox[baprs]-)[A-Za-z0-9_-]{8,}/g, '<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer <redacted>')
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, '<redacted>')
    // SEC-01: a generated secret is exactly 32 base64url bytes (43 characters). A
    // note that ever embedded one is redacted here, even though nothing in the
    // receipt pipeline takes a secret as input. The boundaries are NON-WORD
    // lookarounds, not \b: a base64url secret may begin or end with '-' (or '_'),
    // which are word characters — a \b-bounded pattern misses such a secret when
    // it abuts another word character, and the reviewer demonstrated real
    // crypto-random secrets with a leading '-' surviving redaction.
    .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, '<redacted>')
    .replace(/[A-Za-z]:\\[^\s"']*/g, '<path>')
    .replace(/(?<![\w.])\/(?:[\w.-]+\/)+[\w.-]+/g, '<path>')
}

/**
 * Build the invocation receipt for one call.
 *
 * Takes only host-resolved inputs. There is no parameter for a request body, a
 * token or a skill text, so those cannot reach a receipt through this function at
 * all — which is a stronger guarantee than remembering to omit them.
 * @param input - the resolved provenance.
 * @returns the receipt.
 */
export function buildInvocationReceipt(input: {
  readonly receiptId: string
  readonly contract: string
  readonly contractVersion: string
  readonly implementationId: string
  readonly extension: string
  readonly extensionVersion: string
  readonly extensionContentDigest?: string | null
  readonly dependencyLockDigest?: string | null
  readonly modelIdentity: string
  readonly recipeVersion?: string | null
  readonly activationGeneration: number
  readonly executionLocation: InvocationReceipt['executionLocation']
  readonly warnings?: readonly string[]
}): InvocationReceipt {
  if (input.receiptId.length === 0) {
    throw new ReceiptRedactionError('a receipt needs an identity; an unidentifiable receipt is not an audit trail')
  }
  return {
    receiptId: input.receiptId,
    contract: input.contract,
    contractVersion: input.contractVersion,
    implementationId: input.implementationId,
    extension: input.extension,
    extensionVersion: input.extensionVersion,
    extensionContentDigest: input.extensionContentDigest ?? null,
    dependencyLockDigest: input.dependencyLockDigest ?? null,
    modelIdentity: input.modelIdentity,
    recipeVersion: input.recipeVersion ?? null,
    activationGeneration: input.activationGeneration,
    executionLocation: input.executionLocation,
    // Every note passes through the redactor, so a host-authored note that happened
    // to embed a token or a path cannot leak one.
    warnings: (input.warnings ?? []).map(redactText),
  }
}

/**
 * Record one operator action, separately from execution metadata.
 * @param input - the action, its outcome and its approving principal.
 * @returns the lifecycle record.
 */
export function buildLifecycleRecord(input: {
  readonly operation: LifecycleOperation
  readonly extensionId: string
  readonly version?: string | null
  readonly contentDigest?: string | null
  readonly profile?: string | null
  readonly outcome: LifecycleOutcome
  readonly reason?: string | null
  readonly approvedBy: ApprovingPrincipal
  readonly at?: string
}): LifecycleRecord {
  if (input.approvedBy.kind === 'operator' && input.approvedBy.identity.length === 0) {
    // An approval with no principal cannot be audited, which defeats the record.
    throw new ReceiptRedactionError('an operator approval needs an identity')
  }
  return {
    operation: input.operation,
    extensionId: input.extensionId,
    version: input.version ?? null,
    contentDigest: input.contentDigest ?? null,
    profile: input.profile ?? null,
    outcome: input.outcome,
    // A failed operation with no reason is the record an operator cannot act on.
    reason: input.reason === undefined || input.reason === null ? null : redactText(input.reason),
    approvedBy: input.approvedBy,
    at: input.at ?? new Date().toISOString(),
  }
}

/**
 * The bounded-logging policy an extension's diagnostics run under (EXT-35).
 *
 * Extension logging is bounded and host-policy controlled, and extension-declared
 * telemetry or network behaviour must be disclosed rather than assumed. This
 * applies the policy; it does not infer one.
 */
export interface ExtensionLogPolicy {
  /** Maximum records retained per extension. */
  readonly maxRecords: number
  /** Levels admitted. A disabled level is dropped, not rewritten. */
  readonly levels: readonly ('debug' | 'info' | 'warn' | 'error')[]
  /** Whether the extension declared telemetry, which the operator must approve. */
  readonly telemetryApproved: boolean
  /** Origins the extension declared, which must all be approved. */
  readonly approvedOrigins: readonly string[]
}

/** The default policy: quiet, metadata-only, and telemetry off unless approved. */
export const DEFAULT_LOG_POLICY: ExtensionLogPolicy = {
  maxRecords: 500,
  levels: ['warn', 'error'],
  telemetryApproved: false,
  approvedOrigins: [],
}

/**
 * Apply a logging policy to one extension record.
 *
 * A dropped record is dropped rather than summarised, because a summarised
 * diagnostic is a diagnostic an operator will misread.
 * @param policy - the policy in force.
 * @param record - the proposed record.
 * @returns whether to retain it.
 */
export function admitsLogRecord(
  policy: ExtensionLogPolicy,
  record: { readonly level: 'debug' | 'info' | 'warn' | 'error'; readonly declaredOrigin?: string },
): boolean {
  if (!policy.levels.includes(record.level)) return false
  if (record.declaredOrigin !== undefined) {
    // An undeclared network origin is refused rather than recorded and forgotten:
    // EXT-35 requires the behaviour to be disclosed and approved, not logged.
    if (!policy.approvedOrigins.includes(record.declaredOrigin)) return false
  }
  return true
}
