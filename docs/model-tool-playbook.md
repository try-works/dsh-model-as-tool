# Model tool playbook — use cases, tool shapes and skills

One section per catalogued model: what the tool is called, the jobs it is for,
when an agent should and should not reach for it, how to drive it, and what to
watch out for. This is the source material the plugin renders into each model's
skill, from `packages/dsh-model-tools/catalog/playbooks.json`.

## Which models are actually installable today

| Model | Tool | Skill | Windows x64 | Why not, when unavailable |
| --- | --- | --- | --- | --- |
| **Align** | `align_transcript` | `desert-ant-align` | no | No win32-x64 prebuild; linux-x64 / linux-arm64 / darwin-arm64 only |
| **Clear** | `enhance_speech` | `desert-ant-clear` | no | No win32-x64 prebuild; linux-x64 / linux-arm64 / darwin-arm64 only |
| **Clips** | `select_clips` | `desert-ant-clips` | no | No win32-x64 prebuild; linux-x64 / linux-arm64 / darwin-arm64 only |
| **Ear** | `detect_spoken_language` | `desert-ant-ear` | no | No win32-x64 prebuild; linux-x64 / linux-arm64 / darwin-arm64 only |
| **Emo** | `suggest_emoji` | `desert-ant-emo` | no | No win32-x64 prebuild; linux-x64 / linux-arm64 / darwin-arm64 only |
| **Eye** | `score_frames` | `desert-ant-eye` | no | Closed beta; weights published, no shipping SDK |
| **Face** | `match_faces` | `desert-ant-face` | no | Closed beta; weights published, no shipping SDK |
| **Gist** | `tag_topics` | `desert-ant-gist` | no | No win32-x64 prebuild; linux-x64 / linux-arm64 / darwin-arm64 only |
| **Moderator** | `detect_nsfw` | `desert-ant-moderator` | no | No win32-x64 prebuild; linux-x64 / linux-arm64 / darwin-arm64 only |
| **Redact** | `redact_pii` | `desert-ant-redact` | no | No win32-x64 prebuild; linux-x64 / linux-arm64 / darwin-arm64 only |
| **Schemer** | `extract_fields` | `desert-ant-schemer` | no | Closed beta; weights published, no shipping SDK |
| **Shapes** | `recognize_shape` | `desert-ant-shapes` | no | No win32-x64 prebuild; linux-x64 / linux-arm64 / darwin-arm64 only |
| **Title** | `suggest_title` | `desert-ant-title` | no | Apple-only (Core ML / MLX); no JS or Kotlin SDK |
| **Tongue** | `lang_detect` | `desert-ant-tongue` | yes | — runs here |
| **Toxic** | `moderate_text` | `desert-ant-toxic` | no | Closed beta; weights published, no shipping SDK |
| **Uhm** | `detect_fillers` | `desert-ant-uhm` | no | Apple-only (Core ML / MLX); no JS or Kotlin SDK |
| **Voz** | `transcribe_audio` | `desert-ant-voz` | yes | — runs here with onnxruntime-node |
| **Who** | `detect_speakers` | `desert-ant-who` | no | Closed beta; weights published, no shipping SDK |

## Align — `align_transcript`

Word-timestamp refinement for any transcript, on device, from 0.7MB.

- **Capability:** `audio.word-alignment`
- **Input / output:** audio → { words: [{ text, start, end }] } aligned against the audio
- **Returns:** The transcript split into words, each with a start and end time in seconds.
- **Skill:** `desert-ant-align`
- **Docs:** https://desertant.com/models/align/

**Parameters**

- `audio_path` (string): undefined
- `transcript` (string): undefined

**Use cases**

- Refine coarse segment timings from a transcript into word-accurate timings for captions.
- Produce the timing data a clip cutter or highlight list needs.
- Re-time a transcript produced by a different engine against the original audio.

**When to use**

- You already have the transcript text and the audio, and you need better word timings.
- The existing timings are segment-level or drifted.
- The transcriber was not this project's own model.

**When not to use**

- You have audio but no transcript: transcribe first, alignment refines an existing transcript.
- You need the words themselves to be corrected; alignment places words, it does not fix them.
- The transcript does not correspond to the audio.

**Workflow**

