/**
 * The host-side `tools_plan` discipline (NDL-02, NDL-03).
 *
 * The Needle extension implements the ENGINE half of the planning contract: one-shot
 * proposals over a caller-supplied tool list, with the list validated by the extension
 * itself. What NDL-02 forbids is the HOST trusting that caller-supplied list. The list is
 * the authorization surface: whatever schemas the planner receives, it may propose calls
 * against, and a caller who could hand over the whole registry — or a list of its own
 * invention — would be using `tools_plan` as a permission oracle. So the host owns four
 * things the extension never sees:
 *
 * 1. **The frozen snapshot.** At first use, the host captures the currently registered
 *    tool schemas (name, description, parameters — nothing executable) into a snapshot
 *    that is deep-copied and deep-frozen. Later registry changes cannot leak into it, and
 *    a holder of the snapshot cannot mutate it. The planner receives ONLY entries from
 *    this snapshot; it never receives the caller's declared tool list, an unfiltered
 *    registry, or anything callable (NDL-02's "narrow public broker").
 *
 * 2. **The requested-name gate.** The caller asks for names; the host intersects them
 *    with the LIVE registry. Unknown names (never registered, or withdrawn), excluded
 *    names (management and composition), duplicates, and live-but-unsnapshotted names are
 *    all REJECTED — the whole call fails with every rejection named, never a silently
 *    smaller offer set (the CODE-03 "reject rather than omit" discipline).
 *
 * 3. **Host-side re-validation.** When the provider returns proposals, the host
 *    re-validates every proposal against the SNAPSHOT schema, not the provider's own
 *    verdict. A proposal the engine fabricated outside the offered set, or arguments that
 *    violate the frozen schema, are moved to `rejected` with the violations named.
 *
 * 4. **Fresh policy checks.** A proposal is DATA; executing it goes through the registry's
 *    own admission later (NDL-03). The host still refuses to return a proposal whose tool
 *    is no longer registered — deactivated or withdrawn after the snapshot was captured —
 *    so a caller never receives a proposal for a tool that is not currently callable.
 *
 * Everything here is a pure function over plain data: the DSH context, the store and the
 * lifecycle stay in the host wiring, so the discipline is testable without mounting a
 * plugin and without the pinned engine artifacts.
 *
 * @module @try-works/dsh-model-as-tool/planning
 */

import { Ajv, type ValidateFunction } from 'ajv'
import { EXCLUDED_BINDINGS } from './ptc-authority.ts'

/**
 * The validator the proposal re-checks compile with.
 *
 * Deliberately NON-STRICT, matching the extension's own `checkArguments` policy: the
 * snapshot entries come from the DSH registry's model-facing projection, which may omit
 * keywords a strict compiler refuses (`additionalProperties` in particular), and a
 * caller-facing tool list must not be rejected because the registry's projection is not
 * strict-authored. The strict compiler stays for DECLARED schemas, which are authored
 * under the contracts package's own discipline.
 */
const PROPOSAL_AJV = new Ajv({ allErrors: true, strict: false })

/** The caller-facing name of the planning contract (NDL-02). */
export const PLANNING_TOOL_NAME = 'tools_plan'

/**
 * Tool names the planning surface must never offer or propose (NDL-02 + CODE-07).
 *
 * The program-binding exclusions are reused rather than restated: a proposal targeting
 * `tool_mode_run` (the recursive composition door) or the management surface would hand a
 * caller the same proxy grant CODE-07 withholds from programs. `tools_plan` itself is
 * added so a plan can never propose planning — recursive planning is noise, and the
 * planning tool is not a leaf inference tool.
 *
 * SEALED like {@link EXCLUDED_BINDINGS} — a frozen ARRAY, because freezing a `Set` does
 * not stop `add`/`delete` — so the planning surface and the program-binding surface
 * cannot desynchronize through a runtime mutation.
 */
export const PLANNING_EXCLUDED_TOOLS = Object.freeze([...EXCLUDED_BINDINGS, PLANNING_TOOL_NAME])

/** The registry view a tool schema is captured from (the DSH `ToolSchema` projection). */
export interface RegistryToolSchema {
  readonly name: string
  readonly description: string
  /** The model-facing JSON Schema of the arguments. */
  readonly parameters: Readonly<Record<string, unknown>>
}

/** One frozen entry in the snapshot. */
export interface SnapshotTool {
  readonly name: string
  readonly description: string
  /** Deep-frozen: the snapshot is data nobody can edit after capture. */
  readonly parameters: Readonly<Record<string, unknown>>
}

