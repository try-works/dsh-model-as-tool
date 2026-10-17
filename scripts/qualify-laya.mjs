#!/usr/bin/env node
/**
 * The Laya decision-family qualification (H5): verifies the six pinned
 * SHA-256s and runs REAL decision calls through the BUILT extension entry
 * against the model directory (env LAYA_MODEL_DIR, default
 * E:\\tmp\\laya-investigation\\laya\\model-ml), writing the record to
 * docs/tool-mode/qualification/laya.json.
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const MODEL_DIR = process.env.LAYA_MODEL_DIR
  ?? 'E:\\tmp\\laya-investigation\\laya\\model-ml'
const EXPECTED = {
  'encoder.onnx': 'A774C5C634B99D1A4CED21ACBF11B9617A5CD55C7C7957BD52480B17D95A97F4',
  'encoder.onnx.data': 'F1E49A027352064D72831863456BE6160748854296BFF8332DF14130DBF79834',
  'head.onnx': '7F6B9AC15D5FDF9EEBB352E66BDD3CE799D32885F1446014D268D8C53207858B',
  'head.onnx.data': '0292A4EB478C2C3EC0B6555B4A4093BC802E965654D7AEB4AC22907A17F261D3',
  'tokenizer.json': '609D8F4C067CD3950F88594C5A802616CEA245823836EF5848EE4FC40AAB5B6F',
  'rl_agent_config.json': '25061739243B617AD88D1219BA6F8A9C86C5881CA28DF024FA2D9B3B2FCC30C6',
}

const sha256Hex = data => createHash('sha256').update(data).digest('hex')

const record = {
  qualifiedAt: new Date().toISOString(),
  modelDir: MODEL_DIR,
  digests: [],
  calls: [],
  notes: [],
}
let failed = false

for (const [file, expected] of Object.entries(EXPECTED)) {
  const bytes = readFileSync(join(MODEL_DIR, file))
  const got = sha256Hex(bytes).toUpperCase()
  const ok = got === expected
  record.digests.push({ file, bytes: bytes.length, expected, got, ok })
  if (!ok) failed = true
}

if (!failed) {
  // The extension's lib entry does not re-export the runtime; drive the
  // vendored runtime directly — the same files the built lib/index.js imports
  // at '../vendor/laya-ts/index.js'.
  const vendorUrl = new URL(
    '../packages/extension-laya/vendor/laya-ts/index.js',
    import.meta.url,
  ).href
  const { Agent, createNodeProvider, decide } = await import(vendorUrl)

  const provider = await createNodeProvider(MODEL_DIR, { expectedSha256: EXPECTED, device: 'cpu' })
  const agent = new Agent({ provider })

  const fixtures = [
    {
      tool: 'decision_choose',
      prompt: 'Which of these is a fruit?',
      options: ['apple', 'car', 'banana'],
    },
    {
      tool: 'decision_test',
      prompt: 'Is water wet?',
      options: ['yes', 'no'],
    },
    {
      tool: 'decision_score',
      prompt: 'How urgent is this: the server is on fire?',
      options: ['low', 'medium', 'high', 'critical'],
    },
  ]
  for (const fixture of fixtures) {
    const started = Date.now()
    const result = await decide(
      agent,
      fixture.prompt,
      null,
      {
        questions: {
          answer: {
            type: fixture.tool === 'decision_score' ? 'score' : 'choice',
            instructions: fixture.prompt,
            criteria: fixture.tool === 'decision_score'
              ? fixture.options
              : Object.fromEntries(fixture.options.map(option => [option, null])),
          },
        },
      },
    )
    // Without returnDetails, decide() returns the answers map itself: the
    // question's answer sits at result.answer (the question id).
    const answer = result.answer ?? Object.values(result.answers ?? {})[0]
    record.calls.push({
      tool: fixture.tool,
      prompt: fixture.prompt,
      answer: answer === undefined ? null : {
        ...(answer.type === 'choice' ? { choice: answer.choice } : {}),
        ...(answer.type === 'score' ? { score: answer.score } : {}),
        confidence: Number(answer.confidence ?? answer.answer_confidence ?? 0),
        calibrated: false,
        probabilities: answer.probabilities ?? {},
        action: answer.action ?? null,
      },
      durationMs: Date.now() - started,
    })
  }
  record.notes.push('decisions ran through the vendored runtime over the pinned ONNX sessions (encoder + head, CPU); every confidence is marked calibrated: false (DEC-08, the upstream card ships uncalibrated logits with a clamping warning)')
} else {
  record.notes.push('one or more digests did not match; the decision calls were SKIPPED rather than run on unverified artifacts')
}

const outDir = join(process.cwd(), 'docs', 'tool-mode', 'qualification')
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, 'laya.json')
writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`)
process.stdout.write(`qualify-laya: ${failed ? 'FAILED' : 'OK'} (${record.digests.length} digests, ${record.calls.length} calls) -> ${outPath}\n`)
process.exit(failed ? 1 : 0)
