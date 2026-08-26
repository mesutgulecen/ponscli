/**
 * Serialize a value for `--json` output.
 *
 * `bigint` is rendered as a decimal string rather than a number. Token amounts
 * and wei values routinely exceed `Number.MAX_SAFE_INTEGER`, so emitting them
 * as JSON numbers would silently round a balance. Consumers get an exact
 * string and decide their own numeric representation.
 */
export function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Map) return Object.fromEntries(value)
  if (value instanceof Set) return [...value]
  return value
}

export function stringify(value: unknown, pretty: boolean): string {
  return JSON.stringify(value, jsonReplacer, pretty ? 2 : undefined) ?? 'null'
}
