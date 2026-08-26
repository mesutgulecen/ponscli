import { createPublicClient, custom, http, type PublicClient, type Transport } from 'viem'

import type { PonsConfig } from '../config/schema.js'
import { PACKAGE_NAME, VERSION } from '../version.js'
import { robinhoodChain } from './definition.js'
import { buildEndpoints, type Endpoint } from './endpoint.js'
import type { Clock } from './headSkew.js'
import type { Lease} from './pool.js';
import { RpcPool, type Dispatch } from './pool.js'

/**
 * Identify ourselves on every request.
 *
 * Not politeness but a requirement. The public endpoints on this chain sit behind
 * a WAF that answers 403 to a request carrying no User-Agent: measured with
 * `curl` (which sends one) succeeding where Node's `fetch` (which does not) was
 * refused outright. Without this header the free tier looks dead.
 */
const USER_AGENT = `${PACKAGE_NAME}/${VERSION}`

/**
 * Build the function that actually puts a request on the wire.
 *
 * viem's `http` transport is reused per endpoint for its request formatting,
 * timeout handling and error types, and classification downstream reads those
 * types. Its own retry logic is switched off: retrying the same endpoint is
 * exactly what the measurements said not to do. Re-sending a request that was
 * *answered* with an error returns the same body half a second later, and a
 * genuine transport failure is better served by the next endpoint than by the
 * same one again.
 */
export function createDispatch(timeoutMs: number): Dispatch {
  const transports = new Map<string, ReturnType<Transport>>()

  return async (endpoint: Endpoint, method: string, params: readonly unknown[]) => {
    let transport = transports.get(endpoint.url)
    if (transport === undefined) {
      transport = http(endpoint.url, {
        timeout: timeoutMs,
        retryCount: 0,
        fetchOptions: { headers: { 'user-agent': USER_AGENT } },
      })({ chain: robinhoodChain })
      transports.set(endpoint.url, transport)
    }
    return transport.request({ method, params: params as never })
  }
}

/**
 * Wrap the pool as a viem transport.
 *
 * Everything above this line is viem's: clients, actions, ABI inference,
 * Multicall3 aggregation. Everything below it is the waterfall. viem's retry is
 * disabled here for the same reason as above: there is exactly one retry policy
 * in this CLI and it lives in the pool.
 */
export function poolTransport(pool: RpcPool): Transport {
  return custom(
    {
      request: async ({ method, params }: { method: string; params?: unknown }) =>
        pool.send(method, Array.isArray(params) ? (params as unknown[]) : []),
    },
    { retryCount: 0 },
  )
}

/**
 * Wrap a single pinned endpoint as a viem transport.
 *
 * Writes must not walk the waterfall: taking a nonce from one node and
 * broadcasting to another produces `nonce too low`, and an endpoint 24 blocks
 * behind will not have seen the transaction it is being asked about. A lease
 * holds one endpoint for the whole send, so the nonce, the fee data, the
 * broadcast and the receipt poll all address the same node.
 */
export function leaseTransport(lease: Lease): Transport {
  return custom(
    {
      request: async ({ method, params }: { method: string; params?: unknown }) =>
        lease.send(method, Array.isArray(params) ? (params as unknown[]) : []),
    },
    { retryCount: 0 },
  )
}

export interface RpcOptions {
  onWarn?: (message: string) => void
  clock?: Clock
  /** Overrides the wire layer. Tests pass a fake; nothing else should. */
  dispatch?: Dispatch
}

export interface Rpc {
  pool: RpcPool
  client: PublicClient
  /**
   * The wire layer, exposed so `pons doctor` can address one endpoint directly.
   *
   * The pool's job is to route around a bad endpoint; the doctor's job is to
   * name it, and it cannot do that through a router that hides the failure.
   */
  dispatch: Dispatch
}

/**
 * Assemble the endpoint list, the pool and a viem client from configuration.
 *
 * `batch.multicall` is on because Multicall3 is deployed on this chain: reading
 * fifty tokens' state becomes one request instead of two hundred, which is the
 * single largest saving available and costs nothing.
 */
export function createRpc(config: PonsConfig, options: RpcOptions = {}): Rpc {
  const endpoints = buildEndpoints({
    userUrl: config['rpc.url'],
    freeUrls: config['rpc.endpoints'],
    alchemyKey: config['rpc.alchemyKey'],
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  })

  const dispatch = options.dispatch ?? createDispatch(config['rpc.timeoutMs'])
  const pool = new RpcPool({
    endpoints,
    dispatch,
    tier: config['rpc.tier'],
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.onWarn === undefined ? {} : { onWarn: options.onWarn }),
  })

  const client = createPublicClient({
    chain: robinhoodChain,
    transport: poolTransport(pool),
    batch: { multicall: true },
  })

  return { pool, client, dispatch }
}
