# Adding a model

Three steps: describe it in the catalog, prove it runs, and (only if it needs
code) write an adapter.

## 1. Add the catalog entry

Append to `packages/dsh-model-tools/catalog/desert-ant-models.json`:

```json
{
  "id": "tongue",
  "name": "Tongue",
  "summary": "One sentence, at most 120 characters.",
  "capability": "text.language-identification",
  "input": "text",
  "output": "A short human description of the returned shape.",
  "languages": 84,
  "modelSizeMB": 2,
  "appleOnly": false,
  "closedBeta": false,
  "verifiedRunnableOnWindows": true,
  "windowsSupport": "native-node",
  "npmPackage": "@desert-ant-labs/tongue",
  "npmSubpath": null,
  "requiresRuntime": [],
  "cliVerb": "tongue",
  "license": "source-available",
  "docsUrl": "https://desertant.com/models/tongue/",
  "hfRepo": "https://huggingface.co/desert-ant-labs/tongue",
  "tool": {
    "name": "lang_detect",
    "description": "Model-facing description of the tool.",
    "params": {
      "text": "The required primary input; the FIRST param is the required one.",
      "top": { "description": "Optional integer knob.", "type": "integer" }
    },
    "returns": "What the tool returns."
  },
  "skill": {
    "name": "desert-ant-tongue",
    "description": "Routing description, at most 200 characters.",
    "whenToUse": "One sentence on when to reach for it."
  }
}
```

### Field rules

| Field | Rule |
| --- | --- |
| `id` | Unique. Also the playbook key and the `model_tools` lookup key. |
| `input` | One of `text`, `audio`, `image`, `video`, `stroke`, `transcript`. |
| `windowsSupport` | One of `native-node`, `onnxruntime-node`, `apple-only`, `browser-only`, `no-sdk`. **This drives the capability resolver.** |
| `npmPackage` / `npmSubpath` | The specifier a Node process would import. `null` when no npm package exists. |
| `requiresRuntime` | Peer runtime modules the caller must supply, e.g. `["onnxruntime-node"]`. |
| `languages` / `modelSizeMB` | Numbers, or `null` when not verifiable. **Never guess.** |
| `tool.name` | Lower snake_case, unique across the catalog. |
| `tool.params` | An ordered map. **The first key is the required primary input.** A value is either a description string (shorthand for a string param) or `{ description, type }`. |
| `skill.name` | Kebab-case, must match `^[a-z0-9]+(-[a-z0-9]+)*$`. |

Loading fails loudly on a missing field, a bad enum, a duplicate id, or a
duplicate tool name — a broken entry must not become a silently missing tool.

## 2. Prove it runs

Capability is **verified, not assumed**. From the model's npm package:

```sh
node -e "import('@desert-ant-labs/<model>').then(m => { console.log(Object.keys(m)); return m.<Model>.load() }).then(x => console.log('LOADED', Object.keys(x))).catch(e => console.log('FAILED:', e.message))"
```

Then a real inference, not just a load. Record what you observed:

- Set `verifiedRunnableOnWindows: true` **only** after a real inference succeeded
  on Windows x64.
- Set `windowsSupport` from the error message when it fails — the LiteRT packages
  say `no prebuilt native for win32-x64. Supported server-side targets:
  linux-x64, linux-arm64, darwin-arm64`, which is `browser-only`.
- If the browser/WASM entry refuses `plain Node`, that is not a fallback.

Re-run the resolver after editing:

```sh
node --import tsx -e "
import('./packages/dsh-model-tools/src/catalog.ts').then(async c => {
  const { resolveCapability } = await import('./packages/dsh-model-tools/src/capability.ts')
  for (const e of c.loadCatalog()) {
    const v = resolveCapability(e)
    console.log(v.runnable ? 'RUN ' : 'no  ', e.id, '-', v.reason)
  }
})"
```

## 3. Write an adapter (only when the model needs code)

Add `src/adapters/<model>.ts`:

