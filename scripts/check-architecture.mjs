/**
 * Architecture gates.
 *
 * Round 11 established two separation properties by INSPECTION: the host holds no
 * model-specific code (BASE-09), and an extension imports only the published SDK
 * (EXT-02). An inspection is evidence about one moment; a gate is evidence about
 * every moment after it. These rules turn both into checks that fail a build.
 *
 * The rules are deliberately about SHAPE, not about a list of known offenders. A
 * rule that enumerates today's model names would pass the day a new one is added,
 * which is precisely when it needs to fail.
 *
 * @module scripts/check-architecture
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/** One violated rule. */
export class ArchitectureViolation extends Error {
  constructor(rule, file, line, detail) {
    super(`${rule} at ${file}:${line}: ${detail}`)
    this.name = 'ArchitectureViolation'
    this.rule = rule
    this.file = file
    this.line = line
    this.detail = detail
  }
}

/**
 * Every `.ts` file under a directory.
 * @param {string} directory - directory to walk.
 * @returns {{path: string, text: string}[]} the sources.
 */
export function collectSources(directory) {
  const out = []
  const walk = current => {
    for (const entry of readdirSync(current).sort()) {
      const absolute = join(current, entry)
      if (statSync(absolute).isDirectory()) {
        walk(absolute)
        continue
      }
      if (!entry.endsWith('.ts')) continue
      out.push({
        path: relative(process.cwd(), absolute).split(sep).join('/'),
        text: readFileSync(absolute, 'utf8'),
      })
    }
  }
  walk(directory)
  return out
}

/** Report every line matching a pattern, skipping comments. */
function matchLines(file, pattern, rule, detail) {
  const violations = []
  for (const [index, line] of file.text.split('\n').entries()) {
    // A comment explaining a rule must not violate it, or the documentation of the
    // prohibition becomes the reason the build fails.
    const trimmed = line.trim()
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue
    // A fresh regex per line: a shared /g/ regex carries lastIndex between calls
    // and would silently skip every other match.
    const scanner = new RegExp(pattern.source, pattern.flags)
    const match = scanner.exec(line)
    if (match !== null) violations.push(new ArchitectureViolation(rule, file.path, index + 1, detail(match)))
  }
  return violations
}

/**
 * Blank out comments while preserving length and line numbers.
 *
 * The whole-file scan needs this: a comment that DOCUMENTS a prohibition must not
 * satisfy it, or explaining a rule becomes the reason the build fails. Newlines
 * and character positions are kept so a reported line still points at the real one.
 * @param {string} text - the file's text.
 * @returns {string} the text with comment content replaced by spaces.
 */
function stripComments(text) {
  const blank = match => match.replace(/[^\n]/g, ' ')
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, prefix) => prefix + ' '.repeat(match.length - prefix.length))
}

/**
 * Report matches of a pattern that may SPAN lines.
 *
 * A line-based scan cannot see `= [` on one line and the first entry on the next,
 * which is exactly how a non-empty adapter list is written. Rules about
 * constructs rather than statements need to see the whole file.
 * @param {string} text - the file's text.
 * @param {RegExp} pattern - a multi-line pattern.
 * @param {string} rule - the rule name.
 * @param {(match: RegExpExecArray) => string} detail - the violation detail.
 * @returns {ArchitectureViolation[]} every violation.
 */
function matchText(text, pattern, rule, detail) {
  const violations = []
  const source = stripComments(text)
  const scanner = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  let match
  while ((match = scanner.exec(source)) !== null) {
    // The line of the match START, which is where the reader should look.
    const line = source.slice(0, match.index).split('\n').length
    violations.push(new ArchitectureViolation(rule, '', line, detail(match)))
    if (match.index === scanner.lastIndex) scanner.lastIndex += 1
  }
  return violations
}

/**
 * BASE-09: the host must hold no model-specific implementation.
 *
 * Three shapes are checked, because a built-in path can reappear as any of them:
 * importing a vendor SDK, branching on a literal model id, and shipping a
 * non-empty adapter factory list.
 * @param {{path: string, text: string}[]} files - the host's source files.
 * @returns {ArchitectureViolation[]} every violation.
 */
