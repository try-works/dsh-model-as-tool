/**
 * Legacy enable/disable migration into the extension/tool world (BASE-09, BASE-10).
 *
 * The pre-extraction plugin persisted ONE unversioned document —
 * `<DSH_HOME>/model-as-tool/state.json` — holding two arrays of MODEL IDS:
 * `enabled` and `disabled`, with no version key, no provider selections and no
 * extension/tool identity (the host's legacy shape is
 * `packages/dsh-model-as-tool/src/state.ts`'s `PersistedState`). BASE-09's unmet
 * clause is that no table maps those choices into the new world, so an upgrade
 * either loses the operator's choices or guesses.
 *
 * This module is that table. Its rules follow BASE-10 verbatim:
 *
 * - A legacy DISABLE is a tool-level choice, preserved as an `enabled: false`
 *   tool selection — never an extension deactivation and never an install.
 * - A legacy ENABLE is NOT consent: it cannot install executable third-party
 *   code, run install scripts, widen exports or accept license obligations, so
 *   the choice is STAGED (reported) and the tool stays disabled until the
 *   operator enables it in the new world.
 * - Unresolved mappings — ids with no table row, providers with no mapping,
 *   asset ids with no model deployment — are REPORTED, never silently enabled.
 * - An id recorded as both enabled and disabled is a conflict; the DISABLE wins
 *   (fail closed).
 * - A choice already present in the new world's state is never overwritten: the
 *   newer world wins and the migration reports that it stood back.
 *
 * BASE-09's "preserve model IDs, selected providers, prepared-asset mappings and
 * disabled choices" maps onto this module as: the table carries the legacy model
 * id and its new extension/model identity (model IDs), `providers` carries
 * legacy-provider → implementation mappings (selected providers), `assetSet`
 * carries the new asset identity for durably recorded prepared-asset mappings,
 * and disabled choices become persisted tool selections. Prepared assets are
 * BORROWED assets under BASE-09: recording a mapping must not seize ownership,
 * authorize deletion, or claim the new deployment is prepared.
 *
 * The table is EXPLICIT (every row is written out, no glob or prefix rule) and
 * ORDERED (earlier rows are consulted first; today each legacy id appears in at
 * most one row, and the order is the order operators see in the report).
 *
 * @module @try-works/tool-mode-extension-sdk/install/migration
 */

import type { ExtensionState, ToolSelection } from './../state.ts'

/**
 * The on-disk state era this SDK writes (BASE-09's STATE_VERSION key).
 *
 * Bump it only when the persisted profile-state shape changes and a new
 * migration step is appended to `LEGACY_MODEL_MIGRATIONS`. A document carrying a
 * HIGHER number was written by a newer SDK and must be refused, not rewritten.
 */
export const STATE_VERSION = 1 as const

/**
 * The schema identifier stamped beside `stateVersion` (BASE-09's schemaVersion).
 *
 * `stateVersion` says which era the document is; `schemaVersion` says which
 * schema dialect wrote it, so a reader can tell "v1 from the pre-schema era"
 * from "v1 with the schemaVersion key" without a data migration.
 */
export const STATE_SCHEMA_VERSION = '1.0.0' as const

/** The legacy model-id era document, exactly as the old host persisted it. */
export interface LegacyModelState {
  /** Model ids the user turned on in the old world. */
  readonly enabled: readonly string[]
  /** Model ids the user turned off in the old world. */
  readonly disabled: readonly string[]
  /**
   * Provider selections recorded alongside the choices, when the source document
   * carried them: legacy model id → provider/implementation identifier. The old
   * host never wrote this key; the migration accepts it so a deployment whose
   * legacy document DID record picks migrates them instead of dropping them.
   */
  readonly providers?: Readonly<Record<string, string>>
  /** Assets prepared in the old world, recorded so their mapping survives. */
  readonly preparedAssets?: readonly string[]
}

