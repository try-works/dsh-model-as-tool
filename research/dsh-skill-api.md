# DSH Skill API — how a Cordis plugin registers and provides skills

Reference for writing a DSH plugin that publishes skills programmatically at runtime.
All claims cite the real DSH checkout at `D:\deepseek-harness\`. Where something does not
exist, that is stated explicitly.

Package under study: `@deepseek-ai/dsh-skill` (dir `packages/skill/skill/`), version
`0.2.0-rc.2` (`packages/skill/skill/package.json:4`), whose only export is the registry
service (`package.json:16-23` → `lib/index.js` / `lib/types/index.d.ts`).

---

## 1. Service & methods

### Service class and key

- Class: **`SkillRegistry`**, declared `export class SkillRegistry extends Service`
  (`packages/skill/skill/src/index.ts:356`) and re-exported as the package default
  (`src/index.ts:868`: `export default SkillRegistry`).
- Service key: **`'skills'`**, bound in the constructor: `super(ctx, 'skills')`
  (`src/index.ts:374`). So consumers use `ctx.skills`.
- Config schema: `static Config: Schema<Config>` with a single field
  `collectCacheMaxEntries` (default `128`) (`src/index.ts:22`, `357-359`).

### Public methods — exact signatures

From `packages/skill/skill/src/index.ts` (identical in the emitted
`packages/skill/skill/lib/types/index.d.ts:225-296`):

```ts
// src/index.ts:390
registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void

// src/index.ts:439
register(skill: SkillRegistration): () => void

// src/index.ts:470
async list(options: SkillViewOptions = {}): Promise<SkillSummary[]>

// src/index.ts:481
async snapshot(options: SkillViewOptions = {}): Promise<SkillCatalogSnapshot>

// src/index.ts:500
async get(name: string, options: SkillViewOptions = {}): Promise<SkillDefinition | undefined>
```

There are **no other public methods**. Everything else on the class is `private`
(`collect`, `collectFresh`, `collectLayer`, `listLayerCandidates`, `invalidateCache`,
`invalidateEntry`, `scopeId`, `collectCacheKey`, `notifyChange` —
`lib/types/index.d.ts:285-295`). There is no `unregister`, no `has`, no `remove`.

### Semantics that matter

**`registerProvider(create)`** — registers one borrowed same-process provider.
- `create` is a **synchronous** factory invoked immediately; it receives the
  registration-scoped `SkillProviderControl` and returns the provider (`src/index.ts:390-428`).
- Registration files into the layer of the **calling context's scope** (`layers.effect`
  → `scopeOf(ctx)`; `src/index.ts:411-423`). An unscoped context registers globally.
- Duplicate provider name **within one layer** throws
  (`src/index.ts:334-336`, `NamedEntries.insert` in
  `packages/core/scope/src/store.ts:43-54`).
- The name `'runtime'` is reserved and throws
  (`src/index.ts:24`, `406-408`).
- Returns the **exact Cordis effect disposer**; disposal unregisters the provider,
  aborts `control.signal`, and invalidates catalog caches (`src/index.ts:414-421`).
- Provider `list()` is awaited at read time; a rejection is logged, contained, and
  marks the observation incomplete (`src/index.ts:602-608`).

**`register(skill)`** — registers one in-memory "runtime" skill.
- Validates name/description/invocation eagerly and **throws** on failure
  (`validateRuntimeSkill`, `src/index.ts:741-745`): name must match
  `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` (`src/index.ts:21`), description must be non-empty,
  `invocation` (if given) must have both booleans.
- Defaults are resolved once: `invocation ?? { modelInvocable: true, userInvocable: true }`
  and `provider ?? 'runtime'` (`src/index.ts:447-451`).
- Same-name runtime entries **in one layer are first-wins**: the duplicate logs
  `ctx.logger.warn('runtime skill "<name>" ignored because it is already registered')`
  and gets a **no-op disposer** so it cannot remove the winner (`src/index.ts:442-446`).
- Runtime candidates carry `rank = RUNTIME_RANK = 250` (`src/index.ts:25`, `691-705`),
  and the registry injects them through the internal pseudo-provider whose
  `providerOrder` is `-1` — i.e. runtime entries precede providers within a layer
  (`src/index.ts:588-598`).
- Returns the exact Cordis effect disposer; disposal deletes the entry and invalidates
  caches (`src/index.ts:452-459`).

**`list(options)`** — `(await this.snapshot(options)).skills` (`src/index.ts:470-472`).
Summaries are **sorted by name** (`compareSkillSummary`, `src/index.ts:797-799`).

**`snapshot(options)`** — returns `{ skills, complete }`. `complete` is `false` when any
provider failed, returned an explicitly incomplete observation, or the catalog revision
changed mid-read; **incomplete observations are never cached**
(`src/index.ts:481-489`, `531-548`).

**`get(name, options)`** — returns the full definition, or `undefined`.
- Returns `undefined` immediately for a non-kebab-case name (no throw)
  (`src/index.ts:501`).
- Selects the winning candidate, calls the owning provider's `get(candidate, options)`,
  re-validates the definition, and rejects a definition whose `name` no longer matches
  the candidate (invalidating that entry) (`src/index.ts:500-517`).
- Definitions are **never cached**; every call re-loads (`README.md:99`).

### Related event

`skills/change` — `emit` mode, no payload. Dispatched on every cache invalidation
(`src/index.ts:288-297`, `648-659`). Listeners cannot veto the mutation; failures are
contained and logged.

---

## 2. Types

All from `packages/skill/skill/src/index.ts`; line numbers are the source declarations.

```ts
// src/index.ts:35-37
export function isSkillName(name: string): boolean   // /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// src/index.ts:40
export type SkillSource =
  | 'project-dsh' | 'project-agents' | 'runtime'
  | 'user-dsh' | 'user-agents' | 'custom' | 'bundled'
  | (string & {})

