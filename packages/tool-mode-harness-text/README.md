# @try-works/tool-mode-harness-text

The canonical home of the `text_title` harness-model recipe and its worked
examples (RCP-12). **Recipes-only: this package ships no executable code.**

## Contents

- `recipes/text-title.json` — the `text_title` recipe. It requires text input
  and a JSON response containing a bounded `title` (at most 80 characters) and
  `description` (at most 240 characters); a `{"refused": true, ...}` object is
  the only permitted alternative. The recipe flows through the same declarative
  broker as `describe_image` — there is no `if tool === text_title` path
  anywhere in the broker (pinned by the no-special-case test in
  `packages/tool-mode-recipes/tests/builtins.test.ts`).
- `examples/text-title-request.json` — a worked caller request whose arguments
  satisfy the recipe's declared inputs, with the omission rule explained.
- `examples/text-title-response.json` — the bounded JSON shape the recipe
  requires, with the 80/240 character limits noted.

## Schema

The recipe document is validated against the published vocabulary
`harness-model-recipe.schema.json` (JSON Schema 2020-12), shipped by
`@try-works/tool-mode-recipes` under `schema/harness-model-recipe.schema.json`.
The normative implementation is the code validator in
`packages/tool-mode-recipes/src/recipe-format.ts`; the parity test in
`packages/tool-mode-recipes/tests/schema-parity.test.ts` validates this
package's recipe against the published schema and pins the copy here
byte-identical to the broker's bundled copy, so the two cannot drift.
