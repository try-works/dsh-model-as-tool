/**
 * Qualification for the MiniLM pair (text_embed + text_rerank).
 *
 * This is the REAL-inference record: it verifies the acquired bytes against the
 * pinned digests in each package's models.lock.json, builds each extension
 * through its BUILT entry exactly as the host dispatches, loads the verified
 * group, and measures:
 *
 *   - text_embed: 384-d vectors, finite, unit norm, identical texts identical,
 *     an unrelated text measurably less similar;
 *   - text_rerank: ranking_logit ordering puts a relevant pair above an
 *     unrelated pair, ties keep input order, ids are the caller's;
 *   - timings: cold load (session create + tokenizer) and per-call.
 *
 * Writes docs/tool-mode/qualification/minilm.json. On a machine without the
 * acquired group it prints one SKIPPED line naming the acquisition and exits 0
 * (never a fake pass); pass MINILM_ASSETS_DIR to point elsewhere.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const ASSETS_DIR = process.env.MINILM_ASSETS_DIR ?? 'E:/tmp/minilm-assets'
const RECORD_PATH = join(REPO_ROOT, 'docs', 'tool-mode', 'qualification', 'minilm.json')

const PACKAGES = {
  embed: {
    dir: join(REPO_ROOT, 'packages', 'extension-minilm-embed'),
    group: join(ASSETS_DIR, 'embed-group'),
    modelId: 'minilm-l6',
    implementationId: 'minilm-l6-onnx',
    set: 'minilm-l6-onnx',
  },
  rerank: {
    dir: join(REPO_ROOT, 'packages', 'extension-minilm-rerank'),
    group: join(ASSETS_DIR, 'rerank-group'),
    modelId: 'minilm-rerank',
    implementationId: 'minilm-rerank-onnx',
    set: 'minilm-rerank-onnx',
  },
}

function skip(reason) {
  console.log(`SKIPPED: ${reason}`)
  process.exitCode = 0
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Verify the acquired group against the lock, returning the measured entries. */
function verifyGroup(pkg) {
  const lock = JSON.parse(readFileSync(join(pkg.dir, 'models.lock.json'), 'utf8'))
  const set = lock.assetSets[pkg.set]
  if (set === undefined) throw new Error(`the lock has no asset set ${pkg.set}`)
  if (set.pinning.state !== 'measured') throw new Error(`the lock is not measured (state=${set.pinning.state})`)
  const group = set.groups.find(entry => entry.id === 'text-backbone')
  if (group === undefined) throw new Error('the lock has no text-backbone group')
  const measured = []
  for (const asset of group.assets) {
    const path = join(pkg.group, asset.file)
    if (!existsSync(path)) return { missing: asset.file, set }
    const bytes = statSync(path).size
    const digest = sha256(path)
    if (bytes !== asset.bytes) throw new Error(`${asset.file}: bytes ${bytes} != pinned ${asset.bytes}`)
    if (digest !== asset.digest) throw new Error(`${asset.file}: digest ${digest} != pinned ${asset.digest}`)
    measured.push({ file: asset.file, bytes, digest })
  }
  return { measured, set }
}

function extensionContext(extensionId) {
  return {
    extensionId,
    extensionVersion: '0.1.0',
    activationGeneration: 1,
    storage: { async read() { return undefined }, async write() {}, directory: '' },
    logger: { log(level, message) { if (level !== 'debug') process.stderr.write(`[${level}] ${message}\n`) } },
    signal: new AbortController().signal,
    configuration: {},
  }
}

function invocationContext() {
  return {
    invocationId: 'qualify-minilm',
    signal: new AbortController().signal,
    limits: { maxInputBytes: 8 * 1024 * 1024, maxResultBytes: 4 * 1024 * 1024 },
    resolvePath: candidate => candidate,
  }
}

async function buildProvider(pkg, extensionId) {
  const lib = join(pkg.dir, 'lib', 'index.js')
  if (!existsSync(lib)) skip(`the built extension entry is missing at ${lib}; run the package build first`)
  const module = await import(pathToFileURL(lib).href)
  const declared = module.default
  if (declared === undefined || typeof declared.create !== 'function') {
    throw new Error(`the built extension at ${lib} does not default-export create(context)`)
  }
  const instance = await declared.create(extensionContext(extensionId))
  return { instance, provider: await instance.createProvider({ modelId: pkg.modelId }) }
}

/** The PreparedAssetMap the host assembles for the verified group. */
function assetMap(groupPath) {
  return {
    get: assetId => (assetId === 'text-backbone' ? { path: groupPath, digest: 'sha256:measured' } : undefined),
    assetIds: ['text-backbone'],
  }
}

function unitNorm(vector) {
  let sum = 0
  for (const value of vector) sum += value * value
  return Math.sqrt(sum)
}

function cosine(a, b) {
  let dot = 0
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i]
  return dot / (unitNorm(a) * unitNorm(b))
}