/** The frozen host-approved schema snapshot (NDL-02). */
export interface ToolSchemaSnapshot {
  /** The catalog generation at capture, so a snapshot is attributable. */
  readonly generation: number
  /** Frozen entries, keyed by name. */
  readonly tools: ReadonlyMap<string, SnapshotTool>
}

/**
 * Deep-copy a JSON value, guarding against cycles.
 *
 * Hand-rolled rather than `structuredClone` so the module stays independent of which
 * global typings a build resolves, and so a cyclic schema cannot recurse forever.
 * @param value - the value to copy.
 * @param seen - objects already copied, keyed by source.
 * @returns the copy.
 */
function deepClone(value: unknown, seen: Map<object, unknown>): unknown {
  if (value === null || typeof value !== 'object') return value
  const existing = seen.get(value)
  if (existing !== undefined) return existing
  if (Array.isArray(value)) {
    const out: unknown[] = []
    seen.set(value, out)
    for (const item of value) out.push(deepClone(item, seen))
    return out
  }
  const out: Record<string, unknown> = {}
  seen.set(value, out)
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = deepClone(child, seen)
  }
  return out
}

/**
 * Freeze a value transitively, guarding against cycles.
 * @param value - the value to freeze.
 * @param seen - objects already visited, so a cyclic schema cannot recurse forever.
 */
function deepFreeze(value: unknown, seen: Set<object>): void {
  if (value === null || typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen)
  Object.freeze(value)
}

/**
 * Capture the frozen host-approved tool schema snapshot (NDL-02).
 *
 * The capture is a DEEP COPY: mutating the registry afterwards — registering a tool,
 * withdrawing one, changing a description — cannot change the snapshot, and mutating the
 * snapshot is refused by the runtime because every node is frozen. Excluded names are
 * skipped rather than captured-then-filtered, so a management tool's schema never enters
 * the snapshot at all.
 *
 * An empty description is replaced with a stated placeholder rather than captured empty:
 * the planner-side input contract requires a non-empty description, and a capture that
 * guaranteed a later refusal would freeze a call failure into the snapshot.
 * @param schemas - the registry view at capture time.
 * @param options - the generation, and optionally the excluded names (defaults to
 *   {@link PLANNING_EXCLUDED_TOOLS}).
 * @returns the frozen snapshot.
 */
export function captureToolSchemaSnapshot(
  schemas: readonly RegistryToolSchema[],
  options: { readonly generation: number; readonly excluded?: readonly string[] },
): ToolSchemaSnapshot {
  const excluded = options.excluded ?? PLANNING_EXCLUDED_TOOLS
  const tools = new Map<string, SnapshotTool>()
  for (const schema of schemas) {
    if (excluded.includes(schema.name)) continue
    if (typeof schema.parameters !== 'object' || schema.parameters === null || Array.isArray(schema.parameters)) {
      // A tool whose parameters cannot be described as JSON Schema cannot be planned
      // against; capturing it would hand the planner an entry it cannot use.
      continue
    }
    const description = typeof schema.description === 'string' && schema.description.trim().length > 0
      ? schema.description
      : 'No host description is declared for this tool.'
    const entry: SnapshotTool = {
      name: schema.name,
      description,
      // deepClone, then freeze: the snapshot must share NO structure with the
      // registry's live objects, or a later registry edit would reach a caller.
      parameters: deepClone(schema.parameters as Record<string, unknown>, new Map()) as Record<string, unknown>,
    }
    deepFreeze(entry.parameters, new Set())
    deepFreeze(entry, new Set())
    tools.set(schema.name, entry)
  }
  // The OUTER record is frozen too: "the snapshot is frozen" must include the
  // container a caller holds, not only the entries inside it (the map is frozen
  // below via the same walk, and the record itself last).
  const snapshot: ToolSchemaSnapshot = { generation: options.generation, tools }
  deepFreeze(snapshot, new Set())
  return snapshot
}

/** Why one requested name was refused. */
export interface PlanningRejection {
  readonly name: string
  readonly reason: 'duplicate' | 'excluded' | 'unknown' | 'not-in-snapshot'
  /** What the caller can do about it. */
  readonly remedy: string
}

/** The outcome of the requested-name gate. */
export type PlanningDecision =
  | { readonly ok: true; readonly offered: readonly SnapshotTool[] }
  | { readonly ok: false; readonly rejections: readonly PlanningRejection[] }