// src/index.ts:43-46
export type SkillResourceBase =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'opaque'; readonly description: string }

// src/index.ts:49-54
export interface SkillInvocationPolicy {
  readonly modelInvocable: boolean   // model-facing catalogs/loaders
  readonly userInvocable: boolean    // human-facing command catalogs/loaders
}

// src/index.ts:57-74
export interface SkillSummary {
  readonly path?: string             // absolute instruction file path; absent for virtual skills
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: SkillInvocationPolicy
  readonly source: SkillSource
  readonly provider: string
  readonly resourceBase?: SkillResourceBase
}

// src/index.ts:77-84
export interface SkillCandidate extends SkillSummary {
  readonly rank: number              // lower wins within a layer
  readonly locator: unknown          // opaque provider handle, handed back to provider.get()
  readonly metadata?: Readonly<Record<string, unknown>>
}

// src/index.ts:87-92
export interface SkillDefinition extends SkillSummary {
  readonly content: string           // markdown body
  readonly metadata?: Readonly<Record<string, unknown>>
}

// src/index.ts:95-100
export type SkillRegistration = Omit<SkillDefinition, 'invocation' | 'provider'> & {
  readonly invocation?: SkillInvocationPolicy
  readonly provider?: string
}

// src/index.ts:103-108
export interface SkillLookupOptions {
  readonly cwd?: string | undefined
  readonly signal?: AbortSignal | undefined
}

// src/index.ts:116-119
export interface SkillViewOptions extends SkillLookupOptions {
  readonly scope?: ScopeKey | undefined   // ScopeKey = object (packages/core/scope/src/index.ts:15)
}

// src/index.ts:231-236
export interface SkillCatalogSnapshot {
  readonly skills: SkillSummary[]
  readonly complete: boolean
}
```

### Invocation helpers

```ts
// src/index.ts:126-128
export function isModelInvocable(skill: Pick<SkillSummary, 'invocation'>): boolean
//   => skill.invocation.modelInvocable

// src/index.ts:135-137
export function isUserInvocable(skill: Pick<SkillSummary, 'invocation'>): boolean
//   => skill.invocation.userInvocable
```

Both take **any object carrying `invocation`** — summary, candidate or definition alike.
They are pure reads and never throw. The registry itself never filters by policy; each
consumer applies it at its own boundary (`README.md:55`, `docs/subsystems/skills.md:128`).
The four combinations are all preserved; setting both `false` leaves the skill reachable
only through direct trusted `ctx.skills.get()` calls.

### Rendering helpers

```ts
// src/index.ts:170-183
export function renderSkillContent(
  skill: Pick<SkillDefinition, 'name' | 'provider' | 'resourceBase' | 'content'>,
): string

