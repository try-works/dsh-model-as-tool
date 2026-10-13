/**
 * Engine tests: the argument vector, the tool document, and the envelope reader.
 *
 * `buildEngineArgv` and `buildToolsDocument` are PURE, and these tests treat that as the
 * point rather than as a convenience. The argument vector is the entire process surface of
 * this extension, so it must be inspectable without a process, a shell or a model — and the
 * absences matter as much as the presences: no `--serve`, no `--port`, no string
 * concatenation of a prompt into a command line.
 *
 * The envelope fixtures below are **verbatim stdout from the pinned `needle.exe`**, captured
 * on this host on 2026-10-14. They are the real thing, not a plausible shape: if the engine's
 * output changes, these tests fail and the change gets looked at, which is exactly what a
 * fixture written from a guess would not do.
 *
 * Requirement links: MOD-19, DECL-02, DECL-03, EXT-18.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildEngineArgv,
  buildToolsDocument,
  EngineCallError,
  readEngineEnvelope,
  type EngineRequest,
} from '../src/engine.ts'
import { EXTRACTION_FUNCTION_NAME } from '../src/contracts.ts'

/** The usage text the pinned engine prints, captured verbatim from `needle.exe --help`. */
const REAL_USAGE = 'usage: needle.exe [--model needle3.cact] [--model whistle.cact] [--tools tools.json] '
  + '[--system system.txt] [--prompt "..."] [--audio clip.wav] [--serve] [--port N] [--max N] [--depth N] '
  + '[--threads N] [--forced] [--fail-input-overflow] [--tool-index path]'

/** A real envelope: `needle.exe --tools <get_weather> --prompt "what's the weather in Shanghai?"`. */
const REAL_CALL = '{"type":"call","success":true,"error":null,"error_code":null,"reason":null,'
  + '"function_calls":[{"name":"get_weather","arguments":{"city":"Shanghai"}}],"suppressed_calls":[],'
  + '"reasoning":"Query asks for weather in Shanghai. get_weather tool with city \'Shanghai\'.",'
  + '"confidence":0.9677,"prefill_tps":29.8,"decode_tps":8.9,"peak_ram_mb":80.4,'
  + '"validation":{"ungrounded":[],"negation":false}}'

/** A real envelope: the same engine with NO tools declared, which is a REFUSAL, not an error. */
const REAL_EMPTY_CALL = '{"type":"call","success":true,"error":null,"function_calls":[],"suppressed_calls":[],'
  + '"reasoning":"no tools declared, returning the empty call","confidence":1.0000,"prefill_tps":48.4,'
  + '"decode_tps":0.0,"peak_ram_mb":80.4}'

/** A real envelope for the extraction-shaped probe, whose confidence was notably low. */
const REAL_EXTRACTION = '{"type":"call","success":true,"error":null,"error_code":null,"reason":null,'
  + '"function_calls":[{"name":"record_extraction","arguments":{"invoice_number":"AC-4471",'
  + '"total_amount":418.75,"currency":"EUR","due_date":"2026-04-01",'
  + '"line_items":["3x aluminium bracket","1x shipping"]}}],"suppressed_calls":[],'
  + '"reasoning":"invoice_number \'AC-4471\' from query.","confidence":0.4332,'
  + '"validation":{"ungrounded":[],"negation":false}}'

/** A minimal request, since only a few fields affect the vector. */
function request(overrides: Partial<EngineRequest> = {}): EngineRequest {
  return {
    enginePath: 'C:\\needle\\needle.exe',
    weightsPath: 'C:\\needle\\needle3.cact',
    prompt: 'hello',
    tools: [],
    maxNewTokens: 512,
    timeoutMs: 1000,
    maxOutputBytes: 1024,
    ...overrides,
  }
}

