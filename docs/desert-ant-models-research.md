# Desert Ant Labs — model research

Synthesised from desertant.com, the upstream GitHub READMEs, the Hugging Face
organisation and the published npm packages. Regenerate with `node scripts/gen-docs.mjs`.

## What Desert Ant Labs ships

Small, specialised on-device models — vision, audio and text — that run locally
with no server round trip and no API key. There is **no hosted REST API**:
every model runs in the caller's process.

| Distribution | Detail |
| --- | --- |
| Swift | `desert-ant-core` 3.6.0, one product per model, iOS 18+/macOS 15+ |
| Kotlin | `ai.desertant:<model>:3.6.0`, Android API 24+ |
| JavaScript | `@desert-ant-labs/<model>`, browser (WASM) and Node |
| CLI | `desertant` / `da`, macOS (Apple silicon) and Linux |
| Weights | [huggingface.co/desert-ant-labs](https://huggingface.co/desert-ant-labs) |

## The catalog

| Model | What it does | Input | Languages | Windows x64 Node | Tier |
| --- | --- | --- | --- | --- | --- |
| **Align** | Word-timestamp refinement for any transcript, on device, from 0.7MB. | audio | — | no | Prebuilt for linux-x64 / linux-arm64 / darwin-arm64 only |
| **Clear** | On-device speech enhancement: denoise, dereverb and loudness-normalize to 48 kHz. | audio | — | no | Prebuilt for linux-x64 / linux-arm64 / darwin-arm64 only |
| **Clips** | Clip selection that turns a long recording into ranked shorts and highlights from a transcript. | video | — | no | Prebuilt for linux-x64 / linux-arm64 / darwin-arm64 only |
| **Ear** | On-device spoken language identification across 102 languages from a short audio stretch. | audio | 102 | no | Prebuilt for linux-x64 / linux-arm64 / darwin-arm64 only |
| **Emo** | Type a task or message and get the emoji that fit, in 22 languages, on the device. | text | 22 | no | Prebuilt for linux-x64 / linux-arm64 / darwin-arm64 only |
| **Eye** | On-device frame scoring that tells you which shot to keep, what is in it, and which shots repeat. | image | — | no | Closed beta — no SDK ships it |
| **Face** | On-device face matching that finds the same person across a photo library or through a video. | image | — | no | Closed beta — no SDK ships it |
| **Gist** | On-device topic tagging across a 36-topic taxonomy, in 101 languages, with no server call. | text | 101 | no | Prebuilt for linux-x64 / linux-arm64 / darwin-arm64 only |
| **Moderator** | On-device NSFW detection that flags nudity before upload, trained only on licensed and synthetic data. | image | — | no | Prebuilt for linux-x64 / linux-arm64 / darwin-arm64 only |
| **Redact** | On-device redaction that strips personal data as you type, in 27 languages, with restore support. | text | 27 | no | Prebuilt for linux-x64 / linux-arm64 / darwin-arm64 only |
| **Schemer** | Extract typed fields from any text against your own schema, on device, with empty fields left empty. | text | — | no | Closed beta — no SDK ships it |
| **Shapes** | On-device shape recognition that turns one hand-drawn stroke into a rectangle, ellipse, triangle, star or line in under 10ms. | stroke | — | no | Prebuilt for linux-x64 / linux-arm64 / darwin-arm64 only |
| **Title** | On-device titles and descriptions: a short factual title and a one- or two-sentence description for any passage. | text | — | no | Apple platforms only (Core ML / MLX) |
| **Tongue** | On-device language identification for short text across 84 languages, from just a few words. | text | 84 | yes | Runs in plain Node everywhere |
| **Toxic** | On-device moderation that flags hateful, abusive and threatening text in 23 European languages. | text | 23 | no | Closed beta — no SDK ships it |
| **Uhm** | On-device filler detection that marks every um, uh and hmm to within 20ms, an hour of audio in 12s. | audio | — | no | Apple platforms only (Core ML / MLX) |
| **Voz** | Transcribe 10 minutes of audio in 2s on an iPhone, 14x faster than Whisper, with word timestamps. | audio | 25 | yes | Runs where ONNX Runtime runs |
| **Who** | On-device speaker labeling that turns a recording into per-person turns with face boxes and timestamps. | audio | — | no | Closed beta — no SDK ships it |

## How a developer invokes a model

```js
// JavaScript, in-process. Tongue is the only model that needs nothing else.
import { Tongue } from "@desert-ant-labs/tongue"
const tongue = await Tongue.load()
tongue.detect("kann ich das haben")   // { language: "de", ... }

// Voz needs an ONNX Runtime module handed to it, because the module graph
// must not contain a native addon by default.
import * as ort from "onnxruntime-node"
import { Voz } from "@desert-ant-labs/voz"
const voz = await Voz.load({ ort })
await voz.transcribe("talk.wav")    // { text, words: [{ text, start, end }] }
```

```sh
# The CLI, JSON-first, macOS and Linux only
da redact "Email Anna at anna@example.hu" --json
da voz talk.mp4 --json | da clips talk.mp4 --transcript -
```

## The four routes a DSH tool can take to a model

The plugin resolves these in order and reports which one it used.

| Route | Reaches | Requirement |
| --- | --- | --- |
| `npm-native` | Models with a prebuilt Node core | The npm package, on linux-x64 / linux-arm64 / darwin-arm64 |
| `npm-onnxruntime` | Voz | The npm package plus `onnxruntime-node` (ships win32-x64) |
| `cli` | Every shipping model | The `desertant` CLI on PATH (macOS, Linux) |
| `remote` | Any model, including Apple-only | A bridge the user runs on a machine that can execute it |

The `remote` route is what makes an Apple-only model such as Title usable
from a Windows host; `scripts/desert-ant-bridge.mjs` is a reference bridge.

## Licence

The models are under the [Desert Ant Labs Source-Available License 1.0](https://license.desertant.com/1.0),
not an open-source licence. Inference is unlimited and free below 100,000 monthly
active devices **per platform, per model**; above that a commercial licence is needed.
Attribution is required, and the models may not be redistributed or re-hosted as a
standalone product or service. The CLI itself is MIT.

## Sources

- Align: https://desertant.com/models/align/ · https://huggingface.co/desert-ant-labs/align
- Clear: https://desertant.com/models/clear/ · https://huggingface.co/desert-ant-labs/clear
- Clips: https://desertant.com/models/clips/ · https://huggingface.co/desert-ant-labs/clips
- Ear: https://desertant.com/models/ear/ · https://huggingface.co/desert-ant-labs/ear
- Emo: https://desertant.com/models/emo/ · https://huggingface.co/desert-ant-labs/emo
- Eye: https://desertant.com/models/eye/ · https://huggingface.co/desert-ant-labs/eye
- Face: https://desertant.com/models/face/ · https://huggingface.co/desert-ant-labs/face
- Gist: https://desertant.com/models/gist/ · https://huggingface.co/desert-ant-labs/gist
- Moderator: https://desertant.com/models/moderator/ · https://huggingface.co/desert-ant-labs/moderator
- Redact: https://desertant.com/models/redact/ · https://huggingface.co/desert-ant-labs/redact
- Schemer: https://desertant.com/models/schemer/ · https://huggingface.co/desert-ant-labs/schemer
- Shapes: https://desertant.com/models/shapes/ · https://huggingface.co/desert-ant-labs/shapes
- Title: https://desertant.com/models/title/ · https://huggingface.co/desert-ant-labs/title
- Tongue: https://desertant.com/models/tongue/ · https://huggingface.co/desert-ant-labs/tongue
- Toxic: https://desertant.com/models/toxic/ · https://huggingface.co/desert-ant-labs/toxic
- Uhm: https://desertant.com/models/uhm/ · https://huggingface.co/desert-ant-labs/uhm
- Voz: https://desertant.com/models/voz/ · https://huggingface.co/desert-ant-labs/voz
- Who: https://desertant.com/models/who/ · https://huggingface.co/desert-ant-labs/who
- Upstream SDK: https://github.com/Desert-Ant-Labs/desert-ant-core
- Licence: https://license.desertant.com/1.0