1. Transcribe first, then align the transcript against the same audio file.
2. Feed the exact transcript text that was produced; paraphrasing breaks the alignment.
3. Drop the aligned timings straight into the caption or cut step.

**Pairs with**

- transcribe_audio (Voz) produces the transcript to align

**Caveats**

- Alignment cannot rescue a transcript with missing or inserted words; it degrades where the two disagree.
- Runs on Node only in the JavaScript SDK, and the native core targets linux-x64, linux-arm64 and darwin-arm64.

## Clear — `enhance_speech`

On-device speech enhancement: denoise, dereverb and loudness-normalize to 48 kHz.

- **Capability:** `audio.speech-enhancement`
- **Input / output:** audio → A cleaned audio file path plus processing metadata
- **Returns:** The path of the enhanced audio file.
- **Skill:** `desert-ant-clear`
- **Docs:** https://desertant.com/models/clear/

**Parameters**

- `audio_path` (string): undefined
- `output_path` (string): undefined

**Use cases**

- Clean up a recording before publishing a podcast or a video.
- Remove room echo and background noise from a voice note so it can be transcribed more accurately.
- Level the loudness of a set of recordings so they sit together consistently.

**When to use**

- Speech is present and the problem is noise, echo or inconsistent level.
- The audio must not be uploaded to a service.
- A downstream step (transcription, clipping) benefits from cleaner input.

**When not to use**

- The recording is music: enhancement is tuned for speech.
- The problem is that words are wrong, not that the audio is noisy — that is transcription's job.
- You need a specific broadcast loudness standard certified; verify the output rather than assuming.

**Workflow**

1. Enhance first, then transcribe: cleaner input gives better word timings.
2. Keep the original file; write the enhanced audio to a new path.
3. Check the loudness of the result before publishing rather than trusting the default target.

**Pairs with**

- transcribe_audio (Voz) as the downstream consumer
- detect_fillers (Uhm) after cleanup

**Caveats**

- Enhancement is a transformation: it can remove breath and room tone that a listener expected, and it is not reversible.
- Very noisy input can be over-suppressed, producing artefacts; spot-check the output.

## Clips — `select_clips`

Clip selection that turns a long recording into ranked shorts and highlights from a transcript.

- **Capability:** `video.clip-selection`
- **Input / output:** video → { clips: [{ index, start, end, title, file }] } ranked by interest
- **Returns:** Ranked clips, each with its start and end time, a title and the written clip file.
- **Skill:** `desert-ant-clips`
- **Docs:** https://desertant.com/models/clips/

**Parameters**

- `media_path` (string): undefined
- `transcript` (string): undefined

**Use cases**

- Turn a long podcast, interview or meeting into a ranked list of short clips.
- Produce social cuts from a webinar recording.
- Surface the moments most likely to be worth watching from an archive.

**When to use**

- The recording is long and talking-led, and a set of candidate highlights is wanted.
- A transcript exists or can be produced, since selection works from the transcript.
- The output is a cut list for a human to review, not a final edit.

**When not to use**

- There is no speech: selection is transcript-driven.
- You need a finished, publishable edit rather than candidates.
- The recording is already short; the overhead is not worth it.

**Workflow**

1. Transcribe once, then pass that transcript in so transcription does not repeat.
2. Review the ranked clip list and treat the ranking as a suggestion.
3. Reuse the written clip paths from the result rather than predicting filenames.

**Pairs with**

- transcribe_audio (Voz) for the transcript input
- suggest_title (Title) to give each selected clip a title and description

**Caveats**

- The files this model consumes are documented upstream as not being a stable interface (naming mismatches, int64 versus int32, large memory use); do not depend on their layout.
- Clip boundaries are model-suggested; check the first and last second of each before publishing.

## Ear — `detect_spoken_language`

On-device spoken language identification across 102 languages from a short audio stretch.

- **Capability:** `audio.spoken-language-identification`
- **Input / output:** audio → { language, confidence, candidates: [{ language, probability }] }
- **Returns:** The detected spoken language with a confidence and runner-up candidates.
- **Skill:** `desert-ant-ear`
- **Docs:** https://desertant.com/models/ear/

**Parameters**

- `audio_path` (string): undefined

**Use cases**