/**
 * Intersect the requested names with the live registry and the frozen snapshot (NDL-02).
 *
 * All-or-nothing, mirroring the CODE-03 bindings gate: if ANY requested name is
 * unattainable the whole call is refused with every rejection named, because handing the
 * caller a smaller offer set than it asked for would produce a plan for a different
 * request than the one it stated.
 * @param snapshot - the frozen snapshot, the ONLY source of schemas.
 * @param requested - the names the caller asked to plan over.
 * @param liveLeaf - the leaf tool names currently registered, exclusions already applied.
 * @param excluded - the names refused by policy regardless of registration. Defaults to
 *   {@link PLANNING_EXCLUDED_TOOLS}.
 * @returns the offered entries, or every rejection.
 */
export function offerToolsFromSnapshot(
  snapshot: ToolSchemaSnapshot,
  requested: readonly string[],
  liveLeaf: ReadonlySet<string>,
  excluded: readonly string[] = PLANNING_EXCLUDED_TOOLS,
): PlanningDecision {
  const rejections: PlanningRejection[] = []
  const offered: SnapshotTool[] = []
  const seen = new Set<string>()
  for (const name of requested) {
    if (seen.has(name)) {
      rejections.push({
        name,
        reason: 'duplicate',
        remedy: 'Request each tool once; a repeated name makes the offered set ambiguous.',
      })
      continue
    }
    seen.add(name)
    if (excluded.includes(name)) {
      rejections.push({
        name,
        reason: 'excluded',
        remedy: `"${name}" is not a leaf tool a plan may target: management and composition bindings are excluded (CODE-07, NDL-02).`,
      })
      continue
    }
    if (!liveLeaf.has(name)) {
      rejections.push({
        name,
        reason: 'unknown',
        remedy: 'The tool is not currently registered; its owning extension may be deactivated, or the name may never have existed.',
      })
      continue
    }
    const entry = snapshot.tools.get(name)
    if (entry === undefined) {
      rejections.push({
        name,
        reason: 'not-in-snapshot',
        remedy: 'The tool is registered but was added after the frozen snapshot was captured, so no authorized schema exists for it.',
      })
      continue
    }
    offered.push(entry)
  }
  if (rejections.length > 0) return { ok: false, rejections }
  return { ok: true, offered }
}

/**
 * Describe a refused request for a caller (NDL-02).
 * @param rejections - the refusals.
 * @returns a readable summary naming every rejection and why.
 */
export function describePlanningRejections(rejections: readonly PlanningRejection[]): string {
  const lines = rejections.map(entry => `  ${entry.name}: ${entry.reason} — ${entry.remedy}`)
  return `tools_plan cannot offer the requested tools:\n${lines.join('\n')}`
}

/** One proposal record, normalized from the provider's payload. */
export interface ProposalEntry {
  readonly name: string
  readonly arguments: Record<string, unknown>
  readonly offered: boolean
  readonly valid: boolean
  readonly issues: readonly string[]
}

/** What a re-check pass produced. */
export interface RecheckOutcome {
  /** The payload with proposals that failed any re-check moved to `rejected`. */
  readonly payload: Record<string, unknown>
  /** Non-fatal notes naming what was moved; free of caller content. */
  readonly warnings: readonly string[]
}

/**
 * Raised when a provider returns a proposal record that is not proposal-shaped.
 *
 * The provider's declared output contract types every field and closes the record, so a
 * malformed entry is a PROVIDER DEFECT — and it is surfaced as one rather than silently
 * coerced. Coercing a non-object `arguments` into `{}` would present a record the
 * provider never produced as if the host had validated it, and dropping undeclared
 * fields would hide a contract violation the output validator should refuse.
 */
export class ProviderDefectError extends Error {
  override readonly name = 'ProviderDefectError'
}

/** The keys the declared proposal contract admits. */
const PROPOSAL_FIELDS = new Set(['name', 'arguments', 'offered', 'valid', 'issues'])

/**
 * Normalize one proposal record from the provider's payload, STRICTLY.
 *
 * Structural violations throw {@link ProviderDefectError}: a non-object record, a missing
 * or non-string name, non-object arguments, or undeclared fields. The typed fields the
 * declared output schema constrains (`offered`, `valid`, `issues`) are read tolerantly —
 * their types are enforced by the output validator that runs after the re-check.
 * @param raw - the record.
 * @returns the normalized entry.
 * @throws ProviderDefectError when the record is not proposal-shaped.
 */