/** One row of the explicit, ordered migration table (BASE-09). */
export interface LegacyModelMigration {
  /** The model id the old world persisted in `enabled`/`disabled`. */
  readonly legacyModelId: string
  /** The new-world extension package that owns the model/tool. */
  readonly extensionId: string
  /** The new-world model identity, when the tool is model-backed. */
  readonly modelId?: string
  /** The new-world asset set the legacy prepared asset corresponds to. */
  readonly assetSet?: string
  /** The standard contract the extension implements. */
  readonly contractId: string
  /** The tool name the choice maps onto in the new world. */
  readonly toolName: string
  /**
   * Legacy provider identifiers → new-world implementation ids. A recorded
   * provider outside this map is reported unresolved, never substituted.
   */
  readonly providers?: Readonly<Record<string, string>>
}

/**
 * The migration table (BASE-09, BASE-10).
 *
 * Rows are grounded in the repository's real extension manifests:
 * `extension-desert-ant-tongue` (`tool-mode/lang_detect`, implementation
 * `tongue-default`, asset set `tongue-bundled`), `extension-desert-ant-voz`
 * (`tool-mode/stt_transcribe`, implementation `voz-default`, asset set
 * `voz-weights`; BASE-03's opt-in `transcribe_audio` alias keeps its documented
 * legacy contract separately and is not re-introduced here), and
 * `extension-declarative-recipes` (`text.title`, implementation `text-title`,
 * model-less — BASE-13's recipe package).
 *
 * Legacy ids without a row (align, clear, clips, ear, emo, eye, face, gist,
 * moderator, redact, schemer, shapes, toxic, uhm, who — the old catalog's
 * remaining models, which the new release tool set does not ship) are reported
 * unresolved by construction: the table lookup simply misses.
 */
export const LEGACY_MODEL_MIGRATIONS: readonly LegacyModelMigration[] = [
  {
    legacyModelId: 'tongue',
    extensionId: '@try-works/extension-desert-ant-tongue',
    modelId: 'tongue',
    assetSet: 'tongue-bundled',
    contractId: 'tool-mode/lang_detect',
    toolName: 'lang_detect',
    providers: {
      tongue: 'tongue-default',
      '@desert-ant-labs/tongue': 'tongue-default',
    },
  },
  {
    legacyModelId: 'voz',
    extensionId: '@try-works/extension-desert-ant-voz',
    modelId: 'voz',
    assetSet: 'voz-weights',
    contractId: 'tool-mode/stt_transcribe',
    toolName: 'stt_transcribe',
    providers: {
      voz: 'voz-default',
      '@desert-ant-labs/voz': 'voz-default',
    },
  },
  {
    legacyModelId: 'title',
    extensionId: '@try-works/extension-declarative-recipes',
    contractId: 'text.title',
    toolName: 'text_title',
    providers: {
      title: 'text-title',
    },
  },
]

/** What one report entry is about. */
export type MigrationEntryKind = 'disabled-choice' | 'enabled-choice' | 'provider-selection' | 'prepared-asset'

/** What the migration did with one fact. */
export type MigrationOutcome =
  /** Mapped into the new state exactly (disabled choices, provider picks). */
  | 'preserved'
  /** Recorded but deliberately NOT granted (a legacy enable, per BASE-10). */
  | 'staged'
  /** The id sat in both lists; the DISABLE won (fail closed). */
  | 'conflicting'
  /** No table row / no provider mapping / no model deployment. Nothing enabled. */
  | 'unresolved'
  /** The prepared-asset mapping was recorded durably. */
  | 'mapped'
  /** The new world already carries a choice for this tool; it won untouched. */
  | 'existing-state-preserved'

/** One reported fact about the migration (BASE-10's "report unresolved mappings"). */
export interface MigrationEntry {
  readonly kind: MigrationEntryKind
  readonly outcome: MigrationOutcome
  readonly legacyModelId: string
  readonly extensionId?: string
  readonly modelId?: string
  readonly toolName?: string
  /** The implementation a preserved provider pick selected. */
  readonly selectedImplementation?: string
  readonly assetSet?: string
  /** Why the outcome is what it is; always present for non-preserved facts. */
  readonly reason?: string
}