- Choose the transcription language before running speech recognition.
- Route an inbound call recording to a language-specific queue or agent.
- Check that a recording is in the language it claims to be.

**When to use**

- You have audio and need its spoken language, not its words.
- Running full transcription just to learn the language would be wasteful.
- The language is unknown across a large set (102 supported).

**When not to use**

- The source is written text: use lang_detect (Tongue).
- You already know the language and need the words: go straight to transcribe_audio.
- The clip is shorter than a few seconds of speech.

**Workflow**

1. Detect the spoken language on a short representative stretch rather than the whole file.
2. Pass the result as the language hint to transcription.
3. On a low-confidence or heavily multilingual recording, treat the answer as provisional.

**Pairs with**

- transcribe_audio (Voz) as the immediate consumer
- lang_detect (Tongue) to cross-check against any accompanying written text

**Caveats**

- Code-switching and heavy accents degrade accuracy.
- A recording with music or noise before speech can mislead the detector; sample from where speech actually is.

## Emo — `suggest_emoji`

Type a task or message and get the emoji that fit, in 22 languages, on the device.

- **Capability:** `text.emoji-suggestion`
- **Input / output:** text → [{ emoji, confidence }] ranked suggestions
- **Returns:** Ranked emoji suggestions with confidence scores.
- **Skill:** `desert-ant-emo`
- **Docs:** https://desertant.com/models/emo/

**Parameters**

- `text` (string): undefined
- `limit` (integer): Maximum number of suggestions to return (default 5).

**Use cases**

- Decorate release notes, changelog entries or commit summaries with fitting emoji.
- Pick an emoji for a UI label, notification or section heading.
- Suggest reactions for a chat or support message.

**When to use**

- Text is being written for a surface where an emoji improves scanning or tone.
- The text is in one of the 22 supported languages.
- The choice should be consistent rather than a matter of the model's taste.

**When not to use**

- The destination is a code identifier, a commit subject under a strict convention, or a formal document.
- You need sentiment or intent; this model suggests emoji, it does not classify meaning.
- A single emoji is required: take the top suggestion rather than asking for more and guessing.

**Workflow**

1. Call suggest_emoji with the text as written.
2. Take the top suggestion when one emoji is needed; ask for a larger limit only when offering a choice.
3. Do not stack several suggestions into one label.

**Pairs with**

- suggest_title (Title) when a section needs both a heading and a marker

**Caveats**

- Emoji convention is cultural; a suggestion is a proposal, not a rule.
- Skin-tone variants are not selected by this tool.

## Eye — `score_frames`

On-device frame scoring that tells you which shot to keep, what is in it, and which shots repeat.

- **Capability:** `image.frame-scoring`
- **Input / output:** image → [{ frame, score, labels, duplicate_of }]
- **Returns:** Frames ranked by score, with labels and duplicate grouping.
- **Skill:** `desert-ant-eye`
- **Docs:** https://desertant.com/models/eye/

**Parameters**

- `image_paths` (string[]): Absolute paths of the frames to score.
- `top` (integer): How many top frames to return (default 5).

**Use cases**

- Choose the best frame from a burst for a thumbnail or hero image.
- Reduce a clip to its most representative shots.
- Detect and drop repeated near-identical shots before review.

**When to use**

- A burst or clip must be reduced to the frames worth keeping.
- You need a quality signal plus content labels without uploading the images.
- De-duplication matters as much as ranking.

**When not to use**

- You need aesthetic judgement for a brand; scoring is technical.
- The material is a single deliberate shot.
- You need object detection over many categories.

**Workflow**

1. Score the burst and take the top frame, or the best frame per duplicate group.
2. Use the labels to sanity-check that the chosen frame shows what was expected.
3. Keep the original files; scoring selects, it does not edit.

**Pairs with**

- detect_nsfw (Moderator) to screen the frames that would otherwise be published

**Caveats**

- In closed beta: the weights are published but no SDK ships them.
- Scores favour technical quality (sharpness, exposure) over editorial suitability.

## Face — `match_faces`

On-device face matching that finds the same person across a photo library or through a video.