```ts
export function createMyAdapter(entry: ModelCatalogEntry): ModelAdapter | undefined {
  if (entry.id !== 'mymodel') return undefined
  let loaded: Promise<Instance> | undefined

  const load = async () => {
    loaded ??= (async () => {
      try {
        // A variable specifier keeps an optional dependency out of the module graph.
        const module = await import(entry.npmPackage as string)
        return await module.MyModel.load()
      } catch (error) {
        loaded = undefined   // a later call may succeed
        throw new Error(`MyModel could not be loaded: ${(error as Error).message}`)
      }
    })()
    return loaded
  }

  return {
    modelId: entry.id,
    async invoke({ args, signal }) {
      throwIfAborted(signal)
      const value = await (await load()).run(requireString(args, 'text'))
      throwIfAborted(signal)
      return { result: value }          // must match the tool's output schema
    },
    async dispose() { /* release the loaded model */ },
  }
}
```

Register it in `src/adapters/index.ts`:

```ts
export const ADAPTER_FACTORIES: readonly AdapterFactory[] = [
  createTongueAdapter,
  createVozAdapter,
  createMyAdapter,     // ← add here
]
```

Adapter rules:

1. **Never import a model package at module scope.** Optional dependencies must
   stay optional; a static import breaks installs that skip them.
2. **Cache the loaded model** and release it in `dispose()`.
3. **Clear the cache on a failed load**, so an install or a transient failure is
   recoverable.
4. **Return a plain JSON object** matching the declared output schema.
5. **Forward `exec.signal`** — call `throwIfAborted(signal)` before and after the
   expensive step.

## 4. Write the playbook

Add the model's id to `packages/dsh-model-tools/catalog/playbooks.json`. Every
field is optional and defaults to an empty list; sections with no content are
omitted from the rendered skill.

```json
{
  "mymodel": {
    "useCases": ["Concrete job this is the right tool for."],
    "whenToUse": ["Trigger conditions."],
    "whenNotToUse": ["Anti-triggers, including which sibling model to use instead."],
    "workflow": ["Ordered steps to drive it well."],
    "pairsWith": ["other_tool — why they compose"],
    "caveats": ["Limits, cost, failure modes."]
  }
}
```

The anti-triggers are the highest-value part: they are what stops an agent
reaching for the wrong model when two are similar.

## 5. Verify

```sh
cd packages/dsh-model-tools
node --import tsx --test tests/plugin.test.ts     # boots the plugin on a real context
npx tsc --noEmit -p tsconfig.json                 # types
node ../../scripts/gen-docs.mjs                   # regenerate the data-derived docs
```

Then check the three surfaces agree:

```sh
node --import tsx -e "
import('./src/index.ts').then(async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const ToolRuntime = (await import('@deepseek-ai/dsh-tools')).default
  const SystemPrompt = (await import('@deepseek-ai/dsh-system-prompt')).default
  const SkillRegistry = (await import('@deepseek-ai/dsh-skill')).default
  const plugin = await import('./src/index.ts')
  const ctx = new Context()
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(SkillRegistry)
  await ctx.plugin(plugin, {})
  console.log('tools:', ctx.tools.schemas().map(s => s.name).join(', '))
  console.log('skills:', (await ctx.skills.list({ cwd: process.cwd() })).map(s => s.name).join(', '))
  await ctx.fiber.dispose()
})"
```

## Checklist

- [ ] Catalog entry added and validates (`loadCatalog` does not throw).
- [ ] `verifiedRunnableOnWindows` reflects a **real inference**, not a load.
- [ ] `languages` / `modelSizeMB` are `null` unless verified.
- [ ] Adapter written (if needed) and registered in `ADAPTER_FACTORIES`.
- [ ] Adapter imports lazily, caches, clears on failure, forwards `signal`.
- [ ] Playbook entry written, including anti-triggers.
- [ ] `model_tools list` reports the model with an accurate reason.
- [ ] Tests, typecheck and doc regeneration pass.
