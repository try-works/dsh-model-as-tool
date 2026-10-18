/**
 * The single source of truth for the `modelTools` Remote namespace.
 *
 * Three artifacts are built from this module and must never drift:
 * - `typert.host.mjs`: the Host Loader face the `typert-loader` registers as
 *   strict invocation descriptors (`./typert` package export);
 * - `typert.remote-client.mjs`: the mountable Client contribution (`./remote`);
 * - `client/client.model-tools.js`: the package-local lazy-CJS chunk the
 *   plugin's browser half loads with `require.async('./client.model-tools.js')`
 *   (the client module system serves only `./client`, so the contribution the
 *   page mounts travels as a sibling chunk).
 *
 * The wire method for install is `installExtension`, not `install`: DSH's
 * client RemoteNamespaceService owns a private method `install` and refuses a
 * descriptor method that collides with it. The Host service keeps its member
 * name `install`; the descriptor's `implementation` maps the two.
 *
 * These functions stay dependency-free and self-contained because
 * `scripts/gen-remote-artifacts.mjs` inlines their source into the browser
 * chunk; changing one to reference an enclosing binding breaks the chunk.
 */

/** npm package that owns the namespace. */
export const PACKAGE = '@try-works/dsh-model-as-tool'
/** Cordis service key the Host dispatch resolves. */
export const SERVICE = 'modelTools'
/** Wire namespace exposed as `ctx.remote.modelTools`. */
export const NAMESPACE = 'modelTools'
/** Browser-facing install method (see the collision note above). */
export const INSTALL_WIRE_METHOD = 'installExtension'

/** Structural validators for the JSON values the wire carries. */
const STRING = { kind: 'string' }
const BOOLEAN = { kind: 'boolean' }
const NULLABLE_STRING = { kind: 'nullable', of: STRING }
const STRING_LIST = { kind: 'array', of: STRING }
const INTEGRITY = {
  kind: 'union',
  of: [
    { kind: 'literal', value: 'unchanged' },
    { kind: 'literal', value: 'changed' },
    { kind: 'literal', value: 'unknown' },
  ],
}
const EXTENSION_STATE = {
  kind: 'object',
  fields: {
    id: STRING,
    package: NULLABLE_STRING,
    version: NULLABLE_STRING,
    installed: BOOLEAN,
    active: BOOLEAN,
    disabled: BOOLEAN,
    integrity: INTEGRITY,
    tools: STRING_LIST,
    reason: NULLABLE_STRING,
  },
}
const DESCRIBE_RESULT = {
  kind: 'object',
  fields: {
    store: NULLABLE_STRING,
    writable: BOOLEAN,
    sourceDir: NULLABLE_STRING,
    extensions: { kind: 'array', of: EXTENSION_STATE },
  },
}
const INSTALL_RESULT = {
  kind: 'object',
  fields: { id: STRING, version: STRING, active: BOOLEAN },
}
const TOGGLE_RESULT = {
  kind: 'object',
  fields: { id: STRING, active: BOOLEAN, disabled: BOOLEAN },
}
const OPTIONAL_STRING = { kind: 'optional', of: STRING }

/**
 * Validate one boundary value against the declarative schema.
 * @param schema - schema node from the METHOD_SPECS data.
 * @param value - untrusted boundary value.
 * @returns the validated value; objects are rebuilt without undeclared fields.
 * @throws TypeError when the value does not match.
 */
