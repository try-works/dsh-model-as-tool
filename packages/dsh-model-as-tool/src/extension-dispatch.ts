/**
 * Provider-backed dispatch for extension-declared tools (EXT-19, EXT-21, EXT-22, ARCH-05).
 *
 * The TMX runtime API has **no tool-invocation surface**. `ExtensionInstanceV1` exposes
 * exactly `createProvider` and `dispose` — nothing else. So an extension's tool is not
 * something the host calls directly; the tool is a caller-facing NAME whose contract is
 * bound to an IMPLEMENTATION, and the implementation is a model PROVIDER.
 *
 *     manifest.tools[]          -> the caller-facing name and its contract
 *     manifest.implementations[] -> which contract, served by which model
 *     instance.createProvider() -> the thing that actually runs
 *
 * That chain is what this module walks. An earlier version of the host registrar
 * registered a tool whose `execute` simply REFUSED, which was honest about there being no
 * implementation bound but left the bridge functionally incomplete: the name appeared in
 * the registry and could never be called.
 *
 * The context is INJECTED so the chain is testable without a real extension on disk.
 *
 * @module @try-works/dsh-model-as-tool/extension-dispatch
 */

import { assertNoReservedMeta } from '@try-works/tool-mode-extension-sdk'
import type { PreparedAssetMap } from './prepared-assets.ts'

/** What a manifest declares about one tool. */
export interface DeclaredTool {
  readonly name: string
  readonly contractId: string
  readonly contractVersion: string
}

/** What a manifest declares about one implementation. */
export interface DeclaredImplementation {
  readonly id: string
  readonly contractId: string
  readonly contractVersion: string
  /** The model that serves the contract. */
  readonly modelId: string
}

/** The parts of a manifest this module needs. */
export interface DispatchManifest {
  readonly tools: readonly DeclaredTool[]
  readonly implementations: readonly DeclaredImplementation[]
}

/** A provider, narrowed to what dispatch needs. */
export interface DispatchProvider {
  load(request: {
    readonly assets: unknown
    readonly signal: AbortSignal
    /** The manifest model id; the managed worker's load keys by it. */
    readonly modelId?: string
  }): Promise<void>
  invoke(request: {
    readonly implementationId: string
    readonly input: Readonly<Record<string, unknown>>
    readonly context: unknown
  }): Promise<Record<string, unknown>>
}

/** What dispatch needs from the host to reach an extension. */
export interface DispatchEnvironment {
  /** The manifest of the activated extension that declared the tool. */
  getManifest(): DispatchManifest
  /** Create (or return a cached) provider for a model deployment. */
  providerFor(modelId: string): Promise<DispatchProvider>
  /** Build the invocation context, which carries host-issued identity. */
  contextFor(implementationId: string, signal: AbortSignal): unknown
  /**
   * The host's verified prepared-asset map for THIS extension, or undefined
   * when nothing was prepared (the load then receives the EMPTY map — an
   * extension needing assets refuses by name inside its own load, which is the
   * honest MOD-02 behavior rather than an invented verification). Closes over
   * the extension the environment was built for.
   */
  assetsFor?(): PreparedAssetMap | undefined
}

/** Why a tool could not be dispatched. */
export interface DispatchFailure {
  readonly code: 'not-declared' | 'no-implementation' | 'unsupported'
  readonly message: string
  readonly remedy: string
}

/**
 * Resolve the implementation chain for a declared tool.
 *
 * @param manifest - the activated extension's manifest.
 * @param toolName - the caller-facing name.
 * @returns the tool, its implementation, or why the chain is incomplete.
 */