// src/index.ts:226-228
export function escapeText(value: string): string
//   => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
```

`renderSkillContent` emits the canonical block the `skill` tool result and the
user-invocation injection both use (`src/index.ts:166-183`, `tool-skill/src/index.ts:125`):

```
<skill_content name="<escaped name>">
<skill_resources>
<resource hint lines, provider-dependent>
</skill_resources>

<skill_instructions>
<content verbatim>
</skill_instructions>
</skill_content>
```

The `name` attribute goes through a private `escapeAttr` (also escapes `"`); the body is
embedded **verbatim** — skills are treated as trusted local content
(`src/index.ts:166-168`, `216-218`). `renderResourceHint` (`src/index.ts:185-214`) produces
one of three shapes based on `resourceBase.kind`; **when `resourceBase` is absent** it
emits `Resources for this skill are managed by provider "<provider>".` — so virtual skills
with no base still render correctly.

There is **no `escapeAttr` export**; only `escapeText` is public.

### Constants

```ts
// src/index.ts:28
export const BUNDLED_SKILL_RANK = 600
```

`RUNTIME_PROVIDER = 'runtime'` and `RUNTIME_RANK = 250` are module-private
(`src/index.ts:24-25`), not exported.

---

## 3. Provider seam

**Yes — a first-class provider seam exists.** `ctx.skills` accepts providers that supply
skills dynamically; `register()` is the secondary "embed one literal skill" convenience.
(An Agent Note proposing removal of `register()` was **rejected**, precisely because
"Direct runtime skill registration is an intentional extension path for third-party
plugins" — `.agents/notes/rejected/simplification/2026-07-12-prune-unused-skill-registry-api.md:3`.)

### The provider interface

```ts
// src/index.ts:247-267
export interface SkillProvider {
  /** Unique provider name in the `ctx.skills` registry. */
  readonly name: string
  readonly list: (options: SkillLookupOptions) =>
    Promise<readonly SkillCandidate[] | SkillProviderObservation>
  readonly get: (candidate: SkillCandidate, options: SkillLookupOptions) =>
    Promise<SkillDefinition | undefined>
}

// src/index.ts:239-244
export interface SkillProviderObservation {
  readonly candidates: readonly SkillCandidate[]
  readonly complete: boolean
}

// src/index.ts:270-275
export interface SkillProviderControl {
  readonly signal: AbortSignal
  readonly invalidate: () => void
}
```

- `list()` returning a **plain array is complete-discovery shorthand**
  (`normalizeProviderObservation`, `src/index.ts:662-674`). Return
  `{ candidates, complete: false }` to expose directly-loadable skills from a degraded
  source without letting the result be cached.
- `get()` receives back the **exact `locator`** the provider put on the candidate; the
  registry never interprets it (`src/index.ts:261-266`, `142`).
- Provider objects, options objects and candidates are **borrowed readonly** — never
  mutate them.

### Registration mechanism

`ctx.skills.registerProvider((control) => provider)` — synchronous factory, returns the
Cordis effect disposer (`src/index.ts:390`). The factory's `control.invalidate()` clears
completed catalogs and emits `skills/change`, but **only while that exact registration is
still live** (a late callback cannot disturb a same-name replacement)
(`src/index.ts:394-402`, `627-631`). `control.signal` aborts on failed registration or
disposal.

### How the `provider` string on a skill is produced

Two ways, and they must agree:

1. **Providers** set it themselves on every candidate and definition. The registry then
   *enforces* the invariant: `candidate.provider` must equal `provider.name`, otherwise
   `validateCandidate` throws
   `skill provider "<p>" returned skill "<n>" for provider "<other>"` (`src/index.ts:730-735`).
   `skill-badge` shows the pattern: `const PROVIDER_NAME = 'dsh-badge'` used both as
   `provider:` on the candidate and as `name:` on the provider object
   (`packages/skill/skill-badge/src/index.ts:17`, `29`, `37`).
2. **Runtime registrations** get `'runtime'` unless the caller supplies `provider`
   (`src/index.ts:450`). The runtime pseudo-provider then returns the whole stored
   definition from `get()` (`src/index.ts:680-689`).

### How multiple providers are composed / layered

Two axes, both implemented in `SkillRegistry` over `ScopedLayers<SkillLayer>`
(`src/index.ts:362-365`; `packages/core/scope/src/store.ts:159-266`):

**Axis A — layers by scope.** `collectFresh` builds
`[layers.global, ...layers.chainLayers(options.scope)]` — global first, then the scope
chain farthest-ancestor-first with the exact scope last — and merges into one
`Map<name, IndexedCandidate>` by plain `set`, so **the nearest layer wins a duplicate name
outright, regardless of rank** (`src/index.ts:551-565`; test at
`src/skill.spec.ts:1142-1171`). Confirmed by test
`tests/skill.spec.ts:1165-1169`.

**Axis B — within one layer.** Candidates are sorted by
`rank → providerOrder → localOrder` (`compareIndexedCandidates`, `src/index.ts:807-811`)
and the first of each name wins; later same-name entries are dropped with the warning
`skill "<n>" from <source> ignored because a higher-priority skill already exists`
(`src/index.ts:569-581`). `providerOrder` is a service-wide monotonic counter assigned at
`registerProvider` time (`src/index.ts:409-410`); `localOrder` is the index inside one
provider's `list()` result (`src/index.ts:599-616`).

**Caching.** Completed collections are cached by `{cwd, scope-chain ids, revision}`
(`src/index.ts:643-645`) up to `collectCacheMaxEntries`; the map is FIFO-trimmed
(`src/index.ts:542-545`). An in-flight collection retries once when the revision changes
(`MAX_COLLECT_ATTEMPTS = 2`, `src/index.ts:23`, `533-539`).

**Shipped provider examples:**
- `skill-badge` — immutable single-skill provider, module-level candidate + provider,
  `ctx.skills.registerProvider(() => provider)` (`src/index.ts:25-59`).
- `skill-office` — three candidates, `BUNDLED_SKILL_RANK`, body read lazily in `get()`
  (`src/index.ts:76-96`).
- `skill-filesystem` — dynamic discovery, uses `control.invalidate()` from a watcher
  (`src/index.ts:45-46`, `133-147`, `170`).
- `sandbox-windows-acl` — registers inside a generator effect and yields the disposer:
  `yield ctx.skills.registerProvider(() => provider)` (`src/acl-skill.ts:74`).

---

## 4. Dependency declaration

### Plugin shape

A DSH plugin is an object/function with optional `inject` and `apply(ctx)` exports
(`docs/cordis-primer.md:9-11`). Real examples:

```ts
// packages/skill/skill-badge/src/index.ts:53-59
export const name = 'skill-badge'
export const inject = ['skills']
export function apply(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}
```

```ts
// packages/skill/skill-filesystem/src/index.ts:45-46
export const name = 'skill-filesystem'
export const inject = ['skills']
```

`inject` is **required**: without it the plugin may activate before the service exists.
The Cordis loader waits until every injected service is available.

For a `Service` subclass plugin (like `SkillRegistry` itself), the static form is used
instead: `AgentPresetRegistry` declares `static inject = ['loader', 'sessionProjections']`
(`packages/preset/agent-preset-registry/src/index.ts:52`). Both forms are equivalent.

### The real type augmentation

The declaration that makes `ctx.skills` typecheck comes from the skill package itself
(`packages/skill/skill/src/index.ts:283-298`; emitted at
`lib/types/index.d.ts:199-213`):

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    skills: SkillRegistry
  }

  interface Events {
    /**
     * A skill provider, runtime contribution, or provider-backed catalog may
     * have changed. This is an unfiltered invalidation notification; consumers
     * refetch the catalog for their own lookup options. Listener failures are
     * contained and cannot veto the registry mutation.
     * @mode emit
     */
    'skills/change'(): void
  }
}
```

**A plugin author does not write this augmentation.** It is published by
`@deepseek-ai/dsh-skill`, so a plugin only needs a **type-only import** to pull it in —
the established pattern in this repo is:

```ts
import type {} from '@deepseek-ai/dsh-skill'
```

used, for example, in `apps/cli/tests/web-agent-presets.e2e.ts:31`,
`apps/web/tests/scaffold-hermetic.e2e.ts:5`, `packages/api/session-controller/tests/session-skills.host.spec.ts:6`,
and `apps/cli/tests/fixtures/dsh-badge/snapshot.ts:6`.

The package also augments `@deepseek-ai/dsh-llm`'s `MessageSourceMap` with
`'skill-invocation'` (`src/index.ts:154-159`) — again, not something a provider author
writes.

If you *do* need to declare your own service, the same shape applies — see
`packages/core/agent/src/index.ts:27-31` (`agents: AgentRegistry`) and
`packages/preset/agent-preset-registry/src/index.ts:24-28` (`agentPresets`).

---

## 5. Scoping

### Are skills scoped? Yes — scoped by *registration context*, viewed by explicit *scope key*.

The registry is "host+per-scope layered, the shape the tools registry established"
(`README.md:84`). The primitive lives in `@deepseek-ai/dsh-scope`
(`packages/core/scope/`, re-exported/used at `src/index.ts:16-17`).

**Where scoping is enacted — inside `ctx.skills` itself, not a separate scope service:**

- `SkillLayer implements ScopeLayer` holds `providers: NamedEntries<RegisteredProvider>`
  and `runtime: Map<string, SkillDefinition>` for one scope
  (`src/index.ts:327-343`).
- `ScopedLayers<SkillLayer>` owns `global` plus a `Map<ScopeKey, SkillLayer>`
  (`src/index.ts:362`); registrations go through `layers.effect(this.ctx, ...)`, which
  reads `scopeOf(ctx)` (`packages/core/scope/src/store.ts:226-266`).
- `ctx.skills.**register***` derives the layer from the **calling** context's scope
  (`scopeOf(this.ctx)`, `src/index.ts:441`, and the `ScopedLayers.effect` path for
  providers). Reads never create a layer (`store.ts:180-183`).

The mechanism that makes `this.ctx` mean "the calling context" is Cordis's traceable
service proxy: a service property access through a child context re-binds the service's
`ctx` property to that caller (`vendor/cordis/lib/index.js:105-160`; `Service.ctx` is the
tracked property, `lib/index.js:1774-1781`).

**Where scope keys come from:**
- Every live Agent gets one: `this.scope = createScope(loopCtx, this)` in the AgentLoop
  constructor, so `Agent` itself is the `ScopeKey` (`packages/core/agent-loop/src/agent.ts:130-131`;
  the note at `src/index.ts:212-213`). `scopeOf(agent.ctx)` returns the agent.
- Agent presets get a standing scope: `const key = {}; const scope = createScope(this.owner, key)`
  and agent scopes are parented to it via
  `bindScopeParent(key, generation.key)` (`packages/preset/agent-preset-registry/src/index.ts:103-104`, `242`).
- `createScope(ctx, key, options?)` returns `{ ctx, rawDispose, dispose }`
  (`packages/core/scope/src/index.ts:105-147`); `scopeOf(ctx)` reads the tag
  (`index.ts:154-156`); `scopeChainOf(key)` walks parents nearest-first
  (`index.ts:98-102`).

### Registering for ALL agents vs ONE agent

**All agents (global layer):** call `register` / `registerProvider` through any
**unscoped** context — an ordinary plugin `apply(ctx)` context. `scopeOf(ctx) === undefined`
→ `layers.global` (`src/index.ts:441-442`, `store.ts:236-237`).

**One agent (that agent's layer):** register through the scoped context —
`agentCtx.skills.register(...)` inside `setup(agentCtx, agent)`
(`AgentSetup`, `packages/core/agent/src/index.ts:51-54`), or the equivalent
`createScope(ctx, agent).ctx.skills.register(...)`. Because the *registration origin*
decides both visibility and cleanup, the contribution lives exactly as long as that
agent's scope (`packages/core/scope/src/index.ts:105-147`;
`.agents/notes/implemented/architecture/2026-07-08-agent-scope-contexts.md:52-61`).

**Preset-wide (one preset, all its agents):** register through the preset's standing
scope; agents bound to it inherit it along the scope chain (nearest layer wins).

### The critical asymmetry: writes infer scope, reads require it

`register()`/`registerProvider()` **infer** the scope from the calling context.
`list()`/`snapshot()`/`get()` do **not** — they take an explicit `scope` in
`SkillViewOptions`, and **omitting it reads the global layer alone**
(`src/index.ts:116-119`, `1226-1232` test: a preset runtime skill is invisible to a
global lookup). The model-facing tool passes the agent explicitly:

```ts
// packages/skill/tool-skill/src/index.ts:133
const lookup = { cwd: exec.agent?.session.header.cwd, signal: exec.signal, scope: exec.agent }
```

`cwd` is also scope-adjacent: it selects which project roots a *provider* scans
(`skill-filesystem` resolves project roots from it) but it does not affect layering.

**This is the same convention `ctx.tools` uses**: `ctx.tools.get(name, scope?)`
(`packages/core/tools/src/index.ts:1230`) is scope-aware by argument, while
`ctx.tools.register(definition)` files into the caller's scope
(`packages/core/tools/src/index.ts:1063`, `976`).

---

## 6. Worked example

Based on the real, shipped `skill-badge` plugin
(`packages/skill/skill-badge/src/index.ts:1-60`) — the smallest complete real provider in
the repo. This is the *provider* shape; the `register()` shape follows.

### (a) Provider plugin (recommended — matches every shipped skill)

```ts
/**
 * Publishes one in-memory skill through the ctx.skills provider seam.
 * @module my-skill-plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'

const PROVIDER_NAME = 'my-skill-plugin'
const INVOCATION = { modelInvocable: true, userInvocable: true } as const

const CANDIDATE: SkillCandidate = {
  name: 'my-skill',                       // must match /^[a-z0-9]+(?:-[a-z0-9]+)*$/
  description: 'One sentence telling the model when to load this skill.',
  invocation: INVOCATION,
  provider: PROVIDER_NAME,                // MUST equal provider.name or the registry throws
  source: 'bundled',
  rank: BUNDLED_SKILL_RANK,               // 600; lower rank wins within a layer
  resourceBase: { kind: 'opaque', description: 'Supplied by my-skill-plugin.' },
  locator: { body: 'The markdown instructions the model receives.' },
}

const provider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get(candidate: SkillCandidate, _options): Promise<SkillDefinition> {
    return {
      name: candidate.name,
      description: candidate.description,
      invocation: candidate.invocation,
      provider: candidate.provider,
      source: candidate.source,
      resourceBase: candidate.resourceBase,
      content: (candidate.locator as { body: string }).body,
    }
  },
}

/** Cordis plugin name. */
export const name = 'my-skill-plugin'
/** Service required by the provider. */
export const inject = ['skills']

