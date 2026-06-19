/**
 * Normalizes tool call arguments returned by the LLM.
 *
 * The LLM occasionally double-serializes object/array values — passing them as
 * JSON strings instead of actual objects. For example, the `dashboard` field in
 * `update_dashboard` may arrive as the string `"{\"title\":\"...\",\"panels\":[]}"`.
 * Go backends expect a real object and fail to unmarshal the string with:
 *   "cannot unmarshal string into Go struct field … of type map[string]interface{}"
 *
 * This function walks the top-level fields and, for any string value that looks
 * like a JSON object or array, attempts to parse it back into a native value.
 */
export function normalizeToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => {
      if (typeof value === 'string' && (value.trimStart().startsWith('{') || value.trimStart().startsWith('['))) {
        try {
          return [key, JSON.parse(value)];
        } catch {
          // Not valid JSON — leave the value as-is
        }
      }
      return [key, value];
    })
  );
}
