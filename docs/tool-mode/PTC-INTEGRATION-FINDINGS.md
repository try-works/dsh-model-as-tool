# PTC Integration Findings

Read-only investigation, 2026-10-14. Scope: does `@deepseek-ai/dsh-ptc-runtime` exist and can this
repository integrate it; can slice 2 ("real composition runtime") run locally.

Everything below was verified by reading files or executing read-only commands on this host. Where
something could not be verified it is listed under **What is uncertain** rather than inferred.

---

## Summary

- **PTC integration is possible in-repo today, partially.** Both real packages exist as fully built
  source in the DSH checkout at `D:\deepseek-harness\packages\ptc-runtime\`: the abstract seam
  `@deepseek-ai/dsh-ptc-runtime` **0.2.0-rc.2** and the Node backend
  `@deepseek-ai/dsh-ptc-runtime-node` **0.2.0-rc.2**. Neither is a stub; both have built `lib/`.
- **Slice 2 runs locally, verified end-to-end.** I mounted the *real* DSH Node PTC backend with its
  composed dependencies (`fs`, `subprocess`, `sandbox`, `sandboxPolicy`) and ran a program that made
  two deterministic fixture calls through a branch. Result:
  `{"logs":["first 42"],"value":{"first":42,"second":84},"sandbox":{"mode":"danger-full-access","denied":false}}`.
  A cancellation probe returned `{"error":{"kind":"abort","message":"probe cancellation"}}` in 1061 ms.
  No model weights, no fake executor.
- **This repo contains zero PTC code today.** `packages/dsh-model-as-tool/src/**` has no occurrence of
  `ptc`, `Ptc`, `PTC`, `run_code` or `runCode`. `ctx.ptcRuntime` is never read.
- **The single most important blocker is module resolution, not capability.** The abstract runtime is
  already linked into this repo's `node_modules` (as a peer) but **nothing imports it**, and the Node
  backend is **not resolvable** from this repo (`ERR_MODULE_NOT_FOUND`), nor from
  `C:\Users\erikb\.dsh\profiles` (the installed-DSH root). A naive `ctx.plugin(NodePtcRuntime)` would
  additionally throw if the host already provides `ptcRuntime` — which the DSH base bundle does.

---

## Packages found

| Package | Version | Path | Status |
|---|---|---|---|
| `@deepseek-ai/dsh-ptc-runtime` | `0.2.0-rc.2` | `D:\deepseek-harness\packages\ptc-runtime\ptc-runtime\` (source `src/index.ts`, `src/types.ts`; built `lib/index.js`, `lib/types/*.d.ts`) | **Present, built** |
| `@deepseek-ai/dsh-ptc-runtime-node` | `0.2.0-rc.2` | `D:\deepseek-harness\packages\ptc-runtime\ptc-runtime-node\` (source `src/*.ts` ×13; built `lib/index.js`, `lib/process.js`, `lib/types/*.d.ts`) | **Present, built** |
| `@deepseek-ai/dsh-workflow-ptc` | `0.2.0-rc.2` | `D:\deepseek-harness\packages\workflow\workflow-ptc\` | Present (consumer, not requested) |
| `@deepseek-ai/dsh-experimental-ptc-runtime-python` | `0.2.0-rc.2` | `D:\deepseek-harness\packages\experimental\ptc-runtime-python\` | Present, **private/not published** |

Version sources: `packages/ptc-runtime/ptc-runtime/package.json:2,4` and
`packages/ptc-runtime/ptc-runtime-node/package.json:2,4`.

### Where each one is linked / installed

| Location | `dsh-ptc-runtime` | `dsh-ptc-runtime-node` |
|---|---|---|
| `D:\DEV\dsh-model-as-tool\node_modules\@deepseek-ai\` | **Junction →** `D:\deepseek-harness\packages\ptc-runtime\ptc-runtime` | **absent** |
| `D:\deepseek-harness\packages\bundle\base\node_modules\@deepseek-ai\` | absent | **Junction →** `…\ptc-runtime-node` |
| `D:\deepseek-harness\apps\cli\node_modules\@deepseek-ai\` | absent | absent |
| `D:\deepseek-harness\apps\cli\node_modules\@deepseek-ai\dsh-base\node_modules\@deepseek-ai\` | absent | **Junction →** `…\ptc-runtime-node` |
| `C:\Users\erikb\.dsh\profiles\node_modules\@deepseek-ai\` (installed DSH, all junctions into `D:\deepseek-harness\apps\cli\node_modules`) | **absent** | **absent** |
| `C:\Users\erikb\.dsh\profiles\{headless,web,sttest}\node_modules` | no `@deepseek-ai` at all | no `@deepseek-ai` at all |
| npm registry (`npm view … version`) | `0.1.6-alpha.1` | `0.1.6-alpha.1` (registry is **behind** the checkout) |

The Node backend is declared as a dependency of the base bundle:
`packages/bundle/base/package.json` lists `"@deepseek-ai/dsh-ptc-runtime-node": "workspace:*"`.

### Places searched and NOT found

- `D:\DEV\dsh-model-as-tool\node_modules` — recursive walk and `require.resolve` (abstract package
  found, Node backend not).
- `C:\Users\erikb\.dsh` — recursive directory scan for `*ptc*`: only browser-profile
  `CaptchaProviders` / `Service Worker\ScriptCache` matched (irrelevant). No DSH PTC package.
- `C:\Users\erikb\.deepseek-harness`, `%APPDATA%\dsh`, `%LOCALAPPDATA%\dsh` — **do not exist**.
- Global npm root `C:\Users\erikb\AppData\Roaming\npm\node_modules` — contains only
  `@github`, `bun`, `cf`, `pnpm`, `wrangler`.
- `D:\deepseek-harness\node_modules\.pnpm\node_modules\@deepseek-ai\` — contains symlink/shim entries
  for both packages (pnpm virtual store; not importable by name from the checkout root).

---

## Public interface

### `@deepseek-ai/dsh-ptc-runtime` — the seam

Module augmentation and the abstract service class, `packages/ptc-runtime/ptc-runtime/src/index.ts`:

```ts
// src/index.ts:91-95
declare module '@deepseek-ai/cordis' {
  interface Context {
    ptcRuntime: PtcRuntime
  }
}
```

```ts
// src/index.ts:104-151 (abridged to the declared surface)
export abstract class PtcRuntime extends Service {
  abstract readonly language: string                                   // :114
  abstract readonly isolation: string                                  // :122
  get executionInstructions(): string { return '' }                    // :125
  get sandboxMode(): SandboxMode | undefined { return undefined }      // :128
  get timeout(): { defaultMs: number; maxMs: number } | undefined { return undefined }  // :131
  constructor(ctx: Context) { super(ctx, 'ptcRuntime') }               // :133-135
  abstract resolve(request: PtcRunRequest): PtcRunSpec                 // :143
  abstract run(spec: PtcRunSpec): Promise<PtcRunResult>                // :150
}
export default PtcRuntime                                              // :153
```

Exported value constants (the portable binding contract), same file:
`RESERVED_BINDING_GLOBALS` (`:42-45`), `RESERVED_ERROR_MEMBERS` (`:57-60`), `DUNDER_MEMBER` (`:66`),
`PORTABLE_RESERVED_WORDS` (`:78-89`).

Vocabulary types, `packages/ptc-runtime/ptc-runtime/src/types.ts`:

```ts
// types.ts:20,23
export type PtcBindingFunction = (args: unknown) => Promise<PtcJsonValue>
export type PtcJsonValue = null | boolean | number | string | PtcJsonValue[] | { [key: string]: PtcJsonValue }

// types.ts:32-42
export interface PtcBindingErrorClass {
  name: string
  memberNameProperty: string
}

// types.ts:51-67
export interface PtcBindingNamespace {
  global: string
  functions: Record<string, PtcBindingFunction>
  errorClass?: PtcBindingErrorClass
}

// types.ts:73-98
export interface PtcRunRequest {
  program: string
  bindings: PtcBindingNamespace[]
  cwd?: string
  timeoutMs?: number | null
  sandboxPolicy?: SandboxExecutionPolicy
  signal?: AbortSignal
}

// types.ts:101-106
export interface PtcRunSpec extends PtcRunRequest {
  cwd: string
  timeoutMs: number | null
}

// types.ts:109-116
export interface PtcRunSandbox { mode: SandboxMode; denied: boolean; enforcement?: SandboxEnforcement }

// types.ts:132-137
export interface PtcRunFailure {
  kind: 'exception' | 'timeout' | 'abort' | 'worker-exit' | 'invalid-output' | 'output-limit' | 'protocol' | 'sandbox-unavailable'
  message: string
}

// types.ts:144-162
export interface PtcRunResult {
  sandbox?: PtcRunSandbox
  value?: PtcJsonValue
  logs: string[]
  error?: PtcRunFailure
}
```

Contract notes that matter for integration (from the doc comments, verified in the code I ran):
program failures **resolve** in `result.error`, they do not reject `run()`; only caller misuse rejects
(`src/index.ts:97-103`). A program is the body of an async function — top-level `await` and `return`
work (`types.ts:74-80`).

### `@deepseek-ai/dsh-ptc-runtime-node` — the backend

`packages/ptc-runtime/ptc-runtime-node/src/index.ts`:

```ts
// src/index.ts:52-66
export class NodePtcRuntime extends PtcRuntime {
  static inject = ['fs', 'subprocess', 'sandbox', 'sandboxPolicy']
  static Config: z<Config> = z.object({
    timeoutMs: z.number().default(120_000),
    maxTimeoutMs: z.number().default(600_000),
    maxOutputBytes: z.number().default(67_108_864),
    maxOldGenerationSizeMb: z.number().default(512),
    maxMessageBytes: z.number().default(134_217_728),
    maxPendingCalls: z.number().default(128),
    graceMs: z.number().default(3_000),
    nodeExecutable: z.string(),
    bootstrapPath: z.string(),
  })
  readonly language = 'typescript'
  readonly isolation = 'process'
```

Exports: `export class NodePtcRuntime` and `export default NodePtcRuntime` — verified at runtime:
`node --input-type=module -e "await import('@deepseek-ai/dsh-ptc-runtime-node')"` →
`exports: NodePtcRuntime, default`.

The **composed dependencies are exactly the `static inject` list** (`src/index.ts:53`):
`fs`, `subprocess`, `sandbox`, `sandboxPolicy`. The README states the same in prose
(`packages/ptc-runtime/ptc-runtime-node/README.md:28`):

> "Mount this provider in a composition that supplies `fs`, `subprocess`, `sandbox` and `sandboxPolicy`."

How each is used inside `execute()`:

- `ctx.sandboxPolicy.defaultMode` → `sandboxMode` getter (`src/index.ts:97`).
- `ctx.sandboxPolicy.resolve()` → default policy when the request supplies none (`src/index.ts:110`).
- `ctx.subprocess.resolveExecutable(...)` (`src/index.ts:217`).
- `ctx.sandbox.confine(argv, policy, signal)` — skipped entirely under `danger-full-access`
  (`src/index.ts:224`).
- `ctx.subprocess.spawn({ argv, cwd, env, stdio: { stdin:'ignore', stdout:'pipe', stderr:'pipe', control:'pipe' }, graceMs, signal })` (`src/index.ts:236`).
- `ctx.fs` → `bootstrapArgs(this.ctx.fs, …)` maps host bootstrap paths into the subprocess world
  (`src/launch.ts:21-37`).
- `ctx.effect(...)` → disposal aborts and awaits in-flight runs (`src/index.ts:89-94`).

`resolve()` / `run()` signatures (`src/index.ts:108`, `:126`):

```ts
resolve(request: PtcRunRequest): PtcRunSpec
async run(spec: PtcRunSpec): Promise<PtcRunResult>
```

Cancellation and budgets are real and were exercised (see Evidence). `run()` builds
`AbortSignal.any([spec.signal, controller.signal])` (`src/index.ts:153`) and a wall timer from
`spec.timeoutMs` (`src/index.ts:163-164`).

Structured input is validated before any process starts, `src/bindings.ts:10-51`:
`validateBindings(request)` rejects non-identifier globals, `PORTABLE_RESERVED_WORDS`, the shared
`RESERVED_BINDING_GLOBALS`, duplicate globals, and unusable error-class/member names. Binding names
are looked up as **own properties only** (`src/index.ts:316`: `Object.hasOwn(functions, raw.name)`).

### Canonical minimal mounting recipe

`packages/ptc-runtime/ptc-runtime-node/tests/setup.ts:13-23` is the upstream-authored composition:

```ts
if (!ctx.get('sessions')) await ctx.plugin(SessionStore)
if (!ctx.get('fs')) await ctx.plugin(FileSystem)
if (!ctx.get('subprocess')) await ctx.plugin(Subprocess)
if (!ctx.get('sandbox')) await ctx.plugin(Sandbox, {})
if (!ctx.get('sessionProjections')) await ctx.plugin(SessionProjections)
if (!ctx.get('sandboxPolicy')) await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', ...policy })
await ctx.plugin(NodeRuntime, config)
return ctx.ptcRuntime as NodeRuntime
```

---

## How `ctx.ptcRuntime` is provided

**Service name:** `ptcRuntime`. **Registration:** `super(ctx, 'ptcRuntime')` inside the abstract base
class constructor (`packages/ptc-runtime/ptc-runtime/src/index.ts:133-135`), so *any* subclass that
calls `super(ctx)` registers the service — the provider never calls `ctx.provide` itself.

**Provider mounting is a bundle row, not plugin code.**
`packages/bundle/base/cordis.patch.yml:390-391`:

```yaml
    - id: ptc-runtime
      name: '@deepseek-ai/dsh-ptc-runtime-node'
```

That row sits in the DSH **base** bundle, immediately above the consumer row
(`cordis.patch.yml:393-396`):

```yaml
    - id: workflow-ptc
      name: '@deepseek-ai/dsh-workflow-ptc'
      config:
        provider: spawn
```

**Consumption patterns (three, all real):**

1. **Static `inject`** — `packages/workflow/workflow-ptc/src/index.ts:103`:

   ```ts
   class PtcWorkflowEngine extends WorkflowEngine {
     static inject = ['subagents', 'ptcRuntime', 'sandboxPolicy']
   ```
   then read through `this.ctx` and a language assertion at `:117`:

   ```ts
   if (ctx.ptcRuntime.language !== 'typescript') throw new Error('workflow-ptc requires the Node TypeScript PTC runtime')
   ```
   and passed to the run at `:160`: `runCtx.ptcRuntime,`.

2. **Scoped `ctx.inject([...], cb)`** — `packages/core/agent-tool-presentation/src/index.ts:69-71`,
   which deliberately does *not* put `ptcRuntime` in its static `inject` (`:31-35`) so that
   `mode: 'native'` mounts in a deployment with no runtime:

   ```ts
   ctx.inject(['ptcRuntime'], (runtimeCtx: Context) => {
     runtimeCtx.tools.presentAs(config.mode)
   })
   ```

3. **Use-time `ctx.get('ptcRuntime')` with a loud error** — `packages/core/tools/src/index.ts:1045-1055`:

   ```ts
   private requirePtcRuntime(mode: ToolPresentationMode): PtcRuntime {
     const runtime = this.ctx.get('ptcRuntime')
     if (!runtime) {
       throw new Error(`dsh-tools: mode "${mode}" requires a PTC runtime — load a ctx.ptcRuntime implementation (e.g. @deepseek-ai/dsh-ptc-runtime-node) or set tools mode to "native"`)
     }
     …
   }
   ```

   and the actual `run_code` call site, `packages/core/tools/src/ptc.ts:697-708`:

   ```ts
   result = await runtime.run(runtime.resolve({
     program: args.code,
     bindings: [{
       global: 'tools',
       functions,
       errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
     }],
     signal: runController.signal,
     ...exec.agent?.session.header.cwd !== undefined ? { cwd: exec.agent.session.header.cwd } : {},
     ...policy !== undefined ? { sandboxPolicy: policy } : {},
     ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
   }))
   ```

**Duplicate registration is fatal.** `vendor/cordis/src/reflect.ts:289-291`:

```ts
      if (this.store[key]) {
        throw new Error(`service "${name}" has been registered at <${this.store[key].fiber.name}>`)
      }
```

This is why the upstream test helper guards with `if (!ctx.get('…'))` and why
`workflow-ptc/tests/setup.ts:44` uses `if (!ctx.get('ptcRuntime')) await ctx.plugin(NodePtcRuntime, …)`.

---

## What this repo does today

**Nothing PTC-related. There is no Code Mode, no `run_code`, and no `tool_mode_run`.**

Evidence:

- `grep -r 'ptc|Ptc|PTC|run_code|runCode' packages/**/*.ts` over this repository →
  **No matches found.**
- `packages/dsh-model-as-tool/src/capability.ts` is **not** PTC handling. It is model-route
  resolution: given a catalog entry, decide whether the model's npm package/CLI/bridge is reachable
  (`capability.ts:82-187`, `resolveCapability`). It has no PTC concept and no `ctx` access at all.
- `packages/dsh-model-as-tool/src/index.ts` — plugin identity `name = 'model-tools'` (`:48`),
  `inject = ['tools']` (`:49`), sync `apply(ctx, config)` (`:245`). It registers tools via
  `ctx.tools.register` (`bindings.ts:287`, `index.ts:644`, `registrar.ts:179`) and dispatches
  through `ctx.tools.execute` (`index.ts:394`). No `ctx.plugin(...)` call exists anywhere in the
  package's sources.
- `packages/dsh-model-as-tool/cordis.patch.yml:12-14` mounts exactly one row:
  `id: model-tools`, `name: '@try-works/dsh-model-as-tool'`.
- `tool_mode_run` appears **only** in specification/verification documents, never in code:
  `docs/tool-mode/specs/Tool_Mode_DSH_Implementation_Spec_v1.2.md:34,109,434,470,482`,
  `docs/tool-mode/specs/Tool_Mode_Verification_Checklist_v1.2.md:23`,
  `docs/tool-mode/TRACEABILITY.md:389`, `verification/requirements.json:2847`,
  `verification/evidence.json:2890`. `packages/**` has zero occurrences.
- The repository's own traceability already records the gap, e.g.
  `docs/tool-mode/status.json:346`: *"…no PTC runtime integration because Code Mode does not exist."*

**The one PTC-adjacent artifact that does exist** is a peer link with no consumer:
`scripts/link-dsh.mjs:53` maps `'@deepseek-ai/dsh-ptc-runtime': 'packages/ptc-runtime/ptc-runtime'`
into the `PEERS` table. It was added in commit `27521b6` ("fix(dsh-model-tools): make the package
actually installable and reproducible", 2026-10-13). Nothing in the repository imports that
specifier — the link is currently dead weight with respect to code. Note also that the same script's
`PEERS` table does **not** link `@deepseek-ai/dsh-ptc-runtime-node`, nor `dsh-fs`, `dsh-subprocess`,
`dsh-sandbox`, or `dsh-timeout`, which the Node backend needs.

---

## Concrete integration plan

Goal: a plugin-owned path that satisfies the directive — mount a provider rather than calling
`ctx.ptcRuntime` blind; run both the native PTC presentation and an external `tool_mode_run` through
the same authorized tool pipeline.

1. **Add peer dependencies to `packages/dsh-model-as-tool/package.json`** (peer, matching the
   existing `@deepseek-ai/*` convention at `package.json:59-64`):
   - `"@deepseek-ai/dsh-ptc-runtime": ">=0.2.0-rc.2"` — for the `PtcRuntime` type and
     `PtcBindingNamespace`.
   - `"@deepseek-ai/dsh-ptc-runtime-node": ">=0.2.0-rc.2"` — **only if the plugin mounts the backend
     itself** (step 4). If the plugin instead consumes a host-provided runtime, this stays a peer you
     never import, and step 4 is replaced by a readiness check.
   Mark both `optional` in `peerDependenciesMeta` if the plugin must still load in a `native`-mode
   deployment (the `@deepseek-ai/dsh-skill` precedent at `package.json:65-69`).

2. **Extend `scripts/link-dsh.mjs` `PEERS`** (`scripts/link-dsh.mjs:42-56`) with the packages the
   local dev loop must resolve, otherwise nothing here is importable:
   ```js
   '@deepseek-ai/dsh-ptc-runtime-node': 'packages/ptc-runtime/ptc-runtime-node',
   '@deepseek-ai/dsh-fs': 'packages/fs/fs',
   '@deepseek-ai/dsh-fs-local': 'packages/fs/fs-local',
   '@deepseek-ai/dsh-subprocess': 'packages/subprocess/subprocess',
   '@deepseek-ai/dsh-subprocess-local': 'packages/subprocess/subprocess-local',
   '@deepseek-ai/dsh-sandbox': 'packages/sandbox/sandbox',
   '@deepseek-ai/dsh-sandbox-local': 'packages/sandbox/sandbox-local',
   '@deepseek-ai/dsh-session-projection': 'packages/session/session-projection',
   '@deepseek-ai/dsh-timeout': 'packages/util/timeout',
   ```
   Every one of those nine target directories was verified to exist on this host. Add only the ones
   the chosen integration actually imports — the Node backend's own peer set is
   `dsh-ptc-runtime, dsh-session, dsh-timeout, dsh-fs, dsh-subprocess, dsh-sandbox,
   dsh-sandbox-policy` (`…/ptc-runtime-node/package.json:33-42`), and `sandbox-policy` is already
   linked (`scripts/link-dsh.mjs:55`).

3. **Keep the composed dependencies out of the plugin's own hands when the host already supplies
   them.** `NodePtcRuntime.inject` is `['fs','subprocess','sandbox','sandboxPolicy']`
   (`ptc-runtime-node/src/index.ts:53`), so the plugin must not mount those four itself in a DSH host
   — the base bundle already mounts them. Mounting them again would hit the same
   `service "…" has been registered at <…>` throw (`vendor/cordis/src/reflect.ts:289-291`).

4. **Mount the provider, guarded, mirroring the upstream recipe** (`…-node/tests/setup.ts:13-23`).
   The guard is mandatory: the DSH base bundle already mounts a `ptcRuntime`
   (`packages/bundle/base/cordis.patch.yml:390-391`), so an unguarded `ctx.plugin` throws.
   ```ts
   // inside apply(ctx, config), before anything calls ctx.ptcRuntime
   if (ctx.get('ptcRuntime') === undefined) {
     const { default: NodePtcRuntime } = await import('@deepseek-ai/dsh-ptc-runtime-node')
     await ctx.plugin(NodePtcRuntime, { timeoutMs: 120_000, maxTimeoutMs: 600_000 })
   }
   ```
   If the runtime is genuinely absent and cannot be imported, fail with an actionable message —
   never silently degrade and never report the missing service as an upstream product gap.

5. **Declare a *scoped* injection rather than a static one.** `agent-tool-presentation` is the
   precedent (`agent-tool-presentation/src/index.ts:31-35,69-71`): putting `ptcRuntime` in the static
   `inject` array would hold the whole plugin — and every tool behind `ctx.tools` — hostage to a
   runtime existing even in `native` mode. Use `ctx.inject(['tools','ptcRuntime'], cb)` inside
   `apply()`.

6. **Bind structured input safely, using the seam's own validator.**
   `validateBindings` (`…-node/src/bindings.ts:10-51`) already enforces the portable identifier rule,
   reserved globals, and the error-class contract, and `run()` resolves binding names as own
   properties only (`…-node/src/index.ts:316`). Host-side, build the `functions` map with
   `Object.create(null)` + `Object.defineProperty`, the same idiom `dsh-tools` uses
   (`core/tools/src/ptc.ts:684-692`), so a tool named `__proto__` stays an ordinary own key.

7. **One authorized tool pipeline for both surfaces.** The external `tool_mode_run` and any native
   PTC program must be supplied the *same* `functions` record, produced by one function that
   intersects (a) the requested binding names, (b) the caller's grant (`authority.ts`
   `authorizeTool`), and (c) the currently visible tool set — rejecting unknown or forbidden names
   rather than omitting them. Build the surface once, feed both call sites; do not fork the pipeline.
   The existing grant path is `createGrant` / `authorizeTool` (`src/index.ts:304-313`,
   `src/bindings.ts:30-35`), and the dispatch precedent is `ctx.tools.execute` (`src/index.ts:394`).

8. **Preserve cancellation, budgets, and identity.** Pass `signal` and `timeoutMs` straight through
   `resolve()`/`run()` — the seam implements both (`…-node/src/index.ts:108-119`, `:153`, `:163-164`)
   and returns `kind: 'abort'` / `kind: 'timeout'` as result fields. Do not wrap them in a second
   controller that swallows the reason. Keep the plugin's `HostIdentity` receipt path
   (`src/bindings.ts:39-65`) stamped on external calls, and pass `cwd` and `sandboxPolicy` from the
   session the way `dsh-tools` does (`core/tools/src/ptc.ts:704-707`).

9. **Surface `language`/`isolation` honestly.** A plugin that presents a generated TypeScript SDK
   must switch on `runtime.language === 'typescript'` (the `dsh-tools` pattern:
   `core/tools/src/index.ts:1050-1053` fails loud on an unknown language) rather than assuming.

10. **Do not add a `mode: ptc` presentation row to `cordis.patch.yml` without a deployment decision.**
    `dsh-tools` presentation mode is a deployment choice and the base bundle deliberately leaves it at
    the schema default `native` (`packages/bundle/base/cordis.patch.yml:497-500`). Choosing `ptc` or
    `both` replaces the model's whole tool schema with `run_code`
    (`core/tools/src/index.ts:1022-1027`) — that is not a local engineering decision.

---

## Verification evidence (this host, this session)

### A. Real backend, real composition, two fixture calls through a branch

Command (run from `D:\deepseek-harness\packages\ptc-runtime\ptc-runtime-node`, so package names
resolve from the built packages):

```powershell
node --input-type=module -e $script   # script mounts session-projection, fs-local,
                                      # subprocess-local, sandbox-local, sandbox-policy
                                      # (mode danger-full-access), then NodePtcRuntime
```

Program executed:

```ts
const first: number = await tools.double({ n: 21 });
let second;
if (first > 40) { second = await tools.double({ n: first }); } else { second = 0; }
console.log("first", first);
return { first, second };
```

Output:

```
SPEC cwd=D:\deepseek-harness\packages\ptc-runtime\ptc-runtime-node timeoutMs=30000 mode=danger-full-access lang=typescript isolation=process
RESULT {"logs":["first 42"],"value":{"first":42,"second":84},"sandbox":{"mode":"danger-full-access","denied":false}}
(node:34596) ExperimentalWarning: stripTypeScriptTypes is an experimental feature and might change at any time
```

### B. Cancellation / revocation

Same composition; `setTimeout(() => controller.abort('probe cancellation'), 700)` with an infinite
binding loop program:

```
ABORT-PROBE elapsedMs=1061 {"logs":[],"error":{"kind":"abort","message":"probe cancellation"},"sandbox":{"mode":"danger-full-access","denied":false}}
```

### C. Resolution matrix

```powershell
node -e "require.resolve('@deepseek-ai/dsh-ptc-runtime/package.json',{paths:['D:/DEV/dsh-model-as-tool']})"
#  -> D:\deepseek-harness\packages\ptc-runtime\ptc-runtime\package.json  (name/version confirmed)

node --input-type=module -e "await import('@deepseek-ai/dsh-ptc-runtime-node')"   # cwd = repo root
#  -> IMPORT FAILED: ERR_MODULE_NOT_FOUND
#     Cannot find package '@deepseek-ai/dsh-ptc-runtime-node' imported from D:\DEV\dsh-model-as-tool\[eval1]

node -e "require.resolve('@deepseek-ai/dsh-ptc-runtime-node/package.json',{paths:['D:/deepseek-harness']})"       # -> MODULE_NOT_FOUND
node -e "require.resolve('@deepseek-ai/dsh-ptc-runtime-node/package.json',{paths:['D:/deepseek-harness/apps/cli']})" # -> MODULE_NOT_FOUND
node -e "require.resolve('@deepseek-ai/dsh-ptc-runtime-node/package.json',{paths:['D:/deepseek-harness/packages/bundle/base']})"
#  -> D:\deepseek-harness\packages\ptc-runtime\ptc-runtime-node\package.json
node -e "require.resolve('@deepseek-ai/dsh-ptc-runtime-node/package.json',{paths:['C:/Users/erikb/.dsh/profiles']})" # -> MODULE_NOT_FOUND
```

Importability, `node --input-type=module -e "await import('@deepseek-ai/dsh-ptc-runtime-node')"`
with `cwd = D:\deepseek-harness\packages\bundle\base`:

```
exports: NodePtcRuntime, default
default name: NodePtcRuntime
```

### D. Host identity of the running GUI

`Get-CimInstance Win32_Process -Filter "Name='node.exe'"` shows the host serving
`http://127.0.0.1:3080` is:

```
node  --import tsx/esm apps/cli/src/bin.ts "web"
```

i.e. the running DSH is the **checkout in source mode**, not a published install. Everything the host
loads comes from `D:\deepseek-harness`, which is why the base bundle's `ptc-runtime` row resolves.

---

## What is uncertain

1. **Whether THIS running host currently has `ptcRuntime` mounted.** The base bundle mounts it
   (`packages/bundle/base/cordis.patch.yml:390-391`) and the package resolves from
   `packages/bundle/base`, which is strong evidence — but I could not read the live fiber tree
   through a read-only path to confirm. **Do not assume it.** The integration code must keep the
   `ctx.get('ptcRuntime') === undefined` guard either way, because it is required in both outcomes
   (present → avoid the duplicate-registration throw; absent → mount).

2. **Confined sandbox modes were not exercised.** My probe used `danger-full-access`, which skips
   `ctx.sandbox.confine` entirely (`…-node/src/index.ts:224`). Whether `read-only` / `workspace-write`
   confinement works on this Windows host via `dsh-sandbox-local` / `dsh-sandbox-windows-acl` was
   **not** tested. Real integration must run under the session's standing policy, so this needs its
   own verification before claiming enforcement.

3. **Whether a published plugin can resolve `@deepseek-ai/dsh-ptc-runtime-node` by name.** It is not
   resolvable from `C:\Users\erikb\.dsh\profiles`, nor from `apps/cli`, nor from this repo. It resolves
   only from the bundle package directory / `dsh-base`'s nested `node_modules`
   (steps 1–2 of the plan address this, but I could not verify the exact installed-profile resolution
   order without performing an install). This is the sharpest open question and the reason I would not
   write `import … from '@deepseek-ai/dsh-ptc-runtime-node'` at module top level.

4. **Version skew.** npm publishes `0.1.6-alpha.1`; the checkout builds `0.2.0-rc.2`. The interface
   above is read from `0.2.0-rc.2`. A dependency range that resolves to the published alpha would be a
   *different* interface. Pin deliberately.

5. **Exact `packages/<group>/<name>` paths beyond the PTC pair.** The two PTC paths,
   `dsh-fs`/`dsh-fs-local`, `dsh-subprocess`/`dsh-subprocess-local`, `dsh-sandbox`/`dsh-sandbox-local`,
   `dsh-session-projection` and `dsh-timeout` were each confirmed by directory listing. I did not
   verify that every one of them *builds* standalone in this checkout.

6. **`bootstrapPath` / `nodeExecutable` for packaged deployments.** `launch.ts:21-37` selects between
   a source bootstrap and a built `process.js`, and throws when the host bootstrap cannot be mapped
   into the subprocess world. My probe ran from the source-adjacent case with the built `lib/`; I did
   not test the packaged-electron path (`'pkg' in process`).

7. **Grep coverage caveat.** "This repo does nothing PTC" is established for `packages/**/*.ts` and
   for the whole repo (ripgrep, gitignore-respecting). Markdown fixtures under `docs/` were searched
   separately and only contain spec/verification prose.

---

## Appendix — search paths and exact commands

Directories enumerated for `*ptc*`:
`Get-ChildItem D:\deepseek-harness -Recurse -Directory -Filter "*ptc*"`,
`Get-ChildItem C:\Users\erikb\.dsh -Recurse -Directory -Filter "*ptc*"`.

Package listings:
`Get-ChildItem D:\deepseek-harness\packages -Directory`,
`Get-ChildItem D:\DEV\dsh-model-as-tool\node_modules\@deepseek-ai -Force` (with `LinkType`/`Target`),
`Get-ChildItem C:\Users\erikb\.dsh\profiles\node_modules\@deepseek-ai -Force`,
`Get-ChildItem D:\deepseek-harness\apps\cli\node_modules\@deepseek-ai | ? Name -like '*ptc*'`,
`Get-ChildItem D:\deepseek-harness\packages\bundle\base\node_modules\@deepseek-ai | ? Name -like '*ptc*'`.

Content searches (ripgrep):
`ptcRuntime`, `ptc-runtime-node`, `ptc-runtime`, `ptc|Ptc|PTC|run_code|runCode`,
`tool_mode_run|toolModeRun` across `D:\deepseek-harness\packages`, `D:\deepseek-harness\vendor\cordis`,
and `D:\DEV\dsh-model-as-tool`.

Registry: `npm view @deepseek-ai/dsh-ptc-runtime version`,
`npm view @deepseek-ai/dsh-ptc-runtime-node version`.

No file in `D:\DEV\dsh-model-as-tool` was created or modified other than this report. No file in
`D:\deepseek-harness` was modified. No `npm install` was run; no repository verify script was run.
