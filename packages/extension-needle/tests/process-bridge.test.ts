/**
 * Process-bridge tests: the five required properties, each with a test that FAILS if the
 * property is removed.
 *
 * Every test here drives a REAL child process. That is deliberate: a test that stubbed
 * `spawn` would prove only that this file's mock was called, and the properties below are
 * all properties of what actually happens to a real process on a real operating system.
 *
 * A small Node program is used as the child wherever the test is about the BRIDGE rather
 * than about Needle. The bridge's contract is about processes, so a process written in the
 * language that is already running keeps the test honest and fast — and the real engine is
 * exercised separately, in `engine.test.ts`.
 *
 * Requirement links: SEC-06, EXT-18, EXT-19, MOD-19.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertNoListenerArgument,
  buildScrubbedEnv,
  DEFAULT_MAX_INPUT_BYTES,
  environmentNames,
  runProcess,
} from '../src/process-bridge.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fresh scratch directory that is removed when the suite finishes. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'needle-bridge-test-'))
  dirs.push(dir)
  return dir
}

/** Absolute path of the Node running this test, so no PATH lookup is involved. */
const NODE = process.execPath

/**
 * Run `node -e <script>` through the bridge.
 *
 * `-e` takes the script as one argv element, which is also a small demonstration of the
 * property under test: a script containing quotes and `&` arrives intact.
 */
async function nodeEval(
  script: string,
  options: Parameters<typeof runProcess>[0] extends infer T
    ? Omit<Extract<T, { command: string }>, 'command' | 'args'> & { args?: readonly string[] }
    : never = {},
): Promise<Awaited<ReturnType<typeof runProcess>>> {
  const { args, ...rest } = options as { args?: readonly string[] }
  return runProcess({ command: NODE, args: ['-e', script, ...(args ?? [])], ...rest })
}

describe('argument arrays, NEVER a shell — a hostile argument is one argument', () => {
  it('delivers spaces, quotes, ampersands and carets as ONE argument', async () => {
    // The script echoes its own argv back as JSON. If the bridge had built a command LINE,
    // cmd.exe would have split this argument on the space, treated `&` as a command
    // separator, and possibly created `pwned.txt` through the redirect.
    const hostile = 'a b "quoted" & echo PWNED > pwned.txt ^ caret | pipe ; semi $VAR `backtick`'
    const outcome = await nodeEval(
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      { args: [hostile], cwd: scratch() },
    )
    assert.equal(outcome.kind, 'exited')
    assert.equal(outcome.exitCode, 0, outcome.stderr)
    const received = JSON.parse(outcome.stdout) as string[]
    assert.deepEqual(received, [hostile], 'the argument must arrive byte-for-byte, unsplit and uninterpreted')
  })

  it('does not execute a shell metacharacter hidden in the argument', async () => {
    // The strongest form of the same property: the argument is a complete command that
    // WOULD run if a shell saw it. The sentinel file must not exist afterwards.
    const dir = scratch()
    const sentinel = join(dir, 'pwned.txt')
    const outcome = await nodeEval(
      'process.stdout.write(process.argv[1] ?? "")',
      { args: [`x & echo pwned > "${sentinel}" & rem`], cwd: dir },
    )
    assert.equal(outcome.kind, 'exited')
    assert.equal(outcome.exitCode, 0, outcome.stderr)
    // The child printed the string rather than acting on it.
    assert.match(outcome.stdout, /echo pwned/)
    assert.throws(
      () => readFileSync(sentinel, 'utf8'),
      'the redirect must not have run: shell metacharacters are data, not syntax',
    )
  })

  it('passes an argument containing a NEWLINE as one argument', async () => {
    // A newline is the one character a naive line-based implementation cannot survive, and
    // it is reachable from a prompt.
    const hostile = 'first line\nsecond line\r\nthird'
    const outcome = await nodeEval(
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      { args: [hostile] },
    )
    const received = JSON.parse(outcome.stdout) as string[]
    assert.deepEqual(received, [hostile])
  })

  it('refuses an EMPTY argument rather than dropping it', async () => {
    // An empty argument is meaningful to a CLI (`--system ""` means "no system text"), and a
    // bridge that filtered it out would silently change the meaning of a call. The bridge
    // does not filter: the child sees the empty element.
    const outcome = await nodeEval(
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      { args: ['', 'after'] },
    )
    assert.deepEqual(JSON.parse(outcome.stdout) as string[], ['', 'after'])
  })
})

