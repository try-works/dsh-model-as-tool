/**
 * Generate the two data-derived documents from the catalog and playbooks.
 *
 * The docs are rendered from the same JSON the plugin loads, so a model added
 * to the catalog appears in the documentation without a second edit, and the
 * two can never disagree.
 *
 * Usage: node scripts/gen-docs.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const catalog = JSON.parse(readFileSync(join(root, 'packages/dsh-model-tools/catalog/desert-ant-models.json'), 'utf8'))
const playbooks = JSON.parse(readFileSync(join(root, 'packages/dsh-model-tools/catalog/playbooks.json'), 'utf8'))

mkdirSync(join(root, 'docs'), { recursive: true })

/** How each capability tier reads in the docs. */
const TIER = {
  'native-node': 'Runs in plain Node everywhere',
  'onnxruntime-node': 'Runs where ONNX Runtime runs',
  'browser-only': 'Prebuilt for linux-x64 / linux-arm64 / darwin-arm64 only',
  'apple-only': 'Apple platforms only (Core ML / MLX)',
  'no-sdk': 'Closed beta — no SDK ships it',
}

const win = model => model.verifiedRunnableOnWindows ? 'yes' : 'no'

// ---------------------------------------------------------------- research doc

const research = []
research.push('# Desert Ant Labs — model research', '')
research.push('Synthesised from desertant.com, the upstream GitHub READMEs, the Hugging Face')
research.push('organisation and the published npm packages. Regenerate with `node scripts/gen-docs.mjs`.', '')
research.push('## What Desert Ant Labs ships', '')
research.push('Small, specialised on-device models — vision, audio and text — that run locally')
research.push('with no server round trip and no API key. There is **no hosted REST API**:')
research.push('every model runs in the caller\'s process.', '')
research.push('| Distribution | Detail |', '| --- | --- |')
research.push('| Swift | `desert-ant-core` 3.6.0, one product per model, iOS 18+/macOS 15+ |')
research.push('| Kotlin | `ai.desertant:<model>:3.6.0`, Android API 24+ |')
research.push('| JavaScript | `@desert-ant-labs/<model>`, browser (WASM) and Node |')
research.push('| CLI | `desertant` / `da`, macOS (Apple silicon) and Linux |')
research.push('| Weights | [huggingface.co/desert-ant-labs](https://huggingface.co/desert-ant-labs) |')
research.push('')
research.push('## The catalog', '')
research.push('| Model | What it does | Input | Languages | Windows x64 Node | Tier |')
research.push('| --- | --- | --- | --- | --- | --- |')
for (const model of catalog) {
  research.push(
    `| **${model.name}** | ${model.summary} | ${model.input} | ${model.languages ?? '—'} | ${win(model)} | ${TIER[model.windowsSupport]} |`,
  )
}
research.push('')
research.push('## How a developer invokes a model', '')
research.push('```js')
research.push('// JavaScript, in-process. Tongue is the only model that needs nothing else.')
research.push('import { Tongue } from "@desert-ant-labs/tongue"')
research.push('const tongue = await Tongue.load()')
research.push('tongue.detect("kann ich das haben")   // { language: "de", ... }')
research.push('')
research.push('// Voz needs an ONNX Runtime module handed to it, because the module graph')
research.push('// must not contain a native addon by default.')
research.push('import * as ort from "onnxruntime-node"')
research.push('import { Voz } from "@desert-ant-labs/voz"')
research.push('const voz = await Voz.load({ ort })')
research.push('await voz.transcribe("talk.wav")    // { text, words: [{ text, start, end }] }')
research.push('```')
research.push('')
research.push('```sh')
research.push('# The CLI, JSON-first, macOS and Linux only')
research.push('da redact "Email Anna at anna@example.hu" --json')
research.push('da voz talk.mp4 --json | da clips talk.mp4 --transcript -')
research.push('```')
research.push('')
research.push('## The four routes a DSH tool can take to a model', '')
research.push('The plugin resolves these in order and reports which one it used.', '')
research.push('| Route | Reaches | Requirement |')
research.push('| --- | --- | --- |')
research.push('| `npm-native` | Models with a prebuilt Node core | The npm package, on linux-x64 / linux-arm64 / darwin-arm64 |')
research.push('| `npm-onnxruntime` | Voz | The npm package plus `onnxruntime-node` (ships win32-x64) |')
research.push('| `cli` | Every shipping model | The `desertant` CLI on PATH (macOS, Linux) |')
research.push('| `remote` | Any model, including Apple-only | A bridge the user runs on a machine that can execute it |')
research.push('')
research.push('The `remote` route is what makes an Apple-only model such as Title usable')
research.push('from a Windows host; `scripts/desert-ant-bridge.mjs` is a reference bridge.')
research.push('')
research.push('## Licence', '')
research.push('The models are under the [Desert Ant Labs Source-Available License 1.0](https://license.desertant.com/1.0),')
research.push('not an open-source licence. Inference is unlimited and free below 100,000 monthly')
research.push('active devices **per platform, per model**; above that a commercial licence is needed.')
research.push('Attribution is required, and the models may not be redistributed or re-hosted as a')
research.push('standalone product or service. The CLI itself is MIT.', '')
research.push('## Sources', '')
for (const model of catalog) {
  research.push(`- ${model.name}: ${model.docsUrl} · ${model.hfRepo}`)
}
research.push('- Upstream SDK: https://github.com/Desert-Ant-Labs/desert-ant-core')
research.push('- Licence: https://license.desertant.com/1.0')
research.push('')