export function resolveImplementation(
  manifest: DispatchManifest,
  toolName: string,
): { readonly ok: true; readonly tool: DeclaredTool; readonly implementation: DeclaredImplementation }
  | { readonly ok: false; readonly failure: DispatchFailure } {
  const tool = manifest.tools.find(candidate => candidate.name === toolName)
  if (tool === undefined) {
    return {
      ok: false,
      failure: {
        code: 'not-declared',
        message: `${toolName} is not declared by this extension's manifest`,
        remedy: 'A registered tool must be declared in the manifest it was published from.',
      },
    }
  }
  const implementation = manifest.implementations.find(candidate =>
    candidate.contractId === tool.contractId && candidate.contractVersion === tool.contractVersion)
  if (implementation === undefined) {
    /**
     * THE HONEST REFUSAL, and the case the earlier stub conflated with every other.
     *
     * An extension may DECLARE a tool it does not yet serve — EmbeddingGemma does exactly
     * this, listing contracts whose ONNX path is not wired. The name is legitimately
     * registered and legitimately uncallable, and the caller must be told WHICH of those
     * two situations they are in.
     */
    return {
      ok: false,
      failure: {
        code: 'no-implementation',
        message: `${toolName} declares contract ${tool.contractId}, which no implementation serves`,
        remedy: 'The extension declares this tool but binds no model to it yet; it is not callable in this build.',
      },
    }
  }
  return { ok: true, tool, implementation }
}

/**
 * Build an `execute` for one declared tool.
 *
 * The provider is created lazily on first call, so ACTIVATION stays lightweight as EXT-19
 * requires: nothing is loaded until a caller actually invokes the tool.
 *
 * @param environment - how to reach the extension.
 * @param toolName - the caller-facing name.
 * @returns the execute function, or the failure that prevents one.
 */
export async function createDispatch(
  environment: DispatchEnvironment,
  toolName: string,
): Promise<
  | { readonly ok: true; readonly execute: (args: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, unknown>> }
  | { readonly ok: false; readonly failure: DispatchFailure }
> {
  const resolved = resolveImplementation(environment.getManifest(), toolName)
  if (!resolved.ok) return resolved

  const { implementation } = resolved
  return {
    ok: true,
    async execute(args, signal) {
      // Resolved per call rather than captured, so a provider that was unloaded — or an
      // extension that was deactivated and reactivated — is not served from a stale handle.
      const provider = await environment.providerFor(implementation.modelId)
      /**
       * The HOST-VERIFIED prepared-asset map, when a preparation completed.
       * An absent map means the empty map — the extension's own load refuses a
       * missing group by name (MOD-02), which is the honest outcome rather than
       * a host that invents a verification that never happened. The same map
       * reaches BOTH provider routes here: the in-process module provider and
       * the managed worker (its load forwards the assets to the child).
       */
      const prepared = environment.assetsFor?.()
      await provider.load({ assets: prepared ?? { get: () => undefined, assetIds: [] }, signal, modelId: implementation.modelId })
      const value = await provider.invoke({
        implementationId: implementation.id,
        input: args,
        context: environment.contextFor(implementation.id, signal),
      })
      /**
       * THE EXT-17 META RESERVATION IS ENFORCED HERE, AT THE DISPATCH BOUNDARY.
       *
       * The reserved root `meta` is HOST-authored provenance; an extension supplying one
       * is asserting who ran it and under what receipt, which it does not get to do. The
       * ProviderBridge asserts this on the CATALOG path, but the contribution path
       * (module and declarative providers alike) went unasserted — so a provider that
       * smuggled a `meta` key reached callers whenever its declared output schema did not
       * require the envelope. Asserting at the boundary the two provider routes share
       * closes the gap for both, and it runs BEFORE any host stamping, so a forged
       * envelope is refused rather than overwritten.
       */
      assertNoReservedMeta(value as never, implementation.id)
      return value
    },
  }
}

/**
 * Describe a dispatch failure for a caller (EXT-30).
 * @param failure - the failure.
 * @returns a readable message naming what to do.
 */
export function describeDispatchFailure(failure: DispatchFailure): string {
  return `${failure.message}. ${failure.remedy}`
}