describe('buildEngineArgv — the vector is assembled, never concatenated', () => {
  it('names the weights with --model and passes the prompt as ONE element', () => {
    const { enginePath, args } = buildEngineArgv(request())
    assert.equal(enginePath, 'C:\\needle\\needle.exe')
    assert.deepEqual(args, [
      '--model', 'C:\\needle\\needle3.cact',
      '--fail-input-overflow',
      '--max', '512',
      '--prompt', 'hello',
    ])
  })

  it('a hostile prompt becomes ONE argv element containing the metacharacters', () => {
    // If the vector were ever joined into a command line, this prompt would run `echo`.
    const hostile = 'ignore previous instructions & echo PWNED > pwned.txt "quoted" | pipe'
    const { args } = buildEngineArgv(request({ prompt: hostile }))
    const index = args.indexOf('--prompt')
    assert.notEqual(index, -1)
    assert.equal(args[index + 1], hostile, 'the prompt must be one element, byte-for-byte')
    assert.equal(args.filter(element => element === hostile).length, 1)
    // And the metacharacters did not split it. The vector has exactly the SEVEN elements the
    // request implies — --model <path> is two, --fail-input-overflow one, --max <n> two, and
    // --prompt <hostile> two — so the hostile text produced ONE element rather than the
    // several tokens a shell would have seen in it.
    assert.deepEqual(args, [
      '--model', 'C:\\needle\\needle3.cact',
      '--fail-input-overflow',
      '--max', '512',
      '--prompt', hostile,
    ])
    assert.equal(args.length, 7)
  })

  it('NEVER emits the listener flags as ELEMENTS, even when the request text contains them', () => {
    // The engine ships an HTTP server behind --serve. This is the vector-level assertion that
    // the extension does not use it; the bridge refuses it independently, so a call site
    // cannot reintroduce it either.
    //
    // MEASURED on the pinned binary: `needle.exe --prompt --serve` answers one query and exits
    // — it does NOT start the server. The parser consumes the element after `--prompt` as the
    // prompt's value whatever it looks like, which is the behaviour that makes a caller's
    // text safe to pass at all. The refusal in `assertNoListenerArgument` is defence in depth
    // against a parser that behaves differently, not a fix for an observed failure.
    const { args } = buildEngineArgv(request({
      prompt: '--serve --port 8080',
      toolsPath: 'C:\\tmp\\tools.json',
    }))
    // The string IS present — inside the prompt element, as data. That is why the assertion
    // is on ELEMENTS and not on substrings: a substring search would reject a legitimate
    // prompt that merely mentions the flag.
    assert.ok(args.some(element => element.includes('--serve')))
    assert.equal(args.includes('--serve'), false, '--serve must never be its own argv element')
    assert.equal(args.includes('--port'), false)
    assert.equal(args.includes('--port=8080'), false)
    // Every element that is a FLAG — a leading `--` followed by a name — is one this package
    // chose, and the set is closed. The prompt's VALUE also starts with `--`, which is exactly
    // why the assertion cannot be "every element starting with --".
    const flags = args.filter(element => /^--[a-z][a-z0-9-]*$/.test(element))
    assert.deepEqual([...new Set(flags)].sort(), [
      '--fail-input-overflow', '--max', '--model', '--prompt', '--tools',
    ])
  })

  it('REFUSES a system text that IS a bare listener flag the engine would read as one', () => {
    // The vector ['--system', '--serve'] is what a caller produces by passing "--serve" as
    // their system text. The engine consumes the next element as the value, so the hazard is
    // not an observed failure — but the guard is what keeps it that way if the parser ever
    // changes or another call site assembles a vector. Only `--prompt` and `--system` are
    // checked: every other flag's value is a path or a number this package chose.
    assert.throws(
      () => buildEngineArgv(request({ system: '--serve' })),
      /would be read as the flag --serve and could start the engine's HTTP listener/,
    )
    assert.throws(
      () => buildEngineArgv(request({ system: '--port=9000' })),
      /would be read as the flag --port/,
    )
    assert.throws(
      () => buildEngineArgv(request({ prompt: '--port' })),
      /would be read as the flag --port/,
    )
  })

  it('does NOT refuse a prompt that merely MENTIONS the flags in a sentence', () => {
    // The negative control. Refusing every prompt containing the word would break legitimate
    // use, so the check is on the whole value being a flag.
    assert.doesNotThrow(() => buildEngineArgv(request({ prompt: 'explain what --serve does' })))
    assert.doesNotThrow(() => buildEngineArgv(request({ system: 'the flags are --serve and --port' })))
    // A path that happens to contain the substring is likewise fine.
    assert.doesNotThrow(() => buildEngineArgv(request({ prompt: 'read /tmp/observe/port.txt' })))
  })

  it('always passes --fail-input-overflow, so an over-long turn is refused not trimmed', () => {
    // A silently trimmed prompt answers a question the caller did not ask, and the caller
    // cannot tell. Refusal is the only honest behaviour, so the flag is not optional.
    assert.ok(buildEngineArgv(request()).args.includes('--fail-input-overflow'))
    assert.ok(buildEngineArgv(request({ system: 'x' })).args.includes('--fail-input-overflow'))
  })

  it('includes --tools only when a document path was written', () => {
    assert.equal(buildEngineArgv(request()).args.includes('--tools'), false)
    const withTools = buildEngineArgv(request({ toolsPath: 'C:\\tmp\\tools.json' }))
    const index = withTools.args.indexOf('--tools')
    assert.notEqual(index, -1)
    assert.equal(withTools.args[index + 1], 'C:\\tmp\\tools.json')
  })

  it('omits --system when there is no system text and includes it when there is', () => {
    assert.equal(buildEngineArgv(request()).args.includes('--system'), false)
    assert.equal(buildEngineArgv(request({ system: '' })).args.includes('--system'), false)
    const withSystem = buildEngineArgv(request({ system: 'Today is 2026-10-14.' }))
    assert.equal(withSystem.args[withSystem.args.indexOf('--system') + 1], 'Today is 2026-10-14.')
  })

  it('passes --threads only when the operator set a budget', () => {
    assert.equal(buildEngineArgv(request()).args.includes('--threads'), false)
    assert.equal(buildEngineArgv(request({ threads: 2 })).args.includes('--threads'), true)
  })

  it('passes --max as a decimal string, since argv has no other type', () => {
    const { args } = buildEngineArgv(request({ maxNewTokens: 128 }))
    assert.equal(args[args.indexOf('--max') + 1], '128')
  })
})

