/**
 * Loads and validates the Desert Ant Labs model catalog.
 *
 * The catalog is plain JSON shipped beside the plugin so that a deployment can
 * inspect or override it without rebuilding: `catalogFile` points at another
 * document with the same shape.
 *
 * @module @try-works/dsh-model-as-tool/catalog
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ModelCatalogEntry, ModelInput, ModelParam, ModelParamType, WindowsSupport } from './types.ts'

/** Absolute path of the catalog document shipped with this package. */
export const DEFAULT_CATALOG_FILE = fileURLToPath(
  new URL('../catalog/desert-ant-models.json', import.meta.url),
)

const INPUTS: readonly ModelInput[] = ['text', 'audio', 'image', 'video', 'stroke', 'transcript']
const WINDOWS_SUPPORT: readonly WindowsSupport[] = [
  'native-node',
  'onnxruntime-node',
  'apple-only',
  'browser-only',
  'no-sdk',
]

/** Raised when the catalog document is missing, unparseable, or malformed. */
export class CatalogError extends Error {
  override readonly name = 'CatalogError'
}

function fail(source: string, message: string): never {
  throw new CatalogError(`${source}: ${message}`)
}

function requireString(entry: Record<string, unknown>, key: string, source: string): string {
  const value = entry[key]
  if (typeof value !== 'string' || value.length === 0) {
    fail(source, `entry "${String(entry.id ?? '?')}" field "${key}" must be a non-empty string`)
  }
  return value
}

const PARAM_TYPES: readonly ModelParamType[] = ['string', 'number', 'integer', 'boolean', 'string[]']

/**
 * Normalize one parameter declaration.
 *
 * The string shorthand exists because most parameters are prose descriptions of
 * a string argument; accepting it here keeps the catalog readable while the
 * registrar still receives one resolved shape.
 * @param raw - the declaration as written in the document.
 * @param scope - entry description for error messages.
 * @param key - parameter name.
 * @returns the normalized parameter.
 */
function parseParam(raw: unknown, scope: string, key: string): ModelParam {
  if (typeof raw === 'string' && raw.length > 0) return { description: raw, type: 'string' }
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const spec = raw as Record<string, unknown>
    const description = spec.description
    if (typeof description !== 'string' || description.length === 0) {
      throw new CatalogError(`${scope} tool.params.${key}.description must be a non-empty string`)
    }
    const type = spec.type
    if (type !== undefined && !PARAM_TYPES.includes(type as ModelParamType)) {
      throw new CatalogError(
        `${scope} tool.params.${key}.type must be one of ${PARAM_TYPES.join(', ')}`,
      )
    }
    return { description, type: (type as ModelParamType | undefined) ?? 'string' }
  }
  throw new CatalogError(`${scope} tool.params.${key} must be a description string or a parameter object`)
}

/**
 * Validate the optional `contract` binding.
 *
 * A model without a contract is legitimate — it keeps a per-model tool — but a
 * malformed contract identity would bind a tool to a name no caller can address,
 * so it fails at load rather than at registration.
 * @param value - the raw field.
 * @param scope - entry description for error messages.
 * @param source - document description for error messages.
 * @returns the contract id, or null when unbound.
 */
/**
 * Parse a model's extension provider binding (BASE-09).
 *
 * The binding names the package that implements the model. It is validated here
 * rather than trusted, because it decides which package's code the host will
 * import: a malformed binding must fail the catalog load rather than surface later
 * as an import of something unintended.
 * @param raw - the raw `provider` field.
 * @param source - the catalog source, for error messages.
 * @returns the binding field, or an empty object when absent.
 */
function parseProvider(raw: unknown, source: string): { provider?: { extension: string; modelId: string } } {
  if (raw === undefined || raw === null) return {}
  const value = raw as Record<string, unknown>
  const extension = value.extension
  const modelId = value.modelId
  if (typeof extension !== 'string' || extension.length === 0) {
    throw new Error(`${source}: provider.extension must be a non-empty package name`)
  }
  if (typeof modelId !== 'string' || modelId.length === 0) {
    throw new Error(`${source}: provider.modelId must be a non-empty string`)
  }
  // A relative path is admitted so a first-party package can be exercised from a
  // checkout; anything else must look like a package specifier.
  const packageLike = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(extension)
  const relativeLike = extension.startsWith('./') || extension.startsWith('../')
  if (!packageLike && !relativeLike) {
    throw new Error(
      `${source}: provider.extension ${JSON.stringify(extension)} is neither a package specifier nor a relative path`,
    )
  }
  return { provider: { extension, modelId } }
}

function parseContract(value: unknown, scope: string, source: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    throw new CatalogError(`${source}: ${scope} field "contract" must be a contract id or null`)
  }
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(value)) {
    throw new CatalogError(
      `${source}: ${scope} field "contract" ${JSON.stringify(value)} must be a dotted lower-case `
      + 'contract identity (for example "stt.transcribe")',
    )
  }
  return value
}

/**
 * Parse and validate one catalog entry. Validation is strict on purpose: every
 * downstream decision (which tool to register, whether it can run, what the
 * model sees) reads these fields, so a malformed entry must fail at load rather
 * than become a silently missing tool.
 * @param raw - one decoded JSON object.
 * @param source - description of where the document came from, for messages.
 * @param index - position in the array, for entries with no usable id.
 * @returns the validated entry.
 */
