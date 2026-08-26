/**
 * Strip credentials out of an endpoint URL.
 *
 * The finding this exists for is that structured-field redaction is not
 * enough: the HTTP client embeds the request URL inside
 * transport error messages, and those messages travel through paths that never
 * see the redaction helper. The Alchemy key lives in the URL path, so anything
 * that prints a URL, whether a log line, an error or the `doctor` table, has to go
 * through here.
 */

/** Path segments that are structural rather than secret. */
const STRUCTURAL = new Set([
  'v1',
  'v2',
  'v3',
  'rpc',
  'eth',
  'mainnet',
  'testnet',
  'public',
  'robinhood',
  'ethereum',
  'api',
])

/** Query parameters whose value is a credential regardless of its shape. */
const SECRET_PARAMS = /^(api[-_]?key|key|token|auth|access[-_]?token|secret)$/i

function looksSecret(segment: string): boolean {
  if (STRUCTURAL.has(segment.toLowerCase())) return false
  // A key is long and unbroken. Human-facing path segments are short or
  // hyphenated; keys are 20+ characters of dense alphanumeric noise.
  return segment.length >= 16 && /^[A-Za-z0-9_-]+$/.test(segment) && !segment.includes('.')
}

/**
 * Return a display form of `url` with anything credential-shaped masked.
 *
 * Falls back to the origin alone if the input does not parse: an unparseable
 * string of unknown provenance must not be echoed verbatim.
 */
export function redactUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return '<invalid url>'
  }

  const segments = parsed.pathname.split('/').map((segment) => (looksSecret(segment) ? '***' : segment))
  parsed.pathname = segments.join('/')

  for (const [name] of [...parsed.searchParams]) {
    if (SECRET_PARAMS.test(name)) parsed.searchParams.set(name, '***')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    parsed.username = '***'
    parsed.password = ''
  }

  return parsed.toString()
}

/**
 * Replace every occurrence of a known endpoint URL inside arbitrary text.
 *
 * Used on error messages, which are built by libraries that had no idea a
 * secret was in the string they were formatting.
 */
export function redactText(text: string, urls: readonly string[]): string {
  let result = text
  for (const url of urls) {
    if (url === '') continue
    result = result.split(url).join(redactUrl(url))
  }
  return result
}

/** A short human label for an endpoint, for tables and log lines. */
export function endpointLabel(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return '<invalid url>'
  }
}

/**
 * Mask endpoint URLs inside an error object and its causes, in place.
 *
 * Rethrowing a wrapper would be cleaner but would destroy the error's class,
 * and the revert-decoding layer downstream matches on viem's error types. So
 * the object is kept and only its human-readable fields are rewritten.
 *
 * This exists because structured-field redaction never reaches here: the HTTP client formats the request URL into
 * the message itself, and on the paid tier that URL contains the API key.
 */
export function redactErrorInPlace(error: unknown, urls: readonly string[]): void {
  if (urls.length === 0) return
  const seen = new Set<unknown>()
  let current: unknown = error

  for (let depth = 0; depth < 12 && current !== null && current !== undefined; depth += 1) {
    if (typeof current !== 'object' || seen.has(current)) break
    seen.add(current)
    const node = current as Record<string, unknown>

    for (const field of ['message', 'details', 'shortMessage', 'url']) {
      const value = node[field]
      if (typeof value === 'string') {
        const masked = redactText(value, urls)
        if (masked !== value) node[field] = masked
      }
    }

    const meta = node['metaMessages']
    if (Array.isArray(meta)) {
      node['metaMessages'] = (meta as unknown[]).map((line): unknown =>
        typeof line === 'string' ? redactText(line, urls) : line,
      )
    }

    current = node['cause']
  }
}
