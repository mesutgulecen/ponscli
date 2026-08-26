import { encodeFunctionData, numberToHex } from 'viem'

import { v2FactoryAbi } from '../abi/v2Factory.js'
import { addresses } from './addresses.js'
import { classify, describeError, type ReturnReason, type WalkReason } from './classify.js'
import type { Endpoint } from './endpoint.js'
import type { Dispatch } from './pool.js'
import { redactText } from './redact.js'

/**
 * Capability probing for `pons doctor`.
 *
 * The reason this command exists is one measured trap: drpc answers
 * `eth_chainId` faster than any other endpoint and then rejects `eth_call` and
 * `eth_blockNumber` with `-32601`. A health check built on `eth_chainId` marks
 * that endpoint healthy and routes real work to a node that cannot do any.
 *
 * So every probe below is a request the CLI actually makes in normal use. None
 * of them is a liveness ping.
 */

export type ProbeName = 'chainId' | 'blockNumber' | 'call' | 'getLogs' | 'archive'

export interface ProbeResult {
  name: ProbeName
  ok: boolean
  latencyMs: number
  /** Short description of what came back, for the human table. */
  detail: string | undefined
  reason: WalkReason | ReturnReason | undefined
}

export interface EndpointReport {
  label: string
  url: string
  tier: 1 | 2
  origin: Endpoint['origin']
  parked: boolean
  parkReason: WalkReason | undefined
  /** Minimum request spacing this endpoint enforces, when it is metered. */
  meteredIntervalMs: number | undefined
  probes: ProbeResult[]
  /** True when the endpoint can serve the reads the CLI depends on. */
  usable: boolean
}

/** Blocks back from head for the log probe. Small enough for a weak endpoint. */
const LOG_PROBE_SPAN = 2_000n

/**
 * Blocks back from head for the archive probe.
 *
 * The official endpoint prunes state somewhere between 6,000 and 10,000 blocks
 * back, so 50,000 sits well clear of the boundary: a node that answers here is
 * genuinely retaining history rather than sitting near the edge of its window.
 */
const ARCHIVE_PROBE_DEPTH = 50_000n

const LAUNCH_FEE_CALLDATA = encodeFunctionData({ abi: v2FactoryAbi, functionName: 'launchFee' })

interface Attempt {
  ok: boolean
  latencyMs: number
  value?: unknown
  error?: unknown
}

async function attempt(
  dispatch: Dispatch,
  endpoint: Endpoint,
  method: string,
  params: readonly unknown[],
): Promise<Attempt> {
  const started = Date.now()
  try {
    const value = await dispatch(endpoint, method, params)
    return { ok: true, latencyMs: Date.now() - started, value }
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, error }
  }
}

function failure(name: ProbeName, run: Attempt, urls: readonly string[]): ProbeResult {
  const verdict = classify(run.error)
  return {
    name,
    ok: false,
    latencyMs: run.latencyMs,
    detail: redactText(describeError(run.error), urls).slice(0, 110),
    reason: verdict.reason,
  }
}

/**
 * Run every probe against one endpoint, sequentially.
 *
 * Sequential on purpose. Firing five concurrent requests at a token-bucket
 * endpoint provokes the very 429 the probe is trying to measure, and would
 * report a healthy endpoint as throttled.
 */
