/**
 * The recipe authoring CLI (RCP-08).
 *
 * Three commands, each a required new tool rather than an existing npm/DSH
 * command: `validate` checks a draft against BOTH authorities (the published
 * `harness-model-recipe.schema.json` shipped beside this module AND the code
 * validator `parseRecipe`), `describe` prints the effective bounds an operator
 * reads before deciding, and `pack` builds a declarative-extension package
 * (manifest + recipes, NO executable code) consumable by the extension install
 * path.
 *
 * Guardrails built in rather than documented:
 *
 * - The schema is read from THIS PACKAGE'S SHIPPED FILE, resolved relative to
 *   the module (so a packed install validates against the packed artifact, not
 *   some source checkout).
 * - Packing validates the exact production artifact and runs NO lifecycle
 *   scripts: the output is written directly (directory + a store-method zip),
 *   never through `npm pack`.
 * - Nothing here runs inference, installs or activates anything, or touches
 *   the network (RCP-08's creation rules).
 * - Exit codes are a contract: 0 valid, 1 invalid (every refusal named),
 *   2 usage or IO failure.
 *
 * RCP-09 (agent-assisted creation with an authoring grant) is NOT claimed by
 * this module: the CLI is a plain argv/stdio tool, which an agent CAN drive,
 * but the authoring-grant and draft-directory policy belong to the host and are
 * left as the recorded remainder.
 *
 * @module @try-works/tool-mode-recipes/cli
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, parse, resolve, sep } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'

import {
  INITIAL_MAX_IMAGE_INPUTS,
  INITIAL_MAX_OUTPUT_TOKENS,
  parseRecipe,
  toCanonicalRecipe,
  type RecipeManifest,
} from './recipe-format.ts'
import {
  EDITABLE_FIELDS,
  policyEditRefusal,
  templateFiles,
  validateCreateArguments,
  type CreateTemplate,
} from './templates.ts'
import {
  runFixtureSuite,
  validateFixtureDocument,
  type FixtureDocument,
} from './fixture-provider.ts'
import { INITIAL_HOST_POLICY } from './broker.ts'

/** Where the CLI writes. Injected so a test can capture output. */
export interface RecipeCliIo {
  out(line: string): void
  err(line: string): void
}

/** The published schema, shipped beside this module (RCP-02's artifact). */
const SHIPPED_SCHEMA_URL = new URL('../schema/harness-model-recipe.schema.json', import.meta.url)

/** Load and compile the shipped schema, once per invocation. */
function schemaValidator(): { validate: (document: unknown) => string[]; loadError?: string } {
  let text: string
  try {
    text = readFileSync(fileURLToPath(SHIPPED_SCHEMA_URL), 'utf8')
  } catch (error) {
    return { validate: () => [], loadError: `the shipped schema could not be read: ${messageOf(error)}` }
  }
  let schema: unknown
  try {
    schema = JSON.parse(text)
  } catch (error) {
    return { validate: () => [], loadError: `the shipped schema is not valid JSON: ${messageOf(error)}` }
  }
  try {
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema as never)
    return {
      validate: value => (validate(value) ? [] : (validate.errors ?? []).map(error =>
        `${error.instancePath === '' ? '(root)' : error.instancePath} ${error.message ?? 'is invalid'}`)),
    }
  } catch (error) {
    return { validate: () => [], loadError: `the shipped schema does not compile: ${messageOf(error)}` }
  }
}

/** The two-verdict validation of one recipe document. */
export interface RecipeVerdict {
  /** The published-schema verdict. */
  readonly schemaOk: boolean
  /** Rendered schema violations, one per refusal. */
  readonly schemaViolations: readonly string[]
  /** The code-validator verdict. */
  readonly codeOk: boolean
  /** The code validator's rendered refusals. */
  readonly codeViolations: readonly string[]
  /** The parsed recipe, when the code validator admits the document. */
  readonly recipe?: RecipeManifest
}

/** Validate one decoded document against BOTH authorities (RCP-02, RCP-08). */
export function judgeRecipe(document: unknown): RecipeVerdict {
  const { validate, loadError } = schemaValidator()
  const parsed = parseRecipe(document)
  const schemaViolations = loadError !== undefined ? [loadError] : validate(document)
  return {
    schemaOk: loadError === undefined && schemaViolations.length === 0,
    schemaViolations,
    codeOk: parsed.ok,
    codeViolations: parsed.ok ? [] : parsed.errors,
    ...parsed.ok ? { recipe: parsed.recipe } : {},
  }
}

