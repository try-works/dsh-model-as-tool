/**
 * The host-side contribution registrar (EXT-21..EXT-30, ARCH-06).
 *
 * This is the bridge that was MISSING: `ExtensionLifecycle` could install, activate and
 * publish contributions, and the SDK was fully tested doing so — but the HOST never
 * mounted the lifecycle, so **no extension's tools ever reached the DSH registry**. An
 * extension could be installed, activated and reported `observedActivation: 'active'` with
 * its tool listed, and a caller still could not invoke it.
 *
 * The registrar is the other half: it turns a published contribution into a real registry
 * entry, and withdraws it again on deactivation.
 *
 * Four rules, each of which has been a real defect somewhere:
 *
 * - **Handles are opaque and unguessable.** An extension must not be able to construct a
 *   handle and withdraw a contribution it does not own. A sequence number is guessable;
 *   the handle is a branded object the caller never sees the inside of.
 * - **Withdrawing is idempotent.** A deactivation that runs twice must not throw the
 *   second time, and must not withdraw a DIFFERENT contribution that reused the handle.
 * - **A name collision is refused, not silently overwritten.** Two extensions contributing
 *   `transcribe` is a configuration error; letting the second win would silently change
 *   what an existing caller reaches.
 * - **The host stamps identity.** The contribution carries an extension id, but the HOST
 *   decides what that means; a package claiming another's id is refused rather than
 *   trusted.
 *
 * @module @try-works/dsh-model-as-tool/extension-registrar
 */

import type { Contribution, ContributionRegistrar } from '@try-works/tool-mode-extension-sdk'

/** One thing the registrar can put into the DSH registry. */
export interface RegistrableTool {
  /** The caller-facing tool name. */
  readonly name: string
  /** The extension that owns it, as the HOST resolved it. */
  readonly ownerExtension: string
  /** The contract it implements, when it declares one. */
  readonly contractId?: string
}

/** What the registrar needs from the host registry. */
export interface HostRegistrySurface {
  /**
   * Register one tool.
   * @param tool - the tool, with identity already stamped by the host.
   * @returns a disposer that removes it.
   */
  registerTool(tool: RegistrableTool): () => void
  /** Register one skill, returning a disposer. */
  registerSkill?(skill: { readonly name: string; readonly ownerExtension: string }): () => void
  /**
   * Register the CALLER-FACING tools of one declarative implementation (RCP-01).
   *
   * A declarative package declares implementations only — its manifest has no
   * `tools` array — so the tool names and schemas come from the RESOLVED RECIPES,
   * which only the host can turn into registry entries (the recipes need the
   * deployment's harness provider to be served at all). The contribution arrives
   * per implementation; the host resolves the package's recipes and registers the
   * matching tool, returning its disposer. Absent (or a non-declarative package)
   * keeps the earlier behavior: implementations publish nothing.
   */
  registerDeclarative?(contribution: {
    readonly extensionId: string
    readonly name: string
    readonly contractId?: string
  }): () => void
}

/** Raised when a contribution cannot be published. */
export class ContributionError extends Error {
  override readonly name = 'ContributionError'
  readonly code: 'name-collision' | 'unsupported-kind' | 'unknown-extension'
  constructor(code: ContributionError['code'], message: string) {
    super(message)
    this.code = code
  }
}

/** An opaque handle. The brand makes it unforgeable from the outside. */
interface Handle {
  readonly __contributionHandle: true
  readonly id: number
  readonly extensionId: string
  readonly name: string
}

/**
 * The published contributions, keyed by handle id.
 *
 * A Map rather than a field on the handle, so an extension that receives a handle cannot
 * reach the disposer or another extension's entry through it.
 */
export interface RegistrarOptions {
  readonly registry: HostRegistrySurface
  /**
   * The extensions the host has ACTIVATED.
   *
   * A contribution from an extension not in this set is refused: publishing is a privilege
   * of activation, and without this check any code holding the registrar could register a
   * tool under an extension that was never installed.
   */
  readonly activated: ReadonlySet<string>
  /** Called when a contribution is refused, so the reason is recorded rather than lost. */
  readonly onRefused?: (contribution: Contribution, error: ContributionError) => void
}