export async function probeEndpoint(
  dispatch: Dispatch,
  endpoint: Endpoint,
  options: {
    head?: bigint
    urls?: readonly string[]
    expectedChainId?: number
    /** Honour a metered endpoint's interval instead of stopping at its limit. */
    wait?: boolean
    sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<EndpointReport> {
  const urls = options.urls ?? [endpoint.url]
  const expectedChainId = options.expectedChainId ?? 4663
  const interval = endpoint.capabilities.minIntervalMs
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const probes: ProbeResult[] = []

  /**
   * A metered endpoint throttles itself if probed at full speed.
   *
   * That is the doctor's own version of the health-check trap: five back-to-back
   * probes against an endpoint that allows one request per ten seconds reports a
   * perfectly good node as broken. By default we stop at the first throttle and
   * label the endpoint metered, which is the true answer. `--wait` pays the
   * wall-clock cost to run the full battery.
   */
  let meteredOut = false
  const pace = async (): Promise<boolean> => {
    if (interval === undefined || probes.length === 0) return true
    if (options.wait !== true) return !meteredOut
    await sleep(interval)
    return true
  }
  const meterSkip = (name: ProbeName): ProbeResult => ({
    name,
    ok: false,
    latencyMs: 0,
    detail: `skipped: metered at ${String(interval)}ms between requests`,
    reason: undefined,
  })

  const chainId = await attempt(dispatch, endpoint, 'eth_chainId', [])
  if (!chainId.ok) {
    probes.push(failure('chainId', chainId, urls))
  } else {
    const seen = typeof chainId.value === 'string' ? Number(BigInt(chainId.value)) : NaN
    const matches = seen === expectedChainId
    probes.push({
      name: 'chainId',
      ok: matches,
      latencyMs: chainId.latencyMs,
      detail: matches ? String(seen) : `expected ${expectedChainId}, got ${String(seen)}`,
      reason: matches ? undefined : 'durable',
    })
  }

  let head = options.head
  const blockNumber = (await pace())
    ? await attempt(dispatch, endpoint, 'eth_blockNumber', [])
    : undefined
  if (blockNumber === undefined) {
    probes.push(meterSkip('blockNumber'))
  } else if (!blockNumber.ok) {
    const result = failure('blockNumber', blockNumber, urls)
    if (result.reason === 'throttle' && interval !== undefined) meteredOut = true
    probes.push(result)
  } else {
    const value = typeof blockNumber.value === 'string' ? BigInt(blockNumber.value) : undefined
    if (value !== undefined && (head === undefined || value > head)) head = value
    probes.push({
      name: 'blockNumber',
      ok: true,
      latencyMs: blockNumber.latencyMs,
      detail: value === undefined ? undefined : value.toString(),
      reason: undefined,
    })
  }

  // A real contract read against the live V2 factory. This is the probe that
  // separates an endpoint that answers pings from one that answers questions.
  const call = (await pace())
    ? await attempt(dispatch, endpoint, 'eth_call', [
        { to: addresses.v2Factory, data: LAUNCH_FEE_CALLDATA },
        'latest',
      ])
    : undefined
  if (call === undefined) {
    probes.push(meterSkip('call'))
  } else if (call.ok) {
    probes.push({
      name: 'call',
      ok: true,
      latencyMs: call.latencyMs,
      detail: typeof call.value === 'string' ? `launchFee ${BigInt(call.value).toString()}` : undefined,
      reason: undefined,
    })
  } else {
    const result = failure('call', call, urls)
    if (result.reason === 'throttle' && interval !== undefined) meteredOut = true
    probes.push(result)
  }

  if (head === undefined) {
    probes.push({
      name: 'getLogs',
      ok: false,
      latencyMs: 0,
      detail: 'skipped: chain head unknown',
      reason: undefined,
    })
    probes.push({
      name: 'archive',
      ok: false,
      latencyMs: 0,
      detail: 'skipped: chain head unknown',
      reason: undefined,
    })
  } else {
    const from = head > LOG_PROBE_SPAN ? head - LOG_PROBE_SPAN : 0n
    const logs = (await pace())
      ? await attempt(dispatch, endpoint, 'eth_getLogs', [
          {
            address: addresses.v2Factory,
            fromBlock: numberToHex(from),
            toBlock: numberToHex(head),
          },
        ])
      : undefined
    if (logs === undefined) probes.push(meterSkip('getLogs'))
    else
      probes.push(
      logs.ok
        ? {
            name: 'getLogs',
            ok: true,
            latencyMs: logs.latencyMs,
            detail: `${Array.isArray(logs.value) ? logs.value.length : 0} logs over ${LOG_PROBE_SPAN.toString()} blocks`,
            reason: undefined,
          }
        : failure('getLogs', logs, urls),
    )

    const depth = head > ARCHIVE_PROBE_DEPTH ? head - ARCHIVE_PROBE_DEPTH : 0n
    const archive = (await pace())
      ? await attempt(dispatch, endpoint, 'eth_getBalance', [
          addresses.v2Factory,
          numberToHex(depth),
        ])
      : undefined
    if (archive === undefined) probes.push(meterSkip('archive'))
    else
      probes.push(
      archive.ok
        ? {
            name: 'archive',
            ok: true,
            latencyMs: archive.latencyMs,
            detail: `state at -${ARCHIVE_PROBE_DEPTH.toString()} blocks`,
            reason: undefined,
          }
        : failure('archive', archive, urls),
    )
  }

  const required = new Set<ProbeName>(['chainId', 'blockNumber', 'call'])
  // A metered endpoint is judged on what it was allowed to answer. Scoring it
  // against probes its own rate limit refused would report a working node as
  // broken, and which probe gets refused depends only on how recently the
  // endpoint was last touched, including by a previous run from the same IP.
  const usable = meteredOut
    ? probes.some((probe) => probe.ok)
    : probes.every((probe) => !required.has(probe.name) || probe.ok)

  return {
    label: endpoint.label,
    url: endpoint.safeUrl,
    tier: endpoint.tier,
    origin: endpoint.origin,
    parked: endpoint.isParked(),
    parkReason: endpoint.parkReason,
    meteredIntervalMs: interval,
    probes,
    usable,
  }
}

/**
 * Probe every endpoint.
 *
 * Endpoints are probed in parallel with each other but sequentially within
 * themselves: separate hosts have separate rate limits, so there is nothing to
 * gain from serialising across them and a slow endpoint should not hold up the
 * table.
 */
export async function probeAll(
  dispatch: Dispatch,
  endpoints: readonly Endpoint[],
  options: { head?: bigint; wait?: boolean } = {},
): Promise<EndpointReport[]> {
  const urls = endpoints.map((endpoint) => endpoint.url)
  return Promise.all(
    endpoints.map((endpoint) =>
      probeEndpoint(dispatch, endpoint, {
        ...(options.head === undefined ? {} : { head: options.head }),
        ...(options.wait === undefined ? {} : { wait: options.wait }),
        urls,
      }),
    ),
  )
}