/** Read and decode a recipe file; IO problems are the CALLER's to report as usage failures. */
function readRecipeFile(path: string): { document?: unknown; ioError?: string } {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return { ioError: `cannot read ${path}: ${messageOf(error)}` }
  }
  try {
    return { document: JSON.parse(text) }
  } catch (error) {
    return { ioError: `${path} is not valid JSON: ${messageOf(error)}` }
  }
}

/** Print a verdict; returns whether it was fully clean. */
function printVerdict(io: RecipeCliIo, subject: string, verdict: RecipeVerdict): boolean {
  io.out(`schema: ${verdict.schemaOk ? 'OK' : `${verdict.schemaViolations.length} violation(s)`}`)
  for (const violation of verdict.schemaViolations) io.err(`  ${subject}: ${violation}`)
  io.out(`code: ${verdict.codeOk ? 'OK' : `${verdict.codeViolations.length} violation(s)`}`)
  for (const violation of verdict.codeViolations) io.err(`  ${subject}: ${violation}`)
  return verdict.schemaOk && verdict.codeOk
}

const USAGE = `tool-mode-recipe — author declarative harness-model recipes (RCP-08)

  validate <recipe.json>                  validate a draft against the published
                                          harness-model-recipe.schema.json AND the
                                          code validator; every refusal is named
  describe <recipe.json>                  print the effective bounds: tool/contract,
                                          inputs, output and image ceilings,
                                          destinations, recording, context
  create --template <image-description|text-title>
         [--name <recipe-id>] [--description <text>]
         [--out <dir>]                    emit a STATIC draft project (recipe, input/
                                          output schemas, a starter skill note, a
                                          starter fixtures file, a README) into a
                                          NEW directory; nothing is installed,
                                          activated, downloaded or inferred, and an
                                          existing target is refused
  edit-draft <recipe.json>
         --set <field> --value <text>       a bounded static mutation over the safe
                                            fields (description, maxOutputTokens,
                                            imageInputs.max); policy fields are
                                            refused by name and the result must
                                            validate before it is written
  test <project-dir>
         --fixtures <fixtures.json>       run the recipe(s) through the REAL broker
                                          against a SCRIPTED fake provider (never a
                                          real model): binding, budget, failure
                                          vocabulary and the provider-call ceiling
  pack <recipe.json | project-dir>        build a declarative-extension package
       [--name <pkg>] [--version <x.y.z>]
       [--description <text>] [--out <dir>]
                                          (default --out ./dist) — manifest +
                                          recipes JSON, NO executable code, no
                                          lifecycle scripts run

  --live is NOT provided by this build: a live run requires an explicit deployment
  executor profile with consent and limits (recorded remainder, RCP-08).

Exit codes: 0 valid / packed / passed, 1 invalid recipe or fixture failure, 2 usage or IO failure.`

/** Parsed pack options. */
interface PackOptions {
  readonly out: string
  readonly name?: string
  readonly version?: string
  readonly description?: string
}

/**
 * Run one CLI invocation.
 * @param argv - arguments after the executable name.
 * @param io - the output sinks.
 * @returns a promise of the process exit code.
 */
