# Extension matrix

- profile base URL: `http://127.0.0.1:3097`
- generated: 2026-10-18T22:39:17.257Z
- exit: 1

| extension | status | duration | blocker / detail |
| --- | --- | --- | --- |
| tongue | PASS | 3.5s | prepare: prepared |
| voz | PASS | 34.2s | prepare: prepared |
| embeddinggemma | FAIL | 374.7s | fetch failed |
| laya | SKIPPED | 19.6s | the asset lock declares no download location; the artifacts require the documented manual export: [ASSET_SOURCE_UNAVAILABLE] the asset lock declares no download URL for text-backbone/laya-encoder-onnx: its source is "the split export of the pinned checkpoint"; the artifacts must be produced by the documented export and placed in the prepared-assets cache |
| minilm-embed | PASS | 105.1s | prepare: prepared |
| minilm-rerank | PASS | 130.2s | prepare: prepared |
| needle | PASS | 76.6s | prepare: prepared |
| declarative-recipes | SKIPPED | 46.5s | the invocation host composes no LLM provider (harness limitation; the live host serves declarative recipes via the agent) |

## Tool verdicts

| id | extension | verdict | detail |
| --- | --- | --- | --- |
| lang_detect | tongue | PASS | The long English fixture must be detected as en with the top candidate agreeing; probabilities are the vendor's uncalibrated values, only bounded here. |
| stt_transcribe | voz | PASS | The fixture is a synthesized 2 s tone, NOT speech: this proves decoding, contract shape and duration-bounded coverage only. It cannot prove word accuracy, and no check here claims it. The silence fixture is used only by the offline honest-empty test. |
| tools_plan | needle | SKIPPED | the in-process invocation host composes the host planning adapter but has no Agent turn context, so the frozen planning snapshot is not applied (harness limitation); the live agent host produces a real plan |
| structured_extract | needle | PASS | The extraction must satisfy the CALLER schema in the fixture, and the package's own valid/issues report must agree with an independent re-validation; a blob is never accepted as an extraction. |
| text_embed | minilm-embed | SKIPPED | the in-process invocation host does not carry the live host's prepared-asset map (harness limitation); the live host serves this tool after a successful prepare |
| text_rerank | minilm-rerank | SKIPPED | the in-process invocation host does not carry the live host's prepared-asset map (harness limitation); the live host serves this tool after a successful prepare |
| text_title | declarative-recipes | SKIPPED | the invocation host composes no LLM provider (harness limitation; the live host serves declarative recipes via the agent) |
| image_describe | declarative-recipes | SKIPPED | the invocation host composes no LLM provider (harness limitation; the live host serves declarative recipes via the agent) |