- **Capability:** `image.face-matching`
- **Input / output:** image → [{ path, faces: [{ box, match_id }] }]
- **Returns:** Detected face boxes grouped by person identity.
- **Skill:** `desert-ant-face`
- **Docs:** https://desertant.com/models/face/

**Parameters**

- `image_paths` (string[]): Absolute paths of the images to match faces across.
- `video_path` (string): undefined

**Use cases**

- Group a photo library by person without uploading any image.
- Find every appearance of a person in a video.
- De-duplicate near-identical portrait shots.

**When to use**

- Images or video must be grouped by identity and privacy rules forbid uploading them.
- You need face boxes and cluster ids rather than names.
- The faces are reasonably large and frontal.

**When not to use**

- You need to identify a named individual from a database; that is a different, consent-bound task.
- Faces are tiny, profile-only or heavily occluded.
- Biometric processing is not lawful in your jurisdiction for this purpose — check before using.

**Workflow**

1. Run matching over the set and keep cluster ids stable for the session.
2. Let a human name each cluster; do not infer identity from the model.
3. Keep the images on the machine; only the cluster metadata needs to travel.

**Pairs with**

- detect_speakers (Who) to correlate speakers with on-screen faces

**Caveats**

- In closed beta: the weights are published but no SDK ships them.
- Face matching is biometric processing and is regulated in many jurisdictions; the local-only design helps but does not by itself make a use lawful.
- Quality of the crop dominates accuracy.

## Gist — `tag_topics`

On-device topic tagging across a 36-topic taxonomy, in 101 languages, with no server call.

- **Capability:** `text.topic-tagging`
- **Input / output:** text → { topics: [{ topic, score }] }
- **Returns:** Ranked topic labels from the fixed taxonomy with scores.
- **Skill:** `desert-ant-gist`
- **Docs:** https://desertant.com/models/gist/

**Parameters**

- `text` (string): undefined
- `limit` (integer): Maximum number of topics to return (default 5).

**Use cases**

- Tag a document, post or issue with topics before indexing or routing it.
- Route incoming content to the right owner, queue or template by topic.
- Build a browsable topic facet over a corpus.
- Check a draft against the taxonomy to see whether it is on-topic.

**When to use**

- The content must be classified into a stable, fixed taxonomy rather than free-form tags.
- The classification must not leave the machine.
- You want multi-label output rather than one exclusive category.

**When not to use**

- You need free-form keywords or entity extraction: the taxonomy here is fixed at 36 topics.
- The text is very short or empty; there is not enough signal for multi-label tagging.
- You need sentiment or toxicity — those are different models.

**Workflow**

1. Call tag_topics with the text; use the title when a full document is too long.
2. Treat the returned topics as a set, ranked by score; keep those above the threshold the consumer cares about.
3. Because the taxonomy is fixed, store the label ids rather than the display strings so a relabelling does not break the index.

**Pairs with**

- lang_detect (Tongue) for language-aware downstream routing

**Caveats**

- A fixed taxonomy means genuinely novel subjects fall into the nearest existing topic rather than creating a new one.
- Scores are model confidences, not calibrated probabilities.

## Moderator — `detect_nsfw`

On-device NSFW detection that flags nudity before upload, trained only on licensed and synthetic data.

- **Capability:** `image.nsfw-detection`
- **Input / output:** image → { nsfw, score, labels: [...] }
- **Returns:** A per-image NSFW verdict with score and labels.
- **Skill:** `desert-ant-moderator`
- **Docs:** https://desertant.com/models/moderator/

**Parameters**

- `image_paths` (string[]): Absolute paths of the images to check.

**Use cases**

- Screen a user-supplied image before it is stored, published or forwarded.
- Gate an upload pipeline so objectionable content never reaches a CDN or a review queue unlabelled.
- Batch-audit an asset library for policy compliance.

**When to use**

- Images are entering a system from an untrusted source.
- The check must happen locally, for privacy or because the images may not be uploaded to a third party.
- A binary flag plus a score is enough for the decision.

**When not to use**

- The content is text: use moderate_text (Toxic) instead.
- You need a nuanced appropriateness judgement for a specific audience; this is nudity/sexual-content detection.
- The decision is irreversible and high-stakes without human review.

**Workflow**

