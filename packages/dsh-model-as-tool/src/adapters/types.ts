/**
 * The adapter seam: how one catalog model is actually invoked.
 *
 * An adapter is responsible for exactly two things — loading its model lazily
 * and turning validated tool arguments into the canonical JSON value the tool
 * declares. Everything else (which models exist, whether they may run, what the
 * model sees) belongs to the catalog, the capability resolver, and the
 * registrar.
 *
 * @module @try-works/dsh-model-as-tool/adapters/types
 */

import type { ModelCatalogEntry } from '../types.ts'
import type { InvocationAuthority } from '../authority.ts'

/** A lossless JSON value, the only thing a tool body may return. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** One adapter invocation. */
export interface AdapterInvocation {
  /** Validated tool arguments, already constrained by the registered parameter schema. */
  readonly args: Readonly<Record<string, unknown>>
  /** Caller cancellation, forwarded by the tool body. */
  readonly signal: AbortSignal
  /**
   * Trusted authority for this call (BASE-05).
   *
   * An implementation MUST resolve a caller-supplied path through
   * `authority.resolvePath` rather than opening the argument directly: the
   * authority is constructed by the host and cannot be supplied or widened by a
   * request. It is optional only so a test can drive an adapter without a grant;
   * a host always provides one.
   */
  readonly authority?: InvocationAuthority
}

/** One model's invocation strategy. */
export interface ModelAdapter {
  /** The catalog id this adapter serves. */
  readonly modelId: string
  /**
   * Run the model once and return the canonical value.
   *
   * Every model tool declares an object output schema, so an adapter returns an
   * object rather than an arbitrary JSON root.
   * @param invocation - validated arguments and caller cancellation.
   * @returns the lossless JSON object declared by the tool's output schema.
   */
  invoke(invocation: AdapterInvocation): Promise<Record<string, JsonValue>>
  /**
   * Release any process-level model resources.
   *
   * Called on plugin dispose. Adapters that cache a loaded model must implement
   * it; adapters that hold nothing may omit it.
   */
  dispose?(): Promise<void>
}

/** Build an adapter for one runnable model, or `undefined` when none exists yet. */
export type AdapterFactory = (entry: ModelCatalogEntry) => ModelAdapter | undefined

/**
 * Reject an aborted call before doing model work.
 * @param signal - caller cancellation.
 * @throws the abort reason when the signal is already aborted.
 */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted')
}

/**
 * Read a required string argument.
 * @param args - validated arguments.
 * @param key - argument name.
 * @returns the string value.
 * @throws when the value is absent or not a string.
 */
export function requireString(args: Readonly<Record<string, unknown>>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`argument "${key}" must be a non-empty string`)
  }
  return value
}

/**
 * Read an optional integer argument, clamped to a range.
 * @param args - validated arguments.
 * @param key - argument name.
 * @param options - inclusive bounds and the value to use when absent.
 * @returns the resolved integer.
 * @throws when the value is present but not an integer in range.
 */
export function optionalInteger(
  args: Readonly<Record<string, unknown>>,
  key: string,
  options: { readonly min: number; readonly max: number; readonly fallback: number },
): number {
  const value = args[key]
  if (value === undefined) return options.fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < options.min || value > options.max) {
    throw new Error(`argument "${key}" must be an integer between ${options.min} and ${options.max}`)
  }
  return value
}

/**
 * Read an optional number in a range.
 * @param args - validated arguments.
 * @param key - argument name.
 * @param options - inclusive bounds.
 * @returns the resolved number, or undefined when absent.
 * @throws when the value is present but not a finite number in range.
 */
export function optionalNumber(
  args: Readonly<Record<string, unknown>>,
  key: string,
  options: { readonly min: number; readonly max: number },
): number | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < options.min || value > options.max) {
    throw new Error(`argument "${key}" must be a number between ${options.min} and ${options.max}`)
  }
  return value
}

/**
 * Read a required boolean argument.
 * @param args - validated arguments.
 * @param key - argument name.
 * @param fallback - value used when the argument is absent.
 * @returns the resolved boolean.
 * @throws when the value is present but not a boolean.
 */
export function optionalBoolean(
  args: Readonly<Record<string, unknown>>,
  key: string,
  fallback: boolean,
): boolean {
  const value = args[key]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`argument "${key}" must be a boolean`)
  return value
}
