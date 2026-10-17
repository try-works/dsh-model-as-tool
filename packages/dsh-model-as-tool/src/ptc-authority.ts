/**
 * The authorized tool bindings a PTC program may call (CODE-03, ARCH-01, SEC-03).
 *
 * The directive is specific about this, and about what NOT to do:
 *
 *   "ONE authorized-tool-pipeline function feeding both native PTC and external
 *    `tool_mode_run` — intersect requested names with the grant and the visible tool set,
 *    REJECT unknown/forbidden rather than omit."
 *
 * **Reject rather than omit** is the whole design. A program that asks for a tool it may
 * not have must fail loudly: silently handing it a smaller namespace produces a program
 * that runs, quietly does something other than what it says, and reports success. That is
 * worse than a refusal, because the caller cannot tell the difference.
 *
 * The bindings themselves are built with a **null prototype**, so a program cannot reach
 * `Object.prototype` through a binding name — `toString`, `constructor` and `__proto__`
 * stop being reachable as if they were tools.
 *
 * @module @try-works/dsh-model-as-tool/ptc-authority
 */

/**
 * One binding a program may call.
 *
 * The shape is what a PTC runtime expects: a function that takes already-validated
 * arguments and returns the tool's canonical value.
 */
export type ToolBinding = (args: Record<string, unknown>) => Promise<unknown>

/** What a program asked for. */
export interface ProgramRequest {
  /** The tool names the generated program declares it will call. */
  readonly requested: readonly string[]
}

/** What the caller is permitted to reach. */
export interface ProgramAuthority {
  /**
   * The tool names the caller's grant admits.
   *
   * This is the AUTHORIZATION half. A tool absent here is forbidden regardless of whether
   * it is registered.
   */
  readonly granted: readonly string[]
  /**
   * The tool names actually registered right now.
   *
   * This is the AVAILABILITY half, and it is separate: a granted tool whose owning
   * extension is deactivated is not available, while a registered tool the caller has no
   * grant for is not permitted. Only the INTERSECTION is bindable.
   */
  readonly visible: readonly string[]
}

/** Why one requested name was refused. */
export interface BindingRejection {
  readonly name: string
  readonly reason:
    /** No such tool is registered. */
    | 'unknown'
    /** Registered, but the caller's grant does not admit it. */
    | 'forbidden'
    /** Requested more than once, which makes the program ambiguous. */
    | 'duplicate'
    /** Not a usable identifier as a binding name. */
    | 'invalid-name'
    /** CODE-07: never bindable inside a program, regardless of grant. */
    | 'excluded'
  /** What the caller can do about it, when anything. */
  readonly remedy: string
}

/** The outcome of authorizing a program's requested tools. */
export type AuthorityDecision =
  | {
    readonly ok: true
    /** The bindings, with a null prototype. */
    readonly bindings: Record<string, ToolBinding>
    /** The names that were bound, in request order. */
    readonly bound: readonly string[]
  }
  | {
    readonly ok: false
    /**
     * EVERY rejection, not the first.
     *
     * A program asking for three tools it cannot have should learn all three in one
     * round rather than being handed the next one each time.
     */
    readonly rejections: readonly BindingRejection[]
  }

/**
 * Whether a name is usable as a binding.
 *
 * A generated program references bindings as identifiers, so a name that is not a plain
 * identifier cannot be bound — and `__proto__` in particular must never become a key on
 * the map, since assigning it would change the object's prototype rather than add a field.
 * @param name - the candidate name.
 * @returns whether it is usable.
 */
export function isBindableName(name: string): boolean {
  if (name.length === 0 || name.length > 64) return false
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return false
  // Reserved words would produce a program that cannot be generated.
  if (RESERVED_WORDS.has(name)) return false
  // Globals a binding must never shadow, because the runtime supplies them.
  if (RESERVED_BINDING_GLOBALS.has(name)) return false
  return true
}

/** Words that cannot appear as bindings in the generated language. */
const RESERVED_WORDS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
  'yield', 'let', 'static', 'implements', 'interface', 'package', 'private', 'protected',
  'public',
])

/** Globals the runtime supplies, which a binding must not replace. */
const RESERVED_BINDING_GLOBALS = new Set([
  'console', 'globalThis', 'process', 'require', 'module', 'exports', 'JSON', 'Math',
  'Promise', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'RegExp', 'Error',
  'Map', 'Set', 'Symbol', 'BigInt', 'Reflect', 'Proxy', 'undefined', 'NaN', 'Infinity',
  'eval', 'Function', 'arguments', 'prototype', 'constructor', '__proto__',
  /**
   * EVERY `Object.prototype` member, named explicitly.
   *
   * These are not globals and not reserved words, so a check for those two categories
   * alone lets them through — and they are exactly the names a program probes for. Even
   * with a null-prototype map, refusing them BY NAME means a name that resolves to
   * inherited behaviour can never be bound, rather than depending on the map's prototype
   * staying null forever.
   */
  'toString', 'toLocaleString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
  'propertyIsEnumerable', '__defineGetter__', '__defineSetter__', '__lookupGetter__',
  '__lookupSetter__',
])