1. Call detect_nsfw with the image paths; the model loads once for the whole batch.
2. Treat the score as a threshold you choose, not a verdict, and log the score with the decision.
3. Route borderline scores to human review rather than auto-rejecting.

**Pairs with**

- moderate_text (Toxic) to cover the text side of the same pipeline

**Caveats**

- The model was trained only on licensed and synthetic data, which is what makes it safe to ship commercially — but it also bounds what it has seen.
- A false negative publishes content; choose the threshold with that asymmetry in mind.

## Redact — `redact_pii`

On-device redaction that strips personal data as you type, in 27 languages, with restore support.

- **Capability:** `text.pii-redaction`
- **Input / output:** text → { redactedText, items: [{ label, original, placeholder, confidence }] }
- **Returns:** The redacted text plus the placeholder map, so originals can be restored after a remote round trip.
- **Skill:** `desert-ant-redact`
- **Docs:** https://desertant.com/models/redact/

**Parameters**

- `text` (string): undefined
- `labels` (string[]): Optional list of entity labels to restrict redaction to, for example ["EMAIL", "PHONE"].
- `minimum_confidence` (number): Optional confidence floor between 0 and 1 (default 0.6).

**Use cases**

- Scrub names, emails, phone numbers and account numbers from text before it is sent to a remote model or API.
- Sanitise a transcript, ticket or log excerpt so it can be shared or committed.
- Produce a shareable version of a document while keeping a placeholder map to restore the originals afterwards.
- Meet a data-minimisation requirement in an agent pipeline that would otherwise forward raw personal data.

**When to use**

- Text containing personal data is about to leave the machine, the repository or the trust boundary.
- You need the redacted text AND the ability to put the originals back after a remote round trip.
- The text is in one of the 27 supported languages.

**When not to use**

- Nothing personal is present: redaction adds placeholders that a later reader must resolve.
- You need anonymisation that survives re-identification statistically; placeholder substitution is not that.
- The text is audio or an image: transcribe or OCR it first.

**Workflow**

1. Call redact_pii with the raw text and keep the returned items list — it is the restore map.
2. Send only the redacted text to the remote service.
3. Call the result's restore on the reply to put the original values back, on the machine, before showing it to the user.
4. Narrow with `labels` when only specific categories matter, and raise minimum_confidence to trade recall for precision.

**Pairs with**

- transcribe_audio (Voz) to get text that then needs scrubbing
- moderate_text (Toxic) for a different risk category over the same text

**Caveats**

- Organisation names are detected but not redacted by default, because a company is not a natural person; pass ORG in labels to include them.
- Structured patterns such as emails, card numbers and IMEI are matched by rule and always apply, independent of the model's confidence.
- The free-tier licence counts monthly active devices per platform per model; it does not restrict the volume of inference.

## Schemer — `extract_fields`

Extract typed fields from any text against your own schema, on device, with empty fields left empty.

- **Capability:** `text.structured-extraction`
- **Input / output:** text → An object matching the caller-supplied schema
- **Returns:** An object matching the supplied schema.
- **Skill:** `desert-ant-schemer`
- **Docs:** https://desertant.com/models/schemer/

**Parameters**

- `text` (string): undefined
- `schema` (string): undefined

**Use cases**

- Turn unstructured text into typed JSON against a schema the caller defines.
- Extract invoice, contract or form fields without a hosted model.
- Normalise incoming free-text records into a database shape.

**When to use**

- The target schema is known and the source is text.
- Extraction must happen locally.
- A field being absent from the text should stay absent rather than be guessed.

**When not to use**

- The schema is unknown or you want open-ended information extraction.
- The task needs reasoning beyond field mapping.
- The text is audio or an image.

**Workflow**

1. Write the narrowest schema that answers the question; every optional field is a chance to hallucinate.
2. Pass the schema with the text in one call.
3. Treat a missing field as a real answer: the model leaves fields empty when the text is silent.
4. Validate the returned object against the schema before trusting it downstream.

**Pairs with**

- redact_pii (Redact) before extraction when the text holds personal data

**Caveats**

- In closed beta: the weights are published but no SDK ships them, so this tool cannot be installed yet.
- Schema-constrained extraction fails quietly if the schema itself is ambiguous; make field names and descriptions unambiguous.

## Shapes — `recognize_shape`

