/** Managed process bridge. No filesystem authority is implied by process isolation. */
import { pathToFileURL } from 'node:url'
import { readFileSync, readSync, statSync, existsSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { isWorkerObject, workerWire, workerFrame, workerId } from '../worker.ts'
import type { ExtensionContextV1, ExtensionInstanceV1, InvocationContextV1, JsonObject, ModelProviderV1, ToolModeExtensionV1 } from '../runtime.ts'

function argument(flag: string): string {
  const index = process.argv.indexOf(flag)
  const value = process.argv[index + 1]
  if (index === -1 || value === undefined) throw new Error(`missing ${flag}`)
  return value
}
function bound(flag: string): number {
  const value = Number(argument(flag))
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid ${flag}`)
  return value
}
const maxLine = bound('--max-line-bytes')
const maxInput = bound('--max-input-bytes')
const pathTimeout = bound('--resolve-path-timeout-ms')
let diagnosticBytes = 0
function diagnostic(message: string): void {
  const remaining = 64 * 1024 - diagnosticBytes
  if (remaining <= 0) return
  const line = Buffer.from(message).subarray(0, Math.min(4096, remaining)).toString('utf8')
  diagnosticBytes += Buffer.byteLength(line)
  process.stderr.write(`${line}\n`)
}
function send(message: unknown): void {
  const line = JSON.stringify(message)
  if (Buffer.byteLength(line, 'utf8') > maxLine) {
    diagnostic('worker result protocol line exceeded byte limit')
    process.exit(1)
  }
  process.stdout.write(`${line}\n`)
}
function fatal(message: string): never {
  try { send({ kind: 'fault', message: message.slice(0, 4096) }) } finally { process.exit(1) }
}
function readObject(path: string): Record<string, unknown> {
  if (statSync(path).size > 512 * 1024) throw new Error('manifest metadata exceeds byte limit')
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isWorkerObject(value)) throw new Error('manifest metadata must be an object')
  return value
}
/** Manifest model IDs, including models that have no implementation. */
function modelMapping(entry: string, extensionId: string): { implementations: Map<string, string>; models: Set<string> } {
  let root = dirname(entry)
  while (!existsSync(resolve(root, 'package.json'))) {
    const parent = dirname(root)
    if (parent === root) throw new Error('entry has no owning package.json')
    root = parent
  }
  const pkg = readObject(resolve(root, 'package.json'))
  if (!isWorkerObject(pkg['toolMode']) || typeof pkg['toolMode']['manifest'] !== 'string') throw new Error('package has no toolMode.manifest')
  const path = resolve(root, pkg['toolMode']['manifest'])
  if (!path.startsWith(root + sep)) throw new Error('manifest must be inside owning package')
  const manifest = readObject(path)
  if (manifest['id'] !== extensionId || !Array.isArray(manifest['implementations']) || !Array.isArray(manifest['models'])) throw new Error('invalid extension manifest identity or mapping')
  const models = new Set<string>()
  for (const model of manifest['models']) {
    if (!isWorkerObject(model) || !workerId(model['id']) || models.has(model['id'])) throw new Error('invalid or duplicate manifest model')
    models.add(model['id'])
  }
  const implementations = new Map<string, string>()
  for (const item of manifest['implementations']) {
    if (!isWorkerObject(item) || !workerId(item['id']) || !workerId(item['modelId'])
      || !models.has(item['modelId']) || implementations.has(item['id'])) throw new Error('invalid or duplicate implementation model mapping')
    implementations.set(item['id'], item['modelId'])
  }
  return { implementations, models }
}
function bridgeContext(extensionId: string, generation: number, signal: AbortSignal): ExtensionContextV1 {
  const memory = new Map<string, unknown>()
  return {
    extensionId, extensionVersion: '0.0.0-worker', activationGeneration: generation,
    storage: {
      async read(key) { return memory.get(key) as JsonObject[keyof JsonObject] | undefined },
      async write(key, value) { memory.set(key, value) }, directory: '',
    },
    logger: { log(level, message, fields) {
      if (diagnosticBytes >= 64 * 1024) return
      // Serialize bounded structure only; do not stringify arbitrary huge diagnostics.
      let detail = ''
      try {
        if (fields !== undefined) {
          const encoded = workerWire(fields, 'encode', 4096)
          detail = JSON.stringify(encoded).slice(0, 2048)
        }
      } catch { detail = '[diagnostic fields omitted]' }
      diagnostic(`${level}: ${String(message).slice(0, 2048)} ${detail}`)
    } },
    signal, configuration: {},
  }
}
let pathSequence = 0
/** fd3 is a host-only reply channel, never caller grants or unrestricted fs. */
function resolveHostPath(invokeId: string, candidate: string, signal: AbortSignal): string {
  if (typeof candidate !== 'string' || Buffer.byteLength(candidate) > 16 * 1024 || signal.aborted) throw new Error('path access denied: invalid or aborted path request')
  const id = `path-${++pathSequence}`
  send({ kind: 'resolvePath', id, invokeId, candidate })
  const deadline = Date.now() + pathTimeout + 250
  const chunks: Buffer[] = []
  let bytes = 0
  // Read one byte at a time to avoid consuming a subsequent synchronous reply.
  const byte = Buffer.alloc(1)
  while (true) {
    if (Date.now() >= deadline) throw new Error('path access denied: host path broker deadline elapsed')
    let count: number
    try { count = readSync(3, byte, 0, 1, null) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EAGAIN') {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
        continue
      }
      throw new Error(`path access denied: broker unavailable: ${String(error)}`)
    }
    if (count === 0) throw new Error('path access denied: broker closed')
    if (byte[0] === 10) break
    if (++bytes > maxLine) fatal('path response exceeded byte limit')
    chunks.push(Buffer.from(byte))
  }
  const response: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  workerFrame(response, ['kind', 'id', 'invokeId', 'path', 'error'])
  if (response['kind'] !== 'resolvePathResult' || response['id'] !== id || response['invokeId'] !== invokeId
    || (Object.hasOwn(response, 'path') === Object.hasOwn(response, 'error'))) fatal('malformed host path response')
  if (typeof response['error'] === 'string') throw new Error(response['error'])
  if (typeof response['path'] !== 'string' || response['path'].length === 0 || Buffer.byteLength(response['path']) > 16 * 1024) fatal('malformed canonical host path')
  return response['path']
}
function invocationContext(invocationId: string, signal: AbortSignal): InvocationContextV1 {
  return {
    invocationId, signal,
    limits: { maxInputBytes: maxInput, maxAudioSeconds: 300, maxResultBytes: maxLine },
    resolvePath(candidate) { return resolveHostPath(invocationId, candidate, signal) },
  }
}
/** Stable keys mean semantically identical explicit JSON configs share a provider. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isWorkerObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
async function main(): Promise<void> {
  const entry = argument('--entry')
  const extensionId = argument('--extension-id')
  const generation = Number(argument('--generation'))
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('invalid generation')
  const disposed = new AbortController()
  const providers = new Map<string, Promise<ModelProviderV1>>()
  const selected = new Map<string, string>()
  const inFlight = new Map<string, { controller: AbortController; task: Promise<void> }>()
  let extension: ExtensionInstanceV1
  let mapping: ReturnType<typeof modelMapping>
  try {
    mapping = modelMapping(entry, extensionId)
    const module = await import(pathToFileURL(entry).href) as { default?: ToolModeExtensionV1 }
    const declared = module.default
    if (declared === null || typeof declared !== 'object' || declared.apiVersion !== 1 || typeof declared.create !== 'function') throw new Error('entry must export ToolModeExtensionV1')
    extension = await declared.create(bridgeContext(extensionId, generation, disposed.signal))
  } catch (error) { fatal(`extension activation failed: ${String(error)}`) }
  send({ kind: 'ready' })
  const providerFor = (modelId: string, configuration?: JsonObject): Promise<ModelProviderV1> => {
    if (!mapping.models.has(modelId)) throw new Error(`unknown model ${modelId}`)
    const config = configuration === undefined ? undefined : canonical(configuration)
    const key = config === undefined ? selected.get(modelId) ?? JSON.stringify([modelId, '{}']) : JSON.stringify([modelId, config])
    let created = providers.get(key)
    if (created === undefined) {
      if (providers.size >= 128) throw new Error('worker provider limit exceeded')
      created = Promise.resolve().then(() => extension.createProvider({ modelId, configuration: configuration ?? {} }))
      providers.set(key, created)
    }
    selected.set(modelId, key)
    return created
  }
  const serve = async (message: Record<string, unknown>, controller: AbortController): Promise<void> => {
    const id = message['id'] as string
    const kind = message['kind'] as string
    try {
      const implementationId = message['implementationId'] as string
      const modelId = kind === 'invoke' ? mapping.implementations.get(implementationId) : message['modelId'] as string
      if (modelId === undefined) throw new Error(`unknown implementation ${implementationId}`)
      const provider = await providerFor(modelId, message['configuration'] as JsonObject | undefined)
      let result: Record<string, unknown>
      if (kind === 'inspect') {
        result = { type: 'inspect', inspection: await provider.inspect(controller.signal) }
      } else if (kind === 'load') {
        const handles = new Map((message['assets'] as { id: string; path: string; digest: string }[]).map(asset => [asset.id, { path: asset.path, digest: asset.digest }]))
        await provider.load({ assets: { assetIds: [...handles.keys()], get(assetId) { return handles.get(assetId) } }, signal: controller.signal })
        result = { type: 'load' }
      } else if (kind === 'unload') {
        await provider.unload(controller.signal)
        result = { type: 'unload' }
      } else {
        const value = await provider.invoke({ implementationId, input: message['input'] as JsonObject, context: invocationContext(id, controller.signal) })
        if (!isWorkerObject(value) || ArrayBuffer.isView(value)) throw new Error('worker result must be an object')
        result = { type: 'invoke', value }
      }
      send({ id, kind: 'result', result: workerWire(result, 'encode', maxLine) })
    } catch (error) {
      send({ id, kind: 'error', message: controller.signal.aborted ? 'the invocation was cancelled' : String(error).slice(0, 4096) })
    } finally { inFlight.delete(id) }
  }
  let shuttingDown: Promise<void> | undefined
  const shutdown = (): Promise<void> => {
    if (shuttingDown !== undefined) return shuttingDown
    disposed.abort('shutdown')
    for (const { controller } of inFlight.values()) controller.abort('shutdown')
    shuttingDown = (async () => {
      await Promise.allSettled([...inFlight.values()].map(item => item.task))
      await Promise.allSettled([...providers.values()].map(async created => {
        const provider = await created
        try { await provider.unload(disposed.signal) } finally { await provider.dispose() }
      }))
      await extension.dispose('shutdown')
      process.exit(0)
    })()
    return shuttingDown
  }
  const handle = async (line: string): Promise<void> => {
    const parsed: unknown = JSON.parse(line)
    if (!isWorkerObject(parsed) || typeof parsed['kind'] !== 'string') throw new Error('protocol frame must be an object with string kind')
    const kind = parsed['kind']
    switch (kind) {
      case 'inspect': case 'load': case 'unload': case 'invoke': {
        workerFrame(parsed, ['kind', 'id', ...(kind === 'invoke' ? ['implementationId', 'input'] : ['modelId']), 'configuration', ...(kind === 'load' ? ['assets'] : [])])
        if (disposed.signal.aborted || !workerId(parsed['id']) || inFlight.has(parsed['id']) || inFlight.size >= 1024
          || !workerId(kind === 'invoke' ? parsed['implementationId'] : parsed['modelId'])) throw new Error('malformed request identity')
        if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > maxInput) throw new Error('input exceeds byte limit')
        const message = workerWire(parsed, 'decode', maxInput) as Record<string, unknown>
        if (message['configuration'] !== undefined && (!isWorkerObject(message['configuration']) || ArrayBuffer.isView(message['configuration']))) throw new Error('configuration must be an object')
        if (kind === 'invoke' && (!isWorkerObject(message['input']) || ArrayBuffer.isView(message['input']))) throw new Error('input must be an object')
        if (kind === 'load') {
          const assets = message['assets']
          if (!Array.isArray(assets) || assets.length > 10_000 || !assets.every(asset => isWorkerObject(asset)
            && Object.keys(asset).length === 3 && workerId(asset['id']) && typeof asset['path'] === 'string' && typeof asset['digest'] === 'string')
            || new Set(assets.map(asset => (asset as Record<string, unknown>)['id'])).size !== assets.length) throw new Error('malformed prepared assets')
        }
        const controller = new AbortController()
        // Queue serve after registration: pre-aborted messages see the controller.
        const task = Promise.resolve().then(() => serve(message, controller))
        inFlight.set(parsed['id'], { controller, task })
        void task.catch(error => fatal(String(error)))
        break
      }
      case 'cancel':
        workerFrame(parsed, ['kind', 'invokeId'])
        if (!workerId(parsed['invokeId'])) throw new Error('malformed cancel')
        inFlight.get(parsed['invokeId'])?.controller.abort()
        break
      case 'dispose':
        workerFrame(parsed, ['kind', 'reason'])
        if (parsed['reason'] !== 'shutdown') throw new Error('malformed dispose')
        await shutdown()
        break
      default: throw new Error('unknown protocol kind')
    }
  }
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (Buffer.byteLength(line, 'utf8') > maxLine) fatal('protocol line exceeded byte limit')
      void handle(line).catch(error => fatal(`malformed host protocol: ${String(error)}`))
      newline = buffer.indexOf('\n')
    }
    if (Buffer.byteLength(buffer, 'utf8') > maxLine) fatal('protocol line exceeded byte limit')
  })
  process.stdin.on('end', () => { void shutdown().catch(error => fatal(String(error))) })
}
void main().catch(error => fatal(String(error)))
