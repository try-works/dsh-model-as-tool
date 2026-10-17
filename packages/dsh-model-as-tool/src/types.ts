/**
 * Data model for the Desert Ant Labs model catalog and the capability layer
 * that decides whether a model can actually run in the current DSH process.
 *
 * @module @try-works/dsh-model-as-tool/types
 */

/** The kind of value a model consumes. */
export type ModelInput = 'text' | 'audio' | 'image' | 'video' | 'stroke' | 'transcript'

/**
 * How the model's weights are reachable from a Node process on each platform.
 * This is the field the capability resolver keys off, because it encodes the
 * upstream packaging reality rather than an aspiration.
 */
export type WindowsSupport =
  /** Ships a prebuilt native core for this platform and works in plain Node. */
  | 'native-node'
  /** Needs a caller-supplied ONNX Runtime module (e.g. `onnxruntime-node`). */
  | 'onnxruntime-node'
  /** No Node runtime anywhere: Apple platforms only, through the Swift SDK. */
  | 'apple-only'
  /** Prebuilt native core exists, but not for this platform/arch. */
  | 'browser-only'
  /** Weights exist but no SDK ships them at all. */
  | 'no-sdk'

/** The JSON-level type of one tool parameter. */
export type ModelParamType = 'string' | 'number' | 'integer' | 'boolean' | 'string[]'

/**
 * One declared tool parameter.
 *
 * A bare string is shorthand for `{ type: 'string', description }`, which is
 * what most of the catalog's parameters are; the object form exists for the
 * parameters that are genuinely numbers, booleans or string lists.
 */
export interface ModelParam {
  /** Model-facing description of the parameter. */
  readonly description: string
  /** Declared type; defaults to `string`. */
  readonly type?: ModelParamType
}

/** One parameter as written in the catalog document. */
export type ModelParamSpec = string | ModelParam

/** The model-facing tool a catalog entry installs. */
export interface ModelToolSpec {
  /** DSH tool name (lower snake_case). */
  readonly name: string
  /** Model-facing description of the tool. */
  readonly description: string
  /** Parameter name -> declaration, in documentation order; the first is the primary input. */
  readonly params: Readonly<Record<string, ModelParam>>
  /** What the tool returns. */
  readonly returns: string
}

/** The skill a catalog entry publishes alongside its tool. */
export interface ModelSkillSpec {
  /** Kebab-case skill name. */
  readonly name: string
  /** Short routing description for the skill catalog. */
  readonly description: string
  /** Optional extra routing guidance. */
  readonly whenToUse?: string
}

/** One model in the Desert Ant Labs catalog. */
export interface ModelCatalogEntry {
  readonly id: string
  readonly name: string
  readonly summary: string
  readonly capability: string
  /**
   * The standard contract this model implements, or null when none exists yet.
   *
   * This is what makes tool identity independent of model identity (BASE-02): the
   * contract decides the tool name a caller sees, so a second model implementing
   * the same contract joins the existing tool instead of creating a duplicate. A
   * model with no contract keeps a per-model tool under its own name.
   */
  readonly contract: string | null
  /**
   * The extension package that implements this model (BASE-09).
   *
   * A binding held as DATA, not a switch on the model name. The host loads
   * whatever package this names through the PUBLIC extension API, so a first-party
   * package takes the same route as a third-party one and adding a vendor means
   * publishing a package plus adding this field — with no host change.
   */
  readonly provider?: { readonly extension: string; readonly modelId: string }
  readonly input: ModelInput
  readonly output: string
  readonly languages: number | null
  readonly modelSizeMB: number | null
  readonly appleOnly: boolean
  readonly closedBeta: boolean
  /** True only where this repository verified a real inference on Windows x64. */
  readonly verifiedRunnableOnWindows: boolean
  readonly windowsSupport: WindowsSupport
  readonly npmPackage: string | null
  readonly npmSubpath: string | null
  readonly requiresRuntime: readonly string[]
  readonly cliVerb: string | null
  readonly license: string
  readonly docsUrl: string
  readonly hfRepo: string
  readonly tool: ModelToolSpec
  readonly skill: ModelSkillSpec
}

/** How an adapter reaches a model at run time. */
export type ModelRoute =
  /** A Tool Mode extension package loaded in this process. */
  | 'extension'
  /** An npm package loaded in this process. */
  | 'npm-native'
  /** An npm package plus a caller-supplied ONNX Runtime module. */
  | 'npm-onnxruntime'
  /** The Desert Ant CLI, run as a child process (macOS and Linux). */
  | 'cli'
  /** A user-hosted bridge, reached over HTTP. */
  | 'remote'
  /** No route available in this process. */
  | 'unavailable'

/** The capability resolver's verdict for one model in the current process. */
export interface CapabilityVerdict {
  /** Whether an adapter can actually produce a working tool for this model. */
  readonly runnable: boolean
  readonly route: ModelRoute
  /** Why the model is or is not runnable, always populated for a negative verdict. */
  readonly reason: string
  /** Resolved package specifiers this verdict depended on, for diagnostics. */
  readonly resolved?: readonly string[]
  /** Resolved package specifiers that were required but missing. */
  readonly missing?: readonly string[]
}