On-device shape recognition that turns one hand-drawn stroke into a rectangle, ellipse, triangle, star or line in under 10ms.

- **Capability:** `stroke.shape-recognition`
- **Input / output:** stroke → { shape, confidence, candidates: [...] }
- **Returns:** The recognized shape with a confidence and runner-up candidates.
- **Skill:** `desert-ant-shapes`
- **Docs:** https://desertant.com/models/shapes/

**Parameters**

- `points` (string): undefined
- `closed` (string): undefined

**Use cases**

- Snap a hand-drawn ink stroke to a clean geometric shape in a drawing or whiteboard tool.
- Normalise a diagram sketch into precise primitives before rendering.
- Recognise a gesture stroke as a command shape.

**When to use**

- You have stroke points and need the intended geometric primitive.
- Latency matters and the stroke is a single closed or open path.

**When not to use**

- The input is a raster image: this consumes stroke coordinates, not pixels.
- The drawing is complex or multi-stroke; recognition is per stroke.
- The intended shape is not one of rectangle, ellipse, triangle, star or line.

**Workflow**

1. Capture points in drawing order at a reasonable sample rate; keep the raw points for undo.
2. Pass closed true only when the stroke actually closes.
3. Use the confidence to decide between snapping and leaving the stroke as freehand.

**Caveats**

- A wobbly or over-sampled stroke can be classified by its noise rather than its intent; simplify before recognition if the result is unstable.
- Only the five documented primitives are recognised.

## Title — `suggest_title`

On-device titles and descriptions: a short factual title and a one- or two-sentence description for any passage.

- **Capability:** `text.title-generation`
- **Input / output:** text → { title, description, isEmpty }
- **Returns:** A title and a description, or an empty card when the model returned neither.
- **Skill:** `desert-ant-title`
- **Docs:** https://desertant.com/models/title/

**Parameters**

- `text` (string): undefined
- `max_tokens` (integer): Optional generation cap in tokens (default 96).

**Use cases**

- Write the heading and one-line description for a landing-page section.
- Generate a documentation page title and summary from its body.
- Give each selected clip or chapter a title and description.
- Name an article, note or changelog entry.

**When to use**

- A passage needs a short factual title plus a one- or two-sentence description.
- The text is long enough to have a subject — a section, page or transcript — rather than a fragment.
- You want a factual label rather than a marketing headline.

**When not to use**

- You need persuasive or brand copy; this model writes factual titles.
- The passage is a single sentence with no distinct subject.
- You are on Windows or Linux: see the caveat below — this model cannot run there.

**Workflow**

1. Pass the full passage, not a summary of it; the model needs the material to name.
2. Use the returned title and description together: the title for navigation, the description for context.
3. Cap generation with max_tokens when input is unusual, since the model can otherwise generate without end.
4. On an empty card, fall back to the passage's own first sentence rather than retrying blindly.

**Pairs with**

- select_clips (Clips) to title each selected clip

**Caveats**

- Title runs on Apple platforms only, on the GPU through MLX, and requires the Swift MLX package trait. There is no JavaScript or Kotlin SDK and no Windows or Linux build, so this tool cannot run on a Windows DSH host.
- On iOS the model must be suspended before the app backgrounds, because the platform revokes GPU access.
- Treat it as a remote capability: call it from an Apple machine, not from this process.

## Tongue — `lang_detect`

On-device language identification for short text across 84 languages, from just a few words.

- **Capability:** `text.language-identification`
- **Input / output:** text → { language, reliability, candidates: [{ language, probability }], isTooCloseToCall }
- **Returns:** The detected language code, a reliability verdict, and the top scoring candidates with probabilities.
- **Skill:** `desert-ant-tongue`
- **Docs:** https://desertant.com/models/tongue/

**Parameters**

- `text` (string): undefined
- `top` (integer): How many runner-up language candidates to include (default 3).

**Use cases**

- Route a localisation task: detect the language of a user message, ticket or document before choosing templates, fonts or a translation target.
- Verify generated copy: check that text the agent just wrote is in the language it was asked to write.
- Triage an inbox or a corpus by language without calling a hosted classifier.
- Guard a translation pipeline: only translate when the detected language differs from the target.