function normalizeEntry(raw: unknown): ProposalEntry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ProviderDefectError('a provider returned a proposal record that is not an object')
  }
  const record = raw as Record<string, unknown>
  const extra = Object.keys(record).filter(key => !PROPOSAL_FIELDS.has(key))
  if (extra.length > 0) {
    throw new ProviderDefectError(
      `a provider returned a proposal record with undeclared field(s) ${extra.map(key => JSON.stringify(key)).join(', ')}`,
    )
  }
  if (typeof record.name !== 'string') {
    throw new ProviderDefectError('a provider returned a proposal record whose name is not a string')
  }
  const rawArguments = record.arguments
  if (typeof rawArguments !== 'object' || rawArguments === null || Array.isArray(rawArguments)) {
    throw new ProviderDefectError(
      `a provider returned a proposal record whose arguments are not an object (${JSON.stringify(rawArguments)})`,
    )
  }
  const issues = Array.isArray(record.issues)
    ? record.issues.filter((issue): issue is string => typeof issue === 'string').slice(0, 32)
    : []
  return {
    name: record.name,
    arguments: rawArguments as Record<string, unknown>,
    offered: record.offered === true,
    valid: record.valid === true,
    issues,
  }
}

/** A compiled argument validator over one snapshot entry's schema. */
type ArgumentValidator = (value: unknown) => readonly string[]

/**
 * Re-check the provider's proposals against the frozen snapshot, the per-call offered set
 * AND the live authorization state (NDL-02, NDL-03).
 *
 * The provider's own validation is not trusted here: it validated against the list the
 * HOST built, but the host still re-checks every proposal before it reaches a caller,
 * because a proposal is the one thing a caller will treat as authorized. Four checks:
 *
 * - the name must be IN the frozen snapshot (the engine cannot invent a plannable tool);
 * - the arguments must satisfy the SNAPSHOT's schema, compiled fresh per snapshot entry;
 * - the name must be in the OFFERED set for THIS call — a provider proposing a tool the
 *   caller never requested must not pass it through as valid, even when it is
 *   snapshotted, schema-valid and still registered;
 * - the tool must STILL BE AUTHORIZED right now (NDL-03): a tool deactivated, withdrawn
 *   or quarantined after capture fails the fresh policy check, and the proposal is
 *   refused rather than returned as if it were executable.
 *
 * A proposal failing any check is MOVED to `rejected` with the issues appended, and one
 * bounded warning per moved proposal is returned for the receipt and the meta envelope.
 * A proposal record that is not proposal-shaped throws {@link ProviderDefectError}: the
 * defect belongs to the provider, and silently repairing it would hide the violation.
 * @param snapshot - the frozen snapshot.
 * @param payload - the provider's result.
 * @param offeredNames - the names the HOST offered for this call.
 * @param isCurrentlyAuthorized - the live authorization predicate, read at re-check time;
 *   `true` admits, a string is the refusal reason.
 * @returns the amended payload and the warnings.
 */