/**
 * A durably recorded legacy prepared-asset → new deployment mapping (BASE-09).
 *
 * Recording it is NOT a claim that the new deployment is prepared: the new
 * world's asset pipeline differs from the old world's, and BASE-09 makes the old
 * assets borrowed. The mapping survives so a later preparation step can ask the
 * operator whether the borrowed bytes may be reused, instead of silently
 * re-downloading or silently claiming readiness.
 */
export interface MigratedAssetRecord {
  readonly legacyAssetId: string
  readonly extensionId: string
  readonly modelId?: string
  readonly assetSet?: string
}

/** The pure result of applying the table to one legacy document. */
export interface AppliedMigration {
  readonly extensions: readonly ExtensionState[]
  readonly entries: readonly MigrationEntry[]
  readonly migratedAssets: readonly MigratedAssetRecord[]
}

/** The report a store-level migration returns to the host. */
export interface MigrationReport {
  readonly profile: string
  /** Where the legacy document came from, for operator-facing logs. */
  readonly legacySource: string
  /** The legacy document carries no version key; null records that fact. */
  readonly fromStateVersion: null
  readonly toStateVersion: typeof STATE_VERSION
  readonly toSchemaVersion: string
  /** True when the profile already held current-version state; nothing changed. */
  readonly alreadyCurrent: boolean
  /** True when a versioned profile state file was written. */
  readonly wroteState: boolean
  /** Why nothing was written, when the migration was skipped. */
  readonly skippedReason?: string
  readonly entries: readonly MigrationEntry[]
}

/** The result of inspecting one legacy document. */
export interface LegacyParseResult {
  readonly state?: LegacyModelState
  readonly diagnostic?: string
}

/**
 * Recognize and normalize the legacy model-id era document.
 *
 * Detection is by SHAPE, not by which file it came from: an object holding
 * `enabled`/`disabled` string arrays (or neither) and no version key is the old
 * world's document. A document that already carries `stateVersion` or
 * `schemaVersion` is NOT legacy — it belongs to this world's versioned store.
 * @param raw - the decoded JSON value.
 * @param source - description of the origin, for messages.
 * @returns the legacy state, or a diagnostic explaining why it is not one.
 */
export function parseLegacyModelState(raw: unknown, source: string): LegacyParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { diagnostic: `${source} must be a JSON object` }
  }
  const record = raw as Record<string, unknown>
  if (record.stateVersion !== undefined || record.schemaVersion !== undefined) {
    return { diagnostic: `${source} already carries a version key; it is not a legacy model-id era document` }
  }
  const list = (key: string): string[] | undefined => {
    const value = record[key]
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
      return undefined
    }
    return value as string[]
  }
  const enabled = list('enabled')
  const disabled = list('disabled')
  if (record.enabled !== undefined && enabled === undefined) {
    return { diagnostic: `${source} field "enabled" must be an array of model ids` }
  }
  if (record.disabled !== undefined && disabled === undefined) {
    return { diagnostic: `${source} field "disabled" must be an array of model ids` }
  }
  let providers: Readonly<Record<string, string>> | undefined
  if (record.providers !== undefined) {
    const value = record.providers
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || Object.values(value as Record<string, unknown>).some(item => typeof item !== 'string')) {
      return { diagnostic: `${source} field "providers" must be an object mapping model ids to provider identifiers` }
    }
    providers = value as Readonly<Record<string, string>>
  }
  let preparedAssets: readonly string[] | undefined
  if (record.preparedAssets !== undefined) {
    const value = record.preparedAssets
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
      return { diagnostic: `${source} field "preparedAssets" must be an array of asset ids` }
    }
    preparedAssets = value as readonly string[]
  }
  return {
    state: {
      enabled: enabled ?? [],
      disabled: disabled ?? [],
      ...providers === undefined ? {} : { providers },
      ...preparedAssets === undefined ? {} : { preparedAssets },
    },
  }
}

/**
 * Apply the migration table to one legacy document (BASE-09, BASE-10).
 *
 * Pure: it maps facts to facts and never touches the filesystem, so the store
 * wraps it with locking and atomic writes, and tests can exercise every
 * disposition without a store.
 * @param legacy - the parsed legacy document.
 * @param existing - the new world's current profile state to merge into.
 * @param table - the migration table; defaults to `LEGACY_MODEL_MIGRATIONS`.
 * @returns the merged state, the report entries, and the durable asset mappings.
 */
