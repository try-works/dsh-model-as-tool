/**
 * Playbooks: the per-model knowledge that turns a tool into a usable capability.
 *
 * A catalog entry says what a model *is*; a playbook says what it is *for* — the
 * concrete jobs an agent should reach for it on, the jobs it should not, and how
 * the model composes with its neighbours. Playbooks live in their own document
 * so they can be revised without touching the catalog or the code.
 *
 * @module @try-works/dsh-model-as-tool/playbook
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The authored playbook for one model. */
export interface ModelPlaybook {
  /** Concrete jobs this model is the right tool for. */
  readonly useCases: readonly string[]
  /** Trigger conditions: when the agent should reach for this tool. */
  readonly whenToUse: readonly string[]
  /** Anti-triggers: when this tool is the wrong move. */
  readonly whenNotToUse: readonly string[]
  /** Ordered steps describing how to drive the model well. */
  readonly workflow: readonly string[]
  /** How this model composes with the others, by model id or tool name. */
  readonly pairsWith: readonly string[]
  /** Limits, cost and failure modes worth knowing before calling. */
  readonly caveats: readonly string[]
}

/** Absolute path of the playbook document shipped with this package. */
export const DEFAULT_PLAYBOOK_FILE = fileURLToPath(
  new URL('../catalog/playbooks.json', import.meta.url),
)

/** Raised when the playbook document is present but malformed. */
export class PlaybookError extends Error {
  override readonly name = 'PlaybookError'
}

const STRING_ARRAY_FIELDS = ['useCases', 'whenToUse', 'whenNotToUse', 'workflow', 'pairsWith', 'caveats'] as const

/**
 * Parse a playbook document into a per-model map.
 *
 * An absent document is not an error: playbooks are editorial content, and the
 * skill renderer falls back to the catalog's own routing description.
 * @param file - absolute path of the playbook document.
 * @returns the playbooks by model id, empty when the document does not exist.
 * @throws PlaybookError when the document exists but is not a valid playbook map.
 */
export function loadPlaybooks(file: string = DEFAULT_PLAYBOOK_FILE): Map<string, ModelPlaybook> {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return new Map()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new PlaybookError(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PlaybookError(`${file} must contain a JSON object keyed by model id`)
  }
  const playbooks = new Map<string, ModelPlaybook>()
  for (const [modelId, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new PlaybookError(`${file}: playbook for "${modelId}" must be an object`)
    }
    const record = raw as Record<string, unknown>
    const playbook: Record<string, readonly string[]> = {}
    for (const field of STRING_ARRAY_FIELDS) {
      const value = record[field] ?? []
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        throw new PlaybookError(`${file}: playbook "${modelId}" field "${field}" must be an array of strings`)
      }
      playbook[field] = value as string[]
    }
    playbooks.set(modelId, playbook as unknown as ModelPlaybook)
  }
  return playbooks
}
