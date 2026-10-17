/**
 * Coherent publication from one versioned generation (EXT-24).
 *
 * EXT-24 forbids two observable states: an available tool WITHOUT its executable
 * binding, and a new schema served by an old handler. The way to avoid both is to
 * build the whole surface first, check it for internal consistency, and only then
 * make it visible — staging plus a single switch, which is what the requirement
 * asks for rather than an invented transactional registry API.
 *
 * The rules encoded here, each with a reason:
 *
 * - A tool is advertised only when a real implementation binding exists. A schema
 *   alone is a promise nothing can keep, and EXT-24 states that no contract is
 *   automatically callable merely because its schema is installed.
 * - An ACTIVE package whose model is unprepared publishes readiness information and
 *   a preparation skill, but NOT a working inference tool. Advertising a callable
 *   tool that will fail on first use is worse than advertising nothing, because the
 *   caller has no way to tell the difference until it fails.
 * - A usage skill appears only when every tool it requires is visible. A skill that
 *   instructs an agent to call a tool that is not there produces a confident
 *   failure.
 * - Every skill carries its owning extension, so it can be withdrawn with that
 *   package rather than outliving it.
 *
 * @module @try-works/dsh-model-as-tool/publication
 */

import type { ModelReadiness } from '@try-works/tool-mode-extension-sdk'

const CALLABLE_READINESS: ReadonlySet<ModelReadiness> = new Set<ModelReadiness>([
  'prepared-cold',
  'loading',
  'ready',
  'busy',
])

/** Why a candidate contribution did not reach the published surface. */
export interface WithheldContribution {
  /** Stable reason code. */
  readonly code:
    | 'no-implementation'
    | 'needs-preparation'
    | 'unregistered-contribution'
    | 'model-failed'
  /** Human-readable explanation. */
  readonly message: string
  /** The tool or skill that was withheld. */
  readonly subject: string
  /** The extension that owns it. */
  readonly extensionId: string
}

/** One implementation offered for a contract. */
export interface ImplementationCandidate {
  /** The extension providing it. */
  readonly extensionId: string
  /** The catalog model backing it. */
  readonly modelId: string
  /** Whether the model is prepared and callable right now. */
  readonly readiness: ModelReadiness
  /** Whether the model can run on this host at all. */
  readonly runnable: boolean
}

/** One contract offered for publication. */
export interface ToolCandidate {
  /** The caller-facing tool name. */
  readonly name: string
  /** The contract it implements. */
  readonly contractId: string
  /** The model the operator selected to serve it. */
  readonly selectedModelId: string
  /** Every implementation that could serve it. */
  readonly implementations: readonly ImplementationCandidate[]
}

/** One skill offered for publication. */
export interface SkillCandidate {
  /** The skill name. */
  readonly name: string
  /** The extension that owns it. */
  readonly extensionId: string
  /** Tool NAMES the skill depends on. An absent list means it depends on nothing. */
  readonly requiresTools?: readonly string[]
  /**
   * Whether this skill exists to explain preparation rather than usage.
   *
   * A preparation skill is published even when nothing is callable, because its
   * whole purpose is to tell an operator what to do about that.
   */
  readonly purpose?: 'usage' | 'preparation'
}

/** A published tool, which by construction has an executable binding. */
export interface PublishedTool {
  readonly name: string
  readonly contractId: string
  readonly extensionId: string
  readonly modelId: string
  readonly readiness: ImplementationCandidate['readiness']
  /** The other implementations a caller could be switched to. */
  readonly alternatives: readonly string[]
}

/** A published skill. */
export interface PublishedSkill {
  readonly name: string
  readonly extensionId: string
  readonly purpose: 'usage' | 'preparation'
  readonly requiresTools: readonly string[]
}

/** One model deployment's readiness, published for operator visibility. */
export interface ReadinessNotice {
  readonly extensionId: string
  readonly modelId: string
  readonly readiness: ImplementationCandidate['readiness']
  readonly callable: boolean
  readonly reason: string
}

/** A complete, internally consistent surface. */
export interface CatalogGeneration {
  /** The generation this surface belongs to. */
  readonly generation: number
  readonly tools: readonly PublishedTool[]
  readonly skills: readonly PublishedSkill[]
  readonly readiness: readonly ReadinessNotice[]
  /** Everything withheld, with the reason. Never silently dropped. */
  readonly withheld: readonly WithheldContribution[]
}

/**
 * Build a coherent surface from the candidates available now.
 *
 * Pure: it decides what MAY be published, and the caller makes the result visible.
 * Keeping the decision separate from the switch is what allows a surface to be
 * rejected before anything observes it.
 * @param options - the candidates and the generation they belong to.
 * @returns the complete surface, including what was withheld and why.
 * @throws Error when the candidates are internally inconsistent in a way that
 *   cannot be resolved by withholding, such as two tools sharing a name.
 */
