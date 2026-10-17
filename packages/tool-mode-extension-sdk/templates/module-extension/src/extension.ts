/**
 * The module-extension author template (EXT-36).
 *
 * Default-export a `ToolModeExtensionV1`. `create()` must be LIGHTWEIGHT:
 * no downloads, model loads, inference, sockets or global registration (EXT-19).
 * The host prepares assets explicitly before `load()`; `dispose()` is idempotent
 * and settles after owned resources stop.
 */
export default {
  apiVersion: 1,
  async create(context) {
    const configuration = context.configuration ?? {}
    return {
      async createProvider(request) {
        // One provider per declared model/resource grouping.
        const disposed = { done: false }
        return {
          async inspect(signal) {
            return {
              ready: true,
              prerequisites: [],
              runtimeVersion: 'template-1.0.0',
              diagnostics: `example provider for model ${request.modelId}`,
            }
          },
          async load({ assets, signal }) {
            // No-op: the template ships no model assets (models: []).
          },
          async invoke(request) {
            // The domain payload: the host validates it against the output
            // schema and attaches the reserved `meta` itself (EXT-17).
            const input = request.input ?? {}
            return {
              result: `bounded example output for ${typeof input.text === 'string' ? input.text.slice(0, 40) : 'no text'}`,
            }
          },
          async unload(signal) { /* release prepared state */ },
          async dispose() { disposed.done = true },
        }
      },
      async dispose(reason) {
        // Join owned resources; never throw past the host's grace period.
      },
    }
  },
}