export function parseModelToolsValue(schema, value) {
  switch (schema.kind) {
    case 'string':
      if (typeof value !== 'string') throw new TypeError('expected a string')
      return value
    case 'boolean':
      if (typeof value !== 'boolean') throw new TypeError('expected a boolean')
      return value
    case 'null':
      if (value !== null) throw new TypeError('expected null')
      return null
    case 'literal':
      if (value !== schema.value) throw new TypeError('expected ' + JSON.stringify(schema.value))
      return value
    case 'optional':
      return value === undefined ? undefined : parseModelToolsValue(schema.of, value)
    case 'nullable':
      return value === null ? null : parseModelToolsValue(schema.of, value)
    case 'array':
      if (!Array.isArray(value)) throw new TypeError('expected an array')
      return value.map((item) => parseModelToolsValue(schema.of, item))
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError('expected an object')
      }
      const parsed = {}
      for (const [key, field] of Object.entries(schema.fields)) {
        const raw = value[key]
        if (field.kind === 'optional') {
          const item = parseModelToolsValue(field, raw)
          if (item !== undefined) parsed[key] = item
          continue
        }
        if (raw === undefined) throw new TypeError('missing field ' + JSON.stringify(key))
        parsed[key] = parseModelToolsValue(field, raw)
      }
      return parsed
    }
    case 'union': {
      let last
      for (const variant of schema.of) {
        try {
          return parseModelToolsValue(variant, value)
        } catch (error) {
          last = error
        }
      }
      throw new TypeError('value matched no union variant: ' + last.message)
    }
    default:
      throw new TypeError('unknown schema kind ' + JSON.stringify(schema.kind))
  }
}

/**
 * Build one strict boundary codec from a declarative schema.
 * @param typeSymbol - stable type identity recorded on the codec.
 * @param schema - declarative schema the parser enforces.
 * @returns strict codec with a cached parser factory.
 */
export function codecForModelToolsValue(typeSymbol, schema) {
  let parser
  return {
    mode: 'strict',
    typeSymbol,
    create: () => (parser ??= { parse: (value) => parseModelToolsValue(schema, value) }),
  }
}

/**
 * Turn the static method specs into Host/client invocation descriptors.
 * @param packageName - owning npm package.
 * @param serviceKey - Cordis service key the Host dispatch resolves.
 * @param namespace - wire namespace (also the Client Remote service suffix).
 * @param specs - METHOD_SPECS.
 * @returns fresh descriptors both the Host registry and the Client mount accept.
 */
export function descriptorsFromModelToolsSpecs(packageName, serviceKey, namespace, specs) {
  return specs.map((spec) => {
    const descriptor = {
      id: packageName + '#' + namespace + '/' + spec.method,
      service: serviceKey,
      namespace,
      method: spec.method,
      description: spec.description,
      invocation: { kind: 'direct' },
      parameters: spec.parameters.map((parameter) => {
        const entry = {
          name: parameter.name,
          wire: parameter.wire,
          source: 'json',
          codec: codecForModelToolsValue(parameter.typeSymbol, parameter.schema),
          strictCodec: codecForModelToolsValue(parameter.strictTypeSymbol, parameter.schema),
        }
        if (parameter.description !== undefined) entry.description = parameter.description
        if (parameter.acceptsUndefined === true) entry.acceptsUndefined = true
        return entry
      }),
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: spec.result.typeSymbol,
        create: codecForModelToolsValue(spec.result.typeSymbol, spec.result.schema).create,
        description: spec.result.description,
      },
    }
    if (spec.implementation !== undefined) descriptor.implementation = spec.implementation
    return descriptor
  })
}

