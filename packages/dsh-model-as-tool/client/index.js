// dsh-model-as-tool browser half: the Settings -> Model as Tool page.
//
// Plain JavaScript by necessity: DSH's client module system serves this file to
// the page as a lazy-CJS bundle, so it IS the shipped artifact. The loader id is
// the PACKAGE name (the web client looks that up); the Cordis entry id
// (`model-tools`) is the settings namespace this page configures.
//
// Only 'react' is requested. Controls and styles are written here, using only
// theme tokens that exist on the shipped settings pages: a token that does not
// exist is dropped by the browser and the page degrades into undifferentiated
// prose.
//
// The model catalog is GENERATED INTO THIS FILE at build time (see
// client/index.template.js and scripts/gen-client-catalog.mjs): it carries the
// same entries model_tools reports, with the platform verdict resolved on the
// host that builds the package.
window.__ModuleLoader__.load({
  id: '@try-works/dsh-model-as-tool',
  factory(require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /**
     * The catalog, embedded at build time by scripts/gen-client-catalog.mjs.
     *
     * Each entry: { id, name, summary, package, capability, sizeMB, license,
     * runnable, reason }. `runnable` is this host's capability verdict, so the
     * page can only offer toggles for models that can actually run and can say
     * why the rest cannot.
     */
    const CATALOG = /*__CATALOG_JSON__*/
    [
      {
        "id": "align",
        "name": "Align",
        "summary": "Word-timestamp refinement for any transcript, on device, from 0.7MB.",
        "package": "@desert-ant-labs/align",
        "extension": null,
        "capability": "audio.word-alignment",
        "sizeMB": 0.7,
        "license": "source-available",
        "runnable": false,
        "reason": "Align has no prebuilt native build for win32-x64: @desert-ant-labs/align/native supports linux-x64, linux-arm64 and darwin-arm64 only."
      },
      {
        "id": "clear",
        "name": "Clear",
        "summary": "On-device speech enhancement: denoise, dereverb and loudness-normalize to 48 kHz.",
        "package": "@desert-ant-labs/clear",
        "extension": null,
        "capability": "audio.speech-enhancement",
        "sizeMB": null,
        "license": "source-available",
        "runnable": false,
        "reason": "Clear has no prebuilt native build for win32-x64: @desert-ant-labs/clear/native supports linux-x64, linux-arm64 and darwin-arm64 only."
      },
      {
        "id": "clips",
        "name": "Clips",
        "summary": "Clip selection that turns a long recording into ranked shorts and highlights from a transcript.",
        "package": null,
        "extension": null,
        "capability": "video.clip-selection",
        "sizeMB": null,
        "license": "source-available",
        "runnable": false,
        "reason": "Clips has no npm package; run it through the Desert Ant CLI (macOS/Linux) with `cli.enabled`, or through a bridge with `remote.endpoint`."
      },
      {
        "id": "ear",
        "name": "Ear",
        "summary": "On-device spoken language identification across 102 languages from a short audio stretch.",
        "package": "@desert-ant-labs/ear",
        "extension": null,
        "capability": "audio.spoken-language-identification",
        "sizeMB": null,
        "license": "source-available",
        "runnable": false,
        "reason": "Ear has no prebuilt native build for win32-x64: @desert-ant-labs/ear/native supports linux-x64, linux-arm64 and darwin-arm64 only."
      },
      {
        "id": "emo",
        "name": "Emo",
        "summary": "Type a task or message and get the emoji that fit, in 22 languages, on the device.",
        "package": "@desert-ant-labs/emo",
        "extension": null,
        "capability": "text.emoji-suggestion",
        "sizeMB": 10.2,
        "license": "source-available",
        "runnable": false,
        "reason": "Emo has no prebuilt native build for win32-x64: @desert-ant-labs/emo/native supports linux-x64, linux-arm64 and darwin-arm64 only."
      },
      {
        "id": "eye",
        "name": "Eye",
        "summary": "On-device frame scoring that tells you which shot to keep, what is in it, and which shots repeat.",
        "package": null,
        "extension": null,
        "capability": "image.frame-scoring",
        "sizeMB": null,
        "license": "source-available",
        "runnable": false,
        "reason": "Eye is in closed beta: the weights are published at https://huggingface.co/desert-ant-labs/eye but no SDK ships them yet, so it cannot be installed as a tool."
      },
      {
        "id": "face",
        "name": "Face",
        "summary": "On-device face matching that finds the same person across a photo library or through a video.",
        "package": null,
        "extension": null,
        "capability": "image.face-matching",
        "sizeMB": null,
        "license": "source-available",
        "runnable": false,
        "reason": "Face is in closed beta: the weights are published at https://huggingface.co/desert-ant-labs/face but no SDK ships them yet, so it cannot be installed as a tool."
      },
      {
        "id": "gist",
        "name": "Gist",
        "summary": "On-device topic tagging across a 36-topic taxonomy, in 101 languages, with no server call.",
        "package": "@desert-ant-labs/gist",
        "extension": null,
        "capability": "text.topic-tagging",
        "sizeMB": null,
        "license": "source-available",
        "runnable": false,
        "reason": "Gist has no prebuilt native build for win32-x64: @desert-ant-labs/gist/native supports linux-x64, linux-arm64 and darwin-arm64 only."
      },
      {
        "id": "moderator",
        "name": "Moderator",
        "summary": "On-device NSFW detection that flags nudity before upload, trained only on licensed and synthetic data.",
        "package": "@desert-ant-labs/moderator",
        "extension": null,
        "capability": "image.nsfw-detection",
        "sizeMB": 9.2,
        "license": "source-available",
        "runnable": false,
        "reason": "Moderator has no prebuilt native build for win32-x64: @desert-ant-labs/moderator/native supports linux-x64, linux-arm64 and darwin-arm64 only."
      },
      {
        "id": "redact",
        "name": "Redact",
        "summary": "On-device redaction that strips personal data as you type, in 27 languages, with restore support.",
        "package": "@desert-ant-labs/redact",
        "extension": null,
        "capability": "text.pii-redaction",
        "sizeMB": null,
        "license": "source-available",
        "runnable": false,
        "reason": "Redact has no prebuilt native build for win32-x64: @desert-ant-labs/redact/native supports linux-x64, linux-arm64 and darwin-arm64 only."
      },
      {
        "id": "schemer",
        "name": "Schemer",
        "summary": "Extract typed fields from any text against your own schema, on device, with empty fields left empty.",
        "package": null,
        "extension": null,
        "capability": "text.structured-extraction",
        "sizeMB": null,
        "license": "source-available",
        "runnable": false,
        "reason": "Schemer is in closed beta: the weights are published at https://huggingface.co/desert-ant-labs/schemer but no SDK ships them yet, so it cannot be installed as a tool."
      },
      {
        "id": "shapes",
        "name": "Shapes",
        "summary": "On-device shape recognition that turns one hand-drawn stroke into a rectangle, ellipse, triangle, star or line in under 10ms.",
        "package": "@desert-ant-labs/shapes",
        "extension": null,
        "capability": "stroke.shape-recognition",
        "sizeMB": null,
        "license": "source-available",
        "runnable": false,
        "reason": "Shapes has no prebuilt native build for win32-x64: @desert-ant-labs/shapes/native supports linux-x64, linux-arm64 and darwin-arm64 only."
      },
      {
        "id": "title",
        "name": "Title",
        "summary": "On-device titles and descriptions: a short factual title and a one- or two-sentence description for any passage.",
        "package": null,
        "extension": null,
        "capability": "text.title-generation",
        "sizeMB": null,
        "license": "source-available",
        "runnable": false,
        "reason": "Title is Apple-only (Core ML/MLX through the Swift package); there is no JavaScript SDK, so it cannot run in a Node process. Point `remote.endpoint` at a bridge on an Apple machine to reach it."
      },
      {
        "id": "tongue",
        "name": "Tongue",
        "summary": "On-device language identification for short text across 84 languages, from just a few words.",
        "package": "@desert-ant-labs/tongue",
        "extension": "@try-works/extension-desert-ant-tongue",
        "capability": "text.language-identification",
        "sizeMB": 2,
        "license": "source-available",
        "runnable": true
      },
      {
        "id": "toxic",
        "name": "Toxic",
        "summary": "On-device moderation that flags hateful, abusive and threatening text in 23 European languages.",
        "package": null,
        "extension": null,
        "capability": "text.toxicity-detection",
        "sizeMB": null,
        "license": "source-available",
        "runnable": false,
        "reason": "Toxic is in closed beta: the weights are published at https://huggingface.co/desert-ant-labs/toxic but no SDK ships them yet, so it cannot be installed as a tool."
      },
      {
        "id": "uhm",
        "name": "Uhm",
        "summary": "On-device filler detection that marks every um, uh and hmm to within 20ms, an hour of audio in 12s.",
        "package": null,
        "extension": null,
        "capability": "audio.filler-detection",
        "sizeMB": null,
        "license": "source-available",
        "runnable": false,
        "reason": "Uhm is Apple-only (Core ML/MLX through the Swift package); there is no JavaScript SDK, so it cannot run in a Node process. Point `remote.endpoint` at a bridge on an Apple machine to reach it."
      },
      {
        "id": "voz",
        "name": "Voz",
        "summary": "Transcribe 10 minutes of audio in 2s on an iPhone, 14x faster than Whisper, with word timestamps.",
        "package": "@desert-ant-labs/voz",
        "extension": "@try-works/extension-desert-ant-voz",
        "capability": "audio.speech-recognition",
        "sizeMB": 349,
        "license": "source-available",
        "runnable": true
      },
      {
        "id": "who",
        "name": "Who",
        "summary": "On-device speaker labeling that turns a recording into per-person turns with face boxes and timestamps.",
        "package": null,
        "extension": null,
        "capability": "audio.speaker-labeling",
        "sizeMB": null,
        "license": "source-available",
        "runnable": false,
        "reason": "Who is in closed beta: the weights are published at https://huggingface.co/desert-ant-labs/who but no SDK ships them yet, so it cannot be installed as a tool."
      }
    ]

    /**
     * The Tool Mode extensions this repository ships, embedded at build time.
     *
     * Each entry: { id, name, package, version, license, summary, models, tools,
     * contracts }. The host's extension store is the authority for
     * installed/active state, and it is reachable as `ctx.remote.modelTools`
     * when this client assembly mounts that Remote. When it does not, the page
     * degrades to the config-only `disabledExtensions` preference and says so:
     * it never invents an installed state.
     */
    const EXTENSIONS = /*__EXTENSIONS_JSON__*/
    [
      {
        "id": "@try-works/extension-declarative-recipes",
        "name": "declarative recipes",
        "package": "@try-works/extension-declarative-recipes",
        "version": "0.1.0",
        "license": "MIT",
        "summary": "Ships NO CODE.",
        "models": [],
        "tools": [],
        "contracts": [
          "text.title",
          "image.describe"
        ]
      },
      {
        "id": "@try-works/extension-embeddinggemma",
        "name": "EmbeddingGemma 2",
        "package": "@try-works/extension-embeddinggemma",
        "version": "0.1.0",
        "license": "MIT",
        "summary": "Multimodal embedding and retrieval tools over EmbeddingGemma 2 (google/embeddinggemma-2 through a pinned ONNX conversion): multimodal_embed produces 768-, 51…",
        "models": [
          "embeddinggemma-2"
        ],
        "tools": [
          "multimodal_embed",
          "semantic_similarity",
          "semantic_rank",
          "semantic_classify",
          "semantic_deduplicate",
          "media_find_moments"
        ],
        "contracts": [
          "@try-works/extension-embeddinggemma/multimodal_embed",
          "@try-works/extension-embeddinggemma/semantic_similarity",
          "@try-works/extension-embeddinggemma/semantic_rank",
          "@try-works/extension-embeddinggemma/semantic_classify",
          "@try-works/extension-embeddinggemma/semantic_deduplicate",
          "@try-works/extension-embeddinggemma/media_find_moments"
        ]
      },
      {
        "id": "@try-works/extension-laya",
        "name": "Laya",
        "package": "@try-works/extension-laya",
        "version": "1.0.0",
        "license": "Apache-2.0",
        "summary": "The Laya decision family (H5): decision_choose (a choice over the caller's options), decision_test (yes/no) and decision_score (an ordinal level) over the pi…",
        "models": [
          "laya"
        ],
        "tools": [
          "decision_choose",
          "decision_test",
          "decision_score"
        ],
        "contracts": [
          "@try-works/extension-laya/decision_choose",
          "@try-works/extension-laya/decision_test",
          "@try-works/extension-laya/decision_score"
        ]
      },
      {
        "id": "@try-works/extension-minilm-rerank",
        "name": "MiniLM Rerank",
        "package": "@try-works/extension-minilm-rerank",
        "version": "1.0.0",
        "license": "Apache-2.0",
        "summary": "The ms-marco MiniLM-L-6 cross-encoder reranking extension (TOOL-05): query/document pairs cross-encoded to ranking logits, returned with the caller's own ids…",
        "models": [
          "minilm-rerank"
        ],
        "tools": [],
        "contracts": [
          "text.rerank"
        ]
      },
      {
        "id": "@try-works/extension-minilm-embed",
        "name": "MiniLM-L6",
        "package": "@try-works/extension-minilm-embed",
        "version": "1.0.0",
        "license": "Apache-2.0",
        "summary": "The legacy 384-dimensional MiniLM-L6 text embedding space (TOOL-04, BASE-12): mean pooling, L2 normalization, input order preserved.",
        "models": [
          "minilm-l6"
        ],
        "tools": [],
        "contracts": [
          "text.embed"
        ]
      },
      {
        "id": "@try-works/extension-needle",
        "name": "Needle 3",
        "package": "@try-works/extension-needle",
        "version": "0.1.0",
        "license": "MIT",
        "summary": "Tool proposal and structured extraction over the pinned Cactus Needle 3 native engine (Cactus-Compute/needle3, windows-x86_64/needle.exe at revision 93e88ede…",
        "models": [
          "needle3"
        ],
        "tools": [
          "tools_plan",
          "structured_extract"
        ],
        "contracts": [
          "@try-works/extension-needle/tools_plan",
          "@try-works/extension-needle/structured_extract"
        ]
      }
    ]

    /** Page styles, prefixed to avoid colliding with host styles. */
    const CSS = `
.mtt-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 720px;
  color: var(--dsw-alias-label-primary);
}
.mtt-title {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.mtt-intro {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-tertiary);
}
.mtt-card {
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  background: var(--dsw-alias-settings-card-fill);
  border-radius: var(--dsw-radius-xl);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.mtt-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding: 12px 0;
  border-top: 0.5px solid var(--dsw-alias-settings-card-stroke);
}
.mtt-row:first-of-type { border-top: none; }
.mtt-row-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.mtt-label {
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
  display: flex;
  align-items: center;
  gap: 8px;
}
.mtt-name { font-weight: 500; }
.mtt-meta {
  font-family: var(--ds-font-family-code);
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  word-break: break-all;
}
.mtt-help {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.mtt-control { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }
.mtt-input {
  box-sizing: border-box;
  width: 300px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-family: var(--ds-font-family-code);
  font-size: 12px;
}
.mtt-input:disabled { opacity: 0.6; }
.mtt-toggle {
  width: 40px;
  height: 22px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  position: relative;
  cursor: pointer;
  padding: 0;
  flex: 0 0 auto;
}
.mtt-toggle[data-on='true'] { background: var(--dsw-alias-button-primary-fill); border-color: transparent; }
.mtt-toggle:disabled {
  cursor: not-allowed;
  /* A disabled control must still READ as a control. The previous opacity-only
     treatment left it white on the card fill, which users read as an empty
     placeholder rather than an unavailable switch. */
  opacity: 1;
  background: var(--dsw-alias-bg-mask-2);
  border-color: transparent;
}
.mtt-toggle:disabled .mtt-knob {
  background: var(--dsw-alias-label-tertiary);
  opacity: 0.9;
}
.mtt-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--dsw-alias-label-primary-inverted);
  transition: transform 120ms ease;
}
.mtt-toggle[data-on='true'] .mtt-knob { transform: translateX(18px); }
.mtt-badge {
  font-size: 11px;
  line-height: 16px;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-tertiary);
}
.mtt-badge-on { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-tertiary); }
.mtt-row-note {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.mtt-row-error {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-primary));
}
.mtt-row-blocker {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-primary));
}
.mtt-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-top: 8px;
}
.mtt-button {
  height: 32px;
  padding: 0 14px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-inverted);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
}
.mtt-button:disabled { opacity: 0.5; cursor: default; }
.mtt-button-small {
  height: 28px;
  padding: 0 12px;
  font-size: 12px;
}
.mtt-status { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.mtt-status-ok { color: var(--dsw-alias-label-secondary); }
.mtt-status-error { color: var(--dsw-alias-label-primary); }
`

    // The settings namespace is the plugin's ENTRY ID (the bundle patch row id);
    // a hand-written row may use the package name, so both are tried in order.
    const NAMESPACES = ['model-tools', '@try-works/dsh-model-as-tool']

    /** Global fields (per-model toggles are rendered from CATALOG). */
    const FIELDS = [
      {
        key: 'exposeUnavailable',
        kind: 'toggle',
        label: 'Expose unavailable models',
        help: 'Register a tool even when its runtime is missing, so a model turn can discover why it cannot run.',
      },
      {
        key: 'registerSkills',
        kind: 'toggle',
        label: 'Register skills',
        help: 'Publish one skill per registered tool, teaching when to use it.',
      },
      {
        key: 'registerControlTool',
        kind: 'toggle',
        label: 'Register the inspection tool',
        help: 'Expose the model_tools inspection surface to authorised native callers.',
      },
      {
        key: 'allowNpm',
        kind: 'toggle',
        label: 'Allow in-process packages',
        help: 'Resolve model packages from this installation. Turn off to force every call through the CLI or the bridge.',
      },
      {
        key: 'managedWorkers',
        kind: 'toggle',
        label: 'Managed workers',
        help: 'Run extension entries in a managed child process with a scrubbed environment.',
      },
      {
        key: 'repairAttempts',
        kind: 'number',
        label: 'Repair attempts',
        help: 'Bounded title-repair budget per call (0-8). Out-of-range values are refused, never clamped.',
      },
      {
        key: 'approvedRoots',
        kind: 'list',
        label: 'Approved roots',
        help: 'Comma-separated absolute paths file-reading tools may reach. Empty approves nothing.',
      },
      {
        key: 'models',
        kind: 'list',
        label: 'Allowlist override',
        help: 'Advanced: comma-separated model ids. Empty means every enabled model below; set only to pin an exact set.',
      },
    ]

    /** Read the value a field should display: the draft, else the saved value. */
    function fieldValue(field, value, draft) {
      if (draft[field.key] !== undefined) return draft[field.key]
      const saved = value[field.key]
      if (field.kind === 'list') return Array.isArray(saved) ? saved.join(', ') : ''
      if (field.kind === 'number') return saved === undefined || saved === null ? '' : String(saved)
      return saved === true
    }

    /** Parse one edited field back into its config representation. */
    function fieldPatch(field, text) {
      if (field.kind === 'list') {
        return text.split(',').map(part => part.trim()).filter(part => part.length > 0)
      }
      if (field.kind === 'number') return Number(text)
      return text
    }

    /** One global row: label + help on the left, the control on the right. */
    function fieldRow(field, value, draft, edit, disabled) {
      const current = fieldValue(field, value, draft)
      let control
      if (field.kind === 'toggle') {
        control = h('button', {
          type: 'button',
          className: 'mtt-toggle',
          'data-on': current === true ? 'true' : 'false',
          disabled,
          'aria-pressed': current === true,
          onClick: () => edit(field.key, !(current === true)),
        }, h('span', { className: 'mtt-knob' }))
      } else {
        control = h('input', {
          className: 'mtt-input',
          type: field.kind === 'number' ? 'number' : 'text',
          min: field.kind === 'number' ? 0 : undefined,
          max: field.kind === 'number' ? 8 : undefined,
          value: current,
          disabled,
          onChange: event => edit(field.key, event.target.value),
        })
      }
      return h('div', { className: 'mtt-row', key: field.key },
        h('div', { className: 'mtt-row-text' },
          h('span', { className: 'mtt-label' }, field.label),
          h('p', { className: 'mtt-help' }, field.help)),
        h('div', { className: 'mtt-control' }, control))
    }

    /** One model row: identity, package, size and status, with the toggle. */
    function modelRow(entry, enabled, disabled, onToggle) {
      // An extension-backed model is provided by another package; only the HOST
      // can tell whether it is installed, so the row says "extension" instead of
      // promising it runs here.
      const badge = entry.extension !== null && entry.extension !== undefined
        ? h('span', { className: 'mtt-badge' }, 'extension')
        : entry.runnable === true
          ? h('span', { className: 'mtt-badge mtt-badge-on' }, 'runnable here')
          : h('span', { className: 'mtt-badge' }, 'unavailable here')
      const source = entry.extension ?? (entry.package === null ? 'no package' : entry.package)
      return h('div', { className: 'mtt-row', key: entry.id },
        h('div', { className: 'mtt-row-text' },
          h('span', { className: 'mtt-label' },
            h('span', { className: 'mtt-name' }, entry.name),
            badge),
          h('p', { className: 'mtt-help' }, entry.summary),
          h('span', { className: 'mtt-meta' },
            entry.id,
            ' · ',
            source,
            entry.sizeMB === null ? '' : ' · ' + entry.sizeMB + ' MB',
            ' · ',
            entry.license,
            entry.extension !== null && entry.extension !== undefined
              ? ' · provided by the Tool Mode extension; install and activate it to run'
              : entry.runnable !== true && entry.reason ? ' · ' + entry.reason : '')),
        h('div', { className: 'mtt-control' },
          h('button', {
            type: 'button',
            className: 'mtt-toggle',
            'data-on': enabled ? 'true' : 'false',
            disabled: disabled,
            'aria-pressed': enabled,
            title: enabled ? 'Disable this model' : 'Enable this model',
            onClick: () => onToggle(entry.id, !enabled),
          }, h('span', { className: 'mtt-knob' }))))
    }

    /** How an in-flight Install/Enable/Disable is spelled in the card. */
    const EXTENSION_ACTION_LABELS = { install: 'Installing', prepare: 'Preparing', enable: 'Enabling', disable: 'Disabling' }

    // The extension Remote is a package-local lazy chunk (`client.model-tools.js`)
    // mounted by the wire half: it installs the generated Typert namespace on
    // ctx.remote as `modelTools`. It is optional on purpose — a host without the
    // Remote leaves the page on its config-only fallback.
    const REMOTE_CHUNK = './client.model-tools.js'

    // The namespace may arrive a moment after the page mounts (the chunk is
    // fetched, then the Remote contribution mounts). The first read retries
    // briefly, and the slot subscription below re-reads whenever the chunk's
    // mount settles, so a slow mount upgrades the card instead of stranding it.
    const REMOTE_RETRY_ATTEMPTS = 3
    const REMOTE_RETRY_DELAY_MS = 400

    /**
     * A tiny observable for the optional Remote mount.
     *
     * `apply()` cannot await the chunk before registering the Settings section:
     * on a host without the Remote the page must still render. So the mount runs
     * in the background and publishes its status here; the card subscribes and
     * re-reads when it changes.
     */
    function createRemoteSlot() {
      const listeners = new Set()
      let status = null
      return {
        get: () => status,
        set: next => {
          if (next === status) return
          status = next
          for (const listener of [...listeners]) {
            try {
              listener()
            } catch (error) {
              // A broken listener must not abort the mount or another listener.
            }
          }
        },
        subscribe: listener => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      }
    }

    /** Warn without letting a logger failure blank the page. */
    function warnClient(ctx, message) {
      try {
        if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(message)
        else if (typeof console !== 'undefined' && typeof console.warn === 'function') console.warn(message)
      } catch (error) {
        // A warning is diagnostics, never control flow.
      }
    }

    /**
     * Load the wire chunk and mount the optional `modelTools` namespace.
     *
     * Never throws into `apply`: a missing chunk (older host), a chunk that fails
     * to mount, or a host without `remote` all leave the slot unset, which is the
     * config-only fallback. The disposer is registered through ctx.effect so the
     * namespace unmounts with this plugin.
     */
    function mountExtensionRemote(ctx, slot) {
      const load = async () => {
        if (typeof require.async !== 'function') return
        const chunk = await require.async(REMOTE_CHUNK)
        if (chunk === null || chunk === undefined || typeof chunk.mount !== 'function') {
          throw new Error('the extension Remote chunk exposes no mount()')
        }
        const mounted = await chunk.mount(ctx)
        if (mounted === null || mounted === undefined) return
        if (typeof mounted.dispose === 'function') {
          ctx.effect(() => () => mounted.dispose(), 'model-tools: extension Remote')
        }
        slot.set(mounted)
      }
      load().catch(error => warnClient(ctx, 'model-tools: extension Remote unavailable: '
        + ((error && error.message) || String(error))))
    }

    /**
     * The extension Remote, when this client has one.
     *
     * The generated namespace is registered as the context service
     * `remote.modelTools`, so a direct service read is tried FIRST: the `remote`
     * service's associated-property lookup would resolve against this plugin's
     * own fiber and throw without an `inject`, while `ctx.get('remote.modelTools')`
     * reads the provided service without that requirement. The mount status is
     * still tried as a fallback (a future chunk could hand back the namespace
     * directly), and the associated `remote.modelTools` property is the last
     * route for an assembly that provides it that way. Every route is guarded so
     * absence is a value, not an exception.
     *
     * @param ctx - the client plugin context.
     * @param remoteStatus - the mounted status published by the wire chunk, or null.
     * @returns the namespace surface, or null when it is not available.
     */
    function modelToolsRemote(ctx, remoteStatus) {
      const usable = namespace => namespace !== null && namespace !== undefined
        && typeof namespace.describe === 'function'
      const routes = [() => ctx.get('remote.modelTools')]
      if (remoteStatus !== null && remoteStatus !== undefined) {
        routes.push(() => remoteStatus.remote.modelTools)
        routes.push(() => remoteStatus.modelTools)
      }
      routes.push(() => {
        const remote = ctx.get('remote')
        return remote === null || remote === undefined ? null : remote.modelTools
      })
      for (const route of routes) {
        try {
          const namespace = route()
          if (usable(namespace)) return namespace
        } catch (error) {
          // Try the next route: an undeclared associated namespace throws.
        }
      }
      return null
    }

    /**
     * The install operation on the wire namespace.
     *
     * The verb is `installExtension`, not `install`: the harness gateway's
     * RemoteNamespaceService owns a private `install`, and a colliding descriptor
     * is refused at mount. The host-side service keeps the raw name `install`;
     * this helper tolerates either spelling so a wire rename cannot blank the UI.
     *
     * @param namespace - the modelTools namespace.
     * @returns the method to call, or null when the host exposes neither.
     */
    function extensionInstallMethod(namespace) {
      if (namespace === null || namespace === undefined) return null
      if (typeof namespace.installExtension === 'function') return namespace.installExtension
      if (typeof namespace.install === 'function') return namespace.install
      return null
    }

    /**
     * The host's error text, without inventing one.
     *
     * @param error - a RemoteResult error, an Error, or a string.
     * @returns the message to show; never empty.
     */
    function remoteErrorText(error) {
      if (typeof error === 'string' && error.length > 0) return error
      if (error !== null && typeof error === 'object'
        && typeof error.message === 'string' && error.message.length > 0) return error.message
      return 'The host did not explain the failure.'
    }

    /**
     * Read a generated Remote method's answer.
     *
     * A generated Typert Remote method resolves a RemoteResult
     * (`{ ok: true, value }` / `{ ok: false, error }`); the host service itself
     * resolves the plain value. Both shapes are accepted so a hand-authored wire
     * artifact and a generated one behave the same here, and a refusal becomes a
     * thrown error carrying the host's own message.
     *
     * @param result - the method's resolved value.
     * @returns the value.
     */
    function unwrapRemoteResult(result) {
      if (result !== null && typeof result === 'object' && typeof result.ok === 'boolean') {
        if (result.ok !== true) throw new Error(remoteErrorText(result.error))
        return result.value
      }
      return result
    }

    /**
     * Narrow an ExtensionsDescribeResult. A malformed answer is an error, not an
     * empty list: rendering "not installed" from a broken state read would be a
     * guess, and a guess about installed state is exactly what this page must not
     * make.
     *
     * @param value - the value describe() resolved.
     * @returns { store, writable, extensions }.
     */
    function normalizeDescribe(value) {
      if (value === null || typeof value !== 'object') {
        throw new Error('The host returned no extension state.')
      }
      if (!Array.isArray(value.extensions)) {
        throw new Error('The host returned an extension state without its extension list.')
      }
      const extensions = value.extensions.filter(row => row !== null && typeof row === 'object'
        && typeof row.id === 'string' && row.id.length > 0)
      return {
        store: typeof value.store === 'string' && value.store.length > 0 ? value.store : null,
        writable: value.writable === true,
        extensions,
      }
    }

    /** Read one extension state snapshot, unwrapping the Remote result. */
    async function describeExtensions(namespace) {
      return normalizeDescribe(unwrapRemoteResult(await namespace.describe()))
    }

    /**
     * Find one shipped extension in a describe() snapshot. The host may key a row
     * by the extension id or by its package name, so both are compared.
     *
     * @param extension - the generated EXTENSIONS entry.
     * @param states - the describe() rows.
     * @returns the matching state, or null when the host did not report it.
     */
    function findExtensionState(extension, states) {
      for (let index = 0; index < states.length; index += 1) {
        const state = states[index]
        if (state.id === extension.id) return state
        if (typeof extension.package === 'string' && state.id === extension.package) return state
        if (typeof state.package === 'string' && state.package === extension.id) return state
        if (typeof state.package === 'string' && typeof extension.package === 'string'
          && state.package === extension.package) return state
      }
      return null
    }

    /**
     * The Config.disabledExtensions list after one Enable/Disable action.
     *
     * Two durable sources describe "disabled": the SDK lifecycle that
     * enable/disable change, and this config list, which the plugin's restore
     * filter checks on the next load. The Remote UI writes the lifecycle, so it
     * must dual-write this list too — otherwise a restart can undo the user's
     * choice in the other direction (the example that motivated this: Enable
     * succeeds, the list still names the id, and the next restore re-disables it).
     *
     * @param list - the saved disabledExtensions list (any value, tolerated).
     * @param id - the extension id being enabled/disabled.
     * @param action - 'enable' removes the id; anything else ('disable') adds it.
     * @returns the sorted next list, with non-string entries dropped.
     */
    function nextDisabledExtensions(list, id, action) {
      const next = new Set(Array.isArray(list)
        ? list.filter(entry => typeof entry === 'string' && entry.length > 0)
        : [])
      if (action === 'disable') next.add(id)
      else next.delete(id)
      return [...next].sort()
    }

    /** The state badge: installed/active are the host's words, not a guess. */
    function extensionBadge(state) {
      if (state === null) return h('span', { className: 'mtt-badge' }, 'not reported')
      if (state.installed !== true) return h('span', { className: 'mtt-badge' }, 'not installed')
      return state.active === true
        ? h('span', { className: 'mtt-badge mtt-badge-on' }, 'active')
        : h('span', { className: 'mtt-badge' }, 'inactive')
    }

    /** The parts of one extension row shared by both flows: name, tools, models. */
    function extensionParts(entry) {
      const parts = []
      if (entry.tools.length > 0) parts.push('tools: ' + entry.tools.join(', '))
      if (entry.contracts.length > 0) parts.push('contracts: ' + entry.contracts.join(', '))
      if (entry.models.length > 0) parts.push('models: ' + entry.models.join(', '))
      return parts
    }

    /**
     * The requirements a describe() row reports, when the host checked them.
     *
     * A legacy host (older wire/host) has no `requirements` field, and [] then
     * means "the host did not check" — never "everything is satisfied". Malformed
     * entries are dropped rather than rendered as facts.
     */
    function extensionRequirements(state) {
      if (state === null || !Array.isArray(state.requirements)) return []
      return state.requirements.filter(requirement => requirement !== null && typeof requirement === 'object'
        && typeof requirement.kind === 'string' && typeof requirement.satisfied === 'boolean')
    }

    /** Unmet requirements, preserving the host's order. */
    function unmetExtensionRequirements(state) {
      return extensionRequirements(state).filter(requirement => requirement.satisfied !== true)
    }

    /** A compact disclosure of what the host checked and satisfied. */
    function extensionRequirementSummary(state) {
      const satisfied = extensionRequirements(state).filter(requirement => requirement.satisfied === true)
      if (satisfied.length === 0) return null
      return 'Requirements checked: ' + satisfied.map(requirement => requirement.kind + ' ✓').join(' · ')
    }

    /**
     * The one hint an unmet requirement carries, derived from `action` — never
     * from the message text, because the host may reword its reasons. Assets and
     * executable requirements get no hint: the Prepare control is their fix.
     *
     * @param requirement - one unmet ExtensionRequirement.
     * @returns a hint line, or null when the row's controls say it.
     */
    function requirementHint(requirement) {
      if (requirement.kind === 'assets' || requirement.kind === 'executable') return null
      if (requirement.action === 'config') return 'Configure the deployment to satisfy this requirement.'
      if (requirement.action === 'none') return 'This requirement cannot be fixed from this page.'
      if (requirement.action === 'install') return 'Install the extension to satisfy this requirement.'
      return null
    }

    /**
     * What a row's controls may do, keyed ONLY on requirement kind/action/satisfied
     * and the host's `blocked` flag.
     *
     * Absent fields mean a legacy host: no requirements, `blocked` false, actions
     * enabled exactly as before. Harness-model/platform/integrity/activation
     * blockers disable Enable; assets/executable disable Enable but keep Prepare
     * (the fix); store/source disable Install.
     *
     * @param state - the describe() row, or null.
     * @returns { blocked, unmet, enableBlocked, installBlocked, prepareNeeded }.
     */
    function extensionRequirementControls(state) {
      const installed = state !== null && state.installed === true
      const blocked = state !== null && state.blocked === true
      const unmet = unmetExtensionRequirements(state)
      return {
        blocked,
        unmet,
        enableBlocked: installed && blocked,
        installBlocked: unmet.some(requirement => requirement.kind === 'store' || requirement.kind === 'source'),
        prepareNeeded: installed && unmet.some(requirement => requirement.kind === 'assets'
          || requirement.kind === 'executable'),
      }
    }

    /**
     * Whether a describe() row says the extension's model assets must be
     * prepared before activation.
     *
     * On a current host this is decided ONLY by the requirements array (an unmet
     * assets/executable entry). A legacy host carries no requirements, so its
     * reason text is the only signal — and it only decides whether the Prepare
     * control is offered; the host's text is never rewritten.
     *
     * @param state - the describe() row, or null.
     * @returns true when the host names preparation as the blocker.
     */
    function extensionNeedsPreparation(state) {
      if (state === null || state.installed !== true) return false
      if (Array.isArray(state.requirements)) return extensionRequirementControls(state).prepareNeeded
      if (typeof state.reason !== 'string' || state.reason.length === 0) return false
      const reason = state.reason.toLowerCase()
      return reason.includes('needs its model assets prepared')
        || reason.includes('needs preparation')
        || reason.includes('run prepare for this extension')
        || reason.includes('then prepare again')
    }

    /**
     * What to show after a prepare() call.
     *
     * `prepare` reports acquisition failures IN BAND (`ok: true` with
     * `prepared: false` and a reason), and RES-02 executable approval refusals
     * arrive the same way, so the refusal text is returned verbatim and never
     * replaced with a success claim. A successful call renders the disclosure the
     * host returned (plan bytes/license) rather than a bare "done".
     *
     * @param result - the ExtensionPrepareResult.
     * @returns one operator-facing note.
     */
    function prepareResultNote(result) {
      if (result === null || result === undefined || typeof result !== 'object') {
        return 'The host returned no preparation state.'
      }
      if (result.prepared !== true) {
        return typeof result.reason === 'string' && result.reason.length > 0
          ? result.reason
          : 'The host reported the preparation did not complete.'
      }
      const plan = result.plan !== null && typeof result.plan === 'object' ? result.plan : null
      let text
      if (plan === null) {
        text = 'The host reported the model assets prepared.'
      } else {
        text = 'Prepared ' + (typeof plan.modelId === 'string' ? plan.modelId : 'the model assets')
        if (typeof plan.totalBytes === 'number' && typeof plan.storageBytes === 'number') {
          text += ' — ' + plan.totalBytes + ' bytes download, ' + plan.storageBytes + ' retained'
        }
        if (plan.license !== null && typeof plan.license === 'object'
          && typeof plan.license.name === 'string' && plan.license.name.length > 0) {
          text += ' · license: ' + plan.license.name
        }
      }
      if (result.activationReady === false) {
        text += ' (activation still has remaining blockers; see the row reason)'
      }
      return text
    }

    /**
     * The config-only row: the switch records a `disabledExtensions` preference
     * and cannot observe or change the store. Used when the Remote is absent.
     */
    function extensionFallbackRow(entry, enabled, disabled, onToggle) {
      const parts = extensionParts(entry)
      return h('div', { className: 'mtt-row', key: entry.id },
        h('div', { className: 'mtt-row-text' },
          h('span', { className: 'mtt-label' },
            h('span', { className: 'mtt-name' }, entry.name),
            h('span', { className: 'mtt-badge' }, 'extension')),
          h('p', { className: 'mtt-help' }, entry.summary),
          h('span', { className: 'mtt-meta' },
            entry.id,
            parts.length > 0 ? ' · ' + parts.join(' · ') : '',
            ' · ',
            entry.license ?? 'no license')),
        h('div', { className: 'mtt-control' },
          h('button', {
            type: 'button',
            className: 'mtt-toggle',
            'data-on': enabled ? 'true' : 'false',
            disabled: disabled,
            'aria-pressed': enabled,
            title: enabled ? 'Disable this extension' : 'Enable this extension',
            onClick: () => onToggle(entry.id, !enabled),
          }, h('span', { className: 'mtt-knob' }))))
    }

    /**
     * The store-backed row: Install when absent, Enable/Disable when installed.
     *
     * Nothing here is optimistic. `state` comes from the last describe(), the
     * toggle reflects `active` from that snapshot, and a failed action leaves the
     * host's error text on the row rather than flipping a switch that did not move.
     *
     * @param entry - the generated extension entry.
     * @param state - the describe() row for it, or null when not reported.
     * @param ui - { writable, canInstall, listed, busy, pending, error, prepareNote, onAction }.
     */
    function extensionRemoteRow(entry, state, ui) {
      const installed = state !== null && state.installed === true
      const active = installed && state.active === true
      const pending = ui.pending !== null && ui.pending.id === entry.id ? ui.pending.action : null
      const requirementControls = extensionRequirementControls(state)
      const needsPreparation = extensionNeedsPreparation(state)
      const parts = extensionParts(entry)
      if (state !== null && typeof state.version === 'string' && state.version.length > 0) {
        parts.push('installed v' + state.version)
      }
      if (installed && state.disabled === true) parts.push('disabled in config')

      // Note kinds: 'note' is muted disclosure, 'blocker' is an unmet requirement
      // (prominent), 'error' is the last action's failure. Keeping the kind per
      // note means the class never depends on an array position.
      const notes = []
      const addNote = (text, kind) => {
        if (typeof text === 'string' && text.length > 0) notes.push({ text, kind: kind ?? 'note' })
      }
      const summary = extensionRequirementSummary(state)
      if (summary !== null) addNote(summary)
      if (state === null) {
        addNote('The extension store did not report this package. Installing asks the host for it, and any refusal is shown here.')
      }
      // The host's reason is rendered VERBATIM: it is the authoritative
      // explanation. On a blocked row it is that row's headline, so it is
      // prominent instead of muted.
      if (state !== null && typeof state.reason === 'string' && state.reason.length > 0) {
        addNote(state.reason, requirementControls.blocked ? 'blocker' : 'note')
      }
      if (ui.prepareNote !== null && ui.prepareNote !== undefined && ui.prepareNote.id === entry.id) {
        addNote(ui.prepareNote.text)
      }
      // Every unmet requirement gets its exact reason on the row. A requirement
      // whose reason is the row reason already is not repeated; the hint comes
      // from `action` only, never from the wording.
      if (state !== null && Array.isArray(state.requirements)) {
        for (const requirement of requirementControls.unmet) {
          if (requirement.reason !== state.reason) addNote(requirement.reason, 'blocker')
          addNote(requirementHint(requirement))
        }
        if (requirementControls.blocked && requirementControls.unmet.length === 0 && state.reason === null) {
          addNote('The host reports this extension blocked but named no requirement; see the dsh logs.', 'blocker')
        }
      }
      if (state !== null && state.integrity === 'changed') {
        addNote('The installed content changed since it was recorded; reinstall before enabling it.')
      }
      // The store and the config list must agree across a restart. Rendering both
      // is what lets the operator fix a disagreement with one toggle instead of
      // discovering it after the next restore.
      if (installed && active && ui.listed) {
        addNote('The config list still names this extension; it will be disabled on restart.')
      }
      if (installed && !active && !ui.listed) {
        addNote('The config list does not name this extension; it will not block a restore.')
      }
      if (!installed && !ui.canInstall) {
        addNote('This host exposes extension state but not the install action; install it through the extension store.')
      }
      if (ui.error !== null && ui.error.id === entry.id) addNote(ui.error.text, 'error')

      const canInstall = ui.canInstall
      const control = installed
        ? h('button', {
          type: 'button',
          className: 'mtt-toggle',
          'data-on': active ? 'true' : 'false',
          disabled: ui.busy || !ui.writable || requirementControls.enableBlocked,
          'aria-pressed': active,
          'aria-busy': pending !== null,
          title: requirementControls.enableBlocked
            ? 'Enable is blocked by a host requirement; see the row reason'
            : active ? 'Disable this extension' : 'Enable this extension',
          onClick: () => ui.onAction(entry.id, active ? 'disable' : 'enable'),
        }, h('span', { className: 'mtt-knob' }))
        : h('button', {
          type: 'button',
          className: 'mtt-button mtt-button-small',
          disabled: ui.busy || !ui.writable || !canInstall || requirementControls.installBlocked,
          'aria-busy': pending === 'install',
          title: !canInstall
            ? 'This host does not expose the extension install action'
            : requirementControls.installBlocked
              ? 'Install is blocked by a host requirement; see the row reason'
              : state === null ? 'Ask the host to install this extension' : 'Install this extension',
          onClick: () => ui.onAction(entry.id, 'install'),
        }, pending === 'install' ? 'Installing…' : 'Install')

      return h('div', { className: 'mtt-row', key: entry.id },
        h('div', { className: 'mtt-row-text' },
          h('span', { className: 'mtt-label' },
            h('span', { className: 'mtt-name' }, entry.name),
            extensionBadge(state)),
          h('p', { className: 'mtt-help' }, entry.summary),
          h('span', { className: 'mtt-meta' },
            entry.id,
            parts.length > 0 ? ' · ' + parts.join(' · ') : '',
            ' · ',
            entry.license ?? 'no license'),
          notes.map((note, index) => h('p', {
            className: note.kind === 'error'
              ? 'mtt-row-error'
              : note.kind === 'blocker' ? 'mtt-row-blocker' : 'mtt-row-note',
            key: 'note-' + index,
          }, note.text))),
        h('div', { className: 'mtt-control' },
          control,
          // Preparation is offered only when the HOST names it as the blocker (or
          // an unmet assets/executable requirement names it); it is not a second
          // way to force activation. After a successful prepare the row's
          // requirements change and this control disappears.
          needsPreparation
            ? h('button', {
              type: 'button',
              className: 'mtt-button mtt-button-small',
              disabled: ui.busy || !ui.writable,
              'aria-busy': pending === 'prepare',
              title: 'Prepare the model assets this extension needs before it can be enabled',
              onClick: () => ui.onAction(entry.id, 'prepare'),
            }, pending === 'prepare' ? 'Preparing…' : 'Prepare')
            : null))
    }

    function ModelToolsSettings({ form, ctx, remoteSlot }) {
      const [snap, setSnap] = React.useState(() => form.getSnapshot())
      const [draft, setDraft] = React.useState({})
      const [exclude, setExclude] = React.useState(null)
      const [disabledExt, setDisabledExt] = React.useState(null)
      const [status, setStatus] = React.useState(null)
      // Extension state is the HOST's answer, read from ctx.remote.modelTools.
      // `kind` is loading | ready | absent | error; it starts loading so the card
      // never renders a guessed installed/active state before the first read.
      const [extRemote, setExtRemote] = React.useState({ kind: 'loading' })
      const [extPending, setExtPending] = React.useState(null)
      const [extRowError, setExtRowError] = React.useState(null)
      // Non-fatal: activation succeeded but the config-list dual-write did not.
      // The action is never rolled back for this; the note tells the operator the
      // two stores can disagree until the list is saved manually.
      const [extConfigNote, setExtConfigNote] = React.useState(null)
      // The last prepare() disclosure/refusal, per row. It is rendered beside the
      // host's reason so a RES-02 refusal or plan is shown verbatim.
      const [extPrepareNote, setExtPrepareNote] = React.useState(null)

      /** This mount's namespace status, or null when the wire chunk is absent. */
      const mounted = () => (remoteSlot === null || remoteSlot === undefined ? null : remoteSlot.get())

      React.useEffect(() => form.subscribe(() => setSnap(form.getSnapshot())), [form])

      // Read the extension state on mount. The namespace may arrive after this
      // page (the wire chunk is fetched first), so an absent namespace is retried
      // briefly AND the chunk's slot subscription re-reads when the mount settles.
      // `alive` keeps a late answer from writing into an unmounted page.
      React.useEffect(() => {
        let alive = true
        let timer = null
        let attempts = 0
        const adopt = namespace => {
          describeExtensions(namespace).then(described => {
            if (alive) setExtRemote({ kind: 'ready', namespace, ...described })
          }, error => {
            if (alive) setExtRemote({ kind: 'error', text: remoteErrorText(error) })
          })
        }
        const read = () => {
          const namespace = modelToolsRemote(ctx, mounted())
          if (namespace !== null) {
            adopt(namespace)
            return
          }
          if (attempts >= REMOTE_RETRY_ATTEMPTS) {
            if (alive) setExtRemote({ kind: 'absent' })
            return
          }
          attempts += 1
          timer = setTimeout(read, REMOTE_RETRY_DELAY_MS)
        }
        read()
        const unsubscribe = remoteSlot !== null && remoteSlot !== undefined
          && typeof remoteSlot.subscribe === 'function'
          ? remoteSlot.subscribe(() => {
            if (!alive) return
            const namespace = modelToolsRemote(ctx, mounted())
            if (namespace !== null) adopt(namespace)
          })
          : null
        return () => {
          alive = false
          if (unsubscribe !== null) unsubscribe()
          if (timer !== null) clearTimeout(timer)
        }
      }, [ctx])

      if (snap.status === 'unavailable') {
        return h('div', { className: 'mtt-page' },
          h('style', null, CSS),
          h('h2', { className: 'mtt-title' }, 'Model as Tool'),
          h('p', { className: 'mtt-intro' },
            'The model-tools configuration namespace is not exposed to this client. '
            + 'Edit the profile cordis.patch.yml entry with id "model-tools" instead.'))
      }

      const value = snap.value || {}
      const disabled = snap.writable === false
      const edit = (key, next) => setDraft(previous => {
        const updated = { ...previous }
        updated[key] = next
        return updated
      })

      const savedExclude = Array.isArray(value.exclude) ? value.exclude : []
      const currentExclude = exclude ?? savedExclude
      const allowlist = Array.isArray(value.models) ? value.models : []

      /** Whether a model is exposed: not excluded (and inside the allowlist when one is set). */
      function isEnabled(id) {
        if (currentExclude.includes(id)) return false
        return allowlist.length === 0 || allowlist.includes(id)
      }

      const dirty = FIELDS.some(field => draft[field.key] !== undefined) || exclude !== null || disabledExt !== null

      const save = async () => {
        setStatus({ kind: 'busy', text: 'Saving…' })
        try {
          let refused = false
          for (const field of FIELDS) {
            if (draft[field.key] === undefined) continue
            const accepted = await form.set(field.key, fieldPatch(field, draft[field.key]))
            if (accepted === false) refused = true
          }
          if (exclude !== null) {
            const accepted = await form.set('exclude', exclude)
            if (accepted === false) refused = true
          }
          if (disabledExt !== null) {
            const accepted = await form.set('disabledExtensions', disabledExt)
            if (accepted === false) refused = true
          }
          setDraft({})
          setExclude(null)
          setDisabledExt(null)
          setStatus(refused
            ? { kind: 'error', text: 'Refused by the host — see the dsh logs.' }
            : { kind: 'ok', text: 'Saved. Changes apply to new sessions.' })
        } catch (error) {
          setStatus({ kind: 'error', text: String((error && error.message) || error) })
        }
      }

      const savedDisabledExt = Array.isArray(value.disabledExtensions) ? value.disabledExtensions : []
      const currentDisabledExt = disabledExt ?? savedDisabledExt
      const isExtensionEnabled = id => !currentDisabledExt.includes(id)
      const toggleExtension = (id, on) => setDisabledExt(() => {
        const next = new Set(currentDisabledExt)
        if (on) next.delete(id)
        else next.add(id)
        return [...next].sort()
      })

      const toggleModel = (id, on) => setExclude(() => {
        const next = new Set(currentExclude)
        if (on) next.delete(id)
        else next.add(id)
        return [...next].sort()
      })

      /**
       * Best-effort write of Config.disabledExtensions after a lifecycle
       * enable/disable. Activation is the authority: a refusal here is reported
       * as a NON-FATAL note and never undoes or hides the activation.
       *
       * The list is read from the form's CURRENT snapshot (another tab or the
       * Save button may have changed it since this render), falling back to the
       * render's saved value.
       */
      const dualWriteDisabledExtensions = async (id, action) => {
        const snapshot = form.getSnapshot()
        const snapshotValue = snapshot && snapshot.value !== null && typeof snapshot.value === 'object'
          ? snapshot.value
          : {}
        const saved = Array.isArray(snapshotValue.disabledExtensions)
          ? snapshotValue.disabledExtensions
          : savedDisabledExt
        const nextList = nextDisabledExtensions(saved, id, action)
        const unchanged = Array.isArray(saved) && nextList.length === saved.length
          && nextList.every((entry, index) => entry === saved[index])
        if (unchanged) return
        const what = action === 'disable' ? 'disabled' : 'enabled'
        try {
          const accepted = await form.set('disabledExtensions', nextList)
          if (accepted === false) {
            setExtConfigNote('The extension was ' + what + ', but the host refused the disabledExtensions update; '
              + 'the config list can disagree with the store until it is saved manually.')
          }
        } catch (error) {
          setExtConfigNote('The extension was ' + what + ', but the config list update failed: '
            + remoteErrorText(error))
        }
      }

      /** Read the host state once, after a manual "Try again". */
      const recheckExtensions = async () => {
        setExtRowError(null)
        setExtConfigNote(null)
        setExtPrepareNote(null)
        setExtRemote({ kind: 'loading' })
        const namespace = modelToolsRemote(ctx, mounted())
        if (namespace === null) {
          setExtRemote({ kind: 'absent' })
          return
        }
        try {
          setExtRemote({ kind: 'ready', namespace, ...(await describeExtensions(namespace)) })
        } catch (error) {
          setExtRemote({ kind: 'error', text: remoteErrorText(error) })
        }
      }

      /**
       * Run one extension action, then RE-READ the host state.
       *
       * The host is the authority: a successful install is not activation, and
       * enable/disable may be refused for reasons only describe() can explain.
       * The re-read is what moves the controls; the action result is never
       * painted as a state change by itself.
       */
      const runExtensionAction = async (id, action) => {
        setExtRowError(null)
        setExtConfigNote(null)
        setExtPrepareNote(null)
        setExtPending({ id, action })
        try {
          const namespace = modelToolsRemote(ctx, mounted())
          if (namespace === null) {
            setExtRemote({ kind: 'absent' })
            return
          }
          if (action === 'install') {
            const install = extensionInstallMethod(namespace)
            if (install === null) throw new Error('This host does not expose the extension install action.')
            // The wire descriptor is installExtension(id, source): Typert counts
            // business arguments exactly, and an omitted `source` still occupies
            // its positional slot. Passing only the id is refused by the gateway
            // ("expected 2 business argument(s) ... got 1"), so pass undefined to
            // mean "use the configured first-party source".
            unwrapRemoteResult(await install.call(namespace, id, undefined))
          } else if (action === 'prepare') {
            if (typeof namespace.prepare !== 'function') {
              throw new Error('This host does not expose the extension prepare action.')
            }
            // prepare(id) has no optional data argument; an AbortSignal may ride
            // as the second wire slot, which this page does not need.
            const prepared = unwrapRemoteResult(await namespace.prepare(id))
            setExtPrepareNote({ id, text: prepareResultNote(prepared) })
          } else if (action === 'enable') {
            unwrapRemoteResult(await namespace.enable(id))
            // Dual-write Config.disabledExtensions so a restart cannot re-disable
            // what the operator just enabled. Best-effort and non-fatal.
            await dualWriteDisabledExtensions(id, 'enable')
          } else {
            unwrapRemoteResult(await namespace.disable(id))
            await dualWriteDisabledExtensions(id, 'disable')
          }
          setExtRemote({ kind: 'ready', namespace, ...(await describeExtensions(namespace)) })
        } catch (error) {
          setExtRowError({ id, text: remoteErrorText(error) })
          // The action may have changed host state before failing. Read it back,
          // but keep the action's error text if the re-read fails as well.
          try {
            const namespace = modelToolsRemote(ctx, mounted())
            if (namespace !== null) {
              setExtRemote({ kind: 'ready', namespace, ...(await describeExtensions(namespace)) })
            }
          } catch (readError) {
            // The row keeps the host's action error; the state stays the last
            // snapshot describe() gave us, which is still the last known truth.
          }
        } finally {
          setExtPending(null)
        }
      }

      const runnable = CATALOG.filter(entry => entry.runnable === true)
      const unavailable = CATALOG.filter(entry => entry.runnable !== true)

      const extPendingEntry = extPending === null
        ? null
        : EXTENSIONS.find(entry => entry.id === extPending.id) ?? { name: extPending.id }
      const extPendingText = extPending === null
        ? null
        : (EXTENSION_ACTION_LABELS[extPending.action] ?? 'Working on') + ' ' + extPendingEntry.name + '…'
      const extWritable = extRemote.kind === 'ready' && extRemote.writable === true
      const extBusy = extPending !== null

      let extensionCard
      if (extRemote.kind === 'ready') {
        const notes = []
        if (extRemote.store === null) {
          notes.push('No extension store is configured on this host (extensionStore), so an extension cannot be installed or activated here.')
        } else if (!extRemote.writable) {
          notes.push('The host reports its extension store as read-only right now; the extension controls are disabled.')
        }
        const canInstall = extensionInstallMethod(extRemote.namespace) !== null
        extensionCard = h('div', { className: 'mtt-card' },
          h('p', { className: 'mtt-help' },
            'Tool Mode extensions shipped with this plugin. The host\'s extension store is the authority: '
            + 'Install copies a package into the store, then the switch activates it. Installation is not activation.'),
          notes.map((note, index) => h('p', { className: 'mtt-row-note', key: 'store-note-' + index }, note)),
          extPendingText === null ? null : h('p', { className: 'mtt-status' }, extPendingText),
          extConfigNote === null ? null : h('p', { className: 'mtt-row-note' }, extConfigNote),
          EXTENSIONS.map(entry => extensionRemoteRow(
            entry,
            findExtensionState(entry, extRemote.extensions),
            {
              writable: extWritable,
              canInstall,
              // The SAVED config list, not the fallback draft: the row describes
              // what a restart will actually read, and the dual-write compares
              // against the same saved value.
              listed: savedDisabledExt.includes(entry.id),
              busy: extBusy,
              pending: extPending,
              error: extRowError,
              prepareNote: extPrepareNote,
              onAction: runExtensionAction,
            })))
      } else if (extRemote.kind === 'error') {
        extensionCard = h('div', { className: 'mtt-card' },
          h('p', { className: 'mtt-help' },
            'The host exposes extension controls, but reading their state failed.'),
          h('p', { className: 'mtt-row-error' }, extRemote.text),
          h('div', { className: 'mtt-actions' },
            h('button', {
              type: 'button',
              className: 'mtt-button mtt-button-small',
              onClick: recheckExtensions,
            }, 'Try again')))
      } else if (extRemote.kind === 'absent') {
        extensionCard = h('div', { className: 'mtt-card' },
          h('p', { className: 'mtt-help' },
            'Tool Mode extensions shipped with this plugin. The host\'s extension controls are not available to '
            + 'this page (an older host build, or the extension Remote is not mounted), so this page cannot install, '
            + 'verify, or observe them.'),
          h('p', { className: 'mtt-row-note' },
            'The switches below only record a disabledExtensions preference for the next load: they neither install '
            + 'nor verify the package.'),
          EXTENSIONS.map(entry => extensionFallbackRow(entry, isExtensionEnabled(entry.id), disabled, toggleExtension)),
          h('div', { className: 'mtt-actions' },
            h('button', {
              type: 'button',
              className: 'mtt-button mtt-button-small',
              onClick: recheckExtensions,
            }, 'Recheck')))
      } else {
        extensionCard = h('div', { className: 'mtt-card' },
          h('p', { className: 'mtt-help' }, 'Reading the extension state from the host…'))
      }

      return h('div', { className: 'mtt-page' },
        h('style', null, CSS),
        h('h2', { className: 'mtt-title' }, 'Model as Tool'),
        h('p', { className: 'mtt-intro' },
          'On-device models from the Desert Ant catalog, exposed as tools and skills. A model becomes a tool only when this '
          + 'process can actually run it; extension-backed models are listed with the extension that provides them.'),
        h('div', { className: 'mtt-card' },
          h('p', { className: 'mtt-help' },
            runnable.length + ' of ' + CATALOG.length + ' catalog models are runnable in this process. '
            + 'Unavailable models are listed with the reason they cannot run here.'),
          runnable.map(entry => modelRow(entry, isEnabled(entry.id), disabled, toggleModel)),
          unavailable.map(entry => modelRow(entry, false, disabled, toggleModel))),
        EXTENSIONS.length === 0 ? null : extensionCard,
        h('div', { className: 'mtt-card' }, FIELDS.map(field => fieldRow(field, value, draft, edit, disabled))),
        h('div', { className: 'mtt-actions' },
          h('button', {
            type: 'button', className: 'mtt-button', disabled: disabled || !dirty || status?.kind === 'busy', onClick: save,
          }, 'Save'),
          status ? h('span', { className: 'mtt-status mtt-status-' + status.kind }, status.text) : null,
          disabled
            ? h('span', { className: 'mtt-status' }, 'Read-only: connected from a remote browser.')
            : null),
        h('p', { className: 'mtt-help' },
          'Per-model toggles write the exclude list; the allowlist override pins an exact set. Credentials, the '
          + 'bridge endpoint, the extension store and the headless MCP listener live in the profile cordis.patch.yml '
          + 'row (id "model-tools"), where the launcher and doctor read them.'))
    }

    function apply(ctx) {
      // The extension Remote is optional. Mount it in the BACKGROUND (never await
      // it before registering this section): on a host without it the page must
      // still render its config-only fallback. The slot's subscription upgrades
      // the card when the mount settles.
      const remoteSlot = createRemoteSlot()
      mountExtensionRemote(ctx, remoteSlot)

      const forms = NAMESPACES.map(namespace => ctx.configForms.get(namespace))
      const served = () => forms.find(candidate => {
        const snap = candidate.getSnapshot()
        return snap.status === 'ready' || snap.value !== undefined
      })
      // Fall back to the first candidate so the page still renders its explanatory copy.
      const form = {
        getSnapshot: () => (served() ?? forms[0]).getSnapshot(),
        subscribe: listener => {
          const disposers = forms.map(candidate => candidate.subscribe(listener))
          return () => { for (const dispose of disposers) dispose() }
        },
        set: (field, value) => (served() ?? forms[0]).set(field, value),
      }

      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'model-tools',
        // After the shipped sections (general 0, models 10, plugins 15, agent-presets 20).
        order: 65,
        label: 'Model as Tool',
      }, () => h(ModelToolsSettings, { form, ctx, remoteSlot }))))
    }

    exports.name = 'model-tools'
    // 'remote' is deliberately NOT injected: the mount above is optional and
    // reaches the namespace through a guarded context read, so a host that does
    // not mount it can only fall back to the config-only switches. A required
    // 'remote' / 'remote.modelTools' would park this Settings page instead.
    exports.inject = ['slots', 'configForms']
    exports.apply = apply
    exports.__internals = {
      NAMESPACES,
      FIELDS,
      CATALOG,
      fieldValue,
      fieldPatch,
      createRemoteSlot,
      modelToolsRemote,
      extensionInstallMethod,
      remoteErrorText,
      unwrapRemoteResult,
      normalizeDescribe,
      describeExtensions,
      findExtensionState,
      nextDisabledExtensions,
      extensionRequirements,
      unmetExtensionRequirements,
      extensionRequirementSummary,
      requirementHint,
      extensionRequirementControls,
      extensionNeedsPreparation,
      prepareResultNote,
    }
    return module.exports
  },
})