/** Register the provider on ctx.skills. */
export function apply(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}
```

`import type {} from '@deepseek-ai/dsh-skill'` is not needed here because the value/type
import above already pulls in the module augmentation (§4).

### (b) Single embedded skill, no provider

```ts
export const name = 'my-skill-plugin'
export const inject = ['skills']

export function apply(ctx: Context): void {
  ctx.skills.register({
    name: 'my-skill',
    description: 'One sentence telling the model when to load this skill.',
    whenToUse: 'Optional extra routing guidance.',
    source: 'runtime',
    // invocation omitted => { modelInvocable: true, userInvocable: true }
    // provider omitted   => 'runtime'
    content: 'The markdown instructions the model receives.',
  })
}
```

Real call sites of exactly this shape: `packages/skill/skill/tests/skill.spec.ts:484-490`
and `packages/skill/tool-skill/tests/tool-skill.spec.ts:197`.

### (c) Agent-scoped variant

The only change is *which context you call through*:

```ts
// inside an AgentSetup callback: setup(agentCtx, agent)
agentCtx.skills.register({
  name: 'reviewer-only',
  description: 'Available to this agent alone.',
  source: 'runtime',
  content: '...',
})
// A global lookup (no `scope`) will NOT see it.
// ctx.skills.list({ scope: agent }) WILL see it.
```

Verified by the shipped test `lets the nearest layer win a duplicate name regardless of
rank` (`packages/skill/skill/tests/skill.spec.ts:1142-1171`) and by
`packages/skill/skill/tests/skill.spec.ts:1213-1234` (preset-scoped runtime skill shadows
a global one; a second same-name registration in the same layer is ignored with a warning)
and `:1236-1249` (disposal removes it from the scope view and emits `skills/change`).

### Gotchas checklist

1. `inject = ['skills']` is mandatory — otherwise `ctx.skills` is `undefined`.
2. `candidate.provider` **must** equal `provider.name`, and `provider.name` must be
   unique **per layer** — the same provider name in two scopes is legal, twice in one
   layer throws.
3. `'runtime'` is a **reserved** provider name; `registerProvider` throws on it.
4. `register()` throws synchronously on a bad name or an empty description; `get()` with
   a bad name returns `undefined` instead.
5. Same-name runtime registrations in one layer are **first-wins with a warning** and
   return a **no-op disposer** — disposing the loser silently does nothing.
6. Runtime skills sit at rank **250**; a provider candidate at project rank 100 or 200
   in the same layer beats them. Across layers, the *nearer* layer wins regardless of rank.
7. `list()`/`get()` need an explicit `scope` to see agent/preset layers; omitting it reads
   only the global layer.
8. A provider `list()` that throws is contained and merely marks the snapshot
   `complete: false`; the *definition* mismatch path is what invalidates a cache entry.

---

## 7. Files read

Primary sources (full or targeted reads):

| File | What it gave |
|---|---|
| `packages/skill/skill/src/index.ts` | Service class, all signatures, types, provider contract, layering, validation (868 lines, read in full) |
| `packages/skill/skill/lib/types/index.d.ts` | Emitted declaration of the same surface (298 lines, read in full) |
| `packages/skill/skill/README.md` | Documented model, invocation policy table, limitations (151 lines, read in full) |
| `packages/skill/skill/package.json` | Package name, exports, peer deps |
| `packages/skill/skill-filesystem/src/index.ts` | Real dynamic provider, `inject`, `registerProvider`, `control.invalidate()` |
| `packages/skill/skill-badge/src/index.ts` | Minimal complete provider (60 lines, read in full) |
| `packages/skill/skill-office/src/index.ts` | Multi-skill bundled provider |
| `packages/skill/skill-badge/tests/skill-badge.spec.ts` | Observable register/dispose behavior |
| `packages/skill/skill/tests/skill.spec.ts` | Runtime registration, scoped layers, shadowing, disposal, invalidation |
| `packages/skill/tool-skill/src/index.ts` | Consumer side: `scope: exec.agent`, policy checks, rendering |
| `packages/skill/tool-skill/tests/tool-skill.spec.ts` | Real `register()` call shapes, agent scope minting |
| `packages/skill/tool-skill/README.md` | Consumer contract |
| `packages/skill/skill-filesystem/README.md` | Root ranks, frontmatter keys |
| `packages/sandbox/sandbox-windows-acl/src/acl-skill.ts` | Provider registered from inside a generator effect |
| `packages/preset/agent-preset/tests/skills.spec.ts` | `renderSkillContent` in real use |
| `packages/preset/agent-preset-registry/src/index.ts`, `src/mount.ts` | Standing preset scopes, `bindScopeParent` |
| `packages/core/scope/src/index.ts` | `ScopeKey`, `createScope`, `scopeOf`, `scopeChainOf`, `bindScopeParent` (204 lines, read in full) |
| `packages/core/scope/src/store.ts` | `ScopedLayers`, `NamedEntries`, `effect()` layer selection (267 lines, read in full) |
| `packages/core/agent/src/index.ts` | `AgentSetup`, `AgentSetupCommit` |
| `packages/core/agent-loop/src/agent.ts` | `createScope(loopCtx, this)` — the Agent *is* the scope key |
| `packages/core/tools/src/index.ts` | `tools.get(name, scope)`, `tools.register` comparison |
| `vendor/cordis/lib/types/service.d.ts`, `vendor/cordis/lib/index.js` | `Service` base class, `provide`, traceable proxy, `extend` |
| `docs/subsystems/skills.md` | Subsystem reference incl. generated Cordis surface (352 lines, read in full) |
| `docs/cordis-primer.md` | Plugin/inject/effect model |
| `.agents/notes/implemented/architecture/2026-07-08-agent-scope-contexts.md` | Agent-as-scope contract |
| `.agents/notes/rejected/simplification/2026-07-12-prune-unused-skill-registry-api.md` | Proof `register()` is a supported extension path |

### Things explicitly NOT found

- **No `unregister`, `remove`, `has`, `clear`, `refresh`, or `invalidate()` on
  `ctx.skills` itself.** Invalidation is provider-private via
  `SkillProviderControl.invalidate`, or implicit on registration/disposal.
- **No `escapeAttr` export** — only `escapeText` (`src/index.ts:226`).
- **No per-agent registration option** such as `register(skill, { agent })`. Scope is
  chosen entirely by *which context* the call goes through.
- **No exported `RUNTIME_PROVIDER` / `RUNTIME_RANK`** constants; only
  `BUNDLED_SKILL_RANK` is public.
- **No `SkillRegistry` subclass or interface seam for overriding merging** — layering,
  rank order and caching are private implementation.
- **No production in-repo caller of `ctx.skills.register()`.** Every shipped skill ships
  as a provider; `register()` is exercised only by tests and reserved as the third-party
  embedder path (see the rejected note above). Both paths are supported.