/**
 * Create the registrar the lifecycle publishes through.
 * @param options - the registry surface and the activated set.
 * @returns the registrar.
 */
export function createContributionRegistrar(options: RegistrarOptions): ContributionRegistrar {
  const published = new Map<number, { handle: Handle; dispose: () => void }>()
  /** Names currently taken, so a collision is detected rather than overwritten. */
  const takenNames = new Map<string, string>()
  let nextId = 1

  const refuse = (contribution: Contribution, error: ContributionError): never => {
    options.onRefused?.(contribution, error)
    throw error
  }

  return {
    publish(contribution: Contribution): string {
      // ACTIVATION IS A PRECONDITION. A contribution from a package that was never
      // activated is refused rather than registered.
      if (!options.activated.has(contribution.extensionId)) {
        return refuse(contribution, new ContributionError(
          'unknown-extension',
          `${contribution.extensionId} is not activated, so it cannot publish ${contribution.name}`,
        ))
      }

      /**
       * A COLLISION IS REFUSED. Letting the second registration win would silently change
       * what an existing caller reaches — the same name would resolve to a different tool
       * with no signal.
       */
      const existing = takenNames.get(contribution.name)
      if (existing !== undefined) {
        return refuse(contribution, new ContributionError(
          'name-collision',
          `${contribution.name} is already published by ${existing}; `
          + `${contribution.extensionId} cannot take the name over`,
        ))
      }

      const handle: Handle = {
        __contributionHandle: true,
        id: nextId++,
        extensionId: contribution.extensionId,
        name: contribution.name,
      }

      let dispose: () => void
      if (contribution.kind === 'tool') {
        dispose = options.registry.registerTool({
          name: contribution.name,
          // The HOST stamps the owner from the contribution it validated, so a package
          // cannot claim another's provenance.
          ownerExtension: contribution.extensionId,
          ...contribution.contractId === undefined ? {} : { contractId: contribution.contractId },
        })
      } else if (contribution.kind === 'skill' && options.registry.registerSkill !== undefined) {
        dispose = options.registry.registerSkill({
          name: contribution.name,
          ownerExtension: contribution.extensionId,
        })
      } else if (contribution.kind === 'implementation' && options.registry.registerDeclarative !== undefined) {
        // An `implementation` of a MODULE package is not a caller-facing tool: the model
        // catalogue binds it. An implementation of a DECLARATIVE package, however, IS the
        // whole package: the host turns its resolved recipe into the caller-facing tool
        // here (RCP-01), and the returned disposer is tracked like any other handle.
        dispose = options.registry.registerDeclarative({
          extensionId: contribution.extensionId,
          name: contribution.name,
          ...contribution.contractId === undefined ? {} : { contractId: contribution.contractId },
        })
      } else {
        dispose = () => {}
      }

      takenNames.set(contribution.name, contribution.extensionId)
      published.set(handle.id, { handle, dispose })
      // The SDK types the handle as a string; the runtime value is a branded object, which
      // is what makes it unforgeable. The cast is the boundary between the two.
      return handle as unknown as string
    },

    withdraw(rawHandle: string): void {
      const handle = rawHandle as unknown as Handle
      // A handle that is not ours — a string, a number, a forged object — is ignored
      // rather than treated as a lookup that might match something.
      if (handle === null || typeof handle !== 'object' || handle.__contributionHandle !== true) return
      const entry = published.get(handle.id)
      if (entry === undefined) {
        // IDEMPOTENT: withdrawing twice is not an error, and must not withdraw whatever
        // might have reused the id.
        return
      }
      // The handle must be the SAME one that was issued, not merely an object with the
      // right id, so a reconstructed handle cannot withdraw someone else's tool.
      if (entry.handle !== handle) return
      // Failed cleanup retains ownership and the handle for an explicit retry.
      entry.dispose()
      published.delete(handle.id)
      takenNames.delete(handle.name)
    },
  }
}

