/**
 * Durable install state: which models the user has enabled or disabled.
 *
 * A plugin's `config` states the *deployment* default — what a profile ships
 * with. This store records the *user's* runtime choices on top of it, so an
 * `enable`/`disable` survives a restart instead of evaporating with the session.
 *
 * The two layers are kept distinct on purpose:
 *
 * - `disabled` always wins, so a user can turn off something the config ships.
 * - `enabled` adds to the config selection, so a user can turn on something the
 *   config omitted without editing YAML.
 *
 * Writing to a file rather than back into the profile's `cordis.patch.yml` keeps
 * the plugin out of the user's configuration: a rewrite there would fight the
 * HMR reload and could clobber comments the user wrote.
 *
 * @module @try-works/dsh-model-as-tool/state
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** The persisted user choices. */
export interface PersistedState {
  /** Model ids the user turned on beyond the configured selection. */
  readonly enabled: readonly string[]
  /** Model ids the user turned off, overriding the configured selection. */
  readonly disabled: readonly string[]
}

/** An empty state. */
export const EMPTY_STATE: PersistedState = { enabled: [], disabled: [] }

/** Read and write the durable state. Injectable so tests need no filesystem. */
export interface StateStore {
  /** Read the current state; an absent or unreadable store is empty, not an error. */
  read(): PersistedState
  /** Replace the state, durably. */
  write(state: PersistedState): void
}

/** Raised when a state file exists but cannot be understood. */
export class StateError extends Error {
  override readonly name = 'StateError'
}

/**
 * Normalize a decoded state document.
 *
 * Unknown keys are dropped and non-string entries are rejected rather than
 * silently ignored: a corrupted list is a bug worth surfacing, while a
 * forward-compatible extra key is not.
 * @param raw - the decoded JSON value.
 * @param source - description of the origin, for messages.
 * @returns the normalized state.
 * @throws StateError when the document is not a valid state.
 */
export function parseState(raw: unknown, source: string): PersistedState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new StateError(`${source} must contain a JSON object`)
  }
  const record = raw as Record<string, unknown>
  const list = (key: string): string[] => {
    const value = record[key] ?? []
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
      throw new StateError(`${source} field "${key}" must be an array of model ids`)
    }
    return value as string[]
  }
  return { enabled: list('enabled'), disabled: list('disabled') }
}

/**
 * Derive the default state file from the environment.
 *
 * DSH sets `DSH_HOME`; falling back to `~/.dsh` matches the launcher's own
 * convention for a process started without it.
 * @param env - the environment to read; defaults to the process environment.
 * @returns the absolute path of the state file.
 */
export function defaultStateFile(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME.length > 0
    ? env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'model-as-tool', 'state.json')
}

/**
 * Build a file-backed store.
 *
 * Writes go through a temporary file and a rename, so a crash mid-write leaves
 * the previous state intact rather than a truncated document that would read as
 * "everything the user configured is gone".
 * @param file - absolute path of the state file.
 * @returns the store.
 */
export function createFileStateStore(file: string): StateStore {
  return {
    read() {
      let text: string
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        // No file yet is the normal first-run case.
        return EMPTY_STATE
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch (error) {
        throw new StateError(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
      return parseState(parsed, file)
    },
    write(state) {
      const normalized: PersistedState = {
        enabled: [...new Set(state.enabled)].sort(),
        disabled: [...new Set(state.disabled)].sort(),
      }
      mkdirSync(dirname(file), { recursive: true })
      const temporary = `${file}.tmp`
      writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
      try {
        renameSync(temporary, file)
      } catch (error) {
        rmSync(temporary, { force: true })
        throw new StateError(`cannot write ${file}: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}

/**
 * Build an in-memory store, for tests and for deployments that asked for no
 * persistence.
 * @param initial - the starting state.
 * @returns the store.
 */
export function createMemoryStateStore(initial: PersistedState = EMPTY_STATE): StateStore {
  let current = initial
  return {
    read: () => current,
    write: (state) => { current = state },
  }
}

/**
 * Apply one enable/disable choice to a state.
 *
 * The two lists are kept mutually exclusive so the merge rule never has to
 * break a tie: enabling a model removes it from `disabled` and vice versa.
 * @param state - the current state.
 * @param modelId - the model the user acted on.
 * @param enabled - true to turn on, false to turn off.
 * @returns the updated state.
 */
export function withChoice(state: PersistedState, modelId: string, enabled: boolean): PersistedState {
  const without = (list: readonly string[]): string[] => list.filter(id => id !== modelId)
  return enabled
    ? { enabled: [...without(state.enabled), modelId], disabled: without(state.disabled) }
    : { enabled: without(state.enabled), disabled: [...without(state.disabled), modelId] }
}

/**
 * Decide the effective installed set from the configured selection and the
 * user's persisted choices.
 * @param configured - model ids the config selects (already intersected with what can run).
 * @param state - the persisted user choices.
 * @returns the model ids to install, and those the user turned off.
 */
export function resolveSelection(
  configured: readonly string[],
  state: PersistedState,
): { install: Set<string>; disabled: Set<string> } {
  const disabled = new Set(state.disabled)
  const install = new Set(configured)
  for (const id of state.enabled) install.add(id)
  for (const id of disabled) install.delete(id)
  return { install, disabled }
}
