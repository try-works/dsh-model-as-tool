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
     * contracts }. These are installed and activated through the extension
     * store, so the page lists them as provided-but-not-observable here rather
     * than inventing an installed/uninstalled state.
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

    /** One extension row: identity, tools, models and the store-owned state. */
    function extensionRow(entry) {
      const parts = []
      if (entry.tools.length > 0) parts.push('tools: ' + entry.tools.join(', '))
      if (entry.contracts.length > 0) parts.push('contracts: ' + entry.contracts.join(', '))
      if (entry.models.length > 0) parts.push('models: ' + entry.models.join(', '))
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
            entry.license ?? 'no license')))
    }

    function ModelToolsSettings({ form }) {
      const [snap, setSnap] = React.useState(() => form.getSnapshot())
      const [draft, setDraft] = React.useState({})
      const [exclude, setExclude] = React.useState(null)
      const [status, setStatus] = React.useState(null)

      React.useEffect(() => form.subscribe(() => setSnap(form.getSnapshot())), [form])

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

      const dirty = FIELDS.some(field => draft[field.key] !== undefined) || exclude !== null

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
          setDraft({})
          setExclude(null)
          setStatus(refused
            ? { kind: 'error', text: 'Refused by the host — see the dsh logs.' }
            : { kind: 'ok', text: 'Saved. Changes apply to new sessions.' })
        } catch (error) {
          setStatus({ kind: 'error', text: String((error && error.message) || error) })
        }
      }

      const toggleModel = (id, on) => setExclude(() => {
        const next = new Set(currentExclude)
        if (on) next.delete(id)
        else next.add(id)
        return [...next].sort()
      })

      const runnable = CATALOG.filter(entry => entry.runnable === true)
      const unavailable = CATALOG.filter(entry => entry.runnable !== true)

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
        EXTENSIONS.length === 0 ? null : h('div', { className: 'mtt-card' },
          h('p', { className: 'mtt-help' },
            'Tool Mode extensions shipped with this plugin. They register their tools when the extension store '
            + 'installs and activates them; this page cannot observe that state.'),
          EXTENSIONS.map(extensionRow)),
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
      }, () => h(ModelToolsSettings, { form }))))
    }

    exports.name = 'model-tools'
    exports.inject = ['slots', 'configForms']
    exports.apply = apply
    exports.__internals = { NAMESPACES, FIELDS, CATALOG, fieldValue, fieldPatch }
    return module.exports
  },
})