/** Static method specs. JSON-safe so the browser chunk can embed them verbatim. */
export const METHOD_SPECS = [
  {
    method: 'describe',
    description: 'Read the current extension state; the page calls it on mount and after each action.',
    parameters: [],
    result: {
      typeSymbol: PACKAGE + '#' + NAMESPACE + '/describe:result',
      description: 'the extension surface as the host currently sees it.',
      schema: DESCRIBE_RESULT,
    },
  },
  {
    method: INSTALL_WIRE_METHOD,
    implementation: 'install',
    description: 'Install one extension from `source`, or the configured first-party source.',
    parameters: [
      {
        name: 'id',
        wire: 'id',
        description: 'the extension id, for example `@try-works/extension-laya`.',
        acceptsUndefined: false,
        typeSymbol: PACKAGE + '#' + NAMESPACE + '/install:id',
        strictTypeSymbol: PACKAGE + '#' + NAMESPACE + '/install:id',
        schema: STRING,
      },
      {
        name: 'source',
        wire: 'source',
        description: 'an explicit install directory; absent means the configured first-party source.',
        acceptsUndefined: true,
        typeSymbol: PACKAGE + '#' + NAMESPACE + '/install:source',
        strictTypeSymbol: PACKAGE + '#' + NAMESPACE + '/install:source',
        schema: OPTIONAL_STRING,
      },
    ],
    result: {
      typeSymbol: PACKAGE + '#' + NAMESPACE + '/install:result',
      description: 'the installed extension; installation is not activation.',
      schema: INSTALL_RESULT,
    },
  },
  {
    method: 'enable',
    description: 'Activate an installed extension (removes it from `disabledExtensions`).',
    parameters: [
      {
        name: 'id',
        wire: 'id',
        description: 'the extension id to activate.',
        acceptsUndefined: false,
        typeSymbol: PACKAGE + '#' + NAMESPACE + '/enable:id',
        strictTypeSymbol: PACKAGE + '#' + NAMESPACE + '/enable:id',
        schema: STRING,
      },
    ],
    result: {
      typeSymbol: PACKAGE + '#' + NAMESPACE + '/enable:result',
      description: 'the extension state after activation.',
      schema: TOGGLE_RESULT,
    },
  },
  {
    method: 'disable',
    description: 'Deactivate an extension (adds it to `disabledExtensions`).',
    parameters: [
      {
        name: 'id',
        wire: 'id',
        description: 'the extension id to deactivate.',
        acceptsUndefined: false,
        typeSymbol: PACKAGE + '#' + NAMESPACE + '/disable:id',
        strictTypeSymbol: PACKAGE + '#' + NAMESPACE + '/disable:id',
        schema: STRING,
      },
    ],
    result: {
      typeSymbol: PACKAGE + '#' + NAMESPACE + '/disable:result',
      description: 'the extension state after deactivation.',
      schema: TOGGLE_RESULT,
    },
  },
]

/** The mountable Client contribution (and the Host artifact's invocation source). */
export function buildContribution() {
  return {
    package: PACKAGE,
    descriptors: descriptorsFromModelToolsSpecs(PACKAGE, SERVICE, NAMESPACE, METHOD_SPECS),
  }
}

/** Host documentation for the four methods, kept beside their specs. */
const SERVICE_MODEL = {
  description: 'Host service backing the generated `ctx.remote.modelTools` namespace. It reports the extension store truthfully (store null when unconfigured) and performs staged installs plus persisted enable/disable.',
  summary: 'Host service backing the generated `ctx.remote.modelTools` namespace.',
  tags: [],
  jsDoc: '/** Host service backing the generated `ctx.remote.modelTools` namespace. */',
  key: SERVICE,
  exportName: 'ExtensionsService',
  members: METHOD_SPECS.map((spec) => ({
    kind: 'method',
    name: spec.implementation ?? spec.method,
    signature: spec.method === 'describe'
      ? 'describe(signal?: AbortSignal): Promise<ExtensionsDescribeResult>'
      : spec.method === 'installExtension'
        ? 'install(id: string, source?: string, signal?: AbortSignal): Promise<ExtensionInstallResult>'
        : `${spec.method}(id: string, signal?: AbortSignal): Promise<ExtensionToggleResult>`,
    description: spec.description,
    jsDoc: `/** ${spec.description} */`,
  })),
  types: [],
}

/**
 * Build the Host Loader manifest the `typert-loader` validates and registers.
 * @returns `TYPERT` host-face contribution.
 */
export function buildHostManifest() {
  return {
    package: PACKAGE,
    face: 'host',
    schemas: [],
    get invocations() {
      return buildContribution().descriptors
    },
    model: {
      services: [SERVICE_MODEL],
      events: [],
      objects: [],
    },
  }
}