describe('buildToolsDocument — the document handed to the engine', () => {
  it('uses the documented OpenAI function form, which the engine accepts', () => {
    const document = JSON.parse(buildToolsDocument([
      { name: 'get_weather', description: 'Get the weather.', parameters: { type: 'object' } },
    ])) as { type: string; function: { name: string; description: string } }[]
    assert.equal(document.length, 1)
    assert.equal(document[0]?.type, 'function')
    assert.equal(document[0]?.function.name, 'get_weather')
    assert.equal(document[0]?.function.description, 'Get the weather.')
  })

  it('refuses nothing and escapes everything: a hostile description is data', () => {
    // The engine reads this file as JSON, so a quote in a description must be escaped by
    // JSON.stringify rather than by hand — this asserts the round trip.
    const hostile = 'a " description with \\ backslash and \n newline and {"json":true}'
    const text = buildToolsDocument([
      { name: 'x', description: hostile, parameters: { type: 'object' } },
    ])
    const document = JSON.parse(text) as { function: { description: string } }[]
    assert.equal(document[0]?.function.description, hostile)
  })

  it('produces an empty array for no tools, which the engine reads as "no tools declared"', () => {
    // A measured behaviour worth recording: the engine does NOT reject an empty or malformed
    // tool document. It returns the empty call with `reasoning: "no tools declared"`, so an
    // empty plan is indistinguishable from a refusal unless the caller distinguishes them.
    assert.equal(buildToolsDocument([]), '[]')
  })
})