writeFileSync(join(root, 'docs/desert-ant-models-research.md'), research.join('\n'))

// ---------------------------------------------------------------- playbook doc

const play = []
play.push('# Model tool playbook — use cases, tool shapes and skills', '')
play.push('One section per catalogued model: what the tool is called, the jobs it is for,')
play.push('when an agent should and should not reach for it, how to drive it, and what to')
play.push('watch out for. This is the source material the plugin renders into each model\'s')
play.push('skill, from `packages/dsh-model-tools/catalog/playbooks.json`.', '')
play.push('## Which models are actually installable today', '')
play.push('| Model | Tool | Skill | Windows x64 | Why not, when unavailable |')
play.push('| --- | --- | --- | --- | --- |')
for (const model of catalog) {
  const reason = model.windowsSupport === 'native-node'
    ? '— runs here'
    : model.windowsSupport === 'onnxruntime-node'
      ? '— runs here with onnxruntime-node'
      : model.windowsSupport === 'apple-only'
        ? 'Apple-only (Core ML / MLX); no JS or Kotlin SDK'
        : model.windowsSupport === 'no-sdk'
          ? 'Closed beta; weights published, no shipping SDK'
          : 'No win32-x64 prebuild; linux-x64 / linux-arm64 / darwin-arm64 only'
  play.push(`| **${model.name}** | \`${model.tool.name}\` | \`${model.skill.name}\` | ${win(model)} | ${reason} |`)
}
play.push('')

for (const model of catalog) {
  const book = playbooks[model.id]
  play.push(`## ${model.name} — \`${model.tool.name}\``, '')
  play.push(`${model.summary}`, '')
  play.push(`- **Capability:** \`${model.capability}\``)
  play.push(`- **Input / output:** ${model.input} → ${model.output}`)
  play.push(`- **Returns:** ${model.tool.returns}`)
  play.push(`- **Skill:** \`${model.skill.name}\``)
  play.push(`- **Docs:** ${model.docsUrl}`)
  play.push('')
  play.push('**Parameters**', '')
  for (const [name, param] of Object.entries(model.tool.params)) {
    play.push(`- \`${name}\` (${param.type ?? 'string'}): ${param.description}`)
  }
  play.push('')
  if (!book) {
    play.push('_No playbook authored yet._', '')
    continue
  }
  const section = (title, items) => {
    if (!items || items.length === 0) return
    play.push(`**${title}**`, '')
    for (const item of items) play.push(`- ${item}`)
    play.push('')
  }
  section('Use cases', book.useCases)
  section('When to use', book.whenToUse)
  section('When not to use', book.whenNotToUse)
  if (book.workflow?.length) {
    play.push('**Workflow**', '')
    book.workflow.forEach((step, index) => play.push(`${index + 1}. ${step}`))
    play.push('')
  }
  section('Pairs with', book.pairsWith)
  section('Caveats', book.caveats)
}

writeFileSync(join(root, 'docs/model-tool-playbook.md'), play.join('\n'))

console.log(`catalog entries: ${catalog.length}`)
console.log(`playbooks: ${Object.keys(playbooks).length}`)
console.log('wrote docs/desert-ant-models-research.md')
console.log('wrote docs/model-tool-playbook.md')