/**
 * Tool names a program binding must NEVER expose, regardless of grant (CODE-07).
 *
 * `tool_mode_run` is the recursive composition door: a program could nest programs, which
 * the requirement forbids in v1. The management surface (`model_tools` and the extension
 * install/activation controls) is operator territory: EXT-32 excludes installer and
 * administration bindings from Code Mode, and SEC-09 keeps installation approval separate
 * from tool-use permission, so a program that could reach them would hold the management
 * grant by proxy.
 *
 * EXPORTED so the planning surface (NDL-02) reuses the SAME names: a `tools_plan`
 * proposal must never target the composition door or the management surface either, and a
 * second, independently maintained copy of this list would drift the first time one of
 * them was edited. One set, two consumers, both refused by name.
 *
 * SEALED AS A FROZEN ARRAY, deliberately not a frozen `Set`: freezing a `Set` does NOT
 * prevent `add`/`delete` (those methods mutate internal slots without consulting
 * extensibility), so a frozen Set would only LOOK immutable. A frozen array throws on
 * every mutation in strict mode, so neither consumer — nor any code holding a
 * reference — can add or remove a name at runtime and silently desynchronize the two
 * surfaces that depend on it.
 */
export const EXCLUDED_BINDINGS: readonly string[] = Object.freeze(['tool_mode_run', 'model_tools', 'tool_mode_list', 'tool_mode_describe'] as const)

/**
 * Build the bindings a program may call (CODE-03, SEC-03).
 *
 * Intersects the requested names with BOTH the grant and the visible set, and refuses the
 * whole request if anything is unattainable — so a program never runs against a smaller
 * namespace than it declared.
 *
 * @param request - what the program asked for.
 * @param authority - what is granted and what is available.
 * @param resolve - resolves one bound name to its implementation.
 * @returns the bindings, or every rejection.
 */
export function authorizeProgramTools(
  request: ProgramRequest,
  authority: ProgramAuthority,
  resolve: (name: string) => ToolBinding | undefined,
): AuthorityDecision {
  const granted = new Set(authority.granted)
  const visible = new Set(authority.visible)
  const rejections: BindingRejection[] = []
  const seen = new Set<string>()
  const bound: string[] = []

  for (const name of request.requested) {
    if (!isBindableName(name)) {
      rejections.push({
        name,
        reason: 'invalid-name',
        remedy: 'A binding name must be a plain identifier that is not a reserved word, a runtime global or __proto__.',
      })
      continue
    }
    if (seen.has(name)) {
      rejections.push({
        name,
        reason: 'duplicate',
        remedy: 'Request each tool once; a repeated name makes the generated bindings ambiguous.',
      })
      continue
    }
    seen.add(name)

    /**
     * CODE-07 EXCLUSIONS ARE CHECKED FIRST.
     *
     * These names are un-bindable by policy, not by grant state: whether the caller's
     * grant admits them is irrelevant, because a program must never hold the composition
     * door or the management surface regardless of who authorizes it.
     */
    if (EXCLUDED_BINDINGS.includes(name)) {
      rejections.push({
        name,
        reason: 'excluded',
        remedy: `"${name}" cannot be called from a program: recursive composition and management bindings are excluded from Code Mode (CODE-07).`,
      })
      continue
    }

    /**
     * FORBIDDEN IS CHECKED BEFORE UNKNOWN, deliberately.
     *
     * A caller probing for names it has no grant for must be told "forbidden" rather than
     * "unknown": telling it a tool does not exist would let it infer the difference
     * between a name that is absent and a name it may not use, and the second is
     * information the caller has not earned.
     */
    if (!granted.has(name)) {
      rejections.push({
        name,
        reason: 'forbidden',
        remedy: 'Request only tools this invocation is authorized for; the grant is not widened by asking.',
      })
      continue
    }
    if (!visible.has(name)) {
      rejections.push({
        name,
        reason: 'unknown',
        remedy: 'The tool is authorized but not currently registered; its owning extension may be deactivated.',
      })
      continue
    }
    if (resolve(name) === undefined) {
      rejections.push({
        name,
        reason: 'unknown',
        remedy: 'No implementation is bound for this name.',
      })
      continue
    }
    bound.push(name)
  }

  if (rejections.length > 0) {
    // ALL OR NOTHING. Binding the reachable subset would run a program that does not do
    // what it declares, which is the failure mode this refusal exists to prevent.
    return { ok: false, rejections }
  }

  /**
   * A NULL-PROTOTYPE map, built with `defineProperty`.
   *
   * A plain object literal would inherit `toString`, `constructor` and friends, so a
   * program referencing `toString()` would reach `Object.prototype` instead of failing.
   * A null prototype removes that path entirely rather than filtering the names that use
   * it.
   */
  const bindings = Object.create(null) as Record<string, ToolBinding>
  for (const name of bound) {
    const binding = resolve(name) as ToolBinding
    Object.defineProperty(bindings, name, {
      value: binding,
      enumerable: true,
      writable: false,
      configurable: false,
    })
  }
  return { ok: true, bindings, bound }
}

/**
 * Describe a refusal for a caller (CODE-03).
 *
 * Names every rejection and why, because a program author who is told only that the
 * request failed cannot fix it.
 * @param rejections - the refusals.
 * @returns a readable summary.
 */
export function describeRejections(rejections: readonly BindingRejection[]): string {
  const lines = rejections.map(entry => `  ${entry.name}: ${entry.reason} — ${entry.remedy}`)
  return `the program requested tools it may not use:\n${lines.join('\n')}`
}
