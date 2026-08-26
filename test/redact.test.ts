import { describe, expect, it } from 'vitest'

import { endpointLabel, redactErrorInPlace, redactText, redactUrl } from '../src/chain/redact.js'

const ALCHEMY = 'https://robinhood-mainnet.g.alchemy.com/v2/aB3dEfGhIjKlMnOpQrStUv'

describe('redactUrl', () => {
  it('masks an API key carried in the path', () => {
    expect(redactUrl(ALCHEMY)).toBe('https://robinhood-mainnet.g.alchemy.com/v2/***')
  })

  it('keeps structural path segments readable', () => {
    expect(redactUrl('https://rpc.nodeflare.app/robinhood/public')).toBe(
      'https://rpc.nodeflare.app/robinhood/public',
    )
  })

  it('masks a key carried in the query string', () => {
    expect(redactUrl('https://node.example/rpc?apiKey=abc123')).toBe(
      'https://node.example/rpc?apiKey=***',
    )
  })

  it('masks basic-auth credentials', () => {
    expect(redactUrl('https://user:pass@node.example/')).toBe('https://***@node.example/')
  })

  it('refuses to echo an unparseable string', () => {
    expect(redactUrl('not a url at all')).toBe('<invalid url>')
  })
})

describe('redactErrorInPlace', () => {
  it('masks the key inside a transport error message', () => {
    // The finding this guards: structured-field redaction never reaches here,
    // because the HTTP client formats the URL into the message itself.
    const error = Object.assign(new Error(`HTTP request failed.\nURL: ${ALCHEMY}`), {
      details: `POST ${ALCHEMY}`,
      url: ALCHEMY,
    })
    redactErrorInPlace(error, [ALCHEMY])

    expect(error.message).not.toContain('aB3dEfGhIjKlMnOpQrStUv')
    expect(error.details).not.toContain('aB3dEfGhIjKlMnOpQrStUv')
    expect(error.url).toBe('https://robinhood-mainnet.g.alchemy.com/v2/***')
  })

  it('reaches into the cause chain', () => {
    const inner = new Error(`refused by ${ALCHEMY}`)
    const outer = new Error('RPC Request failed.', { cause: inner })
    redactErrorInPlace(outer, [ALCHEMY])
    expect(inner.message).toContain('/v2/***')
  })

  it('preserves the error class so downstream decoding still works', () => {
    class RevertError extends Error {}
    const error = new RevertError(`reverted at ${ALCHEMY}`)
    redactErrorInPlace(error, [ALCHEMY])
    expect(error).toBeInstanceOf(RevertError)
  })

  it('survives a cyclic cause chain', () => {
    const a = new Error('a')
    const b = new Error('b', { cause: a })
    Object.assign(a, { cause: b })
    expect(() => redactErrorInPlace(a, [ALCHEMY])).not.toThrow()
  })
})

describe('redactText', () => {
  it('replaces every occurrence of a known endpoint', () => {
    const text = `tried ${ALCHEMY} then ${ALCHEMY}`
    expect(redactText(text, [ALCHEMY]).match(/aB3dEfGhIjKlMnOpQrStUv/g)).toBeNull()
  })
})

describe('endpointLabel', () => {
  it('reduces an endpoint to its host', () => {
    expect(endpointLabel(ALCHEMY)).toBe('robinhood-mainnet.g.alchemy.com')
  })
})