export function parseCatalogEntry(raw: unknown, source: string, index: number): ModelCatalogEntry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(source, `entry ${String(index)} must be an object`)
  }
  const entry = raw as Record<string, unknown>
  const id = requireString(entry, 'id', source)
  const scope = `entry "${id}"`

  const input = requireString(entry, 'input', source)
  if (!INPUTS.includes(input as ModelInput)) {
    fail(source, `${scope} has unsupported input ${JSON.stringify(input)} (expected one of ${INPUTS.join(', ')})`)
  }
  const windowsSupport = requireString(entry, 'windowsSupport', source)
  if (!WINDOWS_SUPPORT.includes(windowsSupport as WindowsSupport)) {
    fail(source, `${scope} has unsupported windowsSupport ${JSON.stringify(windowsSupport)} (expected one of ${WINDOWS_SUPPORT.join(', ')})`)
  }
  const tool = entry.tool
  if (typeof tool !== 'object' || tool === null) fail(source, `${scope} is missing its "tool" object`)
  const skill = entry.skill
  if (typeof skill !== 'object' || skill === null) fail(source, `${scope} is missing its "skill" object`)

  const toolSpec = tool as Record<string, unknown>
  const skillSpec = skill as Record<string, unknown>
  const params = toolSpec.params
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    fail(source, `${scope} tool.params must be an object`)
  }

  const bool = (key: string): boolean => {
    const value = entry[key]
    if (typeof value !== 'boolean') fail(source, `${scope} field "${key}" must be a boolean`)
    return value
  }
  const nullableNumber = (key: string): number | null => {
    const value = entry[key]
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
      fail(source, `${scope} field "${key}" must be a finite number or null`)
    }
    return value as number | null
  }
  const nullableString = (key: string): string | null => {
    const value = entry[key]
    if (value !== null && typeof value !== 'string') {
      fail(source, `${scope} field "${key}" must be a string or null`)
    }
    return value as string | null
  }
  const strings = (key: string): string[] => {
    const value = entry[key]
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
      fail(source, `${scope} field "${key}" must be an array of strings`)
    }
    return value as string[]
  }

  const toolName = requireString(toolSpec, 'name', source)
  if (!/^[a-z][a-z0-9_]*$/.test(toolName)) {
    fail(source, `${scope} tool.name ${JSON.stringify(toolName)} must be lower snake_case starting with a letter`)
  }
  const skillName = requireString(skillSpec, 'name', source)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) {
    fail(source, `${scope} skill.name ${JSON.stringify(skillName)} must be kebab-case`)
  }

  return {
    id,
    name: requireString(entry, 'name', source),
    summary: requireString(entry, 'summary', source),
    capability: requireString(entry, 'capability', source),
    contract: parseContract(entry.contract, scope, source),
    ...parseProvider(entry.provider, source),
    input: input as ModelInput,
    output: requireString(entry, 'output', source),
    languages: nullableNumber('languages'),
    modelSizeMB: nullableNumber('modelSizeMB'),
    appleOnly: bool('appleOnly'),
    closedBeta: bool('closedBeta'),
    verifiedRunnableOnWindows: bool('verifiedRunnableOnWindows'),
    windowsSupport: windowsSupport as WindowsSupport,
    npmPackage: nullableString('npmPackage'),
    npmSubpath: nullableString('npmSubpath'),
    requiresRuntime: strings('requiresRuntime'),
    cliVerb: nullableString('cliVerb'),
    license: requireString(entry, 'license', source),
    docsUrl: requireString(entry, 'docsUrl', source),
    hfRepo: requireString(entry, 'hfRepo', source),
    tool: {
      name: toolName,
      description: requireString(toolSpec, 'description', source),
      params: Object.fromEntries(
        Object.entries(params as Record<string, unknown>).map(([key, value]) => [
          key,
          parseParam(value, scope, key),
        ]),
      ),
      returns: requireString(toolSpec, 'returns', source),
    },
    skill: {
      name: skillName,
      description: requireString(skillSpec, 'description', source),
      ...typeof skillSpec.whenToUse === 'string' ? { whenToUse: skillSpec.whenToUse } : {},
    },
  }
}

/**
 * Load the catalog from a JSON document.
 * @param file - absolute path of the catalog document.
 * @returns every validated entry, in document order.
 * @throws CatalogError when the file cannot be read, is not valid JSON, is not an array, or holds a malformed entry.
 */
export function loadCatalog(file: string = DEFAULT_CATALOG_FILE): ModelCatalogEntry[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    // Node errors are not stable enough to switch on; the message is the point.
    throw new CatalogError(`cannot read model catalog ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new CatalogError(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(parsed)) throw new CatalogError(`${file} must contain a JSON array of model entries`)
  const entries = parsed.map((raw, index) => parseCatalogEntry(raw, file, index))
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new CatalogError(`${file} declares model id "${entry.id}" more than once`)
    seen.add(entry.id)
  }
  const toolNames = new Set<string>()
  for (const entry of entries) {
    if (toolNames.has(entry.tool.name)) {
      throw new CatalogError(`${file} maps tool name "${entry.tool.name}" to more than one model`)
    }
    toolNames.add(entry.tool.name)
  }
  return entries
}

/** Index a catalog by model id. */
export function indexCatalog(entries: readonly ModelCatalogEntry[]): Map<string, ModelCatalogEntry> {
  return new Map(entries.map(entry => [entry.id, entry]))
}