export function recheckProposals(
  snapshot: ToolSchemaSnapshot,
  payload: Record<string, unknown>,
  offeredNames: ReadonlySet<string>,
  isCurrentlyAuthorized: (name: string) => true | string,
): RecheckOutcome {
  const warnings: string[] = []
  const compiled = new Map<string, ArgumentValidator>()

  /** Compile a snapshot entry's schema once; an uncompilable schema is an issue, not a crash. */
  const validatorFor = (entry: SnapshotTool): ArgumentValidator | undefined => {
    const cached = compiled.get(entry.name)
    if (cached !== undefined) return cached
    let validate: ValidateFunction
    try {
      validate = PROPOSAL_AJV.compile(entry.parameters as Record<string, unknown>)
    } catch {
      // Kept uncompiled: every proposal for this entry then carries the compile failure
      // as an issue instead of the host throwing mid-call.
      return undefined
    }
    const validator: ArgumentValidator = value => (validate(value) ? [] : [...(validate.errors ?? [])]
      .map(error => `${error.instancePath === '' ? '(root)' : error.instancePath} ${error.message ?? 'is invalid'}`))
    compiled.set(entry.name, validator)
    return validator
  }

  const rawProposals = Array.isArray(payload.proposals) ? payload.proposals : []
  const rawRejected = Array.isArray(payload.rejected) ? payload.rejected : []
  const kept: unknown[] = []
  const rejected: unknown[] = [...rawRejected]

  for (const raw of rawProposals) {
    const entry = normalizeEntry(raw)
    const hostIssues: string[] = []
    let offered = entry.offered
    const snapshotEntry = snapshot.tools.get(entry.name)
    if (snapshotEntry === undefined) {
      // A proposal outside the snapshot was never offered by the HOST, whatever the
      // provider believed: the host's offer set is the snapshot by construction.
      offered = false
      hostIssues.push(
        `the tool ${JSON.stringify(entry.name)} is not in the frozen host-approved snapshot`,
      )
    } else {
      const validate = validatorFor(snapshotEntry)
      if (validate === undefined) {
        hostIssues.push(
          `the frozen schema for ${JSON.stringify(entry.name)} does not compile, so no arguments can be validated`,
        )
      } else {
        hostIssues.push(...validate(entry.arguments))
      }
      if (hostIssues.length === 0 && !offeredNames.has(entry.name)) {
        // F6: the OFFERED set is per-call. A snapshotted, schema-valid, still-registered
        // proposal for a tool the caller never requested is still not a valid plan step:
        // the provider had no business proposing it this turn.
        offered = false
        hostIssues.push(
          `the tool ${JSON.stringify(entry.name)} was not offered for this turn`,
        )
      }
      if (hostIssues.length === 0) {
        const authorization = isCurrentlyAuthorized(entry.name)
        if (authorization !== true) {
          // NDL-03: fresh policy checks at execution time. The tool was authorized when the
          // snapshot froze, but it is not callable NOW — withdrawn, deactivated or
          // quarantined — so returning the proposal would present a tool that would fail
          // admission as a valid plan step.
          hostIssues.push(
            `the tool ${JSON.stringify(entry.name)} is no longer authorized: ${authorization}`,
          )
        }
      }
    }
    if (hostIssues.length === 0) {
      kept.push(entry)
      continue
    }
    // The bounded report shape: the provider's issues first, then the host's, capped at
    // the shipped schema's own 32-item bound rather than grown without limit.
    rejected.push({
      name: entry.name,
      arguments: entry.arguments,
      offered,
      valid: false,
      issues: [...entry.issues, ...hostIssues].slice(0, 32),
    })
    warnings.push(`the host refused the ${entry.name} proposal: ${hostIssues[0] ?? 'invalid'}`)
  }

  return {
    payload: { ...payload, proposals: kept, rejected },
    warnings,
  }
}

/**
 * The input the HOST advertises and validates for `tools_plan` (NDL-02).
 *
 * The caller names tools as STRINGS — a requested eligible subset, never a grant and
 * never full declarations. The extension's own shipped input schema (full tool objects)
 * remains its provider contract; the host is the broker that turns requested names into
 * snapshot entries, so a caller never supplies the schemas the planner reasons over.
 * Bounds mirror the shipped extension input, so the advertised surface and the transport
 * surface cannot admit different requests.
 */
export const PLANNING_TOOL_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['request', 'tools'],
  properties: {
    request: {
      type: 'string',
      minLength: 1,
      maxLength: 32_768,
      description: 'The user request the plan is derived from, verbatim.',
    },
    tools: {
      type: 'array',
      minItems: 1,
      maxItems: 64,
      description: 'The tool names to plan over. A requested eligible subset, never a grant; unknown or excluded names refuse the call.',
      items: { type: 'string', minLength: 1 },
    },
    system: {
      type: 'string',
      maxLength: 4_096,
      description: 'Session facts the model should assume: the date, the locale, the device.',
    },
    max_new_tokens: {
      type: 'integer',
      minimum: 16,
      maximum: 4_096,
      description: 'Response-token budget for the planner.',
    },
  },
} as const

/**
 * Whether a declared input schema has the planning shape (a `tools` array property).
 *
 * The NAME alone is not enough to treat a contribution as the planning contract: a
 * package that named a tool `tools_plan` without the planning input would otherwise be
 * served through the planning pipeline and fail in ways nobody could see. The name plus
 * the shape is the contract; the host refuses the name without the shape.
 * @param schema - the declared input schema.
 * @returns whether the schema declares an array-valued `tools` property.
 */
export function hasPlanningInputShape(schema: Readonly<Record<string, unknown>> | undefined): boolean {
  if (schema === undefined) return false
  const properties = schema.properties
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) return false
  const tools = (properties as Record<string, unknown>).tools
  if (typeof tools !== 'object' || tools === null || Array.isArray(tools)) return false
  const type = (tools as Record<string, unknown>).type
  return type === 'array' || (Array.isArray(type) && type.includes('array'))
}