**When to use**

- You have a short piece of text (even three or four words is enough) and you need its language code.
- The text must not leave the machine, so a local detector is required.
- You need a fast, cheap check that can run on every message rather than on a sample.

**When not to use**

- The input is audio: use detect_spoken_language (Ear) instead.
- The text is a single proper noun, a URL, an emoji or pure digits — there is too little signal and the result will be unreliable.
- You need translation; this model identifies language, it does not translate.

**Workflow**

1. Call lang_detect with the raw text; do not pre-clean it, since punctuation and casing carry signal.
2. Read `language` as the answer and `reliability` as the confidence verdict.
3. Treat isTooCloseToCall true as 'ask or abstain' rather than guessing between the top candidates.
4. When the answer drives a destructive or expensive action, confirm with a candidate margin before acting.

**Pairs with**

- detect_spoken_language (Ear) when the source is a recording
- transcribe_audio (Voz) to pick the transcription language first

**Caveats**

- Language identification over short text is inherently ambiguous between close relatives (da/no/sv, es/ca, id/ms); the candidate list is the honest answer, not just the top label.
- The model ships inside the npm package, so there is no download and no network call.
- It reports ISO 639-1 style codes; map them if the consumer expects another convention.

## Toxic — `moderate_text`

On-device moderation that flags hateful, abusive and threatening text in 23 European languages.

- **Capability:** `text.toxicity-detection`
- **Input / output:** text → { toxic, score, labels: [...] }
- **Returns:** A toxicity verdict with score and the matched labels.
- **Skill:** `desert-ant-toxic`
- **Docs:** https://desertant.com/models/toxic/

**Parameters**

- `text` (string): undefined
- `minimum_confidence` (number): Optional confidence floor between 0 and 1.

**Use cases**

- Pre-screen user-generated text before publishing or forwarding it.
- Flag abuse in a support or community inbox for human review.
- Audit a corpus for hateful or threatening content.

**When to use**

- Text is entering a system from an untrusted source and needs a risk signal.
- The content is in one of the 23 supported European languages.
- The result will be reviewed by a human before any action is taken.

**When not to use**

- The content is an image: use detect_nsfw (Moderator).
- You need a legal determination; this is a triage signal.
- Auto-banning on the score alone — false positives on reclaimed language and quoted abuse are expected.

**Workflow**

1. Call moderate_text with the text and a deliberate confidence floor.
2. Use the verdict to prioritise human review, not to decide alone.
3. Record the score alongside the decision so thresholds can be tuned later.

**Pairs with**

- redact_pii (Redact) to strip personal data before a reviewer sees the text

**Caveats**

- In closed beta: the weights are published but no SDK ships them.
- Coverage is 23 European languages; other languages are out of scope.
- Quoted or reported speech is a known source of false positives.

## Uhm — `detect_fillers`

On-device filler detection that marks every um, uh and hmm to within 20ms, an hour of audio in 12s.

- **Capability:** `audio.filler-detection`
- **Input / output:** audio → [{ start, end, word }] filler spans to cut
- **Returns:** Filler spans with start and end times in seconds, ready to cut.
- **Skill:** `desert-ant-uhm`
- **Docs:** https://desertant.com/models/uhm/

**Parameters**

- `audio_path` (string): undefined

**Use cases**

- Find every hesitation in a recording so an editor can cut them.
- Tighten a spoken transcript by removing filler spans.
- Measure how disfluent a speaker is across a set of recordings.

**When to use**

- Spoken audio needs its filler words located with tight time bounds.
- You are preparing an edited cut and need exact spans to remove.
- The language and speaker are broadly covered by the model.

**When not to use**

- You need the transcript: detect_fillers returns spans, not words.
- The audio is music or non-speech.
- You intend to remove every match automatically without listening: over-cutting is easy.

**Workflow**

1. Transcribe first so you can see the fillers in context.
2. Use the returned spans as cut candidates, keeping a margin so the cut does not clip neighbouring words.
3. Review the cut list; some 'uh' sounds are meaningful emphasis.

**Pairs with**

- transcribe_audio (Voz) for the words around the fillers
- clear (Clear) to clean audio before editing

**Caveats**