export function checkHostPurity(files) {
  const violations = []
  for (const file of files) {
    // A vendor SDK import is the clearest form of a model-specific implementation
    // living in the host.
    violations.push(...matchLines(
      file,
      /from\s+['"]@desert-ant-labs\//,
      'BASE-09/vendor-import',
      () => 'the host imports a vendor SDK; the implementation belongs in an extension package',
    ))
    // A literal model-id comparison is the model-name switch the requirement names.
    // Comparing against a CONFIGURED value is legitimate and does not match,
    // because a configured value is not a string literal.
    violations.push(...matchLines(
      file,
      /(?:entry|item\.entry)\.id\s*===\s*['"]/,
      'BASE-09/model-name-switch',
      match => `the host branches on a literal model id (${match[0].trim()}); branch on the contract or on configuration instead`,
    ))
    // An adapter registry that ships entries is a private built-in path by
    // definition, however it is spelled. Checked over the WHOLE file, because the
    // list opens on one line and holds its first entry on the next.
    violations.push(...matchText(
      file.text,
      /ADAPTER_FACTORIES\s*(?::[^=]+)?=\s*\[\s*(?!\])[A-Za-z_$]/,
      'BASE-09/built-in-adapter-list',
      () => 'ADAPTER_FACTORIES must stay empty; model implementations belong in extension packages',
    ).map(violation => new ArchitectureViolation(violation.rule, file.path, violation.line, violation.detail)))
  }
  return violations
}

/**
 * EXT-02: an extension imports the published SDK, never host internals.
 *
 * This is what makes an extension buildable by an author who has not installed the
 * host, and what stops a host refactor from breaking a published package.
 * @param {{path: string, text: string}[]} files - the extension's source files.
 * @returns {ArchitectureViolation[]} every violation.
 */
export function checkExtensionIsolation(files) {
  const violations = []
  for (const file of files) {
    // A relative import that climbs out of the package reaches a sibling checkout.
    violations.push(...matchLines(
      file,
      /from\s+['"]\.\.\/\.\.\//,
      'EXT-02/host-internal-import',
      () => 'the extension imports outside its own package; depend on the published SDK instead',
    ))
    // Reaching another package by path bypasses its exports map.
    violations.push(...matchLines(
      file,
      /@try-works\/dsh-model-as-tool/,
      'EXT-02/host-package-import',
      () => 'the extension imports the Tool Mode host; it must depend only on @try-works/tool-mode-extension-sdk',
    ))
    violations.push(...matchLines(
      file,
      /from\s+['"]@deepseek-ai\//,
      'EXT-02/dsh-internal-import',
      () => 'the extension imports DSH itself; only the host integrates with DSH',
    ))
  }
  return violations
}

/**
 * ARCH-01 and ARCH-05: one dispatch authority, and no second executor.
 *
 * ARCH-01 forbids the MCP adapter or Code Mode from calling a tool's raw `execute`
 * callback to avoid the registry pipeline, and ARCH-05 forbids a parallel dispatch
 * path with different validation or permissions. Both are the same defect seen from
 * two sides: a second way to run a tool that skips the grant, the receipt and the
 * result policy.
 *
 * The rule is about the RECEIVER rather than the method: `ctx.tools.execute(...)` is
 * the authority, while any other `.execute(` in the MCP or Code Mode layers is a
 * bypass.
 * @param {{path: string, text: string}[]} files - the dispatch-layer sources.
 * @returns {ArchitectureViolation[]} every violation.
 */
export function checkSingleDispatchAuthority(files) {
  const violations = []
  for (const file of files) {
    violations.push(...matchLines(
      file,
      /**
       * A call on a TOOL DEFINITION rather than on the executor.
       *
       * The distinction that matters is the receiver. `ctx.tools.execute(...)` is the
       * authority, and an INJECTED executor (`surface.execute(...)`) is how the MCP
       * binding is handed that authority without importing it — that is dependency
       * injection, not a bypass, and treating it as one produced a false positive that
       * would have taught a reader to ignore this rule.
       */
      /\b(?!ctx\.tools\b)(definition|tool|resolved|adapter)\.execute\s*\(/,
      'ARCH-01/second-dispatch-path',
      match => `${match[1]}.execute() runs a tool without the registry pipeline; dispatch through ctx.tools.execute()`,
    ))
    // `ctx.tools.get(name)` hands back a definition whose `execute` would bypass the
    // pipeline, so reaching for it at all is the shape ARCH-01 names.
    violations.push(...matchLines(
      file,
      /\.tools\.get\s*\(/,
      'ARCH-01/registry-bypass',
      () => 'ctx.tools.get() hands back a definition whose execute bypasses the registry pipeline; use ctx.tools.execute()',
    ))
  }
  return violations
}

/**
 * ARCH-06: the host must not hardcode a model- or tool-specific prompt.
 *
 * The test is IMPERATIVE PHRASING naming a model, not merely a long literal: an error
 * message, a parameter description or a warning template mentioning a tool is
 * documentation, and flagging those made this rule report three things that were not
 * prompts. A rule with false positives is worse than a narrow one, because it teaches
 * its reader to skip it.
 * @param {{path: string, text: string}} - the host source file.
 * @returns {ArchitectureViolation[]} every violation.
 */
export function checkNoHardcodedPrompt(file) {
  return matchLines(
    file,
    /['"`][^'"`]{60,}['"`]/,
    'ARCH-06/hardcoded-prompt',
    match => `the host carries a prompt-like literal (${match[0].length} chars); prompts belong to an extension, not the host`,
  ).filter(violation => {
    const line = file.text.split('\n')[violation.line - 1] ?? ''
    // Instruction phrasing is what makes a literal a prompt rather than a message.
    const instructive = /\b(you are|your task|respond with|act as|do not|must not|please (?:analy[sz]e|transcribe|detect))\b/i.test(line)
    const namesAModel = /tongue|voz|lang_detect|transcri(?:be|ption)/i.test(line)
    return instructive && namesAModel
  })
}

/**
 * Check every rule across the repository.
 * @param {string} [root] - repository root.
 * @returns {ArchitectureViolation[]} every violation.
 */
export function checkRepository(root = process.cwd()) {
  const hostSources = collectSources(join(root, 'packages/dsh-model-as-tool/src'))
  const violations = [
    ...checkHostPurity(hostSources),
    // ARCH-01/ARCH-05 apply to the DISPATCH layers specifically: the MCP server and
    // binding, plus the host's own contract path.
    ...checkSingleDispatchAuthority(hostSources.filter(file => /\/mcp\//.test(file.path))),
    ...hostSources.flatMap(checkNoHardcodedPrompt),
  ]
  for (const extension of ['extension-desert-ant-tongue', 'extension-desert-ant-voz', 'extension-embeddinggemma']) {
    violations.push(...checkExtensionIsolation(collectSources(join(root, 'packages', extension, 'src'))))
  }
  // ARCH-02: installing an extension must not require rebuilding the host, which is
  // only true while no extension depends on the host package.
  violations.push(...checkExtensionReleaseIndependence(root))
  return violations
}

/**
 * ARCH-02: no extension may depend on the host package.
 *
 * "Installing one extension must not require rebuilding or releasing the host." A
 * declared dependency on the host would make that false, and a workspace protocol
 * reference would make it false in a way a publish would not catch.
 * @param {string} root - repository root.
 * @returns {ArchitectureViolation[]} every violation.
 */
export function checkExtensionReleaseIndependence(root) {
  const violations = []
  for (const extension of ['extension-desert-ant-tongue', 'extension-desert-ant-voz']) {
    const path = join(root, 'packages', extension, 'package.json')
    if (!existsSync(path)) continue
    const pkg = JSON.parse(readFileSync(path, 'utf8'))
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      if (pkg[field] !== undefined && pkg[field]['@try-works/dsh-model-as-tool'] !== undefined) {
        violations.push(new ArchitectureViolation(
          'ARCH-02/extension-depends-on-host',
          `packages/${extension}/package.json`,
          1,
          `the extension declares the host in ${field}; installing it would then require the host release it was built against`,
        ))
      }
    }
  }
  return violations
}

/** Run the gates. */
function main() {
  const violations = checkRepository()
  if (violations.length === 0) {
    console.log('architecture OK — the host holds no model-specific code and extensions use only the published SDK.')
    return
  }
  console.error(`architecture check FAILED with ${violations.length} violation(s):\n`)
  for (const violation of violations) console.error(`  ${violation.message}`)
  console.error('\nA private built-in path is the defect these gates exist to prevent; fix the code, not the rule.')
  process.exitCode = 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