export function applyLegacyChoices(
  legacy: LegacyModelState,
  existing: readonly ExtensionState[] = [],
  table: readonly LegacyModelMigration[] = LEGACY_MODEL_MIGRATIONS,
): AppliedMigration {
  const enabled = new Set(legacy.enabled)
  const disabled = new Set(legacy.disabled)
  const providers = legacy.providers ?? {}
  const preparedAssets = legacy.preparedAssets ?? []

  const extensions: ExtensionState[] = [...existing]
  const entries: MigrationEntry[] = []
  const migratedAssets: MigratedAssetRecord[] = []
  const indexOf = new Map<string, number>(extensions.map((state, index) => [state.extensionId, index]))

  /** The new-world identity of a table row, with exact-optional discipline. */
  const rowIdentity = (row: LegacyModelMigration) => ({
    extensionId: row.extensionId,
    ...row.modelId === undefined ? {} : { modelId: row.modelId },
    toolName: row.toolName,
  })

  // Iteration order is the report order: enabled first, then disabled, then
  // providers, then prepared assets. One id yields one report entry per fact.
  const legacyIds: string[] = []
  for (const id of [...enabled, ...disabled, ...Object.keys(providers), ...preparedAssets]) {
    if (!legacyIds.includes(id)) legacyIds.push(id)
  }

  for (const legacyModelId of legacyIds) {
    const row = table.find(candidate => candidate.legacyModelId === legacyModelId)
    const isEnabled = enabled.has(legacyModelId)
    const isDisabled = disabled.has(legacyModelId)
    const conflict = isEnabled && isDisabled
    const providerId = providers[legacyModelId]
    const assetPrepared = preparedAssets.includes(legacyModelId)

    if (row === undefined) {
      // No table row: REPORT, never enable (BASE-10's "report unresolved
      // mappings without enabling everything").
      if (isEnabled && !conflict) {
        entries.push({ kind: 'enabled-choice', outcome: 'unresolved', legacyModelId, reason: 'no migration table row for this legacy model id' })
      }
      if (isDisabled || conflict) {
        entries.push({
          kind: 'disabled-choice', outcome: 'unresolved', legacyModelId,
          reason: conflict
            ? 'the id appears in both lists and has no migration table row; nothing was enabled'
            : 'no migration table row for this legacy model id; the disabled choice cannot be attached to a tool',
        })
      }
      if (providerId !== undefined) {
        entries.push({ kind: 'provider-selection', outcome: 'unresolved', legacyModelId, reason: 'no migration table row for this legacy model id' })
      }
      if (assetPrepared) {
        entries.push({ kind: 'prepared-asset', outcome: 'unresolved', legacyModelId, reason: 'no migration table row for this legacy asset id' })
      }
      continue
    }

    const existingIndex = indexOf.get(row.extensionId)
    const existingState = existingIndex === undefined ? undefined : extensions[existingIndex]
    const existingTool = existingState?.tools.find(candidate => candidate.toolName === row.toolName)

    // Provider pick: a resolved pick rides on whichever tool selection the
    // choice yields, so it survives the operator re-enabling the tool later.
    // When the profile already carries a choice for this tool, the newer world
    // wins wholesale and the pick is reported as NOT applied.
    let selectedImplementation: string | undefined
    if (providerId !== undefined) {
      const mapped = row.providers?.[providerId]
      if (mapped !== undefined) {
        if (existingTool === undefined) selectedImplementation = mapped
        entries.push({
          kind: 'provider-selection',
          outcome: existingTool === undefined ? 'preserved' : 'existing-state-preserved',
          legacyModelId,
          ...rowIdentity(row),
          selectedImplementation: mapped,
          ...existingTool === undefined ? {} : {
            reason: 'the profile state already records a choice for this tool; the legacy provider pick was mapped but not applied',
          },
        })
      } else {
        entries.push({
          kind: 'provider-selection', outcome: 'unresolved', legacyModelId,
          extensionId: row.extensionId, toolName: row.toolName,
          reason: `the recorded provider ${JSON.stringify(providerId)} has no mapping for ${row.extensionId}; no implementation was substituted`,
        })
      }
    }

    if (existingTool !== undefined) {
      // The new world already carries a choice for this tool. The newer world
      // wins; the legacy fact is reported, not applied (BASE-11's spirit: never
      // silently overwrite an operator-pinned choice).
      if (isEnabled || isDisabled) {
        entries.push({
          kind: isEnabled ? 'enabled-choice' : 'disabled-choice',
          outcome: 'existing-state-preserved',
          legacyModelId,
          ...rowIdentity(row),
          reason: 'the profile state already records a choice for this tool; the legacy choice was not applied',
        })
        if (conflict) {
          entries.push({
            kind: 'enabled-choice', outcome: 'existing-state-preserved', legacyModelId,
            ...rowIdentity(row),
            reason: 'the legacy conflict was not resolved against an existing choice; the existing choice stands',
          })
        }
      }
    } else if (conflict || isDisabled || isEnabled || selectedImplementation !== undefined) {
      // BASE-10: a disable is preserved; an enable is staged; a conflict keeps
      // the disable. Every path produces a DISABLED tool — migration never
      // enables anything on its own. A RESOLVED PROVIDER PICK alone (an id
      // recorded only in `providers`) also creates the disabled selection:
      // BASE-09's "selected providers" preservation is only true if the pick is
      // durably attached to the tool it selects, so it survives the operator
      // enabling the tool later instead of living in the report alone.
      let tool: ToolSelection = { toolName: row.toolName, enabled: false }
      if (selectedImplementation !== undefined) tool = { ...tool, selectedImplementation }
      if (conflict) {
        entries.push({
          kind: 'enabled-choice', outcome: 'conflicting', legacyModelId,
          ...rowIdentity(row),
          reason: 'the id appears in both enabled and disabled; the disable won (fail closed)',
        })
        entries.push({
          kind: 'disabled-choice', outcome: 'preserved', legacyModelId,
          ...rowIdentity(row),
        })
      } else if (isDisabled) {
        entries.push({
          kind: 'disabled-choice', outcome: 'preserved', legacyModelId,
          ...rowIdentity(row),
        })
      } else if (isEnabled) {
        entries.push({
          kind: 'enabled-choice', outcome: 'staged', legacyModelId,
          ...rowIdentity(row),
          reason: 'a legacy enable is not consent to install, activate or prepare code (BASE-10); the choice is staged for the operator, not granted',
        })
      }
      if (existingState !== undefined) {
        extensions[existingIndex!] = { ...existingState, tools: [...existingState.tools, tool] }
      } else {
        // BASE-10: migrating a choice must NOT install or activate anything. The
        // entry exists only to carry the tool choice (and its provider pick)
        // until the operator acts in the new world.
        const state: ExtensionState = {
          extensionId: row.extensionId,
          installation: 'absent',
          desiredActivation: 'inactive',
          observedActivation: 'inactive',
          readiness: {},
          tools: [tool],
          export: 'not-exported',
        }
        indexOf.set(row.extensionId, extensions.length)
        extensions.push(state)
      }
    }

    if (assetPrepared) {
      if (row.modelId !== undefined) {
        migratedAssets.push({
          legacyAssetId: legacyModelId,
          extensionId: row.extensionId,
          modelId: row.modelId,
          ...row.assetSet === undefined ? {} : { assetSet: row.assetSet },
        })
        entries.push({
          kind: 'prepared-asset', outcome: 'mapped', legacyModelId,
          extensionId: row.extensionId, modelId: row.modelId,
          ...row.assetSet === undefined ? {} : { assetSet: row.assetSet },
          reason: 'the mapping is recorded; the borrowed asset is not seized and the new deployment is NOT claimed prepared (BASE-09)',
        })
      } else {
        entries.push({
          kind: 'prepared-asset', outcome: 'unresolved', legacyModelId,
          extensionId: row.extensionId, toolName: row.toolName,
          reason: 'the new world has no model deployment for this id; the prepared-asset mapping has nothing to attach to',
        })
      }
    }
  }

  return { extensions, entries, migratedAssets }
}