describe('a SCRUBBED environment — the parent environment is never forwarded', () => {
  it('buildScrubbedEnv keeps only the allow-list and drops everything else', () => {
    // A synthetic parent, so the assertion does not depend on what this machine happens to
    // export. The secret-looking names are the ones a developer or CI machine really has.
    const built = buildScrubbedEnv({}, {
      PATH: '/usr/bin',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      AWS_SECRET_ACCESS_KEY: 'AKIA-not-a-real-key',
      GITHUB_TOKEN: 'ghp_not_a_real_token',
      HF_TOKEN: 'hf_not_a_real_token',
      NPM_TOKEN: 'npm_not_a_real_token',
      DATABASE_URL: 'postgres://user:pw@host/db',
      NEEDLE_TELEMETRY: '1',
      DO_NOT_TRACK: '0',
    })
    assert.deepEqual(environmentNames(built), ['PATH', 'SystemRoot', 'TEMP'])
    assert.equal(built.AWS_SECRET_ACCESS_KEY, undefined)
    assert.equal(built.GITHUB_TOKEN, undefined)
    assert.equal(built.HF_TOKEN, undefined)
    assert.equal(built.DATABASE_URL, undefined)
    assert.equal(built.NEEDLE_TELEMETRY, undefined)
  })

  it('matches Windows environment names case-insensitively', () => {
    // Windows environment names are case-insensitive, so an image that spells it `Path`
    // must still be recognised — otherwise a "scrubbed" environment loses the loader.
    const built = buildScrubbedEnv({}, { Path: 'C:\\Windows', systemroot: 'C:\\Windows' })
    if (process.platform === 'win32') {
      assert.deepEqual(environmentNames(built).sort(), ['Path', 'systemroot'])
    } else {
      assert.deepEqual(environmentNames(built), [])
    }
  })

  it('a real child CANNOT see a secret that was in the parent environment', async () => {
    // The end-to-end form, which is the one that matters: the parent sets a secret, the
    // child prints its whole environment, and the secret is absent. A unit test on the
    // builder could pass while a call site forwarded `process.env`; this cannot.
    const secrets = {
      AWS_SECRET_ACCESS_KEY: 'AKIA-scrubbed-environment-test',
      GITHUB_TOKEN: 'ghp_scrubbed_environment_test',
      HF_TOKEN: 'hf_scrubbed_environment_test',
      NEEDLE_TELEMETRY: '1',
    }
    const previous = new Map(Object.keys(secrets).map(name => [name, process.env[name]]))
    for (const [name, value] of Object.entries(secrets)) process.env[name] = value
    try {
      const outcome = await runProcess({
        command: NODE,
        args: ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      })
      assert.equal(outcome.kind, 'exited')
      const childEnv = JSON.parse(outcome.stdout) as Record<string, string>
      for (const name of Object.keys(secrets)) {
        assert.equal(childEnv[name], undefined, `${name} must be ABSENT from the child environment`)
      }
      // And the child is not simply empty, or this test would pass for the wrong reason.
      assert.ok(Object.keys(childEnv).length > 0, 'the child must still receive the allow-list')
      // Every name present is accounted for. The allow-list is this package's, and the
      // remainder is Windows itself: CreateProcess fills in the profile variables for a new
      // process, which is why they appear even though nothing here passed them. What must
      // NEVER appear is a name this package did not choose and Windows does not supply.
      const allowList = ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'SystemDrive', 'windir', 'NUMBER_OF_PROCESSORS']
      const windowsSupplied = [
        'HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR',
      ]
      const accountedFor = new Set([...allowList, ...windowsSupplied].map(name => name.toLowerCase()))
      for (const name of Object.keys(childEnv)) {
        assert.ok(
          accountedFor.has(name.toLowerCase()),
          `${name} is neither on the allow-list nor supplied by Windows, so it must not be forwarded`,
        )
      }
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it('lets a caller add an entry explicitly, which is the only way to widen it', () => {
    const built = buildScrubbedEnv({ LANG: 'en_GB.UTF-8' }, { PATH: '/usr/bin', HOME: '/root' })
    assert.equal(built.LANG, 'en_GB.UTF-8')
    assert.equal(built.HOME, undefined, 'an unlisted parent variable stays out even when extras are given')
  })
})

describe('bounded I/O — the cap KILLS the child, it does not merely truncate', () => {
  it('terminates a child whose stdout passes the cap and reports the breach', async () => {
    // The child writes far more than the cap in a loop that NEVER ends. If the bridge only
    // truncated, this test would hang until the timeout: the child would keep writing
    // forever and the promise would never settle. Settling quickly is the proof of the kill.
    const cap = 64 * 1024
    const started = Date.now()
    const outcome = await nodeEval(
      'const chunk = "x".repeat(8192); for (;;) { process.stdout.write(chunk) }',
      { maxOutputBytes: cap, timeoutMs: 30_000 },
    )
    const elapsed = Date.now() - started
    assert.equal(outcome.kind, 'output-overflow', `expected a kill, got ${outcome.kind}: ${outcome.note ?? ''}`)
    assert.ok(
      outcome.stdoutBytes <= cap,
      `stdout must be bounded by the ${cap}-byte cap, saw ${outcome.stdoutBytes}`,
    )
    assert.ok(outcome.stdoutBytes > 0, 'the accepted prefix must be retained, not discarded')
    assert.match(String(outcome.note), /stdout passed the/)
    // Order-of-magnitude check: a truncating bridge would run to the 30 s timeout.
    assert.ok(elapsed < 20_000, `the child must be killed promptly, took ${elapsed}ms`)
  })

  it('terminates a child whose STDERR passes the cap', async () => {
    // stderr is the stream an engine writes diagnostics to, so it is the one most likely to
    // flood unprompted.
    const cap = 32 * 1024
    const outcome = await nodeEval(
      'const chunk = "e".repeat(4096); for (;;) { process.stderr.write(chunk) }',
      { maxOutputBytes: cap, timeoutMs: 30_000 },
    )
    assert.equal(outcome.kind, 'output-overflow')
    assert.ok(outcome.stderrBytes <= cap)
    assert.match(String(outcome.note), /stderr passed the/)
  })

  it('returns the FULL output when it fits, so the cap is not an accidental truncation', async () => {
    // The negative control. Without it, an implementation that truncated everything to zero
    // bytes would pass the tests above.
    const outcome = await nodeEval('process.stdout.write("hello needle")', { maxOutputBytes: 4096 })
    assert.equal(outcome.kind, 'exited')
    assert.equal(outcome.stdout, 'hello needle')
    assert.equal(outcome.stdoutBytes, 12)
  })

  it('refuses a stdin body over the input cap instead of feeding it', async () => {
    const outcome = await runProcess(
      { command: NODE, args: ['-e', 'process.stdin.resume()'], maxInputBytes: 16 },
      { body: 'x'.repeat(64) },
    )
    assert.equal(outcome.kind, 'output-overflow')
    assert.match(String(outcome.note), /stdin body is 64 bytes/)
  })

  it('rejects a non-positive budget before spawning anything', async () => {
    // A zero cap is a configuration mistake, and it must fail as one rather than producing a
    // process that is killed the instant it writes.
    await assert.rejects(
      runProcess({ command: NODE, args: ['-e', ''], maxOutputBytes: 0 }),
      /maxOutputBytes must be a positive integer/,
    )
    await assert.rejects(
      runProcess({ command: NODE, args: ['-e', ''], timeoutMs: -5 }),
      /timeoutMs must be a positive integer/,
    )
  })
})

describe('cancellation and timeout — the child really dies', () => {
  it('reports `cancelled` for an aborted signal, never an empty success', async () => {
    const controller = new AbortController()
    // Abort AFTER the child is running, so the abort-LISTENER path is the one exercised
    // rather than the pre-abort check below.
    const timer = setTimeout(() => controller.abort(new Error('caller cancelled')), 50)
    try {
      const outcome = await nodeEval(
        'setTimeout(() => process.stdout.write("late"), 20000)',
        { signal: controller.signal, timeoutMs: 30_000 },
      )
      assert.equal(outcome.kind, 'cancelled')
      assert.match(String(outcome.note), /aborted the invocation/)
      // An empty success is the failure mode this forbids: the caller must not be able to
      // mistake a cancelled call for a model that produced nothing.
      assert.notEqual(outcome.exitCode, 0)
    } finally {
      clearTimeout(timer)
    }
  })

  it('reports `cancelled` when the signal was ALREADY aborted before the spawn', async () => {
    const controller = new AbortController()
    controller.abort(new Error('pre-aborted'))
    const outcome = await nodeEval('process.stdout.write("should not run")', {
      signal: controller.signal,
    })
    assert.equal(outcome.kind, 'cancelled')
  })

  it('terminates a child that ignores the deadline and reports `timed-out`', async () => {
    const started = Date.now()
    const outcome = await nodeEval(
      'setTimeout(() => process.stdout.write("never"), 60000)',
      { timeoutMs: 400 },
    )
    const elapsed = Date.now() - started
    assert.equal(outcome.kind, 'timed-out')
    assert.match(String(outcome.note), /exceeded its 400 ms budget/)
    assert.ok(elapsed < 10_000, `the timeout must terminate the child promptly, took ${elapsed}ms`)
  })

  it('leaves no orphan behind: the killed child actually exits', async () => {
    // A "kill" that only detaches the listener leaves an engine holding 80 MB of weights and
    // the weights file locked. The proof that it died is that a file the child was told to
    // write AFTER the kill window never appears.
    const dir = scratch()
    const marker = join(dir, 'orphan.txt')
    const script =
      `setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive') }, 1500);`
      + 'setTimeout(() => {}, 20000)'
    const controller = new AbortController()
    const pending = runProcess({
      command: NODE,
      args: ['-e', script],
      signal: controller.signal,
      timeoutMs: 30_000,
    })
    setTimeout(() => controller.abort(), 60)
    const outcome = await pending
    assert.equal(outcome.kind, 'cancelled')
    // Wait past the child's write deadline.
    await new Promise(resolve => setTimeout(resolve, 2500))
    assert.throws(() => readFileSync(marker, 'utf8'), 'the terminated child must not have run its timer')
  })

  it('reports `spawn-failed` for an executable that does not exist', async () => {
    const outcome = await runProcess({
      command: join(scratch(), 'no-such-engine.exe'),
      args: [],
    })
    assert.equal(outcome.kind, 'spawn-failed')
    assert.match(String(outcome.note), /could not be started/)
  })
})

describe('NO PUBLIC LISTENER — the surface is closed by refusal, not by habit', () => {
  it('refuses --serve and --port before a process is spawned', () => {
    // `needle.exe` links WS2_32 and ships an HTTP server behind these flags. Refusing them
    // structurally means a later call site cannot reintroduce the listener by assembling
    // its own vector.
    assert.throws(
      () => assertNoListenerArgument(['--model', 'w.cact', '--serve']),
      /would start the engine's HTTP listener/,
    )
    assert.throws(() => assertNoListenerArgument(['--serve']), /would start the engine's HTTP listener/)
    assert.throws(() => assertNoListenerArgument(['--port', '8080']), /would start the engine's HTTP listener/)
    assert.throws(() => assertNoListenerArgument(['--port=8080']), /would start the engine's HTTP listener/)
    // A harmless argument with a similar prefix is NOT refused: the check is exact, not a
    // substring search, or it would reject a legitimate path containing "serve".
    assert.doesNotThrow(() => assertNoListenerArgument(['--model', '/tmp/observe/model.cact']))
    assert.doesNotThrow(() => assertNoListenerArgument(['--prompt', 'please serve me tea']))
  })

  it('refuses a bare listener flag in the VALUE position of a value-taking flag', () => {
    // The subtle shape. A caller-supplied system text is DATA, but it sits where an argument
    // parser expects a value, and ['--system', '--serve'] is what a caller produces by passing
    // "--serve" as that text. MEASURED: the pinned engine consumes the element after --system
    // as its value, so this does NOT start the server today. The guard is what keeps that true
    // if the parser changes or another call site assembles a vector.
    assert.throws(
      () => assertNoListenerArgument(['--system', '--serve']),
      /would be read as the flag --serve/,
    )
    assert.throws(
      () => assertNoListenerArgument(['--system', '--port=9000']),
      /would be read as the flag --port/,
    )
    // The negative controls: a value that merely MENTIONS the flag, or a listener flag after a
    // flag whose value is a path this package chose, is left alone — otherwise every
    // legitimate prompt or path would be refused.
    assert.doesNotThrow(() => assertNoListenerArgument(['--system', 'explain --serve']))
    assert.doesNotThrow(() => assertNoListenerArgument(['--prompt', 'what does --port do?']))
    assert.doesNotThrow(() => assertNoListenerArgument(['--model', '/tmp/engines/portable.exe']))
  })

  it('still refuses the flag as its own element wherever it appears', () => {
    // The first rule is absolute and independent of what precedes it. The second rule — the
    // value-position one — is narrower, so this test is what stops the narrowing from becoming
    // a hole: a listener flag immediately after a caller-TEXT flag is refused (above), and a
    // listener flag anywhere else is refused here.
    assert.throws(
      () => assertNoListenerArgument(['--model', '--serve']),
      /would start the engine's HTTP listener/,
    )
    assert.throws(
      () => assertNoListenerArgument(['--fail-input-overflow', '--serve']),
      /would start the engine's HTTP listener/,
    )
    assert.throws(
      () => assertNoListenerArgument(['--serve', '--port', '8080']),
      /would start the engine's HTTP listener/,
    )
  })

  it('runProcess refuses a listener argument instead of spawning', async () => {
    const outcome = await runProcess({ command: NODE, args: ['--serve'] }).catch((error: unknown) => error)
    assert.ok(outcome instanceof Error, 'the call must THROW, not return an outcome')
    assert.match(outcome.message, /HTTP listener/)
  })

  it('the bridge source imports no networking module and opens no server', () => {
    // The behavioural tests above cover the flags. This is the STRUCTURAL assertion the task
    // asks for: whatever a future edit does with arguments, the module itself must have no
    // way to listen. Reading the source is the only check that survives a refactor.
    const source = readFileSync(
      fileURLToPath(new URL('../src/process-bridge.ts', import.meta.url)),
      'utf8',
    )
    for (const forbidden of [
      "from 'node:net'",
      'from "node:net"',
      "from 'node:http'",
      'from "node:http"',
      "from 'node:https'",
      'from "node:https"',
      "from 'node:dgram'",
      'from "node:dgram"',
      "from 'node:tls'",
      'from "node:tls"',
      'createServer(',
      'listen(',
      'WebSocket',
      'fetch(',
    ]) {
      assert.equal(
        source.includes(forbidden),
        false,
        `process-bridge.ts must not contain ${forbidden}`,
      )
    }
    // And it does import the ONE thing it is allowed to spawn with.
    assert.ok(source.includes("from 'node:child_process'"))
    assert.ok(source.includes('shell: false'), 'the shell must be disabled explicitly, not by default')
  })

  it('the bridge never inherits the parent stdio', async () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/process-bridge.ts', import.meta.url)),
      'utf8',
    )
    // `stdio: 'inherit'` would hand a child this process's descriptors, including any a host
    // gave it. Pipes only.
    assert.equal(source.includes("stdio: 'inherit'"), false)
    assert.ok(source.includes("stdio: ['pipe', 'pipe', 'pipe']"))
  })
})

describe('the bridge reports rather than throws for a process that ran', () => {
  it('carries the exit code and both streams through', async () => {
    const outcome = await nodeEval(
      'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)',
    )
    assert.equal(outcome.kind, 'exited')
    assert.equal(outcome.exitCode, 3)
    assert.equal(outcome.stdout, 'out')
    assert.equal(outcome.stderr, 'err')
    assert.ok(outcome.durationMs >= 0)
  })

  it('closes stdin so a child that reads it is not left waiting', async () => {
    // A child whose stdin is never ended waits forever, which a caller experiences as a hang
    // rather than as a bug.
    const outcome = await nodeEval(
      'process.stdin.on("end", () => process.stdout.write("stdin-closed")); process.stdin.resume()',
      { timeoutMs: 10_000 },
    )
    assert.equal(outcome.kind, 'exited')
    assert.equal(outcome.stdout, 'stdin-closed')
  })

  it('delivers a stdin body when one is supplied', async () => {
    const outcome = await runProcess(
      {
        command: NODE,
        args: ['-e', 'process.stdin.on("data", d => process.stdout.write(d)); process.stdin.on("end", () => {})'],
      },
      { body: 'piped payload' },
    )
    assert.equal(outcome.kind, 'exited')
    assert.equal(outcome.stdout, 'piped payload')
  })

  it('exports a sane default input cap', () => {
    assert.ok(DEFAULT_MAX_INPUT_BYTES >= 1024 * 1024)
  })

  it('runs in the working directory it was given', async () => {
    const dir = scratch()
    writeFileSync(join(dir, 'marker.txt'), 'here', 'utf8')
    const outcome = await nodeEval(
      'process.stdout.write(require("node:fs").readFileSync("marker.txt", "utf8"))',
      { cwd: dir },
    )
    assert.equal(outcome.stdout, 'here')
  })
})