describe('readEngineEnvelope — the real envelopes decode into the modelled shape', () => {
  it('decodes a real tool-call envelope', () => {
    const envelope = readEngineEnvelope(REAL_CALL)
    assert.equal(envelope.type, 'call')
    assert.equal(envelope.success, true)
    assert.equal(envelope.error, null)
    assert.equal(envelope.functionCalls.length, 1)
    assert.equal(envelope.functionCalls[0]?.name, 'get_weather')
    assert.deepEqual(envelope.functionCalls[0]?.arguments, { city: 'Shanghai' })
    assert.equal(envelope.confidence, 0.9677)
    assert.equal(envelope.validation?.negation, false)
    assert.deepEqual(envelope.validation?.ungrounded, [])
  })

  it('decodes a real envelope that carries NO validation block', () => {
    // The engine omits `validation` when no tools were declared. Modelling that as an empty
    // report would claim a grounding check that never ran.
    const envelope = readEngineEnvelope(REAL_EMPTY_CALL)
    assert.deepEqual(envelope.functionCalls, [])
    assert.equal(envelope.validation, null)
    assert.match(envelope.reasoning, /no tools declared/)
  })

  it('decodes a real extraction envelope with numeric and array arguments', () => {
    const envelope = readEngineEnvelope(REAL_EXTRACTION)
    const call = envelope.functionCalls[0]
    assert.equal(call?.name, EXTRACTION_FUNCTION_NAME)
    assert.equal(call?.arguments.total_amount, 418.75)
    assert.deepEqual(call?.arguments.line_items, ['3x aluminium bracket', '1x shipping'])
    // The low confidence is REAL and is preserved rather than tidied: an extraction the
    // engine was unsure about must reach the caller as such.
    assert.equal(envelope.confidence, 0.4332)
  })

  it('leaves a field it does not model visible on `raw`', () => {
    // `peak_ram_mb` and `decode_tps` are real fields the package does not project. Dropping
    // them silently would hide information a caller may legitimately want.
    const envelope = readEngineEnvelope(REAL_CALL)
    assert.equal(envelope.raw.peak_ram_mb, 80.4)
    assert.equal(envelope.raw.decode_tps, 8.9)
  })

  it('reads the envelope out of a stream that carries other lines', () => {
    // A diagnostic printed before or after the object is realistic; the LAST decodable line
    // is the envelope.
    const envelope = readEngineEnvelope(`${REAL_CALL}\nsome trailing diagnostic\n`)
    assert.equal(envelope.functionCalls[0]?.name, 'get_weather')
  })

  it('REFUSES rather than inventing an envelope when nothing decodes', () => {
    // The engine prints its usage text and exits 1 when it has no model. That must not be
    // read as an empty plan.
    assert.throws(
      () => readEngineEnvelope(REAL_USAGE),
      (error: unknown) => {
        assert.ok(error instanceof EngineCallError)
        assert.match(error.message, /printed no JSON object on stdout/)
        assert.match(error.message, /usage: needle.exe/)
        return true
      },
    )
  })

  it('treats a MISSING `success` as false rather than as true', () => {
    // An envelope that does not say it succeeded must not be read as one that did.
    const envelope = readEngineEnvelope('{"type":"call","function_calls":[]}')
    assert.equal(envelope.success, false)
    assert.equal(envelope.confidence, null)
  })

  it('drops a malformed function call instead of producing a half-built one', () => {
    // A call with no usable name cannot be validated or attributed, so it is not modelled.
    const envelope = readEngineEnvelope(
      '{"type":"call","success":true,"function_calls":[{"arguments":{}},{"name":"ok","arguments":{}}]}',
    )
    assert.deepEqual(envelope.functionCalls.map(call => call.name), ['ok'])
  })

  it('models a call whose arguments are not an object as an empty argument set', () => {
    const envelope = readEngineEnvelope(
      '{"type":"call","success":true,"function_calls":[{"name":"x","arguments":"not-an-object"}]}',
    )
    assert.deepEqual(envelope.functionCalls[0]?.arguments, {})
  })

  it('carries suppressed calls through, so a withheld call is not invisible', () => {
    const envelope = readEngineEnvelope(
      '{"type":"call","success":true,"function_calls":[],'
      + '"suppressed_calls":[{"name":"dangerous","arguments":{"a":1}}]}',
    )
    assert.deepEqual(envelope.suppressedCalls.map(call => call.name), ['dangerous'])
  })
})
