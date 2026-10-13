# Desert Ant Labs — Model Catalog Research

_Researched 2026-10-13. Method: fetched pages with PowerShell `Invoke-WebRequest -UseBasicParsing`, stripped HTML (`<script>`/`<style>`/tags) to readable text, decoded entities, and followed internal docs / Hugging Face / GitHub / npm / licence links. Web search tooling was not used. Raw HTML and fetch-status logs are kept under `D:\DEV\dsh-model-as-tool\research\raw\`; stripped text under `...\research\text\`._

## Executive summary (incl. the critical Windows / invocation answer)

Desert Ant Labs (desertant.com) is an on-device AI lab shipping small, specialized models with Swift, Kotlin, and JavaScript SDKs, public Hugging Face weights, npm and Maven packages, and an agent-oriented CLI.

**Catalog count correction:** the task listed 19 names but supplied 18 (`align, clear, clips, ear, emo, eye, face, gist, moderator, redact, schemer, shapes, title, tongue, toxic, uhm, voz, who`). I found exactly those 18 model slugs. The press page says "12 models available today, 6 more in closed beta", which sums to 18.

**Critical answer — can this run on Windows, and how is it invoked?**

Not Apple-only, but **not a clean Windows path either**. The company ships for iOS, macOS, tvOS, visionOS, Android, Linux, Windows, the browser, and Node, and many models publish `.tflite`/ONNX artifacts. However, several model pages and the SDK README state that the **JavaScript `/native` Node builds are prebuilt only for linux-x64, linux-arm64, and darwin-arm64** — no win32-x64. That matches prior local findings in this workspace that the LiteRT-backed npm packages throw on plain Windows Node. Concretely:

- **Works on Windows today:** **Tongue** (pure JavaScript, no wasm, no inference runtime, 2 MB model bundled in the package, synchronous `detect()`).
- **Plausible with work:** **Voz** via `@desert-ant-labs/voz` + `onnxruntime-node` (CPU) — and the docs state the **Swift SDK runs Voz on Windows GPU through ONNX Runtime + DirectML**. Large download (~390–467 MB) and runtime plumbing required.
- **Artifacts exist but no working Windows SDK path shown:** Redact, Emo, Gist, Clear, Ear, Moderator, Shapes, Align (LiteRT npm native lacks win32; the browser build needs a browser/Worker), Clips (docs explicitly warn the `.tflite` files do not work with the SDK yet).
- **Apple-only / blocked on Windows:** **Title** (MLX, Apple silicon only, no Android/Linux/Windows/browser/Node build) and **Uhm** (Apple-only SDK today).
- **Closed beta (no shipping SDK):** Eye, Face, Schemer, Toxic, Who.
- **CLI:** `desertant` / `da` is JSON-first and explicitly built for coding agents, but its README says **macOS (Apple silicon) and Linux** — not Windows.

**How a developer invokes a model (concrete, all from the site/README):**

- Swift Package Manager: `.package(url: "https://github.com/Desert-Ant-Labs/desert-ant-core.git", from: "3.6.0")` then a product per model (e.g. `Redact`, `Emo`, `Voz`).
- Kotlin / Maven Central: `implementation("ai.desertant:redact:3.6.0")` (Android API 24+, arm64-v8a/x86_64; Tongue also any JVM 17+).
- npm: `npm i @desert-ant-labs/redact` (browser also needs `@litertjs/core`); Node uses the `/native` subpath (except Voz); Voz uses `onnxruntime-web` / `onnxruntime-node`.
- CLI: `da redact "…" --json`, `da voz talk.mp4 --json | da clips talk.mp4 --transcript -`, `desertant schema --json`.

```swift
import Redact
let redact = Redact()
let result = try await redact.redaction(of: text)
// result.redactedText: "Email [GIVEN_NAME_1] at [EMAIL_1]."
```

```ts
import { Redact } from "@desert-ant-labs/redact";          // browser
// import { Redact } from "@desert-ant-labs/redact/native"; // server-side Node
const redact = await Redact.load();
const result = await redact.redaction(text);
redact.dispose();
```

**There is no hosted REST API or API-key service.** Probes for `/api/`, `/developers/`, `/sdk/`, `/download/`, `/pricing/`, `/company/` all returned 404. The entire pitch is local inference: "no per-call cost", "no server call", "nothing is uploaded".

## Company / platform context (SDK, distribution, pricing, licensing)

**Company.** Desert Ant Labs B.V., Amsterdam, the Netherlands; KvK 42136051; founded August 2026. Founders: Paul Veugen (CEO), Laurier Rochon (CTO), Fredrik Wallin (Engineering). Press page: "Desert Ant Labs builds high-performance, small AI models that run on device, instead of the cloud", "12 models available today, 6 more in closed beta, across audio, text, and vision." The team is behind Detail (Apple iPad App of the Year, 2025 App Store Awards) and Subwave.

**Distribution surfaces actually verified:**

| Surface | Status | Evidence |
|---|---|---|
| Website model pages `/models/<slug>/` | 200 for all 18 | fetched individually |
| `/llms.txt`, `/llms-full.txt`, `/catalog.json` | 200 | machine-readable catalog |
| GitHub org `Desert-Ant-Labs` | 200 | `desert-ant-core`, `desert-ant-cli`, `desert-ant-swift`, `homebrew-tap`, `demo-clipper`, `demo-redactor`, `desert-ant-web-examples`, `COnnxRuntime`, `.github` |
| Hugging Face org `desert-ant-labs` | 200 | API listed 17 public model repos (+ `toxic-en`); demos as Spaces |
| npm `@desert-ant-labs/*` | registry API 200 | core, align, clear, ear, emo, gist, moderator, redact, shapes, tongue, voz, (internal) desert-ant-web; latest **3.6.0** |
| `npmjs.com/org/desert-ant-labs` | **403** | registry API works, web org page refused |
| Maven Central `ai.desertant` | stated in docs | e.g. `ai.desertant:clear:3.6.0` |
| PyPI | **404** for `/pypi/desertant/json` and `/pypi/desert-ant/json` | no Python package verified |
| CocoaPods | search resolved, "No pods found" | not distributed as pods |
| Swift Package Index | **404** for `swiftpackageindex.com/Desert-Ant-Labs` | SPM distribution is via the GitHub URL, not SPI |
| Desert Ant CLI | repo 200 | macOS (Apple silicon) + Linux only |
| GitHub org repos API | **403** | org HTML page used instead |

**Pricing (uniform across models), quoted from the footer and every model FAQ:** "Each model is free up to 100k monthly active devices. Inference is unlimited. Contact us for custom licenses."

**Licensing — Desert Ant Labs Source-Available License 1.0** (`https://license.desertant.com/1.0`, version dated 3 July 2026, SPDX `LicenseRef-DAL-Source-Available-1.0`):

- Source-available, **not open source**; perpetual; worldwide, royalty-free, non-exclusive, non-transferable, non-sublicensable. Accepting happens by downloading/using the Models; production use requires acceptance.
- **Free tier:** below **100,000 monthly active devices (MAD) per Platform, per Model**; each platform (iOS, Android, macOS, Windows, Linux, web, …) counted separately, and different Models counted separately. Above that a commercial licence is required (`licensing@desertant.com`). "No splitting" — accounts/apps under common control count together.
- **Research/teaching:** non-commercial scientific research, teaching, and academic publication are free and exempt from the MAD threshold (not for building/shipping a commercial product).
- **Free-tier obligation:** attribution — a short visible "Powered by Desert Ant Labs"-style credit naming Desert Ant Labs, linked to https://desertant.com where the medium allows; one reasonably discoverable placement (about/settings/credits/licences screen, store listing, or docs/repo for headless products). File-level licence and copyright notices shipped inside the SDK must be kept.
- **Telemetry:** SDKs send a minimal MAD-counting signal using an identifier the SDK generates solely to count MAD, "not tied to any end user, account, or other identifier… never includes your inputs, your Outputs, or your users' content", and does not link users across installations/devices/platforms/apps. Desert Ant is the controller of that telemetry, not the developer's processor. Tampering with telemetry is prohibited.
- **Outputs:** as between you and Desert Ant, you own your Outputs and your logs.
- **Prohibitions (licence §6, restated for agents in §19):** (a) no using the Models, their Outputs, or their logs to train, fine-tune, distill, or assemble a dataset for a **Competing Model** (an on-device audio/video/image/text model that substitutes for, is substantially similar to, or competes with a Desert Ant Model); (b) no bulk-extracting or systematically logging Outputs to build such a dataset; (c) **no redistributing the Models or SDKs as a standalone product, model, SDK, or hosted service** (embedding in your application and shipping that application is the permitted case); (d) no reverse engineering, model extraction, distillation attacks, or weight recovery; (e) no bypassing safety-model safeguards or misrepresenting safety-critical outputs; (f) no disabling/tampering with telemetry. Tuning thresholds for your product is explicitly fine.
- **Permitted:** running the Models in production, ordinary logging/analytics of your own app, threshold tuning, accessibility work, benchmarking, and internal-only classifiers/filters/embeddings built from Outputs and not distributed as a model.
- **Enforcement/audit:** Desert Ant may fingerprint Outputs, require written certification, and audit compliance on reasonable notice (≤ once a year absent good-faith suspicion). Keep weights reasonably secure against extraction.
- **EU AI Act:** Desert Ant considers the Models narrow-purpose components rather than general-purpose AI models; the developer is the provider of the AI system built with them.
- **Governing law:** the Netherlands, exclusive jurisdiction of the Amsterdam courts; liability capped at the greater of fees paid in the last 12 months or €100.
- **CLI licence differs:** `desert-ant-cli` is **MIT**; the models it runs remain under the source-available licence.

**Hardware / OS requirements stated (SDK README platform table):**

| Platform | Runtime | Requirements |
|---|---|---|
| iOS, macOS, tvOS, visionOS | Core ML | iOS 18+, macOS 15+, tvOS 18+, visionOS 2+, Swift 6.2+ (Xcode 26). An older OS cannot load the Core ML models. |
| Android | LiteRT | API 24+, arm64-v8a and x86_64 |
| Windows | LiteRT | x64, Swift 6.2+ |
| Browser | WebAssembly + LiteRT.js | any browser with WebAssembly; `@litertjs/core` |
| Node | prebuilt native core | **linux-x64, linux-arm64, darwin-arm64** |

Voz is the exception: ONNX Runtime outside Apple — **Windows GPU via ONNX Runtime + DirectML**, browser via WebGPU (`onnxruntime-web`) with WebNN for the decode step where available, Node via `onnxruntime-node` on CPU. Align's `StreamingRefiner` (SpeechAnalyzer integration) needs iOS 26 / macOS 26 / tvOS 26 / visionOS 26.

**Weight file formats observed:** compiled Core ML `.mlmodelc` (Apple), `.aimodel` (Clear, Core AI), `.tflite` (LiteRT), `.onnx`, `.safetensors`/MLX for Title, raw `.bin` int8/int4 (Tongue, Align calibrator, tokenizer), `.pt` for toxic-en. Download model: the SDK fetches from Hugging Face on first use, pinned to one revision per SDK version, verifies the download, then caches it in the platform cache directory; `directory:` / `{ directory }` / `modelBaseUrl` override for offline or self-hosted use; `HF_TOKEN` for gated/private repos. Tongue ships its 2 MB model inside the package (nothing downloads); **Title does not download at all** (you supply the MLX folder). Optional Swift `Xet` trait enables chunked/parallel downloads on Apple platforms.


## Model-by-model reference

### Align

1. **Name + one-line purpose:** Align — word timestamps: "Word timestamps on device, for any transcriber. Cut, caption, and highlight on the word, five times more accurately, from 0.7MB."
2. **Full capability description:** corrects the word-level timings an existing transcript already has (Apple `SpeechTranscriber`/`SpeechAnalyzer`, Whisper, Parakeet, any transcript) against the audio, returning the same words with tighter `audioTimeRange` start/end values. Two-stage coarse-to-fine cascade over a log-mel spectrogram plus a gradient-boosted calibrator. A structural fallback keeps the original timestamp whenever a correction would be invalid, hits the edge of the search window, or lacks streaming context — "a correction can only help or leave the word alone". It does **not** transcribe. `StreamingRefiner` attaches to Apple's `SpeechAnalyzer` (it records the audio passed in and corrects finalized results; volatile results pass through unchanged); the offline `Align.refine` works standalone on any transcript's words.
3. **Inputs / outputs:** mono audio (16 kHz typical; other rates must be under 37 hours) + the words of any transcript with proposed start/end times + a language code → the same words with corrected `start`/`end` and a `refined` flag. Bad input throws `AlignError.invalidInput` (Swift) / `RangeError` (JS); a word more than 1.2 s past the end of the audio keeps its input times with `refined: false`.
4. **Size / latency / accuracy / languages:** **20.2 ms** mean error on LibriSpeech test-clean vs Apple's raw 106.4 ms, **95%** of words within 50 ms; test-other 111.6 → 24.8 ms (92% within 50 ms); macro-average across all nine languages 124.2 → 43.9 ms; 45.0 ms against 258 hand-corrected boundaries (WhisperX 53.5 ms). The worst decile improves from 230.7 ms to 33.0 ms, about one frame of 30 fps video. Size ≈ **0.7 MB** compiled Core ML in two ~0.3 MB stages plus filter bank and calibrator; a typical result is refined in a few milliseconds. Core ML and LiteRT runtimes can disagree by ~10 ms. Languages: nine — English, Spanish, French, Italian, Portuguese, German, Japanese, Korean, Chinese; other locales pass through unchanged.
5. **Platform / runtime:** iOS 26 / macOS 26 / tvOS 26 / visionOS 26 on Core ML (`StreamingRefiner` requires those versions) **plus Linux, Windows, and Node on LiteRT**. No browser build (the wasm build loads only one model) and no Android SDK.
6. **Distribution & access:** model page `https://desertant.com/models/align/`; docs `https://desertant.com/docs/align/`; Swift product `Align`; npm `@desert-ant-labs/align` (Node only — in a browser `load()` throws and tells you to import `/native`); weights `https://huggingface.co/desert-ant-labs/align` (v1.1.0); "Get started", "Docs", and "Model card" links on the page. No CLI verb listed for Align.
7. **Licensing / pricing:** standard Desert Ant Labs Source-Available Licence — free below 100,000 MAD per platform, per model; inference unlimited; commercial licence above; attribution required.
8. **Restrictions for wrapping:** no standalone redistribution of the model/SDK or hosted service; no training competing models from outputs/logs; no weight extraction; keep telemetry. **Windows caveat:** docs claim Linux/Windows/Node via LiteRT, but the JS `/native` prebuilds are linux/darwin only, so plan on the Swift SDK or a custom LiteRT runner rather than `@desert-ant-labs/align/native`.

### Clear

1. **One-line purpose:** Clear — speech enhancement: "Studio sound, no cloud bill."
2. **Full capability description:** denoise + dereverb + loudness normalize/master a voice recording into a close-miked podcast sound, "processed 100% on-device". Two variants: `clear-studio` (default) cleans down to near silence; `clear-natural` keeps room tone, breath, and lip texture for treated rooms and intentional voiceover. Trained for warm low-mids and a forward voice with no thin or distant sound; sibilance-safe (no harsh peaks on S, T, F), no pumping or musical noise, breaths and plosives intact, and it adds no reverberation of its own. Loudness presets for Apple Podcasts, Spotify, YouTube, and EBU R128; output 48 kHz. Decodes any audio file AVFoundation can read; the output extension picks the encoding (`.wav` 16-bit PCM, `.m4a`/`.mp4`/`.aac` AAC, `.caf`/`.aiff` PCM); without a filesystem `enhance(bytes:)` returns WAV bytes. Stereo is opt-in (`channelMode: .preserve`) and costs an inference pass per channel (1.8× mono); channels are mastered jointly with one gain and one limiter envelope, and `Mastering.balanceChannelsLUFS` can equalise mismatched sides. The file path streams chunk by chunk, so a one-hour recording uses the same memory as a ten-second clip. Model: fine-tuned **DeepFilterNet 3**. Limits: speech only (music, effects, and other non-vocal sound get pulled down as noise), not a source separator, no voice changing/cloning, no transcription.
3. **Inputs / outputs:** audio file / bytes / samples, mono by default with channels opt-in → enhanced audio file or WAV bytes plus result metadata (`realtimeFactor`, `measuredLUFS`, `measuredTruePeakDBFS`, `phaseTimings.modelPredictSec`); 48 kHz output.
4. **Size / latency / accuracy / languages:** **302× realtime on iPhone 16 Pro**, **345× on MacBook Pro (M5)** — enhance, master, and re-encode a 60-second clip, best of three, on device; a 5-minute clip in 1 s. **9.0 MB** Core ML (fp16 compute with a 6-bit weight palette) and **24 MB** ONNX per variant. All 492 Core ML operations run on the Neural Engine per `MLComputePlan`. First load on iPhone 16 Pro takes 3.4 s while Core ML compiles for the ANE, then 62 ms. No timings for Android, Linux, Windows, or the browser; no audio-quality score against the cloud tools published. No language list — it is speech enhancement and language-independent.
5. **Platform / runtime:** iOS 18+/macOS 15+/tvOS 18+/visionOS 2+ (Core ML; an iOS 16-format Core ML model, with `.aimodel` Core AI artifacts also published), Android API 24+ (LiteRT, arm64-v8a and x86_64), Linux, Windows, browser (WebAssembly + LiteRT.js), Node. ONNX files exist "for runtimes the SDK does not cover".
6. **Distribution & access:** docs `/docs/clear/`; npm `@desert-ant-labs/clear` (+ `@litertjs/core` for browser); Maven `ai.desertant:clear`; Swift product `Clear`; weights `desert-ant-labs/clear` (v0.3.0); Hugging Face Space `clear-demo`; CLI `da clear talk.mp4` (renders video as a passthrough container with the enhanced audio muxed in).
7. **Licensing / pricing:** standard terms; no separate pricing.
8. **Restrictions for wrapping:** standard. **Windows caveat:** the `.tflite` "runs wherever LiteRT does: Linux, Windows, and the browser through LiteRT.js", but the npm `/native` prebuild set is linux/darwin, so plain Windows Node native is not supported today.

### Clips

1. **One-line purpose:** Clips — clip selection: "Create short videos and highlight clips."
2. **Full capability description:** ranks a transcript's best non-overlapping moments into shorts, highlight reels, or a rough auto-edit, working from a transcript rather than the media. Four heads: saliency, start, end, and clip score. Sentences run through the selector in batches of 16 and each candidate is scored on its own, so there is **no context window and no length limit** (the longest transcript run is an 835-sentence podcast). `limit` both caps the number of clips and sizes the work (candidates are built around the `4 × limit` most salient sentences, and scorer passes take 60–85% of the runtime); the result at `limit: 10` is not the first ten of `limit: 14`, because Clips returns the non-overlapping set with the highest total score. Percentile, not raw score, is the recommended control: a 0.8 cut averages 5 clips covering 17% (highlights); a 0.3 cut averages 32 clips covering 74% (auto edit). Each clip carries `text`, `start`, `end`, `score`, `percentile`, `sentenceIDs`, and `estimatedDurationSec`. Pairs with Title to name each clip. Self-described weak spots: clip edges (a clip can open on a pronoun whose referent was in the previous sentence, fuse topics, or swallow a sponsor read), sensitivity of selection to small score changes, few clips on short transcripts, no calibrated confidence, and no fixed duration.
3. **Inputs / outputs:** a transcript as one sentence per element, in spoken order (text + start/end times) → `[Clip]` best-first; under three sentences it returns `[]`. CLI JSON adds `id`, `durationSec`, and the written `file` path, and `clips --transcript -` reads a Voz transcript document or SRT/VTT from stdin.
4. **Size / latency / accuracy / languages:** a 404-sentence / 25-minute transcript → 12 clips in **9.19 s on iPhone 17 Pro** and **10.22 s on iPhone 15 Pro**; per candidate (encoder only) 2.78 ms / 3.13 ms; measured at batch 16 with Core ML pinned to `.cpuAndNeuralEngine`. **284 MB int8 Core ML** Apple multifunction package (function `select`: ids/mask/disc → saliency/start_p/end_p; function `score`: ids/mask → score); two 283 MB LiteRT files for Android/Linux/Windows. **No quality figures published** — "Clips is in internal testing." Languages: **100** stated for one model; non-Latin scripts under-tested.
5. **Platform / runtime:** iOS 18 / macOS 15 / tvOS 18 / visionOS 2 Core ML (specification version 9); reaching a specific graph needs `MLModelConfiguration.functionName` set to `select` or `score` (otherwise both halves silently run the selector). Android/Linux/Windows LiteRT files are published but **the SDK cannot drive them**: the graphs name inputs `args_0…args_2` and outputs `output_0…output_2` while the SDK asks for `ids`/`mask`/`disc`/`saliency`/`start_p`/`end_p`, the graphs take int64 while the SDK builds int32, the 256-wide scorer exceeds the SDK's 128 fallback, and the LiteRT export peaks at 2.1 GB RSS against a 1.6 GB Android budget. The docs carry a boxed warning: "Don't build on them."
6. **Distribution & access:** docs `/docs/clips/`; **Swift product only** (npm `@desert-ant-labs/clips` and Maven listed as "coming soon"); weights `desert-ant-labs/clips` (v0.1.0). Example app **Clipper** (macOS 26+, Apple silicon; `brew tap desert-ant-labs/tap && brew install --cask clipper`) built with Voz + Clips + Title. CLI `da clips talk.mp4`.
7. **Licensing / pricing:** standard terms.
8. **Restrictions for wrapping:** standard. **Windows:** not practical today — no SDK path and the published LiteRT files are explicitly unusable; a custom LiteRT driver is speculative.

### Ear

1. **One-line purpose:** Ear — spoken language detection: "Detect language based on 30 seconds of audio."
2. **Full capability description:** spoken language identification that runs **before** transcription so the right recognizer is chosen (a transcriber pointed at the wrong language "returns nonsense with confidence"). It does not read the whole file: it ranks candidate windows by how much their loudness varies at syllable rate (speech rises and falls 3–6×/s; music sustains notes; silence does not vary), then analyzes the three most speech-like 30-second windows. Ranking by speech-likeness rather than position or loudness matters: position-based selection finds the language 4% of the time on a five-minute recording with speech in a tenth of it, and the loudest windows are fooled by a music intro mixed louder than the voice. Returns language, confidence, ranked candidates, and `isReliable`; the flag is false when the top two are too close to call and false for Norwegian/Swedish/Danish, which it confuses at high confidence. Recordings under 30 s get one window and a less certain answer; multilingual recordings are reported as the language of the chosen windows. Construction does no work and starts no download; weights download on first use.
3. **Inputs / outputs:** an audio file URL (Apple) or already-decoded samples at any sample rate → `language` (ISO code), `confidence`, `candidates[{ language, probability }]`, `isReliable`. CLI JSON adds `input` and drops candidates under 0.01.
4. **Size / latency / accuracy / languages:** **98.5%** of above-threshold answers routed to the right transcriber across 162 recordings; 12/12 exact on ordinary uploads and 8/8 confident on the same files rebuilt as podcasts, with **no wrong confident answer** in either set (the one miss — a German episode identified as English under its jingle — was marked unreliable). **250 ms** per identification over three windows. Speech mixed under louder music is read correctly about 60% of the time. Size not stated numerically on the site; HF artifacts are `ear.mlmodelc`, `ear.tflite`, `mel_filters.f32`, `languages.json`, `ear_meta.json`. Languages: **99** on the model page, **102** in the current SDK docs and HF tag list (the figures disagree; SDK docs are newer).
5. **Platform / runtime:** iOS/macOS/tvOS/visionOS (Core ML; HF tags include `apple-neural-engine`); Android/Linux/Windows (LiteRT); browser (WebAssembly + LiteRT.js); Node (prebuilt native core). Every SDK reads `isReliable` from the same shared core, so the same recording gets the same answer on every platform.
6. **Distribution & access:** docs `/docs/ear/`; npm `@desert-ant-labs/ear`; Maven `ai.desertant:ear`; Swift product `Ear`; weights `desert-ant-labs/ear` (v0.2.0); Spaces `ear-language-id-demo` (Gradio) and `clear-demo`; CLI `da ear talk.mp4`.
7. **Licensing / pricing:** standard terms.
8. **Restrictions for wrapping:** standard. **Windows caveat:** listed for Windows/LiteRT/browser/Node, but the npm `/native` set is linux/darwin — plain Windows Node native is not supported today.

### Emo

1. **One-line purpose:** Emo — emoji suggestions: "Suggest emoji faster than you can type."
2. **Full capability description:** predicts the emoji that fit short, intent-carrying text — "Pay my bills" → 💰 💳 🧾; "Dentist appointment" → 🦷 🪥 🏥 🩺 — the way a predictive keyboard proposes the next word. It "fills the suggestion strip above the keyboard", so a user who knows what they want still browses the grid. Two-stream text classifier: lexical n-grams plus a multilingual embedding. Curated vocabulary of 812 everyday emoji with skin-tone variants (`skinTone: .medium`, `limit`) and per-suggestion confidence. Tuned for short text that states an intent (a task, an entry, a message); long-form text gives noisier suggestions; emoji meaning is imprecise so near-ties at the top are expected; lower-resource languages in the set are a little weaker than English. Under 2 ms makes it viable on every keystroke, with no network round-trip.
3. **Inputs / outputs:** plain text string (+ `limit`, `skinTone`) → ranked `[EmoSuggestion { emoji, confidence }]` (JS `[{ emoji, confidence }, …]`; Kotlin `List<EmoSuggestion>`). The model gives each of the ~800 emoji in its vocabulary a probability.
4. **Size / latency / accuracy / languages:** **under 2 ms** per suggestion; **5 MB** Core ML (model + tokenizer, Apple) / **11 MB** via LiteRT elsewhere; **812** emoji vocabulary. Older SDKs loaded `Emo.mlmodelc` + `emo.safetensors` (through v0.6.0). Internal measurements only; no emoji-prediction benchmark published. Languages: **22** — English, Spanish, Portuguese, French, German, Italian, Dutch, Russian, Polish, Turkish, Arabic, Chinese (Simplified and Traditional), Japanese, Korean, Hindi, Indonesian, Thai, Vietnamese, Ukrainian, Swedish, Danish, Czech.
5. **Platform / runtime:** iOS/macOS/tvOS/visionOS (Core ML), Android/Linux/Windows (LiteRT), browser (WebAssembly + LiteRT.js), Node (prebuilt native core; `/native` prebuilt for linux-x64, linux-arm64, darwin-arm64).
6. **Distribution & access:** docs `/docs/emo/`; npm `@desert-ant-labs/emo`; Maven `ai.desertant:emo`; Swift product `Emo`; weights `desert-ant-labs/emo` (v0.7.0); Space `emo-demo`; CLI `da emo "<text>"`.
7. **Licensing / pricing:** standard terms.
8. **Restrictions for wrapping:** standard. **Windows caveat:** LiteRT npm `/native` has no win32 prebuild; the browser build needs a browser/Worker.

### Eye

1. **Name + one-line purpose:** Eye — image and video scoring: "Tag and rank images based on aesthetics and content" (models index: "Image and video understanding").
2. **Full capability description:** a burst leaves forty near-identical photos and Eye picks the sharp, well-composed one and marks the rest as duplicates. One call returns a pick score, five quality axes (interestingness, composition, subject clarity, thumbnail quality, aesthetic), a scene class, and tags/concepts. A perceptual embedding fingerprints each image so near-identical shots group without comparing pixels. The optional `EyeFaces` module (+22 MB) is "identity-blind by design, with no face recognition". Use cases on the page: keep one photo instead of forty, camera-roll near-duplicate cleanup, and pick the cover frame for a video.
3. **Inputs / outputs:** images and video frames in; pick score, quality axes, scene class, tags/concepts, and a perceptual embedding out; optional additional face-related output from the EyeFaces add-on. Exact API types are not published.
4. **Size / latency / accuracy / languages:** no benchmark, accuracy, latency, or size figures are published on the page beyond the EyeFaces module size (+22 MB). No language list (it is a vision model).
5. **Platform / runtime:** "Platforms: Apple (Swift); Android and web planned". Status: closed beta, "In development. Early access on request." The SDK docs page does not exist (404).
6. **Distribution & access:** model page `https://desertant.com/models/eye/` with a "Contact us for early access" link (`/contact/?topic=early-access&model=Eye`); listed in `llms.txt` under "Models (closed beta)"; the Hugging Face repo `desert-ant-labs/eye` is linked from the org but its raw README returned **401**; `https://desertant.com/docs/eye/` is **404**.
7. **Licensing / pricing:** the page's FAQ repeats the standard line — "Each model is free up to 100k monthly active devices. Inference is unlimited. Contact us for custom licenses."
8. **Restrictions for wrapping:** not shippable through public channels today; access requires early access. **UNVERIFIED:** API shape, weight sizes, runtime details, any Windows path.

### Face

1. **One-line purpose:** Face — face matching: "Find people in photos, private on the device."
2. **Full capability description:** on-device face matching across a photo library or through a video: group a library by person the way the system photo app does, search by example (pick one face and find every other photo and video moment that person appears in), and match the same face frame after frame through a clip so an app can jump to every moment one person is on screen. All matching happens on the device — "the photos stay where they are, nothing is uploaded, and there is no face infrastructure on your side to run or secure".
3. **Inputs / outputs:** images and video frames in; grouped people, matches, and search-by-example results out. The exact result shape is not published.
4. **Size / latency / accuracy / languages:** nothing published.
5. **Platform / runtime:** "Platforms: Apple (Swift)"; "Status: Closed beta"; "Face is on Apple platforms first, in closed beta." No docs page (404).
6. **Distribution & access:** model page with "Contact us for early access" (`/contact/?topic=early-access&model=Face`); HF repo linked from the org but raw README returned **401**.
7. **Licensing / pricing:** standard FAQ wording (free up to 100k MAD; contact for custom licences).
8. **Restrictions for wrapping:** not publicly available; early access required. **UNVERIFIED:** API, sizes, Windows path.

### Gist

1. **One-line purpose:** Gist — content topic tagging: "Generate topics and tags for posts and articles."
2. **Full capability description:** multi-label classification of a title, post, or description into a fixed 36-topic taxonomy, from one model across 101 languages "with no language setting to pass in". Architecture is a two-stream classifier (a multilingual static embedding plus hashed n-grams) with **no transformer**, so scoring costs CPU time and nothing else — "a browser tab tags a post without warming up a language model". `classify` accepts `topK` (default 3) and `threshold`; `scores` returns all 36 topic scores; `channelTopics` is a pure function (runs no model) that adds up an account's post topics into channel-level topics with optional recency decay (`halfLifeDays` + `nowMillis`). The 36 topics map to industry taxonomies via a shipped crosswalk: IAB Content Taxonomy 2.2 integer IDs and Apple Podcasts categories (e.g. `law` → IAB 383 News & Politics › Law; `finance` → IAB 391 Personal Finance); five topics are flagged as Gist extensions. An English-only 15 MB build is selectable in Swift only (`Gist(variant: .english)`); the JavaScript and Kotlin SDKs load only the multilingual build. Gist tags what a text is about, not whether it is good or safe; the 36 topics are a fixed list, so an off-list subject gets the nearest topic.
3. **Inputs / outputs:** plain text (a title, or a title and a description) → `[Topic { slug, name, score }]`; `scores` → a 36-entry map; `channelTopics` → `[ChannelTopic { slug, share, postCount }]`. Graph shapes: `features [1, 8448]` → `topic_probs [1, 36]`.
4. **Size / latency / accuracy / languages:** **91% recall@3** (71% recall@1) on 572 human-labeled real posts; **88%** top-3 in a 15-language spot check across Latin, Cyrillic, Arabic, CJK, Devanagari, Hebrew, Thai, and Greek scripts, with CJK/Arabic/Cyrillic matching or beating Latin. Size **74 MB** multilingual (64 MB int8 static embedding + 6 MB Core ML head + 4 MB tokenizer) or **15 MB** English-only; the LiteRT head is 13 MB float32. Benchmark table: Qwen2.5-7B (cloud, zero-shot) 79% recall@1 / n/a; multilingual-e5-small + head 74%/92%; bge-small-en + head 71%/92%; **Gist 71%/91%**; all-MiniLM-L6-v2 + head 68%/90%; mDeBERTa-v3-mnli-xnli zero-shot 50%/73%; GLiClass-base zero-shot 44%/65%. Languages: **101**.
5. **Platform / runtime:** iOS/macOS/tvOS/visionOS (Core ML), Android/Linux/Windows (LiteRT), browser (WebAssembly + LiteRT.js), Node (prebuilt native core).
6. **Distribution & access:** docs `/docs/gist/`; npm `@desert-ant-labs/gist`; Maven `ai.desertant:gist`; Swift product `Gist`; weights `desert-ant-labs/gist` (v2.2.0, with `taxonomy_crosswalk.json` and an `en/` variant directory); Space `gist-demo`; CLI `da gist "<text>"`.
7. **Licensing / pricing:** standard terms.
8. **Restrictions for wrapping:** standard; the English-only variant is Swift-only. **Windows caveat:** LiteRT npm `/native` has no win32 prebuild.

### Moderator

1. **One-line purpose:** Moderator — content moderation: "Flag nudity before upload or display."
2. **Full capability description:** on-device NSFW/adult-content classification for images and video frames, so "questionable uploads never reach your servers, your CDN or a moderator's queue". Five separate detection heads score an image (exposed nipples, genitals, buttocks, nudity, sexual activity) and a **policy** decides which of them count toward the NSFW decision: `.standard` counts all five, `.allowTopless` leaves exposed nipples out of the score for platforms whose rules permit them. Options are identical across SDKs: `threshold` (default 0.5), `policy`, and `quality` — `fast` scores one centre crop (for video frames), `balanced` scores four multiscale tiles, `accurate` scores those tiles and their mirrors (the setting the model is evaluated with); the reported score is the maximum across crops. The training claim is commercial-safety: "Trained only on permissively licensed and synthetic images, with nothing scraped." Adult content only — "Minors are out of scope by design and excluded from the training set." Positioned as "a moderation aid, not a legal determination": send every flag to a human reviewer, and region scores rank images but are not calibrated probabilities. Files and `Data` are decoded upright following EXIF; a `UIImage` keeps orientation and full pixel resolution; cancelling the calling task stops analysis and throws `CancellationError`.
3. **Inputs / outputs:** Swift `contentsOf:` URL, `UIImage`/`NSImage`/`CGImage`/`Data`, or `ImagePixels(width:height:rgba:)` on Linux/Windows; Kotlin `Bitmap` or `bytes` + width/height; JS anything `createImageBitmap` accepts or `ImageData` in the browser and `{ data, width, height }` (RGB or RGBA) in Node; → `{ score, isNSFW, regions { nipples, genitals, buttocks, nude, sexAct } }`, with threshold/policy/quality echoed in CLI JSON.
4. **Size / latency / accuracy / languages:** **recall 87.8%**, **specificity 93.7%** at threshold 0.50, a ~6.3% false-block rate, "about half NudeNet's", from a 9.7 MB on-device model; for video, one crop per frame gives 74% per frame at 97% specificity, with frame sampling recovering recall. Internal evaluation on a proprietary held-out set, not a published benchmark. Sizes: **9.7 MB** Core ML int8 (Apple) / **9.2 MB** LiteRT int8 (elsewhere). Not language-bound.
5. **Platform / runtime:** iOS, macOS, tvOS, visionOS, Android, Linux, Windows, browser, and Node.
6. **Distribution & access:** docs `/docs/moderator/`; npm `@desert-ant-labs/moderator`; Maven `ai.desertant:moderator`; Swift product `Moderator`; weights `desert-ant-labs/moderator` (v1.0.0; the HF repo carries the `not-for-all-audiences` tag); CLI `da moderator photo.jpg`. No demo Space listed for Moderator in the catalog.
7. **Licensing / pricing:** standard terms; the licensed-and-synthetic training data is presented as the reason it is safe to ship commercially.
8. **Restrictions for wrapping:** standard, plus the licence's safety-model clause (do not bypass safeguards or misrepresent safety-critical outputs). If wrapped as a tool, keep the "aid, not a verdict" framing and route flags to human review. **Windows caveat:** LiteRT npm `/native` has no win32 prebuild; a Kotlin/JVM or direct LiteRT runner would be needed.

### Redact

1. **One-line purpose:** Redact — PII redaction: "Filter PII on the device."
2. **Full capability description:** detects and masks personal data with **reversible numbered placeholders** (`[GIVEN_NAME_1]`, `[EMAIL_1]`) so text can be scrubbed before it leaves the device — and put back afterwards (`result.restore(reply)`), keeping an LLM round-trip lossless. Keeping the placeholder map makes the copy pseudonymised; deleting it makes it anonymised. 20 detection labels: `GIVEN_NAME`, `SURNAME`, `STREET_NAME`, `BUILDING_NUMBER`, `SECONDARY_ADDRESS`, `CITY`, `STATE`, `ZIP_CODE`, `EMAIL`, `PHONE`, `CREDIT_CARD`, `BANK_ACCOUNT`, `ROUTING_NUMBER`, `IP_ADDRESS`, `URL`, `GOVERNMENT_ID`, `PASSPORT`, `DRIVERS_LICENSE`, `TAX_ID`, `SSN`. A **deterministic validation layer** backs the structured fields: Luhn card checks, ISO-13616 IBANs, checksummed national IDs for all 24 EU countries, all 27 EU VAT formats, IMEI (flagged only when a 15-digit number passes Luhn and sits within 32 characters of the word "IMEI"), and per-country driving licences — "so a random 16-digit string is never masked as a card number". `ORG` is detected but not redacted by default because "a company is not a person"; passing `ORG` in the labels option masks them too, and its presence stops company names being mislabelled as surnames. Options: filter by `labels`, raise `minimumConfidence` (default 0.6, applied to model detections — pattern matches for structured data always apply). Long text is split into 256-token windows overlapping by 64 tokens so an entity on a window edge comes back whole. Filter and inspect every detection with its exact character span. Limits stated plainly: it catches about 90% of personal data, so roughly one item in ten gets through — "treat Redact as the layer that removes the bulk before data leaves the device, not a guarantee that a document is clean"; structured fields are the reliable part; it misses most often on free-form names and addresses in unusual formats and occasionally masks an ordinary word in ALL-CAPS text.
3. **Inputs / outputs:** plain text + options (labels, minimumConfidence) → `redactedText` plus `items[]` with label/displayName, original value, placeholder, confidence, and exact character span, and a restore map for round-trips.
4. **Size / latency / accuracy / languages:** **recall 88.8 / precision 99.6**, 11.6 MB, 23 M params, against GLiNER-PII 91.1/90.4 at 2.3 GB and 570 M, Rampart 61.4/97.2 at 14.7 MB, and OpenAI privacy filter 60.2/93.5 at 3 GB. Recall is the share of personal data fully masked (none leaked), macro-averaged over WikiANN, MultiNERD and a format-valid structured set across 24 EU languages; precision is the share of masked spans that really were personal data. False-positive test: 94.1% of 11,528 no-PII rows in 27 languages returned untouched. On the same English rows AWS Comprehend scores 91.6 vs Redact's 86.5 composite (ahead on names 84.3/98.5 vs 69.5/94.9, behind on structured data 95.0 vs 91.9), but Comprehend's PII API accepts only English. Sizes: **11.6 MB** Core ML (Apple, 4-bit) / **24.5 MB** LiteRT (Android, web, int8). Languages: **27** — every official EU language (bg, hr, cs, da, nl, en, et, fi, fr, de, el, hu, ga, it, lv, lt, mt, pl, pt, ro, sk, sl, es, sv) plus Norwegian Bokmål (`nb`), Norwegian Nynorsk (`nn`) and Icelandic (`is`), across Latin, Greek and Cyrillic scripts; most accurate on the largest EU languages, with Maltese and Irish the weakest.
5. **Platform / runtime:** iOS/macOS/tvOS/visionOS (Core ML), Android/Linux/Windows (LiteRT), browser (WebAssembly + LiteRT.js), Node (prebuilt native core).
6. **Distribution & access:** docs `/docs/redact/`; npm `@desert-ant-labs/redact` (dependencies `@desert-ant-labs/core` + `@bjorn3/browser_wasi_shim`, optional `koffi`, peer `@litertjs/core`; 29 published versions up to 3.6.0; exports `.`, `./native`, `./browser`, `./wasm`); Maven `ai.desertant:redact`; Swift product `Redact`; weights `desert-ant-labs/redact` (v0.4.0); Space `redact-demo`; repo `demo-redactor`; CLI `da redact "<text>"`. The model page itself carries one of the eight "Inspiration" prompts: "Write an MCP tool that strips personal data before it reaches any other tool."
7. **Licensing / pricing:** standard terms.
8. **Restrictions for wrapping:** standard terms; strong fit for an agent tool that masks data before it leaves the machine (the page explicitly suggests a Node-side ingest filter and a Lambda). **Windows caveat:** package metadata shows optional `koffi` native dependencies and prebuilt cores only for linux-x64/linux-arm64/darwin-arm64, so plain Windows Node native is not supported today; earlier local testing in this workspace confirmed the win32-x64 failure.

### Schemer

1. **Name + one-line purpose:** Schemer — structured extraction: "Extract typed JSON from any text."
2. **Full capability description:** typed extraction from free text against a **caller-supplied schema** — "the schema is the model's input, not a prompt suggestion, and every field is decoded for its type". Field types: `string`, `label` (with up to 16 `values`), `number` (optional `min`, `max`, `unit`), `datetime`, `boolean`, `array` of strings, and `array` of objects (flat properties). Every field takes a short `describe`; `nullable: true` tells the model absence is an expected answer. Three guarantees claimed that generative extractors do not offer: (1) **typed by construction** — labels are always one of the declared choices, numbers arrive clamped to the range, datetimes are ISO 8601, and relative expressions ("tomorrow at 3pm", "i morgen kl 15", misspellings included) resolve against device time; (2) **absence detection** — unstated fields come back null; (3) **verbatim** — extracted strings are substrings of the input, so hallucination auditing is a substring check. It does not generate text, is not a general entity extractor (it fills the fields you declare without enumerating every name in the paragraph), and nested schemas are handled by the harness rather than the model, with internal-template quality measurement. Declare `nullable: true` on an optional number or Schemer will compose a value. Budget: schema and text share one 1,216-token window (roughly 1,100 tokens of text, about three pages); inputs of 256 tokens or fewer run a faster short shape; the model runs once per field, so cost scales with the number of declared fields.
3. **Inputs / outputs:** text + schema (+ device time, pinnable) → one value per declared field, in schema order: strings and array items verbatim substrings, labels constrained to declared values, numbers decoded to the field's unit, datetimes ISO 8601 (`YYYY-MM-DDTHH:MM`), absent string/boolean/datetime → null, absent array → empty.
4. **Size / latency / accuracy / languages:** **0.800** overall on 9,021 held-out records (7 usage slices, 13 languages, schemas never seen) with **0.911** absence detection vs 0.18–0.43 for LLMs and span extractors at any size; **211 M parameters**, **230 MB** per platform (int8), files including Core ML 8-bit and TFLite int8; the Core ML files score 0.804 overall, and the LiteRT files match them. Latency: 8.1 ms per forward on Apple Neural Engine at a 256-token shape; on an M1, a short four-field record extracts in ~85 ms and a long document in ~1.2 s. Comparison table: Gemma 4 26B A4B 0.834, Claude Haiku 4.5 0.816, Qwen 3.5 9B 0.812, **Schemer 0.800**, Ministral 3 8B 0.790, Gemma 4 E2B 0.780, Qwen 3.5 0.8B 0.651, NuExtract-2.0-2B 0.643, GLiNER2-multi 0.585, GLiNER2-base 0.524, LFM2-1.2B-Extract 0.489, NuExtract-tiny-v1.5 0.334, LFM2-350M-Extract 0.331, FunctionGemma 270M 0.288. Per field type it owns boolean (0.911), datetime (0.769), array (0.766) and number (0.750) and trails larger extractors on string (0.648 vs 0.774) and label (0.629 vs 0.636). Languages: **13** — da, de, en, es, fr, it, ja, nl, no, pl, pt, sv, zh.
5. **Platform / runtime:** artifacts for **Core ML and LiteRT**, described as cross-platform. The HF card's prose says the SDKs "download the files for their platform… and run the whole pipeline on device: Swift on Apple platforms, Linux and Windows, Kotlin on Android, and JavaScript in the browser and in Node", and its file table lists each `.tflite` as running "on Android, Linux, Windows, Node, and the web (downloaded on demand by the Kotlin and JavaScript SDKs)". **But** the website, the core README and `llms.txt` all say Schemer is in **closed beta with no SDK shipping yet**: "Weights exist and the models work, but no SDK ships them yet, so there is nothing to install today." The card's Install block is empty and `https://desertant.com/docs/schemer/` is **404**.
6. **Distribution & access:** model page with "Contact us for early access"; HF card and weights public at `desert-ant-labs/schemer` (tag `other`/`license:other`); Space `schemer-demo` (static) — "paste text, describe your fields, get typed JSON, fully in your browser".
7. **Licensing / pricing:** standard terms stated in the page FAQ (free up to 100k MAD; contact for custom licences).
8. **Restrictions for wrapping:** standard terms. **The status conflict is the key fact:** install lines are absent from the live card and no SDK ships, so do not present this as usable today. **UNVERIFIED** for any Windows/DSH runtime path.

### Shapes

1. **One-line purpose:** Shapes — shape recognition: "Rough sketch. Perfect shape."
2. **Full capability description:** turns one hand-drawn stroke into precise vector geometry. Recognizes `line`, `rectangle`, `triangle`, `ellipse` and `star`, and rejects scribbles, partial shapes and non-shapes as the `none` class. It fits precise geometry and snaps to axes, circles, squares, and 15° rotations (`rectangle` covers squares, `ellipse` covers circles). On Apple platforms one call adds Notes-style smart-shape snapping to a PencilKit canvas — when the user pauses mid-stroke the canvas previews the recognized shape and on pen-up the SDK swaps in the clean shape, registering the swap with the undo manager so undo/redo work. That fills the gap left by Apple's own "Snap to Shape", which is private API third-party apps cannot call. It works with tldraw and Excalidraw stroke data and on your own canvas. Limits: one stroke at a time (a shape drawn in two strokes is not recognized; multi-stroke diagrams need your own grouping step first) and very rough or ambiguous strokes are rejected on purpose.
3. **Inputs / outputs:** ordered stroke points as `[x, y]` (or `{x, y}`), from PencilKit (`PKStroke` supported on Apple, plus `[CGPoint]`), tldraw, Excalidraw, or any canvas → the shape class plus its fitted geometry (rectangle corners, ellipse centre/semi-axes/rotation, a drawable `CGPath` on Apple), or `null`/`none` when rejected. Kotlin returns a `Shape?` sealed type; JS returns `{ kind: "ellipse", center: {...}, ... }` or null.
4. **Size / latency / accuracy / languages:** **under 10 ms** per stroke; **0.2 MB** Core ML (Apple, 4-bit palettized classifier) / **1.3 MB** LiteRT float32 elsewhere (fixed `[1,256,3]` feature window and `[1,256]` mask). Per-class thresholds that decide acceptance live in `shapes_meta.json`; `shapes.safetensors` is the old v0.1.0 artifact and is no longer loaded. No accuracy benchmark published. The Kotlin package bundles the weights by default so it ships inside the app; in the browser the SDK fetches 1.3 MB once and caches it. Not language-bound.
5. **Platform / runtime:** iOS/macOS/tvOS/visionOS (Core ML), Android/Linux/Windows (LiteRT; Kotlin bundles the file, JS downloads it on demand), browser (LiteRT.js), Node (prebuilt native libraries).
6. **Distribution & access:** docs `/docs/shapes/`; npm `@desert-ant-labs/shapes`; Maven `ai.desertant:shapes`; Swift product `Shapes`; weights `desert-ant-labs/shapes` (v0.3.0); Space `shapes-demo`. No CLI verb listed for Shapes.
7. **Licensing / pricing:** standard terms.
8. **Restrictions for wrapping:** standard. **Windows caveat:** LiteRT npm `/native` has no win32 prebuild; on Apple the recognizer is bundled in the binary, on Android the package bundles it, and in the browser 1.3 MB is fetched and cached.

### Title

1. **One-line purpose:** Title — titles and descriptions: "Suggest a title and description for any text."
2. **Full capability description:** one call returns a short factual title (3–8 words, no final punctuation) and a one- or two-sentence description. The register is deliberately plain: "no emoji, no hashtags, no clickbait", and the description "identifies this passage rather than its topic". Fine-tuned on transcript clips but holds up on a news paragraph, a product description, or an email. `cards(for:)` returns one card per Clips clip, index-aligned in the same order. Loading is slow and writing a card is fast, so create one `Titles` and reuse it — it is an `actor` because MLX is not safe to drive from several tasks at once, and parallel generations are not faster. `maxTokens` (default 96) caps runaway generation. The SDK sends the exact instruction the model was fine-tuned with and parses the reply tolerantly (`TITLE:` / `DESC:` lines; a reply with no labels takes the first line as the title); `card.isEmpty` is true when neither is found. Keep the shipped chat template — "a different template changes the task the model performs". On iOS call `suspend()` before backgrounding and `resume()` after, because iOS revokes GPU access in the background and MLX crashes the app if a generation is still running. Status: internal testing, no quality figures published, "Title sometimes opens a description with a stock phrase that its instruction forbids" — read each card before it reaches a user.
3. **Inputs / outputs:** plain text (or `[Clip]` objects via `cards(for:)`/`card(for:)`) → `Card { title, description, isEmpty }`, where the title is 3–8 words with no final punctuation and the description is one or two sentences.
4. **Size / latency / accuracy / languages:** base model **`ibm-granite/granite-4.0-350m`**, fine-tuned, **6-bit** quantized, run through MLX — a ~350 M-parameter model. Short generation measured **5.7–8.3× faster on the GPU (MLX) than on the Neural Engine (Core ML)**; the Core ML comparison build lost on time-to-first-token, tokens per second, load time, and memory, and will not ship. **No quality figures** — "Title is in internal testing and its card carries no quality figures. No independent review has been completed." No supported-language list is published (the base model is multilingual-tagged). **UNVERIFIED** languages.
5. **Platform / runtime:** **Apple silicon only, through MLX** — iOS, macOS, tvOS, visionOS. "MLX runs only on Apple silicon, so Title has no Android, Linux, Windows, browser or Node build." Requires the Swift package trait: `.package(url: "…desert-ant-core.git", from: "3.5.0", traits: ["MLX"])`; without the trait the module compiles as a stub, so a build cannot silently ship a broken model. It does **not** download weights: download the MLX folder from Hugging Face and pass it to `Titles(directory:)`. That folder is `model.safetensors` (6-bit quantized weights), `model.safetensors.index.json` (required even with one shard), `config.json`, `generation_config.json`, `tokenizer.json`/`tokenizer_config.json` (byte-level BPE with merges), and `chat_template.jinja`.
6. **Distribution & access:** docs `/docs/title/`; **Swift product only** (no npm, no Maven); weights `desert-ant-labs/title` (v0.1.0, MLX/safetensors, tags include `mlx`, `granitemoehybrid`, `6-bit`, `license:other`); example app Clipper (macOS 26+, Apple silicon) pairs Voz + Clips + Title.
7. **Licensing / pricing:** standard terms; base model notice points to the HF `THIRD_PARTY_NOTICES.md`.
8. **Restrictions for wrapping:** standard terms. **Windows:** blocked — Apple silicon/MLX only, so it cannot be wrapped as a DSH tool on this machine today.

### Tongue

1. **One-line purpose:** Tongue — language identification: "Detect language based on 3 words."
2. **Full capability description:** language identification for very short text, where "three words is the hard case, and three words is what a search box gives you". Two stages: a **script router** settles languages whose script belongs to one language only, "with no model involved" (Hangul is Korean, Thai is Thai), and the rest go to the model — script router plus hashed character n-grams into an int8 linear head. It returns ranked ISO 639-1/639-3 codes with probabilities plus a reliability signal (`confident`, `likely`, `tentative`), reports a tie when the input is too short to call (`tooCloseToCall` is true when the top two are within 0.12), and for a script-decided language returns a single confident answer. It reads only the first 512 characters. **No tokenizer, no vocabulary file, no inference runtime** — which is how the whole package fits in 2 MB and why `detect` is synchronous. Published failure modes: one or two words are often genuinely ambiguous and no model size fixes that ("sale" is English, French and Italian; "la casa" is equally Italian and Spanish); Malay and Indonesian cannot be separated on short samples; Mongolian is covered in the traditional script only, so Cyrillic Mongolian is read as Russian; brand names, numbers, and code have no language and still get a guess; single-word scores mostly measure vocabulary recognition. Treat low reliability as unknown and ask for more text where the product allows it.
3. **Inputs / outputs:** a short UTF-8 string (first 512 characters read) → `{ language, reliability, tooCloseToCall, candidates[{ language, probability }] }`. The ONNX graph holds only the classification head: it reads `values` (int64 hashed bucket ids) and `offsets` (int64 per-sample starts) and produces `logits`; the host runs normalization, hashing and script routing first, and `tongue_meta.json` documents those steps. The CLI leaves `language` out when there is nothing to read and adds an `empty` reliability value.
4. **Size / latency / accuracy / languages:** **2.01 MiB** int8 weights bundled in the package (plus an 8.4 MB fp32 ONNX opset-17 graph for onnxruntime/onnxruntime-web, and a tiny `tongue_meta.json` and `labels.json`). Measured on the shipped int8 weights against detectors run on identical rows: FLORES-200 2/3/5 words **0.869 / 0.933 / 0.974** vs lingua 0.800/0.887/0.956 (293 MB) and eld 0.780/0.856/0.912 (1 MB); the lingua test set single words/word pairs/sentences **0.746 / 0.909 / 0.988** vs lingua 0.752/0.915/0.985; the eld benchmark tweets **0.992**, single words 0.759, word pairs 0.887, sentences 0.971 vs lingua 0.984/0.756/0.894/0.950, HeLI-OTS 0.986/0.683/0.843/0.967 (51 MB) and Apple's system detector 0.997/0.641/0.719/0.748. Latency measured in JavaScript on an Apple silicon laptop: **0.013 ms** for one word, 0.028 ms for a short sentence, 0.10 ms for a 193-character input (p99 0.24 ms), with a design target under 1 ms. Languages: **84** across **31 scripts** — 59 decoded by the model and 25 settled by script alone.
5. **Platform / runtime:** the broadest reach of any model here — iOS/macOS/tvOS/visionOS, Android, Linux, Windows, browser, and Node. **Tongue has no native code**, so it also works outside Android on any JVM 17+ (`Tongue.bundled(null)` on a bare JVM). The JavaScript SDK is **plain JavaScript**: no wasm, no LiteRT.js, no native core, and `detect` is called without `await`. The 2 MB model ships inside the package, so Tongue never downloads anything. Browser caveat: a bundler does not serve files out of `node_modules`, so you serve `tongue_int8.bin` and `tongue_meta.json` yourself (both are exported as subpaths so a copy script can `require.resolve` them, including under pnpm and Yarn PnP) and pass `{ from: "/models/tongue" }`.
6. **Distribution & access:** docs `/docs/tongue/`; npm `@desert-ant-labs/tongue` (install it alone — no `@litertjs/core`); Maven `ai.desertant:tongue`; Swift product `Tongue`; weights `desert-ant-labs/tongue` (v1.0.0; files `tongue_int8.bin`, `tongue_int4.bin`, `tongue.onnx`, `labels.json`, `tongue_meta.json`); Space `tongue-demo`; CLI `da tongue "<text>"`, and the model page lists an inspiration prompt "Build an agent skill that tags and language-routes text for an agent".
7. **Licensing / pricing:** standard terms.
8. **Restrictions for wrapping:** standard terms. **This is the model that works on Windows today** — pure JavaScript with no native addon — and earlier local testing in this workspace confirmed it (`Tongue.load()` ≈ 39 ms, synchronous detection). It is the best candidate for an immediately useful DSH tool, including agent-facing language routing and tie/reliability reporting.

### Toxic

1. **Name + one-line purpose:** Toxic — hate speech triage: "Catch hate speech before it posts."
2. **Full capability description:** three content heads — `HATEFUL` (public incitement to violence or hatred against a protected group, scoped to the EU notion of illegal hate speech, Framework Decision 2008/913/JHA), `ABUSIVE` (abusive and insulting language, severity-ordered from human crowd votes; a superset of `HATEFUL`), and `THREAT` (violence against a person or group) — plus ten protected-group target heads (race, colour, religion, descent, national or ethnic origin, sexual orientation, gender, disability, age, other), all sharing one encoder and exposed as two multi-label output layers (content and target). Text can fire several heads at once and thresholds apply per head (0.40 for hate, 0.50 for the other two). A recommended per-language setting ships in the model metadata. It is explicitly "a triage aid, not a verdict": flags are escalation signals for human review or a heavier local tier, not autonomous removal decisions, and the failure modes are published on purpose. It reacts to hateful words even when someone is quoting or condemning them, so counter-speech and news reporting can trip the flag; at the default setting it flags 26–30% of non-hateful text in the seven measured EU languages (12% in English), and it separates hate speech from ordinary text well but from plain rudeness much less well.
3. **Inputs / outputs:** text → per-head scores (three content heads plus target heads) with per-head thresholds; CLI-style outputs are escalation signals rather than verdicts.
4. **Size / latency / accuracy / languages:** **0.847 macro-F1** on real Multilingual HateCheck across the seven EU languages it covers (de, fr, nl, pt, es, it, pl), measured on the shipped weights; three independent runs of the same recipe average **0.834**. Out-of-domain corroboration on real in-the-wild corpora: 0.724 macro-F1 on textdetox (5 languages) and 0.658 on offenseval2020 (3 languages). Eight of the 23 languages (English plus the 7-EU set) are scored on the real published benchmark; the other 15 use translate-and-audit synthetic sets and are explicitly development estimates, never averaged into the headline. The English specialist `toxic-en` scores 0.855 on English real HateCheck against this model's 0.852. Baseline from the same harness: Mistral's Shieldstral-1.0-3B at 0.786 (and it wants a 16 GB GPU); phone-sized guard models score 0.65. Model: XLM-R-base, 12 layers, **159.6 M parameters**; artifacts **80.2 MB** Core ML (4-bit palettized, CPU+Neural Engine), **90.6 MB** TFLite (int4 blockwise-32, Android/Linux), **100.2 MB** ONNX (int4 + int4 embedding, browser), with a 3.7 MB trimmed 95,552-piece SentencePiece-Unigram tokenizer (XLM-R lineage) plus a 1.3 MB precompiled binary form. Quantisation cost measured per lane: ONNX int4 −0.8 points against the torch reference on the 7-EU mean, TFLite int4 −1.7, Core ML int4 −1.5. **Latency has not been measured yet** (stated explicitly on the card). Languages: **23** — bg, cs, da, de, el, en, es, et, fi, fr, ga, hr, hu, it, lt, lv, nl, pl, pt, ro, sk, sl, sv.
5. **Platform / runtime:** iOS and macOS (Core ML), Android (LiteRT), browser (ONNX); HF tags include `litert`, `tflite`, `onnx`, `core-ml`, `edge-ai`, `mobile`, `ios`, `android`, `browser`, `offline`. **"Weights on Hugging Face, not in the SDK yet"** — no shipping SDK, and `https://desertant.com/docs/toxic/` is **404**.
6. **Distribution & access:** model page with "Contact us for early access" (`/contact/?topic=early-access&model=Toxic`) and a public model card; HF weights `desert-ant-labs/toxic` (plus `toxic-en`), with an arXiv reference `arxiv:2607.25857`; Space `toxic-demo` (static) — "Type or paste text and watch the scores live in the browser; nothing you type leaves the page."
7. **Licensing / pricing:** standard terms stated in the page FAQ (free up to 100k MAD; contact for custom licences).
8. **Restrictions for wrapping:** standard terms, plus the licence's safety-model clause. **Not shippable today** — no SDK. If ever wrapped, keep the human-review guidance and the published failure modes, and do not present it as an enforcement verdict. **UNVERIFIED** for Windows.

### Uhm

1. **One-line purpose:** Uhm — filler-word detection: "Find and remove every filler word."
2. **Full capability description:** finds "uh", "um" and "hmm" (plus `and` and `other` classes) directly from the waveform, **skipping the transcript step** — partly because a transcript would not help: "models like Whisper leave fillers out of their output, so the ums never appear in the text to find". Frame-precise to 20 ms, it marks every filler it hears with start/end/confidence/type so an editor can cut them or a one-click cleanup can tighten a whole take; in a web editor every filler is listed with a click-to-seek time. The optional type labeler runs on Apple's SoundAnalysis framework and can be skipped with `includeTypes: false` when only locations matter. `Options` sets the precision/recall balance via `bias`: `.precision` (0.75) when fillers are cut automatically, `.balanced` (0.65) the default, `.recall` (0.50) when you would rather review each one than miss one; `minDurationSec` defaults to 0.12 s and drops shorter spans. A `progressHandler` tracks long files, and cancelling the enclosing task stops the run. Limits: heavy background music, laughter, or several people talking over each other cost accuracy, and "trust the filler-or-not answer more than the label" — whether a filler was an uh, an um, or an hmm is the less reliable half of the result.
3. **Inputs / outputs:** any audio format AVFoundation can read (`analyze(audioPath:)`/`analyze(audioURL:)`), in-memory bytes, or raw PCM samples (`analyze(samples:sampleRate:)`), decoded to 16 kHz mono → `fillers[] { start, end, confidence 0…1, type ∈ {uh, um, hmm, and, other} }` plus `audioDuration` and `phaseTimings.inferenceSec`. Raw model I/O: 16 kHz mono in windows of up to 30 s → a softmax over 6 classes per 20 ms frame, with class indices `0 = not_filler, 1 = uh, 2 = um, 3 = hmm, 4 = and, 5 = other`.
4. **Size / latency / accuracy / languages:** **20 ms** frame resolution; **296× realtime on iPhone 17 Pro**, 279× on iPad Pro (M4), 169× on iPhone 15 Pro — "an hour of audio in 12s", "10 minutes of audio in 2s". Sizes: **45 MB** Core ML fp16 compiled (iOS/macOS), **51 MB** ONNX fp16 (browser, server, Python `onnxruntime`), **98 MB** ONNX fp32 unquantized reference. Internal benchmarks only; no accuracy metric published. Languages: trained on **English**; "transfers to Spanish, French, German, and Dutch without retraining" — but transfer "has not been separately measured" against per-language ground truth.
5. **Platform / runtime:** iOS/macOS/tvOS/visionOS only today. "Uhm runs on Apple platforms only" (docs); site: Android coming soon, Web/Node coming soon; `catalog.json` lists kotlin and js as `soon`. The HF card notes the browser demo and a Python backend run the same model as 51 MB ONNX, "so a web editor and a batch job behave identically".
6. **Distribution & access:** docs `/docs/uhm/`; **Swift product `Uhm` only** (no npm, no Maven); weights `desert-ant-labs/uhm` (v1.1.0; `uhm.mlmodelc`, `uhm.onnx`, `uhm-web-fp16.onnx`, `UhmLabel.mlmodel`, `labels.json`, `uhm.tflite`); Space `uhm-demo` (static); CLI `da uhm talk.mp4`.
7. **Licensing / pricing:** standard terms.
8. **Restrictions for wrapping:** standard. **Windows:** blocked through the official SDK (Apple-only). The 51 MB ONNX file is the only theoretical non-Apple route and no wrapper is provided. **UNVERIFIED** whether a custom onnxruntime path reproduces the SDK's types and timing behaviour.

### Voz

1. **One-line purpose:** Voz — speech recognition: "Transcribe 10 minutes in 2 seconds."
2. **Full capability description:** on-device speech recognition with a timestamp on every word — "accurate start and end times for every word", precise enough to edit on, for captions, transcript highlighting, and clip-finding. It is an **Apple Neural Engine optimised version of NVIDIA's Parakeet TDT 0.6B v3** (log-mel frontend, conformer encoder, transducer decoder): "The weights are unchanged; the conversion, compression, and the Neural Engine runtime are ours" (base model CC BY 4.0). On Apple silicon the whole graph runs on the Neural Engine with no CPU or GPU fallback, and peak memory does not grow with the length of the recording. Long audio is cut into 15 s windows at pauses and joined on the words neighbouring windows agree on; the SDK resamples and downmixes to mono. Word times come from the frame that emitted each word rather than a second alignment pass, at 80 ms resolution. Crucially it **does not detect language** — "Audio in a language Voz doesn't support comes back as fluent text that's wrong. Voz doesn't raise an error" — so pair it with Ear. Word ends are less precise than word starts, and short clips run slowly relative to long ones because every clip pays for a full 15 s window.
3. **Inputs / outputs:** `File`/`Blob` (streamed, any container WebCodecs can decode), a path (Node 20+, streamed), `ArrayBuffer`/`Uint8Array` (decoded whole), `Float32Array` (mono 16 kHz), or `{ samples, sampleRate }` (resampled) → `{ text, words[{ text, start, end }], sentences, captions, realtimeFactor, durationSec, processingSec }`, and CLI writers for SRT/VTT/TXT (`--srt`, `--vtt`, `--txt`, `--format srt`) with broadcast-style cues: two lines of 42 characters, no more than 7 s on screen. A `decodeAudioData` that returns a short buffer is reported rather than silently truncated.
4. **Size / latency / accuracy / languages:** **10 minutes of audio** in 0.8 s on M3 Ultra (762×), 1.2 s on iPhone 18 Pro (492×), 1.3 s on M4 Max (453×), 1.8 s on iPhone 17 Pro (334×), 2.1 s on iPhone 15 Pro (283×), 2.4 s on M1 Mac mini (251×); short clips run 50–62×. **7.40% word error rate** averaged over six Open ASR Leaderboard sets versus Whisper large-v3-turbo's 7.00% (per set: LibriSpeech test-clean 2.19% vs 2.13%, test-other 3.86% vs 3.70%, GigaSpeech 9.70% vs 8.47%, SPGISpeech 3.86% vs 2.79%, Earnings-22 12.97% vs 11.07%, AMI 11.84% vs 13.87%); 2.83% on 30 minutes of audiobook (Whisper 2.72%); per-language on 10 minutes of read speech from **3.31% (Italian)** to **39.46% (Greek)**. Word starts are off by 83 ms and ends by 95 ms on average against a forced aligner, at 80 ms frame resolution. Size **467 MB on disk** (Whisper large-v3-turbo is 1.6 GB at fp16); the browser needs its own ~390 MB bundle (a GPU wants a different weight layout) and about 1.2 GB resident, ~900 MB of which is ONNX Runtime's compiled session; first load after download takes 10–30 s while Core ML specialises, then 0.2 s. Browser speed: ~125× realtime on M5, 38× on M1, 255× on M3 Ultra, ~35× in Safari. Languages: **25 European** — Bulgarian, Croatian, Czech, Danish, Dutch, English, Estonian, Finnish, French, German, Greek, Hungarian, Italian, Latvian, Lithuanian, Maltese, Polish, Portuguese, Romanian, Russian, Slovak, Slovenian, Spanish, Swedish, Ukrainian.
5. **Platform / runtime:** iOS/iPadOS/macOS/tvOS/visionOS on Core ML (entirely on the Neural Engine); **Windows via the Swift SDK on the GPU through ONNX Runtime and DirectML**, same API; browser on WebAssembly + ONNX Runtime (encoder on WebGPU, decoder on WebNN where the browser has it, as Chromium on a Mac does); Node on the CPU via `onnxruntime-node`. **No Android SDK, and the Swift package does not run Voz on Linux** — deliberately, "because LiteRT can't preallocate buffers or batch the decode loop, and Voz would run slower". Browser tested on Chromium 135+ and Safari 26+; needs no SharedArrayBuffer and no cross-origin isolation (the runtime is configured for a single wasm thread, which also avoids a WebKit JIT pathology that costs 15% in Safari).
6. **Distribution & access:** docs `/docs/voz/`; npm `@desert-ant-labs/voz` (no `/native` subpath — it has no native Node core, so browser and server run the same WebAssembly pipeline; `onnxruntime-node` must be passed in with `load({ ort })` because a server bundle cannot include a native addon); Swift product `Voz`; weights `desert-ant-labs/voz` (v0.3.0, including a `web/` directory of ONNX files); CLI `da voz talk.mp4 -t`, with `--srt`/`--vtt`/`--txt` and `--json` for pipelines; example app Clipper.
7. **Licensing / pricing:** standard terms; the Parakeet base model is CC BY 4.0 and the notice is in `THIRD_PARTY_NOTICES.md`.
8. **Restrictions for wrapping:** standard. **Windows: the most viable heavyweight path** — `@desert-ant-labs/voz` + `onnxruntime-node` works without Apple hardware, and the site claims a Windows GPU path via DirectML in the Swift SDK. Expect a large download, CPU-speed transcription on Node, Node 20+ for path streaming, and WAV conversion (e.g. `ffmpeg -i in.mp4 -ac 1 -ar 16000 out.wav`) where WebCodecs is absent.

### Who

1. **One-line purpose:** Who — speaker labeling: "Label who said what in audio and video."
2. **Full capability description:** turns a recording into per-person turns — "Record a two-hour two-camera interview and Who splits it by speaker, so you jump to what one person said or cut on every speaker change". It "listens and watches the mouths at the same time, so overlaps and short interjections do not throw the labels off" — it uses the picture as well as the audio, not audio alone. Each turn carries a speaker id, a face-track id, a normalized face bounding box, and millisecond timestamps, "in the same shape a Whisper transcript uses", so it plugs into captioning pipelines and follow-the-speaker editing (switching camera on every speaker change, framing with the face box).
3. **Inputs / outputs:** audio/video recordings in; per-turn speaker id, face-track id, normalized face bbox, and millisecond timestamps out; Whisper-compatible turns for captioning/editing pipelines.
4. **Size / latency / accuracy / languages:** nothing published (no benchmarks, sizes, or language list). The HF repo `desert-ant-labs/who` holds component weights (`who-face.mlmodelc.zip`, `who-segment.mlmodelc.zip`, `who-voice.mlmodelc.zip`, `model_combo_syncnet_synth.mlmodelc.zip`, `blazeface_back.mlmodelc.zip`, `person_distill.mlmodelc.zip`, `blend_distill.mlmodelc.zip`, `silero-vad-batch.mlmodelc.zip`, `mel_fb_40x201.f32`, `anchorsback.f32`) but its README is just `# who`.
5. **Platform / runtime:** "Platforms: Apple (Swift) first"; status closed beta, "In development. Early access on request." `https://desertant.com/docs/who/` is **404**.
6. **Distribution & access:** model page with "Contact us for early access"; HF repo with weights (last modified 2026-08-03, 0 downloads observed); listed in `llms.txt` under closed beta.
7. **Licensing / pricing:** standard FAQ wording (free up to 100k MAD; contact for custom licences); the HF repo carries its own `LICENSE.md` and `licenses/apache-2.0.txt`.
8. **Restrictions for wrapping:** standard terms. Closed beta and Apple-first, so not wrappable from public channels today. **UNVERIFIED:** API shape, sizes, Windows path.

## Cross-cutting observations (runtime, packaging, licensing patterns)

1. **Two runtime philosophies.** Apple gets Core ML almost everywhere; **Title is the deliberate exception, on MLX**, because autoregressive short-text decode measured 5.7–8.3× faster on the GPU than on the Neural Engine (and the Core ML build lost on time-to-first-token, throughput, load time, and memory). Everything else is LiteRT/TFLite first, ONNX where LiteRT cannot express the workload (Voz's transducer decode, Uhm's server/browser path, Toxic's browser artifact), plus hand-written pure JavaScript for Tongue.
2. **Artifacts ≠ supported platforms.** Counting `.tflite` files overstates reach. Clips is the honest counter-example (files published, SDK explicitly cannot drive them, documented bit-for-bit why); Schemer's HF card describes SDK platform coverage that the website says does not exist yet. Judge support by the SDK docs and package prebuild targets, not by what is in the weights repo.
3. **Closed beta is a real gate.** Eye, Face, Schemer, Toxic and Who have public or early-access weights but no shipping SDK, and all five `/docs/<model>/` URLs return 404.
4. **Version skew is normal.** SDK/core 3.6.0 is current (npm `dist-tags.latest = 3.6.0`, repo `VERSION` = 3.6.0), while several marketing pages still print `from: "3.5.0"` snippets. The SDK docs pin a Hugging Face revision per SDK version (`Redact` v0.4.0, `Emo` v0.7.0, `Gist` v2.2.0, `Shapes` v0.3.0, `Clear` v0.3.0, `Tongue` v1.0.0, `Voz` v0.3.0, `Align` v1.1.0, `Uhm` v1.1.0, `Ear` v0.2.0, `Moderator` v1.0.0, `Clips` v0.1.0, `Title` v0.1.0).
5. **Packaging is one package per model.** Swift: one product per model, so an app includes only the models it adds. npm: one package per model plus shared `@desert-ant-labs/core` (the core README explains the split: the browser entry wires wasm + LiteRT.js with late-bound host seams and nothing installed on `globalThis`; `/native` uses koffi to bind prebuilt Swift cores under `native/<platform>-<arch>`). Android: one module per model sharing a single LiteRT copy through `ai.desertant:core`.
6. **Telemetry and MAD counting are load-bearing.** The free tier is enforced by SDK-generated device-counting telemetry, and both the licence and its "Rules for agents" section (§19) prohibit disabling or interfering with it. Any wrapper must leave it intact.
7. **Attribution is a licence condition, not a courtesy.** A wrapper with a user-visible surface needs the "Powered by Desert Ant Labs" credit linked to desertant.com; a headless/background integration can satisfy it in documentation or the repository. File-level notices inside the SDK must also be kept.
8. **Weights are hosted, not vendored.** Everything downloads at runtime from Hugging Face at a pinned revision, verified by the SDK. For offline/airgapped use the documented path is to pre-download with the Hugging Face CLI (`hf download desert-ant-labs/redact --revision v0.4.0 --include "redact.mlmodelc/*" redact_tokenizer.bin labels.json --local-dir redact`) and pass `directory`/`{ directory }`/`modelBaseUrl`. Apple platforms can opt into the `Xet` package trait for chunked parallel downloads; every other platform uses plain HTTPS.

## Implications for wrapping these as agent tools (honest assessment, including blockers)

**The constraint that reorders everything:** the target machine here is **Windows x64 with Node**, not Apple silicon. The catalogue is rich, but the Windows-servable slice is small.

**Tier 1 — buildable now (Windows):**

- **Tongue** (`@desert-ant-labs/tongue`): pure JavaScript, 2 MB bundled, no download, no wasm, no native addon, synchronous `detect()`, 84 languages, reliability and tie reporting. Ideal first tool, and already confirmed working in this workspace by earlier local testing. Good agent use: language routing before other tools, plus a "what language is this?" utility.
- **CLI adapter (conditional):** `desertant`/`da` is unusually agent-friendly — JSON in/out, `desertant schema --json` for discovery, stdin composition (`da voz talk.mp4 --json | da clips talk.mp4 --transcript -`), exit codes 0/1/64, never overwrites output files, and `desertant setup` writes agent skills (Claude Code/Pi skill file, Codex `AGENTS.md` section). **Blocker:** the README says macOS (Apple silicon) and Linux, so on Windows it needs WSL/Linux or a remote host the user has installed. Build it as an optional adapter that detects and reports unavailability cleanly.

**Tier 2 — possible with real engineering:**

- **Voz** (`@desert-ant-labs/voz` + `onnxruntime-node`): works without Apple hardware; expect a multi-hundred-MB download, CPU-speed transcription, Node 20+ for streaming paths, and WAV conversion via ffmpeg where WebCodecs is missing. The site also claims a Windows GPU path through ONNX Runtime + DirectML in the Swift SDK.
- **Browser/Worker LiteRT harness:** the LiteRT-backed npm packages ship a browser build (WebAssembly + LiteRT.js) that is refused in plain Node. A headless-browser or Worker-based adapter could technically run Redact/Emo/Gist/Clear/Ear/Moderator/Shapes/Align on Windows, but it is a substantial harness with model-download, memory, and performance caveats.
- **Kotlin/JVM sidecar:** Tongue is explicitly usable on any JVM 17+, and `ai.desertant` artifacts are published for Android/JVM. A JVM sidecar could plausibly host some models on Windows if the artifacts are JVM-compatible — **UNVERIFIED**.

**Tier 3 — blocked or unavailable today:**

- **Title** (Apple silicon/MLX only) and **Uhm** (Apple-only SDK) cannot be wrapped on this machine.
- **Clips** has no working non-Apple SDK path (published-but-broken LiteRT files).
- **Eye, Face, Schemer, Toxic, Who** need early access; no SDK ships.
- **Redact, Emo, Gist, Clear, Ear, Moderator, Shapes, Align** in plain Windows Node: the `/native` subpath fails (no win32-x64 prebuild) and the browser build refuses plain Node.

**Design guidance for the plugin:**

1. Model the capability matrix as data (per model × per runtime × per platform), not as a hard dependency list; expose "available / needs download / unsupported here / needs early access" per tool.
2. Ship adapters — `tongue-js`, `voz-node-onnx`, `da-cli`, `browser-worker-litert`, `swift-native`, `unavailable` — each with its own install and health check.
3. Never bundle or redistribute weights; download from Hugging Face at the pinned revision or accept a user-supplied directory, and surface size/first-run cost before starting.
4. Keep telemetry untouched and surface licence acceptance and the attribution text during setup.
5. Prefer tools that report model limits in their output (Redact ~90% recall; Ear's unreliable languages; Voz does not detect language; Moderator/Uhm/Toxic are aids, not verdicts).
6. Because the licence forbids redistributing the SDKs as a standalone product or hosted service, the plugin should be a local installer/wrapper the user runs — not a re-hosted Desert Ant API offered to others.

## Sources (every URL fetched, with HTTP status)

Complete machine-generated fetch logs are in `D:\DEV\dsh-model-as-tool\research\raw\_status.tsv`, `_status2.tsv`, `_status3.tsv`. The full list follows.

### Site, docs, company (batch 1)

- 200 | https://desertant.com/llms.txt | desertant.com_llms.txt.txt | 7186
- 200 | https://desertant.com/swift/ | desertant.com_swift_.txt | 25977
- 200 | https://desertant.com/kotlin/ | desertant.com_kotlin_.txt | 22453
- 200 | https://desertant.com/js/ | desertant.com_js_.txt | 23112
- 200 | https://desertant.com/audio/ | desertant.com_audio_.txt | 22234
- 200 | https://desertant.com/text/ | desertant.com_text_.txt | 22278
- 200 | https://desertant.com/vision/ | desertant.com_vision_.txt | 20901
- 200 | https://desertant.com/blog/ | desertant.com_blog_.txt | 20594
- 200 | https://desertant.com/privacy/ | desertant.com_privacy_.txt | 20829
- 200 | https://desertant.com/contact/ | desertant.com_contact_.txt | 24372
- 200 | https://desertant.com/jobs/ | desertant.com_jobs_.txt | 23424
- 200 | https://desertant.com/press/ | desertant.com_press_.txt | 23060
- 200 | https://desertant.com/inspiration/ | desertant.com_inspiration_.txt | 149236
- 200 | https://license.desertant.com/ | license.desertant.com_.txt | 21796
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-core/main/README.md | raw.githubusercontent.com_Desert-Ant-Labs_desert-ant-core_main_README.md.txt | 13560
- 200 | https://huggingface.co/desert-ant-labs | huggingface.co_desert-ant-labs.txt | 208947
- 200 | https://desertant.com/models/align/ | desertant.com_models_align_.txt | 53798
- 200 | https://desertant.com/models/clear/ | desertant.com_models_clear_.txt | 63446
- 200 | https://desertant.com/models/clips/ | desertant.com_models_clips_.txt | 53176
- 200 | https://desertant.com/models/ear/ | desertant.com_models_ear_.txt | 58283
- 200 | https://desertant.com/models/emo/ | desertant.com_models_emo_.txt | 53996
- 200 | https://desertant.com/models/eye/ | desertant.com_models_eye_.txt | 25175
- 200 | https://desertant.com/models/face/ | desertant.com_models_face_.txt | 24867
- 200 | https://desertant.com/models/gist/ | desertant.com_models_gist_.txt | 57479
- 200 | https://desertant.com/models/moderator/ | desertant.com_models_moderator_.txt | 40638
- 200 | https://desertant.com/models/redact/ | desertant.com_models_redact_.txt | 62411
- 200 | https://desertant.com/models/schemer/ | desertant.com_models_schemer_.txt | 29487
- 200 | https://desertant.com/models/shapes/ | desertant.com_models_shapes_.txt | 57006
- 200 | https://desertant.com/models/title/ | desertant.com_models_title_.txt | 48876
- 200 | https://desertant.com/models/tongue/ | desertant.com_models_tongue_.txt | 57515
- 200 | https://desertant.com/models/toxic/ | desertant.com_models_toxic_.txt | 30637
- 200 | https://desertant.com/models/uhm/ | desertant.com_models_uhm_.txt | 43907
- 200 | https://desertant.com/models/voz/ | desertant.com_models_voz_.txt | 66691
- 200 | https://desertant.com/models/who/ | desertant.com_models_who_.txt | 24772
- 200 | https://desertant.com/docs/align/ | desertant.com_docs_align_.txt | 48789
- 200 | https://desertant.com/docs/clear/ | desertant.com_docs_clear_.txt | 47810
- 200 | https://desertant.com/docs/clips/ | desertant.com_docs_clips_.txt | 36913
- 200 | https://desertant.com/docs/ear/ | desertant.com_docs_ear_.txt | 43208
- 200 | https://desertant.com/docs/emo/ | desertant.com_docs_emo_.txt | 39253
- 200 | https://desertant.com/docs/gist/ | desertant.com_docs_gist_.txt | 44704
- 200 | https://desertant.com/docs/moderator/ | desertant.com_docs_moderator_.txt | 37473
- 200 | https://desertant.com/docs/redact/ | desertant.com_docs_redact_.txt | 44183
- 200 | https://desertant.com/docs/shapes/ | desertant.com_docs_shapes_.txt | 38094
- 200 | https://desertant.com/docs/title/ | desertant.com_docs_title_.txt | 34099
- 200 | https://desertant.com/docs/tongue/ | desertant.com_docs_tongue_.txt | 42503
- 200 | https://desertant.com/docs/uhm/ | desertant.com_docs_uhm_.txt | 33755
- 200 | https://desertant.com/docs/voz/ | desertant.com_docs_voz_.txt | 42283

### SDK docs, catalog, licence, Hugging Face model cards, npm registry (batch 2)

- 200 | https://desertant.com/catalog.json | desertant.com_catalog.json.txt | 22290
- 200 | https://desertant.com/llms-full.txt | desertant.com_llms-full.txt.txt | 45491
- 200 | https://license.desertant.com/1.0 | license.desertant.com_1.0.txt | 21796
- 200 | https://github.com/Desert-Ant-Labs | github.com_Desert-Ant-Labs.txt | 283478
- 200 | https://github.com/Desert-Ant-Labs/desert-ant-core | github.com_Desert-Ant-Labs_desert-ant-core.txt | 392438
- 200 | https://github.com/Desert-Ant-Labs/desert-ant-cli | github.com_Desert-Ant-Labs_desert-ant-cli.txt | 321598
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-cli/main/README.md | raw.githubusercontent.com_Desert-Ant-Labs_desert-ant-cli_main_README.md.txt | 5702
- 403 | https://www.npmjs.com/org/desert-ant-labs | FAILED | Response status code does not indicate success: 403 (Forbidden).
- 200 | https://registry.npmjs.org/-/v1/search?text=desert-ant-labs&size=50 | registry.npmjs.org_-_v1_search_text_desert-ant-labs_size_50.txt | 58301
- 200 | https://pypi.org/search/?q=desertant | pypi.org_search__q_desertant.txt | 3036
- 200 | https://huggingface.co/desert-ant-labs/redact | huggingface.co_desert-ant-labs_redact.txt | 166350
- 200 | https://huggingface.co/desert-ant-labs/voz | huggingface.co_desert-ant-labs_voz.txt | 154234
- 200 | https://huggingface.co/desert-ant-labs/tongue | huggingface.co_desert-ant-labs_tongue.txt | 182142
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-core/main/docs/models/align.md | raw.githubusercontent.com_Desert-Ant-Labs_desert-ant-core_main_docs_models_align.md.txt | 9793
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-core/main/docs/models/clear.md | raw.githubusercontent.com_Desert-Ant-Labs_desert-ant-core_main_docs_models_clear.md.txt | 8401
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-core/main/docs/models/clips.md | raw.githubusercontent.com_Desert-Ant-Labs_desert-ant-core_main_docs_models_clips.md.txt | 6717
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-core/main/docs/models/ear.md | raw.githubusercontent.com_Desert-Ant-Labs_desert-ant-core_main_docs_models_ear.md.txt | 5812
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-core/main/docs/models/emo.md | raw.githubusercontent.com_Desert-Ant-Labs_desert-ant-core_main_docs_models_emo.md.txt | 4487
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-core/main/docs/models/gist.md | raw.githubusercontent.com_Desert-Ant-Labs_desert-ant-core_main_docs_models_gist.md.txt | 7436
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-core/main/docs/models/moderator.md | raw.githubusercontent.com_Desert-Ant-Labs_desert-ant-core_main_docs_models_moderator.md.txt | 4231
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-core/main/docs/models/redact.md | raw.githubusercontent.com_Desert-Ant-Labs_desert-ant-core_main_docs_models_redact.md.txt | 7096
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-core/main/docs/models/shapes.md | raw.githubusercontent.com_Desert-Ant-Labs_desert-ant-core_main_docs_models_shapes.md.txt | 4559
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-core/main/docs/models/title.md | raw.githubusercontent.com_Desert-Ant-Labs_desert-ant-core_main_docs_models_title.md.txt | 5210
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-core/main/docs/models/tongue.md | raw.githubusercontent.com_Desert-Ant-Labs_desert-ant-core_main_docs_models_tongue.md.txt | 8066
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-core/main/docs/models/uhm.md | raw.githubusercontent.com_Desert-Ant-Labs_desert-ant-core_main_docs_models_uhm.md.txt | 5307
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-core/main/docs/models/voz.md | raw.githubusercontent.com_Desert-Ant-Labs_desert-ant-core_main_docs_models_voz.md.txt | 6958
- 200 | https://huggingface.co/desert-ant-labs/align/raw/main/README.md | huggingface.co_desert-ant-labs_align_raw_main_README.md.txt | 6515
- 200 | https://huggingface.co/desert-ant-labs/clear/raw/main/README.md | huggingface.co_desert-ant-labs_clear_raw_main_README.md.txt | 7163
- 200 | https://huggingface.co/desert-ant-labs/clips/raw/main/README.md | huggingface.co_desert-ant-labs_clips_raw_main_README.md.txt | 6432
- 200 | https://huggingface.co/desert-ant-labs/ear/raw/main/README.md | huggingface.co_desert-ant-labs_ear_raw_main_README.md.txt | 6866
- 200 | https://huggingface.co/desert-ant-labs/emo/raw/main/README.md | huggingface.co_desert-ant-labs_emo_raw_main_README.md.txt | 4416
- 200 | https://huggingface.co/desert-ant-labs/gist/raw/main/README.md | huggingface.co_desert-ant-labs_gist_raw_main_README.md.txt | 7898
- 200 | https://huggingface.co/desert-ant-labs/moderator/raw/main/README.md | huggingface.co_desert-ant-labs_moderator_raw_main_README.md.txt | 5713
- 200 | https://huggingface.co/desert-ant-labs/redact/raw/main/README.md | huggingface.co_desert-ant-labs_redact_raw_main_README.md.txt | 6810
- 200 | https://huggingface.co/desert-ant-labs/shapes/raw/main/README.md | huggingface.co_desert-ant-labs_shapes_raw_main_README.md.txt | 4065
- 200 | https://huggingface.co/desert-ant-labs/title/raw/main/README.md | huggingface.co_desert-ant-labs_title_raw_main_README.md.txt | 4210
- 200 | https://huggingface.co/desert-ant-labs/tongue/raw/main/README.md | huggingface.co_desert-ant-labs_tongue_raw_main_README.md.txt | 9587
- 200 | https://huggingface.co/desert-ant-labs/uhm/raw/main/README.md | huggingface.co_desert-ant-labs_uhm_raw_main_README.md.txt | 5089
- 200 | https://huggingface.co/desert-ant-labs/voz/raw/main/README.md | huggingface.co_desert-ant-labs_voz_raw_main_README.md.txt | 8015
- 401 | https://huggingface.co/desert-ant-labs/eye/raw/main/README.md | FAILED | Response status code does not indicate success: 401 (Unauthorized).
- 401 | https://huggingface.co/desert-ant-labs/face/raw/main/README.md | FAILED | Response status code does not indicate success: 401 (Unauthorized).
- 200 | https://huggingface.co/desert-ant-labs/schemer/raw/main/README.md | huggingface.co_desert-ant-labs_schemer_raw_main_README.md.txt | 14680
- 200 | https://huggingface.co/desert-ant-labs/toxic/raw/main/README.md | huggingface.co_desert-ant-labs_toxic_raw_main_README.md.txt | 19328
- 200 | https://huggingface.co/desert-ant-labs/who/raw/main/README.md | huggingface.co_desert-ant-labs_who_raw_main_README.md.txt | 106

### Hugging Face API, licence pages, PyPI probes (batch 3)

- 200 | https://huggingface.co/api/models?author=desert-ant-labs&full=true&limit=100 | huggingface.co_api_models_author_desert-ant-labs_full_true_limit_100 | 21978
- 401 | https://huggingface.co/desert-ant-labs/eye | FAILED | Response status code does not indicate success: 401 (Unauthorized).
- 401 | https://huggingface.co/desert-ant-labs/face | FAILED | Response status code does not indicate success: 401 (Unauthorized).
- 200 | https://github.com/Desert-Ant-Labs/desert-ant-swift | github.com_Desert-Ant-Labs_desert-ant-swift | 262207
- 200 | https://license.desertant.com/attribution | license.desertant.com_attribution | 6523
- 200 | https://license.desertant.com/1.0.txt | license.desertant.com_1.0.txt | 16728
- 404 | https://pypi.org/pypi/desertant/json | FAILED | Response status code does not indicate success: 404 (Not Found).
- 404 | https://pypi.org/pypi/desert-ant/json | FAILED | Response status code does not indicate success: 404 (Not Found).

### Additional probes and fetches

- 200 | https://desertant.com/ (home page)
- 200 | https://desertant.com/models/ (catalog index)
- 200 | https://desertant.com/docs/ (SDK docs index)
- 200 | https://desertant.com/llms-full.txt
- 200 | https://license.desertant.com/attribution
- 200 | https://license.desertant.com/1.0.txt
- 200 | https://huggingface.co/api/models?author=desert-ant-labs&full=true&limit=100 (17 model repos listed)
- 200 | https://huggingface.co/api/spaces?author=desert-ant-labs&limit=50 (11 Spaces listed)
- 200 | https://huggingface.co/desert-ant-labs/redact
- 200 | https://huggingface.co/desert-ant-labs/voz
- 200 | https://huggingface.co/desert-ant-labs/tongue
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-core/main/Package.swift
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-core/main/manifest.json
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-core/main/VERSION (3.6.0)
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-core/main/LICENSE.md
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-core/main/THIRD_PARTY_NOTICES.md
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-core/main/Sources/Redact/Catalog.swift
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-core/main/packages/voz-node/README.md
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-core/main/docs/models/<13 model files>.md
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-cli/main/README.md
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-cli/main/docs/agents.md
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-cli/main/docs/json.md
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-cli/main/docs/pipelines.md
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/demo-clipper/main/README.md
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/demo-redactor/main/README.md
- 200 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-swift/main/README.md
- 200 | https://registry.npmjs.org/-/v1/search?text=desert-ant-labs&size=50
- 200 | https://registry.npmjs.org/@desert-ant-labs%2fredact (29 versions, latest 3.6.0)
- 200 | https://registry.npmjs.org/@desert-ant-labs%2femo
- 200 | https://registry.npmjs.org/@desert-ant-labs%2fcore (18 versions, latest 3.6.0)
- 200 | https://registry.npmjs.org/@litertjs%2fcore
- 200 | https://cocoapods.org/?q=desertant (no pods found)
- 404 | https://desertant.com/pricing/
- 404 | https://desertant.com/developers/
- 404 | https://desertant.com/sdk/
- 404 | https://desertant.com/download/
- 404 | https://desertant.com/company/
- 404 | https://desertant.com/api/
- 404 | https://desertant.com/models.json
- 404 | https://desertant.com/docs/schemer/
- 404 | https://desertant.com/docs/eye/
- 404 | https://desertant.com/docs/face/
- 404 | https://desertant.com/docs/who/
- 404 | https://desertant.com/docs/toxic/
- 404 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-core/main/docs/models/schemer.md
- 404 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-core/main/docs/models/eye.md
- 404 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-core/main/docs/models/face.md
- 404 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-core/main/docs/models/who.md
- 404 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-core/main/docs/models/toxic.md
- 404 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-core/main/docs/agents.md
- 404 | https://raw.githubusercontent.com/Desert-Ant-Labs/desert-ant-core/main/docs/README.md
- 404 | https://swiftpackageindex.com/Desert-Ant-Labs
- 404 | https://pypi.org/pypi/desertant/json
- 404 | https://pypi.org/pypi/desert-ant/json
- 401 | https://huggingface.co/desert-ant-labs/eye/raw/main/README.md
- 401 | https://huggingface.co/desert-ant-labs/face/raw/main/README.md
- 403 | https://www.npmjs.com/org/desert-ant-labs
- 403 | https://api.github.com/orgs/Desert-Ant-Labs/repos?per_page=100

### Hugging Face model cards fetched as raw README (all 200 unless noted)

- https://huggingface.co/desert-ant-labs/{align,clear,clips,ear,emo,gist,moderator,redact,shapes,title,tongue,uhm,voz,schemer,toxic,who}/raw/main/README.md
- 401 https://huggingface.co/desert-ant-labs/eye/raw/main/README.md
- 401 https://huggingface.co/desert-ant-labs/face/raw/main/README.md
- Note: `desert-ant-labs/who/raw/main/README.md` returned 200 but its content is a single line, `# who`.

### Model and docs pages fetched individually (all 200)

- https://desertant.com/models/{align,clear,clips,ear,emo,eye,face,gist,moderator,redact,schemer,shapes,title,tongue,toxic,uhm,voz,who}/ — 18 pages
- https://desertant.com/docs/{align,clear,clips,ear,emo,gist,moderator,redact,shapes,title,tongue,uhm,voz}/ — 13 pages
- https://desertant.com/{,audio/,text/,vision/,swift/,kotlin/,js/,about/,blog/,press/,privacy/,contact/,jobs/,inspiration/} — 14 pages

### Registry presence summary

| Registry | Result |
|---|---|
| npm (`@desert-ant-labs/*`) | **Resolves.** 3.6.0 latest; per-model packages + shared `@desert-ant-labs/core` |
| npm org web page | 403 Forbidden |
| Maven Central (`ai.desertant:*`) | Stated in docs (not independently fetched here — UNVERIFIED by direct fetch) |
| PyPI | **No package** (`desertant`, `desert-ant` both 404) |
| CocoaPods | No pods found |
| Swift Package Index | 404 for the org URL |
| GitHub org | **Resolves** (`github.com/Desert-Ant-Labs`) with 9 public repos seen in HTML |
| Hugging Face org | **Resolves** (`huggingface.co/desert-ant-labs`), 17+ model repos and 11 Spaces |

### Explicitly NOT verified

- Commercial pricing above 100,000 MAD — not published anywhere on the site.
- Maven Central artifact existence — docs claim it; I did not fetch Maven Central.
- Windows behaviour of the Swift SDK — stated in docs, not tested here.
- Any working non-Apple wrapper for the LiteRT models on Windows.
- Eye/Face model details — Hugging Face README fetches returned 401 and no docs page exists.
- Whether a JVM sidecar can host `ai.desertant` models on Windows.
- Title`s supported languages — no list published.
- Uhm`s transfer-language accuracy — explicitly unmeasured by the vendor.
- Toxic latency — explicitly unmeasured by the vendor.
- Two conflicting language counts: Ear (99 site vs 102 docs/HF tags) and Clips/others where the site and README disagree on SDK platform coverage.

### Evidence notes on method

- HTML was stripped by removing `<head>`, `<script>`, `<style>`, `<svg>`, `<footer>` blocks, converting block-closing tags to newlines, dropping remaining tags, and decoding entities with `System.Net.WebUtility::HtmlDecode`.
- Quoted snippets in this document are taken verbatim from those stripped pages or from the raw Markdown README/model-card files.
- Where a fact came from a Hugging Face model card rather than the website, it is attributed to the card in the text.
- Anything I could not confirm is marked **UNVERIFIED** or "not stated".