export function buildSurface(options: {
  readonly generation: number
  readonly tools: readonly ToolCandidate[]
  readonly skills: readonly SkillCandidate[]
}): CatalogGeneration {
  const tools: PublishedTool[] = []
  const readiness: ReadinessNotice[] = []
  const withheld: WithheldContribution[] = []

  // A duplicate tool name cannot be resolved by dropping one: the caller asked for
  // a specific name and would get a different implementation than the catalog says.
  const seen = new Set<string>()
  for (const candidate of options.tools) {
    if (seen.has(candidate.name)) {
      throw new Error(
        `two contracts publish the tool name ${JSON.stringify(candidate.name)}; `
        + 'a name identifies one tool, so this cannot be resolved by withholding',
      )
    }
    seen.add(candidate.name)
  }

  for (const candidate of options.tools) {
    const runnable = candidate.implementations.filter(impl => impl.runnable)
    for (const implementation of candidate.implementations) {
      readiness.push({
        extensionId: implementation.extensionId,
        modelId: implementation.modelId,
        readiness: implementation.readiness,
        // Callable requires BOTH that the host can run it and that preparation
        // says a call is possible. Residency states such as prepared-cold/loading
        // affect admission, not publication (RES-04).
        callable: implementation.runnable && CALLABLE_READINESS.has(implementation.readiness),
        reason: !implementation.runnable
          ? 'this model cannot run on this host'
          : CALLABLE_READINESS.has(implementation.readiness)
            ? `model is ${implementation.readiness}; prepared and callable`
            : `model is ${implementation.readiness}; the tool is not advertised as working`,
      })
    }

    const selected = candidate.implementations.find(impl => impl.modelId === candidate.selectedModelId)
    if (selected === undefined || !selected.runnable) {
      withheld.push({
        code: 'no-implementation',
        subject: candidate.name,
        extensionId: selected?.extensionId ?? candidate.implementations[0]?.extensionId ?? 'unknown',
        message: 'no runnable implementation is bound, so the tool is not published',
      })
      continue
    }
    if (selected.readiness === 'failed') {
      withheld.push({
        code: 'model-failed',
        subject: candidate.name,
        extensionId: selected.extensionId,
        message: 'the selected model deployment has failed and will not become ready by waiting',
      })
      continue
    }
    if (!CALLABLE_READINESS.has(selected.readiness)) {
      // EXT-24: an active package with an unprepared model may publish readiness
      // and preparation guidance, but MUST NOT advertise working inference.
      withheld.push({
        code: 'needs-preparation',
        subject: candidate.name,
        extensionId: selected.extensionId,
        message: `the selected model is ${selected.readiness}; readiness is published instead of a callable tool`,
      })
      continue
    }
    tools.push({
      name: candidate.name,
      contractId: candidate.contractId,
      extensionId: selected.extensionId,
      modelId: selected.modelId,
      readiness: selected.readiness,
      alternatives: runnable.filter(impl => impl.modelId !== selected.modelId).map(impl => impl.modelId),
    })
  }

  const visible = new Set(tools.map(tool => tool.name))
  const skills: PublishedSkill[] = []
  for (const candidate of options.skills) {
    const purpose = candidate.purpose ?? 'usage'
    const required = candidate.requiresTools ?? []
    if (purpose === 'usage') {
      const missing = required.filter(name => !visible.has(name))
      if (missing.length > 0) {
        // A usage skill whose tool is absent would instruct an agent to call
        // something that is not there, producing a confident failure.
        withheld.push({
          code: 'unregistered-contribution',
          subject: candidate.name,
          extensionId: candidate.extensionId,
          message: `the required tool(s) ${missing.join(', ')} are not visible, so the usage skill is withheld`,
        })
        continue
      }
    }
    skills.push({ name: candidate.name, extensionId: candidate.extensionId, purpose, requiresTools: required })
  }

  return { generation: options.generation, tools, skills, readiness, withheld }
}

/**
 * The published surface, swapped only as a whole (EXT-24).
 *
 * `publish` refuses a surface that would retire a tool without retiring the skill
 * that teaches it, which is the "new schema with the old handler" failure seen from
 * the other side.
 */
export class PublicationSurface {
  #current: CatalogGeneration
  readonly #onSwap: ((next: CatalogGeneration, previous: CatalogGeneration) => void) | undefined

  constructor(options: { readonly generation?: number; readonly onSwap?: (next: CatalogGeneration, previous: CatalogGeneration) => void } = {}) {
    this.#current = { generation: options.generation ?? 1, tools: [], skills: [], readiness: [], withheld: [] }
    this.#onSwap = options.onSwap
  }

  /** The generation currently visible. */
  get current(): CatalogGeneration {
    return this.#current
  }

  /**
   * Replace the visible surface.
   *
   * The callback receives the whole change at once, so a consumer can update its
   * declarations without ever seeing an intermediate state.
   * @param next - the surface to make visible.
   */
  publish(next: CatalogGeneration): void {
    const previous = this.#current
    this.#current = next
    this.#onSwap?.(next, previous)
  }

  /**
   * Skills that must be withdrawn because their owning extension is gone.
   *
   * EXT-24 requires the host to track skill provenance and remove a skill with the
   * package or tool that owns it, rather than leaving orphaned guidance behind.
   * @param liveExtensionIds - the extensions still installed and active.
   * @returns the skills that should no longer be visible.
   */
  orphanedSkills(liveExtensionIds: readonly string[]): readonly PublishedSkill[] {
    const live = new Set(liveExtensionIds)
    return this.#current.skills.filter(skill => !live.has(skill.extensionId))
  }
}
