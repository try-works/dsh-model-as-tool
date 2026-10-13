/**
 * The machine-readable management error vocabulary (EXT-34).
 *
 * Every management failure carries a stable code, the operation that failed, and
 * safe recovery advice. Recovery text is authored to be safe to show: it never
 * contains a credential, a token, or an absolute path from the operator's disk,
 * because these errors surface in logs and operator UIs.
 *
 * @module @try-works/tool-mode-extension-sdk/errors
 */

/** Every management error code the protocol defines (EXT-34). */
export const MANAGEMENT_ERROR_CODES = [
  'INVALID_EXTENSION',
  'INCOMPATIBLE_PROTOCOL',
  'UNSUPPORTED_PLATFORM',
  'INTEGRITY_MISMATCH',
  'PERMISSION_REQUIRED',
  'DEPENDENCY_UNSATISFIED',
  'TOOL_NAME_CONFLICT',
  'CONTRACT_MISMATCH',
  'EXTENSION_INACTIVE',
  'EXTENSION_IN_USE',
  'BUILTIN_PROTECTED',
  'EXTENSION_REVOKED',
  'EXTENSION_FAULT',
  'UPGRADE_FAILED',
  'CLEANUP_PENDING',
] as const

/** One management error code. */
export type ManagementErrorCode = (typeof MANAGEMENT_ERROR_CODES)[number]

/** The management operations an error can be attributed to. */
export type ManagementOperation =
  | 'discover'
  | 'install'
  | 'activate'
  | 'deactivate'
  | 'update'
  | 'uninstall'
  | 'prepare'
  | 'invoke'

/** Whether a code's condition is worth retrying unchanged. */
const RETRYABLE: ReadonlySet<ManagementErrorCode> = new Set<ManagementErrorCode>([
  'EXTENSION_FAULT',
  'CLEANUP_PENDING',
])

/** A structured management failure. */
export interface ManagementErrorShape {
  /** Stable machine-readable code. */
  readonly code: ManagementErrorCode
  /** The operation that failed. */
  readonly operation: ManagementOperation
  /** Human-readable description, safe to log. */
  readonly message: string
  /** Safe recovery advice. Never contains credentials or operator paths. */
  readonly recovery: string
  /** Whether retrying the same operation could succeed. */
  readonly retryable: boolean
}

/**
 * A management failure raised by discovery, installation or lifecycle code.
 *
 * `retryable` is derived from the code rather than passed in, so a caller cannot
 * accidentally mark a permission refusal as a transient fault the agent should
 * retry in a loop.
 */
export class ManagementError extends Error {
  override readonly name = 'ManagementError'
  readonly code: ManagementErrorCode
  readonly operation: ManagementOperation
  readonly recovery: string
  readonly retryable: boolean

  constructor(
    code: ManagementErrorCode,
    operation: ManagementOperation,
    message: string,
    recovery: string,
  ) {
    super(message)
    this.code = code
    this.operation = operation
    this.recovery = recovery
    this.retryable = RETRYABLE.has(code)
  }

  /** Render the structured shape, for receipts and management surfaces. */
  toShape(): ManagementErrorShape {
    return {
      code: this.code,
      operation: this.operation,
      message: this.message,
      recovery: this.recovery,
      retryable: this.retryable,
    }
  }
}

/**
 * Strip anything credential-shaped from recovery advice.
 *
 * EXT-34 requires that recovery text never carries raw credentials. Advice is
 * authored rather than interpolated, so this is a guard against a future edit
 * that interpolates a path or a value by accident.
 * @param text - the authored advice.
 * @returns the advice with path- and credential-shaped spans removed.
 */
export function sanitizeRecovery(text: string): string {
  return text
    // Windows and POSIX absolute paths.
    .replace(/[A-Za-z]:\\[^\s"']*/g, '<path>')
    .replace(/(?<![\w.])\/(?:[\w.-]+\/)+[\w.-]+/g, '<path>')
    // Token-shaped spans.
    .replace(/\b(?:npm_|ghp_|gho_|sk-)[A-Za-z0-9_-]{8,}/g, '<redacted>')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '<redacted>')
}