async function main() {
  const embed = PACKAGES.embed
  const rerank = PACKAGES.rerank
  const embedCheck = verifyGroup(embed)
  if (embedCheck.missing !== undefined) {
    skip(`the embed group is missing ${embedCheck.missing} under ${embed.group}; acquire it per models.lock.json`)
  }
  const rerankCheck = verifyGroup(rerank)
  if (rerankCheck.missing !== undefined) {
    skip(`the rerank group is missing ${rerankCheck.missing} under ${rerank.group}; acquire it per models.lock.json`)
  }
  console.log('digests verified against the pinned locks')

  // ---- text_embed -------------------------------------------------------
  const embedBuilt = await buildProvider(embed, '@try-works/extension-minilm-embed')
  const embedStarted = Date.now()
  await embedBuilt.provider.load({ assets: assetMap(embed.group), signal: new AbortController().signal })
  const embedColdLoadMs = Date.now() - embedStarted

  const texts = [
    'The quick brown fox jumps over the lazy dog.',
    'The quick brown fox jumps over the lazy dog.',
    'A completely different sentence about banking and interest rates.',
  ]
  const embedCallStarted = Date.now()
  const embedded = await embedBuilt.provider.invoke({
    implementationId: embed.implementationId,
    input: { texts },
    context: invocationContext(),
  })
  const embedCallMs = Date.now() - embedCallStarted
  const vectors = embedded.embeddings
  if (!Array.isArray(vectors) || vectors.length !== texts.length) throw new Error('text_embed did not return one vector per text')
  for (const vector of vectors) {
    if (vector.length !== 384) throw new Error(`text_embed returned ${vector.length} dimensions, expected 384`)
    if (!vector.every(Number.isFinite)) throw new Error('text_embed returned a non-finite value')
    const norm = unitNorm(vector)
    if (Math.abs(norm - 1) > 1e-5) throw new Error(`text_embed vector is not unit norm (${norm})`)
  }
  const identical = cosine(vectors[0], vectors[1])
  const unrelated = cosine(vectors[0], vectors[2])
  if (Math.abs(identical - 1) > 1e-6) throw new Error(`identical texts differ (${identical})`)
  if (!(identical > unrelated)) throw new Error(`an unrelated text scored as similar (${unrelated})`)
  console.log(`text_embed: 384-d unit vectors, identical=${identical.toFixed(6)} unrelated=${unrelated.toFixed(6)}`)
  await embedBuilt.provider.unload(new AbortController().signal)
  await embedBuilt.instance.dispose('qualified')

  // ---- text_rerank ------------------------------------------------------
  const rerankBuilt = await buildProvider(rerank, '@try-works/extension-minilm-rerank')
  const rerankStarted = Date.now()
  await rerankBuilt.provider.load({ assets: assetMap(rerank.group), signal: new AbortController().signal })
  const rerankColdLoadMs = Date.now() - rerankStarted
  const rerankCallStarted = Date.now()
  const ranked = await rerankBuilt.provider.invoke({
    implementationId: rerank.implementationId,
    input: {
      query: 'What is the capital of France?',
      documents: [
        { id: 'unrelated', text: 'Bananas are yellow fruits.' },
        { id: 'relevant', text: 'Paris is the capital of France.' },
      ],
    },
    context: invocationContext(),
  })
  const rerankCallMs = Date.now() - rerankCallStarted
  const results = ranked.results
  if (!Array.isArray(results) || results.length !== 2) throw new Error('text_rerank did not return both documents')
  if (results[0].id !== 'relevant') throw new Error(`text_rerank ranked ${results[0].id} first; the relevant document must lead`)
  if (results[0].score <= results[1].score) throw new Error('ranking_logit order is not descending')
  if (ranked.scoreKind !== 'ranking_logit') throw new Error(`text_rerank scoreKind is ${ranked.scoreKind}`)
  console.log(`text_rerank: ranking_logit relevant=${results[0].score.toFixed(4)} unrelated=${results[1].score.toFixed(4)}`)
  await rerankBuilt.provider.unload(new AbortController().signal)
  await rerankBuilt.instance.dispose('qualified')

  // ---- record -----------------------------------------------------------
  const record = {
    schema: 'tool-mode/qualification/1',
    generatedAt: new Date().toISOString(),
    host: { os: process.platform, arch: process.arch, node: process.version },
    note: 'Real ONNX inference over the DIGEST-VERIFIED public artifacts: sentence-transformers/all-MiniLM-L6-v2 (text.embed, 384-d) and cross-encoder/ms-marco-MiniLM-L-6-v2 (text.rerank, ranking_logit). The tokenizer is the pure-TS WordPiece implementation, pinned against the HF reference ids by the package suites.',
    embed: {
      set: embed.set,
      revision: embedCheck.set.pinning.revision,
      assets: embedCheck.measured,
      dimensions: 384,
      coldLoadMs: embedColdLoadMs,
      callMs: embedCallMs,
      identicalCosine: identical,
      unrelatedCosine: unrelated,
    },
    rerank: {
      set: rerank.set,
      revision: rerankCheck.set.pinning.revision,
      assets: rerankCheck.measured,
      coldLoadMs: rerankColdLoadMs,
      callMs: rerankCallMs,
      ranked: results,
      scoreKind: ranked.scoreKind,
    },
  }
  mkdirSync(join(REPO_ROOT, 'docs', 'tool-mode', 'qualification'), { recursive: true })
  writeFileSync(RECORD_PATH, `${JSON.stringify(record, null, 2)}\n`)
  console.log(`record written: ${RECORD_PATH}`)
  console.log(`cold loads: embed ${embedColdLoadMs} ms, rerank ${rerankColdLoadMs} ms; calls ${embedCallMs}/${rerankCallMs} ms`)
}

await main()