export async function runRecipeCli(argv: readonly string[], io: RecipeCliIo): Promise<number> {
  try {
    return await dispatchRecipeCli(argv, io)
  } catch (error) {
    // The exit-2 contract: an UNEXPECTED failure (IO, filesystem, decode) is a
    // named usage/IO refusal — never a raw stack, never exit 1.
    io.err(`IO failure: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}

async function dispatchRecipeCli(argv: readonly string[], io: RecipeCliIo): Promise<number> {
  // A NULL-PROTOTYPE flags map: `--__proto__ x` must not touch the object's
  // prototype chain (the name is still refused by the per-command flag set).
  const positional: string[] = []
  const flags: Record<string, string | true> = Object.create(null) as Record<string, string | true>
  const booleanFlags = new Set(['help', 'live'])
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const name = token.slice(2)
    if (name === 'help') {
      io.out(USAGE)
      return 0
    }
    if (booleanFlags.has(name)) {
      // A boolean flag REFUSES a following value token: `--live <value>` must
      // not silently consume the value and downgrade the live request.
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('--')) {
        io.err(`the flag --${name} takes no value; ${JSON.stringify(next)} is not a flag`)
        io.err(USAGE)
        return 2
      }
      flags[name] = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      flags[name] = true
      continue
    }
    flags[name] = value
    index += 1
  }

  const [command, ...rest] = positional
  if (command === undefined) {
    io.err(USAGE)
    return 2
  }

  // A mistyped flag must be refused, never silently ignored (the contract the
  // original parser pinned): each command names its accepted flags.
  const acceptedFlags: Record<string, readonly string[]> = {
    validate: [], describe: [],
    pack: ['out', 'name', 'version', 'description'],
    create: ['template', 'name', 'description', 'out'],
    'edit-draft': ['set', 'value'],
    test: ['fixtures', 'live'],
  }
  const allowed = acceptedFlags[command]
  if (allowed === undefined) {
    io.err(`unknown command ${JSON.stringify(command)}`)
    io.err(USAGE)
    return 2
  }
  for (const name of Object.keys(flags)) {
    if (!allowed.includes(name)) {
      io.err(`unknown option --${name} for ${JSON.stringify(command)}`)
      io.err(USAGE)
      return 2
    }
  }

  // Flag-style commands: create / edit-draft / test.
  if (command === 'create') {
    return createCommand(flags, io)
  }
  if (command === 'edit-draft') {
    return editDraftCommand(rest, flags, io)
  }
  if (command === 'test') {
    return await testCommand(rest, flags, io)
  }

  // The original positional commands keep their exact contract.
  if (rest.length !== 1) {
    io.err(USAGE)
    return 2
  }
  const subject = rest[0] as string

  if (command === 'validate' || command === 'describe') {
    const { document, ioError } = readRecipeFile(subject)
    if (ioError !== undefined) {
      io.err(ioError)
      return 2
    }
    const verdict = judgeRecipe(document)
    const clean = printVerdict(io, subject, verdict)
    if (!clean) return 1
    if (command === 'describe') {
      describeTo(io, verdict.recipe as RecipeManifest)
    }
    return 0
  }

  if (command === 'pack') {
    return packCommand(subject, flags as unknown as PackOptions, io)
  }

  io.err(`unknown command ${JSON.stringify(command)}`)
  io.err(USAGE)
  return 2
}

/**
 * Refuse a target whose ancestor chain carries a reparse point (symlink or
 * Windows junction) or a `tool-mode.extension.json` (an installed or packed
 * artifact is immutable). `create`/`edit-draft` never write through either.
 * @param target - the absolute target path (a directory for create, a file for edit-draft).
 * @returns a refusal reason, or undefined when the target is writable-by-construction.
 */
function writabilityRefusal(target: string): string | undefined {
  const absolute = resolve(target)
  const parsed = parse(absolute)
  // Walk from the FILESYSTEM ROOT, not from cwd: a target on another drive (or
  // outside cwd) must be walked too — the old cwd-relative slice heuristic
  // silently skipped it. Every EXISTING component is lstat'ed (a Windows
  // junction reports as a symlink) and every ancestor is checked for the
  // installed-artifact manifest.
  const components = absolute.slice(parsed.root.length).split(sep).filter(Boolean)
  let cursor = parsed.root
  // The root itself participates: a drive root that were a reparse point is as
  // much an escape as any deeper component.
  for (const component of components) {
    cursor = join(cursor, component)
    try {
      if (lstatSync(cursor).isSymbolicLink()) {
        return `the target path ${target} passes through a symbolic link or junction at ${cursor}; refused`
      }
    } catch {
      // The component does not exist yet: no deeper component can exist either.
      break
    }
  }
  // The installed-artifact rule applies to EVERY ancestor directory, not only
  // the immediate parent (the reviewer's grandparent-manifest case): the target
  // must not lie inside a directory tree that carries tool-mode.extension.json.
  let ancestor = dirname(absolute)
  for (;;) {
    if (existsSync(join(ancestor, 'tool-mode.extension.json'))) {
      return `the target path ${target} lies inside an installed or packed artifact at ${ancestor}; those are immutable and refused`
    }
    const parent = dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  return undefined
}

/**
 * Verify a directory chain is still reparse-free IMMEDIATELY before a write.
 * The TOCTOU residual: a junction flipped between this call and the following
 * open() can still redirect that ONE open; the post-write verification below
 * detects it and no FURTHER file is created (the window is a single sub-
 * millisecond open per file, and the created project is refused and removed).
 */
function chainStillClean(dir: string): string | undefined {
  return writabilityRefusal(join(dir, '.sentinel'))
}

/**
 * Create one file EXCLUSIVELY ('wx') in a chain-verified directory, verifying
 * the chain again after the write. A reparse point observed at any point
 * aborts the operation (the caller refuses the whole command).
 */
function safeWriteFile(target: string, data: string): string | undefined {
  const parent = dirname(target)
  const before = chainStillClean(parent)
  if (before !== undefined) return before
  let descriptor: number | undefined
  try {
    descriptor = openSync(target, 'wx')
    writeFileSync(descriptor, data, 'utf8')
    fsyncSync(descriptor)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
  const after = chainStillClean(parent)
  if (after !== undefined) return after
  if (lstatSync(target).isSymbolicLink()) {
    return `the written file ${target} is a reparse point; refused`
  }
  return undefined
}

/** `create`: emit the static project files, refusing anything unsafe. */
function createCommand(flags: Record<string, string | true>, io: RecipeCliIo): number {
  const template = typeof flags.template === 'string' ? flags.template : undefined
  const out = resolve(typeof flags.out === 'string' ? flags.out : './draft')
  const name = typeof flags.name === 'string' ? flags.name : basenameOf(out)
  const description = typeof flags.description === 'string' ? flags.description : undefined

  const validated = validateCreateArguments(template, name, description)
  if (validated.error !== undefined) {
    io.err(validated.error)
    io.err(USAGE)
    return 2
  }

  const refused = writabilityRefusal(out)
  if (refused !== undefined) {
    io.err(refused)
    return 2
  }
  if (existsSync(out)) {
    io.err(`create refused: the target ${out} already exists; create never overwrites an existing path`)
    return 2
  }

  const files = templateFiles(validated.template as CreateTemplate, name, validated.description as string)
  // The draft must validate under the SHARED validator BEFORE any file lands.
  const draft = files.find(file => file.path === `recipes/${name}.json`)
  const draftDocument = JSON.parse(draft?.data ?? '{}') as unknown
  const verdict = judgeRecipe(draftDocument)
  if (!verdict.schemaOk || !verdict.codeOk) {
    io.err('create refused: the generated draft does not validate — this is a template bug, not your input')
    for (const violation of [...verdict.schemaViolations, ...verdict.codeViolations]) io.err(`  ${violation}`)
    return 1
  }

  const created: string[] = []
  // Cleanup runs ONLY when the chain re-verifies clean at refusal time:
  // deleting through a now-junctioned path could remove VICTIM files.
  const cleanupOwned = (): void => {
    try {
      if (chainStillClean(out) !== undefined) return
      for (const path of created.reverse()) rmSync(path, { recursive: true, force: true })
    } catch {
      // Best-effort: the refusal already stands; a stuck file reports honestly
      // on the next run instead of being silently deleted through a link.
    }
  }
  try {
    mkdirSync(out, { recursive: true })
    created.push(out)
    const postMkdir = chainStillClean(out)
    if (postMkdir !== undefined) {
      cleanupOwned()
      io.err(`create refused after creation: ${postMkdir}`)
      return 2
    }
    for (const file of files) {
      const target = join(out, file.path)
      mkdirSync(dirname(target), { recursive: true })
      const writeRefusal = safeWriteFile(target, file.data)
      if (writeRefusal !== undefined) {
        cleanupOwned()
        io.err(`create refused mid-write: ${writeRefusal}`)
        return 2
      }
      created.push(target)
    }
    // Post-write verification: if ANY reparse point appeared anywhere in the
    // chain during the run, the command refuses and removes the project it
    // created — but ONLY along a chain that is still verified clean.
    const finalCheck = writabilityRefusal(out)
    if (finalCheck !== undefined) {
      cleanupOwned()
      io.err(`create refused after verification: ${finalCheck}`)
      return 2
    }
  } catch (error) {
    cleanupOwned()
    io.err(`create failed: ${messageOf(error)}`)
    return 2
  }
  io.out(`created draft project ${name} at ${out} (template ${validated.template as string})`)
  io.out(`  files: ${files.map(file => file.path).join(', ')}`)
  io.out('  nothing was installed, activated, downloaded or inferred (RCP-08)')
  io.out(`  next: tool-mode-recipe validate recipes/${name}.json, then test ., then pack .`)
  return 0
}

/** The last path component of an absolute or relative directory path. */
function basenameOf(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

/** `edit-draft`: a bounded static mutation that must validate before it is written. */
function editDraftCommand(positional: readonly string[], flags: Record<string, string | true>, io: RecipeCliIo): number {
  if (positional.length !== 1) {
    io.err('edit-draft needs exactly one recipe file')
    io.err(USAGE)
    return 2
  }
  const subject = resolve(positional[0] as string)
  const field = typeof flags.set === 'string' ? flags.set : undefined
  const value = flags.value
  if (field === undefined || typeof value !== 'string') {
    io.err('edit-draft needs --set <field> --value <text>')
    io.err(USAGE)
    return 2
  }
  if (field.startsWith('policy.')) {
    io.err(policyEditRefusal(field))
    return 2
  }
  // The whitelist lives on a null-prototype map, so prototype-key lookups
  // ('__proto__', 'constructor', 'toString', …) resolve to undefined and hit
  // this refusal instead of traversing Object.prototype.
  const editable = EDITABLE_FIELDS[field as keyof typeof EDITABLE_FIELDS]
  if (editable === undefined) {
    io.err(`editing ${JSON.stringify(field)} is refused: only the safe fields are mutable (`
      + `${Object.keys(EDITABLE_FIELDS).join(', ')}); rename the draft instead of reshaping its identity`)
    return 2
  }
  const valueError = editable.validate(value)
  if (valueError !== undefined) {
    io.err(`--set ${field} refused: ${valueError}`)
    return 2
  }

  const refused = writabilityRefusal(subject)
  if (refused !== undefined) {
    io.err(refused)
    return 2
  }
  const { document, ioError } = readRecipeFile(subject)
  if (ioError !== undefined) {
    io.err(ioError)
    return 2
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    io.err(`${subject} is not a recipe object`)
    return 2
  }
  const mutated = { ...(document as Record<string, unknown>) }
  // The DRAFT's intermediate shape is validated BEFORE any mutation: a draft
  // whose imageInputs is a primitive refuses by name instead of crashing.
  const shapeRefusal = editable.precondition(mutated)
  if (shapeRefusal !== undefined) {
    io.err(`--set ${field} refused: ${shapeRefusal}; ${subject} is unchanged`)
    return 2
  }
  editable.apply(mutated, value)
  const verdict = judgeRecipe(mutated)
  const clean = printVerdict(io, subject, verdict)
  if (!clean) {
    io.err(`edit-draft refused: the edited recipe would not validate; ${subject} is unchanged`)
    return 1
  }
  // Atomic write: chain-verified exclusive temp + rename, so a crash never
  // leaves a truncated draft and a flipped junction cannot redirect the temp.
  const temporary = `${subject}.tmp-${process.pid}-${Date.now().toString(36)}`
  const tempRefusal = safeWriteFile(temporary, `${JSON.stringify(mutated, null, 2)}\n`)
  if (tempRefusal !== undefined) {
    rmSync(temporary, { force: true })
    io.err(`cannot write ${subject}: ${tempRefusal}`)
    return 2
  }
  try {
    renameSync(temporary, subject)
  } catch (error) {
    rmSync(temporary, { force: true })
    io.err(`cannot write ${subject}: ${messageOf(error)}`)
    return 2
  }
  io.out(`edited ${field} of ${subject}; the result validates`)
  return 0
}

/** `test`: the REAL broker over the scripted fixture provider. */
async function testCommand(positional: readonly string[], flags: Record<string, string | true>, io: RecipeCliIo): Promise<number> {
  if (flags.live === true) {
    io.err(
      '--live is not provided by this CLI build (RCP-08 remainder): a live run requires an explicit deployment '
      + 'executor profile with consent and limits. This CLI never invokes a real model; use the fixture suite instead.',
    )
    return 2
  }
  if (positional.length !== 1) {
    io.err('test needs exactly one project directory')
    io.err(USAGE)
    return 2
  }
  const project = resolve(positional[0] as string)
  const fixturesPath = resolve(typeof flags.fixtures === 'string' ? flags.fixtures : join(project, 'tests', 'fixtures.json'))

  const recipesDir = join(project, 'recipes')
  if (!existsSync(recipesDir)) {
    io.err(`no recipes directory at ${recipesDir}; create a project first (tool-mode-recipe create)`)
    return 2
  }
  const recipePaths = readdirSync(recipesDir).filter(entry => entry.endsWith('.json')).sort()
    .map(entry => join(recipesDir, entry))
  if (recipePaths.length === 0) {
    io.err(`no recipe JSON files in ${recipesDir}`)
    return 2
  }
  if (!existsSync(fixturesPath)) {
    io.err(`no fixtures file at ${fixturesPath}; pass --fixtures or create a project first`)
    return 2
  }

  let fixture: FixtureDocument
  try {
    const parsed: unknown = JSON.parse(readFileSync(fixturesPath, 'utf8'))
    const validated = validateFixtureDocument(parsed)
    if (validated.error !== undefined || validated.document === undefined) {
      io.err(`the fixtures file is not usable: ${validated.error ?? 'unknown shape'}`)
      return 2
    }
    fixture = validated.document
  } catch (error) {
    io.err(`the fixtures file is not valid JSON: ${messageOf(error)}`)
    return 2
  }

  let allPassed = true
  const failedCases: string[] = []
  for (const path of recipePaths) {
    const { document, ioError } = readRecipeFile(path)
    if (ioError !== undefined) {
      io.err(ioError)
      return 2
    }
    const verdict = judgeRecipe(document)
    if (!verdict.schemaOk || !verdict.codeOk) {
      io.err(`${path} does not validate; the fixture suite runs only validated recipes`)
      allPassed = false
      continue
    }
    io.out(`testing ${path} against ${fixturesPath}`)
    const verdicts = await runFixtureSuite(verdict.recipe as RecipeManifest, fixture, io, INITIAL_HOST_POLICY)
    for (const entry of verdicts) {
      if (!entry.pass) {
        allPassed = false
        failedCases.push(entry.caseId)
      }
    }
  }

  if (!allPassed) {
    io.err(`test failed: fixture case(s) ${failedCases.join(', ')} did not match their expected outcomes`)
    return 1
  }
  io.out('test passed: every fixture case matched its expected outcome against the scripted provider (not a real model)')
  return 0
}

/**
 * Print the effective bounds for a recipe (RCP-08's describe).
 *
 * The recipe's own ceilings are RES-10's initial maxima by construction (the
 * validator refuses anything above them); the host may narrow further at
 * runtime, which the output says rather than hides.
 */
function describeTo(io: RecipeCliIo, recipe: RecipeManifest): void {
  const names = Object.keys(recipe.inputs)
  const required = names.filter(name => recipe.inputs[name]?.required === true)
  const images = names.filter(name => recipe.inputs[name]?.type === 'image')
  io.out(`${recipe.tool.name} (contract ${recipe.tool.contractId}) — recipe ${recipe.id}@${recipe.version}`)
  io.out(`  description: ${recipe.description}`)
  io.out(`  inputs: ${names.length} (${required.length} required: ${required.join(', ') || '(none)'}`
    + `${images.length > 0 ? `; ${images.length} image: ${images.join(', ')}` : ''})`)
  io.out(`  output ceiling: at most ${recipe.maxOutputTokens} tokens `
    + `(RES-10 initial maximum ${INITIAL_MAX_OUTPUT_TOKENS}; the host policy may narrow this)`)
  io.out(`  image ceiling: at most ${recipe.imageInputs.max} image input(s) `
    + `(RES-10 initial maximum ${INITIAL_MAX_IMAGE_INPUTS})`)
  io.out(`  recording: ${recipe.policy.record ? 'requested' : 'not requested'} — a host policy that `
    + `requires recording will refuse a ${recipe.policy.record ? 'recorded' : 'record: false'} recipe rather than silently drop it`)
  io.out(`  destinations: ${recipe.policy.allowRemote ? 'local or remote, by the host policy' : 'local only, by the recipe'}`)
  io.out('  context: none supplied — a recipe is data; no conversation, tools, attachments or memory are inherited (HLM-05)')
  if (recipe.modelSelection !== undefined) {
    io.out(`  executor: approved-profile "${recipe.modelSelection.profile}" (RCP-05) — the operator binds the profile; `
      + 'an unresolved binding keeps the tool unavailable with EXECUTOR_NOT_CONFIGURED')
  } else {
    io.out('  executor: caller-model (RCP-05) — the invoking agent\'s authorized harness model, resolved once per invocation')
  }
  if (recipe.response !== undefined) {
    io.out(`  response: ${recipe.response.mode} into payload field "${recipe.response.field}" (RCP-04)`)
    if (recipe.response.mode === 'json') {
      io.out('    disclosure: json mode is prompt-enforced and locally validated in this build — the provider\'s '
        + 'verified structured-output feature is NOT negotiated (RCP-04\'s disclosure requirement)')
    }
  } else {
    io.out('  response: plain text payload (RCP-04)')
  }
}

/** The declarative-manifest template, mirroring the shipped declarative package. */
function manifestFor(
  name: string,
  version: string,
  description: string,
  recipes: readonly RecipeManifest[],
): Record<string, unknown> {
  return {
    protocolVersion: '1.1.0',
    id: name,
    version,
    displayName: name,
    description,
    license: 'MIT',
    activation: { policy: 'operator', deactivatable: true },
    runtimeApi: 1,
    compatibility: {
      hostApi: '^1.1.0',
      requiredFeatures: ['declarative-recipes-v1'],
    },
    execution: { kind: 'declarative' },
    permissions: {
      networkOrigins: [],
      inputFiles: false,
      storage: 'none',
      secrets: [],
      nativeCode: false,
    },
    models: [],
    tools: [],
    implementations: recipes.map(recipe => ({
      id: recipe.id,
      contractId: recipe.tool.contractId,
      contractVersion: '1.0.0',
      recipeVersion: recipe.version,
    })),
    skills: [],
    licenses: [
      {
        layer: 'code',
        name: 'MIT',
        url: 'https://opensource.org/license/mit',
        openSource: true,
        redistribution: 'permitted',
        attributionRequired: false,
        obligations: [],
      },
      {
        layer: 'weights',
        name: 'none: the package carries no weights',
        url: 'https://example.invalid/none',
        openSource: false,
        redistribution: 'not-permitted',
        attributionRequired: false,
        obligations: ['the recipes reference a harness model supplied by the deployment, so no weights are distributed here'],
      },
      {
        layer: 'engine',
        name: 'none: the host broker is the engine',
        url: 'https://example.invalid/none',
        openSource: false,
        redistribution: 'not-permitted',
        attributionRequired: false,
        obligations: ['execution happens in the host broker, which is the point of a declarative package'],
      },
      {
        layer: 'sdk',
        name: 'none: a declarative package links no SDK at runtime',
        url: 'https://example.invalid/none',
        openSource: false,
        redistribution: 'not-permitted',
        attributionRequired: false,
        obligations: ['the host needs no runtime link for a package that ships no module'],
      },
      {
        layer: 'conversion-artifacts',
        name: 'none: no conversion is performed',
        url: 'https://example.invalid/none',
        openSource: false,
        redistribution: 'permitted',
        attributionRequired: false,
        obligations: [],
      },
    ],
    network: { requiredTelemetry: false, otherNetworkUse: false },
  }
}

/** Run `pack`, emitting a package directory and a store-method zip. */
function packCommand(subject: string, options: PackOptions, io: RecipeCliIo): number {
  const out = resolve(options.out ?? './dist')

  let name = options.name
  let version = options.version
  const recipePaths: string[] = []
  const isFile = existsSync(subject) && statSync(subject).isFile()
  if (isFile) {
    recipePaths.push(resolve(subject))
  } else {
    const dir = resolve(subject)
    if (!existsSync(dir)) {
      io.err(`no recipe or project directory at ${subject}`)
      return 2
    }
    const packagePath = join(dir, 'package.json')
    if (existsSync(packagePath)) {
      let manifest: { name?: unknown; version?: unknown } = {}
      try {
        manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as typeof manifest
      } catch (error) {
        io.err(`the project package.json is not valid JSON: ${messageOf(error)}`)
        return 2
      }
      if (name === undefined && typeof manifest.name === 'string') name = manifest.name
      if (version === undefined && typeof manifest.version === 'string') version = manifest.version
    }
    const recipesDir = join(dir, 'recipes')
    const source = existsSync(recipesDir) ? recipesDir : dir
    for (const entry of readdirSync(source).sort()) {
      if (!entry.endsWith('.json')) continue
      if (source === dir && (entry === 'package.json' || entry === 'tool-mode.extension.json')) continue
      recipePaths.push(join(source, entry))
    }
  }

  if (name === undefined || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) {
    io.err('pack needs a package name: pass --name <pkg> or pack a project directory with a package.json')
    return 2
  }
  if (recipePaths.length === 0) {
    io.err('no recipe JSON files found to pack')
    return 2
  }

  const recipes: RecipeManifest[] = []
  let clean = true
  for (const path of recipePaths) {
    const { document, ioError } = readRecipeFile(path)
    if (ioError !== undefined) {
      io.err(ioError)
      clean = false
      continue
    }
    const verdict = judgeRecipe(document)
    const fileClean = printVerdict(io, path, verdict)
    if (!fileClean) {
      clean = false
      continue
    }
    // Two recipes claiming one tool name would publish two implementations of
    // one contract under one manifest; the packer refuses rather than guessing.
    const recipe = verdict.recipe as RecipeManifest
    const clash = recipes.find(existing => existing.tool.name === recipe.tool.name)
    if (clash !== undefined) {
      io.err(`${path} claims the tool "${recipe.tool.name}" already claimed by recipe ${clash.id}; `
        + 'one package serves one implementation per tool')
      clean = false
      continue
    }
    recipes.push(recipe)
  }
  if (!clean) {
    io.err('pack refused: the production artifact is only packed from recipes that validate')
    return 1
  }

  const packageVersion = version ?? (recipes.length === 1 ? recipes[0]?.version : undefined) ?? '0.1.0'
  const description = options.description
    ?? `Declarative recipe package ${name}: ${recipes.map(recipe => recipe.tool.name).join(', ')}.`
  const files: { path: string; data: string }[] = []
  files.push({
    path: 'package.json',
    data: `${JSON.stringify({
      name,
      version: packageVersion,
      type: 'module',
      license: 'MIT',
      description,
      files: ['tool-mode.extension.json', 'recipes'],
      toolMode: { manifest: './tool-mode.extension.json' },
    }, null, 2)}\n`,
  })
  files.push({
    path: 'tool-mode.extension.json',
    data: `${JSON.stringify(manifestFor(name, packageVersion, description, recipes), null, 2)}\n`,
  })
  for (const recipe of recipes) {
    // Pack emits the CANONICAL RCP-02 shape: the packaged artifact is the
    // vocabulary the spec publishes, and the lossless binding constraints keep
    // the canonical round trip identical to the frozen recipe.
    files.push({ path: `recipes/${recipe.id}.json`, data: `${JSON.stringify(toCanonicalRecipe(recipe), null, 2)}\n` })
  }

  const packageDir = join(out, `${name.replaceAll('/', '__')}-${packageVersion}`)
  mkdirSync(packageDir, { recursive: true })
  for (const file of files) {
    const target = join(packageDir, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.data, 'utf8')
  }
  const zipPath = `${packageDir}.zip`
  writeFileSync(zipPath, writeZip(files.map(file => ({
    path: file.path,
    data: Buffer.from(file.data, 'utf8'),
  }))))

  io.out(`packed ${name}@${packageVersion}`)
  io.out(`  package: ${packageDir}`)
  io.out(`  archive: ${zipPath} (store-method zip, consumable by the extension install path)`)
  io.out(`  contents: ${files.map(file => file.path).join(', ')}`)
  io.out('  NO executable code ships, and no lifecycle scripts were run (RCP-08)')
  return 0
}

/** Best-effort message from an arbitrary thrown value. */
function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return '<unrenderable>'
  }
}

// ---------------------------------------------------------------------------
// A minimal, dependency-free ZIP writer (STORE method, deterministic order).
// ---------------------------------------------------------------------------

/** The CRC-32 table and update, for the store-method entries. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Write a STORE-method zip over the given files, in the given order. */
function writeZip(files: readonly { readonly path: string; readonly data: Buffer }[]): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  const put = (buffer: Buffer): void => {
    chunks.push(buffer)
    offset += buffer.byteLength
  }
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8')
    const crc = crc32(new Uint8Array(file.data))
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4) // version needed
    header.writeUInt16LE(0, 6) // flags
    header.writeUInt16LE(0, 8) // STORE
    header.writeUInt16LE(0, 10) // time
    header.writeUInt16LE(0x21, 12) // date (1980-01-01, deterministic)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(file.data.byteLength, 18)
    header.writeUInt32LE(file.data.byteLength, 22)
    header.writeUInt16LE(name.byteLength, 26)
    header.writeUInt16LE(0, 28) // extra length
    put(header)
    put(name)
    put(file.data)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4) // version made by
    entry.writeUInt16LE(20, 6) // version needed
    entry.writeUInt16LE(0, 8)
    entry.writeUInt16LE(0, 10)
    entry.writeUInt16LE(0, 12)
    entry.writeUInt16LE(0x21, 14)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(file.data.byteLength, 20)
    entry.writeUInt32LE(file.data.byteLength, 24)
    entry.writeUInt16LE(name.byteLength, 28)
    entry.writeUInt16LE(0, 30)
    entry.writeUInt16LE(0, 32)
    entry.writeUInt16LE(0, 34)
    entry.writeUInt16LE(0, 36) // external attrs
    entry.writeUInt32LE(offset - header.byteLength - name.byteLength - file.data.byteLength, 42) // local header offset
    central.push(entry)
    central.push(name)
  }
  const centralSize = central.reduce((sum, buffer) => sum + buffer.byteLength, 0)
  const centralStart = offset
  for (const buffer of central) put(buffer)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralStart, 16)
  end.writeUInt16LE(0, 20)
  put(end)
  return Buffer.concat(chunks)
}