- Runs on Apple platforms only through the Swift SDK; it is not available to a Windows or Linux DSH host.
- Spans are millisecond-precise but a cut still needs a small crossfade to avoid clicks.

## Voz — `transcribe_audio`

Transcribe 10 minutes of audio in 2s on an iPhone, 14x faster than Whisper, with word timestamps.

- **Capability:** `audio.speech-recognition`
- **Input / output:** audio → { text, words: [{ text, start, end }], realtimeFactor }
- **Returns:** The transcript text, optional per-word start and end times, and the measured realtime factor.
- **Skill:** `desert-ant-voz`
- **Docs:** https://desertant.com/models/voz/

**Parameters**

- `audio_path` (string): undefined
- `include_words` (boolean): Whether to include the per-word timestamps (default true).

**Use cases**

- Transcribe a meeting, interview or voice note locally so the audio never leaves the machine.
- Produce captions or subtitles with word-level timing that a cut or highlight list can be built from.
- Turn a recording into text the agent can then summarise, search or index.
- Find where a phrase was said, using the per-word timestamps rather than re-listening.

**When to use**

- The task needs the words of an audio or video file, and the audio is private or too large to upload.
- You need timing, not just text: captions, clip boundaries or 'jump to that moment' behaviour.
- The recording is one of the 25 supported languages.

**When not to use**

- The file is not speech (music, ambient, a tone) — expect an empty transcript, which is a correct result rather than a failure.
- You only need the language, not the words: detect_spoken_language is far cheaper.
- The environment cannot supply an ONNX Runtime module, or the ~349 MB of weights cannot be downloaded.

**Workflow**

1. Confirm the runtime is present first; on Node this model needs onnxruntime-node, and the plugin reports that as the unavailable reason when it is missing.
2. Prefer a 16 kHz mono WAV when a decoder is unavailable: convert with ffmpeg -i in.mp4 -ac 1 -ar 16000 out.wav.
3. Transcribe once and reuse the result: transcription is the expensive step and its output feeds clips, alignment and summaries.
4. Pass include_words true only when timing is actually needed; a long transcript with word timings is a large payload.
5. Treat an empty `text` with wordCount 0 as 'no speech found' rather than an error.

**Pairs with**

- select_clips (Clips) consumes the transcript to cut highlights
- align_transcript (Align) refines word timings against the audio
- detect_fillers (Uhm) finds the hesitations to cut
- detect_speakers (Who) attributes turns to people

**Caveats**

- The weights are ~349 MB and ONNX Runtime holds roughly 1.2 GB resident; load once and reuse rather than per call.
- The first call downloads the bundle, so the first transcription is much slower than later ones.
- Node CPU inference is materially slower than the browser's GPU path; budget time for long recordings.
- A decoder can return less audio than the container claims; the SDK reports that instead of silently truncating.

## Who — `detect_speakers`

On-device speaker labeling that turns a recording into per-person turns with face boxes and timestamps.

- **Capability:** `audio.speaker-labeling`
- **Input / output:** audio → [{ speaker, start, end, face_box }] turns
- **Returns:** Speaking turns labelled by speaker, with start and end times.
- **Skill:** `desert-ant-who`
- **Docs:** https://desertant.com/models/who/

**Parameters**

- `audio_path` (string): undefined

**Use cases**

- Split an interview into per-speaker turns for a readable transcript.
- Attribute quotes to people in a meeting recording.
- Label speakers so an edit can cut between them.

**When to use**

- A recording has multiple speakers and the transcript needs attribution.
- Timestamps per turn are needed for cutting or captions.
- The speakers are distinguishable by voice.

**When not to use**

- Only one person speaks: attribution adds nothing.
- You need to know who a person is by name; this labels turns, it does not identify identities.
- The audio quality is too poor to separate voices.

**Workflow**

1. Transcribe first, then attribute turns to the transcript.
2. Treat speaker labels as anonymous clusters until a human assigns names.
3. Use the face boxes on video to help a human confirm which cluster is which person.

**Pairs with**

- transcribe_audio (Voz) for the words
- match_faces (Face) to help map clusters to people

**Caveats**

- In closed beta: the weights are published but no SDK ships them.
- Overlapping speech and similar voices cause cluster swaps; verify before publishing attributed quotes.
