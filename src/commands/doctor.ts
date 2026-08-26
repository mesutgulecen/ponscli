import { Command } from 'commander'

import { probeAll, type EndpointReport, type ProbeName, type ProbeResult } from '../chain/probe.js'
import type { ActivationCounters } from '../chain/pool.js'
import type { CommandContext } from '../context.js'
import { renderTable, type Painter } from '../output/index.js'

interface DoctorPayload {
  chainId: number
  head: string | undefined
  endpoints: EndpointReport[]
  summary: {
    usable: number
    total: number
    paidTierConfigured: boolean
  }
  stats?: ActivationCounters
}

const COLUMNS: { name: ProbeName; header: string }[] = [
  { name: 'chainId', header: 'CHAIN' },
  { name: 'blockNumber', header: 'BLOCK' },
  { name: 'call', header: 'CALL' },
  { name: 'getLogs', header: 'LOGS' },
  { name: 'archive', header: 'ARCHIVE' },
]

function cell(probe: ProbeResult | undefined, paint: Painter): string {
  if (probe === undefined) return paint('grey', '-')
  if (probe.ok) return paint('green', 'ok')
  // A pruned archive probe is expected on a Tier 1 node, not a defect. Naming
  // the reason instead of a bare "fail" keeps the table from reading as an
  // outage when it is describing normal retention.
  if (probe.reason === undefined) return paint('grey', 'skip')
  return paint(probe.reason === 'pruned' ? 'yellow' : 'red', probe.reason)
}

function render(payload: DoctorPayload, paint: Painter): string {
  const table = renderTable(
    [
      { header: 'ENDPOINT' },
      { header: 'TIER' },
      { header: 'RATE' },
      ...COLUMNS.map((column) => ({ header: column.header })),
      { header: 'LATENCY', align: 'right' as const },
    ],
    payload.endpoints.map((report) => {
      const byName = new Map(report.probes.map((probe) => [probe.name, probe]))
      const answered = report.probes.filter((probe) => probe.latencyMs > 0)
      const latency =
        answered.length === 0
          ? '-'
          : `${Math.round(answered.reduce((total, probe) => total + probe.latencyMs, 0) / answered.length)}ms`
      return [
        report.parked ? paint('grey', report.label) : report.label,
        String(report.tier),
        report.meteredIntervalMs === undefined
          ? paint('grey', '-')
          : paint('yellow', `1/${String(Math.round(report.meteredIntervalMs / 1000))}s`),
        ...COLUMNS.map((column) => cell(byName.get(column.name), paint)),
        latency,
      ]
    }),
  )

  const lines = [table, '']

  const { usable, total, paidTierConfigured } = payload.summary
  const health = usable === total ? paint('green', `${usable}/${total}`) : paint('yellow', `${usable}/${total}`)
  lines.push(
    `${health} endpoints usable for reads. Paid tier: ${
      paidTierConfigured ? paint('green', 'configured') : paint('grey', 'not configured')
    }.`,
  )
  if (!paidTierConfigured) {
    lines.push(
      paint('grey', '  Without it, exhausting Tier 1 fails the request instead of billing you.'),
    )
  }

  const notes = payload.endpoints.flatMap((report) =>
    report.probes
      .filter((probe) => !probe.ok && probe.detail !== undefined)
      .map((probe) => [report.label, probe.name, probe.detail ?? ''] as string[]),
  )
  if (notes.length > 0) {
    lines.push('', paint('dim', 'notes'))
    lines.push(
      renderTable(
        [{ header: 'ENDPOINT' }, { header: 'PROBE' }, { header: 'DETAIL' }],
        notes,
        '  ',
      ),
    )
  }

  if (payload.stats !== undefined) {
    lines.push('', paint('dim', 'activation counters'))
    lines.push(
      renderTable(
        [{ header: 'BRANCH' }, { header: 'COUNT', align: 'right' as const }],
        Object.entries(payload.stats).map(([key, value]) => [key, String(value)]),
        '  ',
      ),
    )
    lines.push(
      paint('grey', '  A zero with traffic flowing proves that branch is inert.'),
    )
  }

  return lines.join('\n')
}

export function createDoctorCommand(getContext: () => CommandContext): Command {
  return new Command('doctor')
    .description('Probe every RPC endpoint with the calls the CLI actually makes')
    .option('--stats', 'Also print waterfall activation counters')
    .option('--wait', 'Pace probes to a metered endpoint instead of stopping at its limit')
    .action(async (options: { stats?: boolean; wait?: boolean }) => {
      const context = getContext()
      const { pool, dispatch } = context.rpc()

      // Probes address each endpoint directly rather than going through the
      // pool. The pool exists to route around a bad endpoint; the doctor exists
      // to name it, and it cannot do that if a healthy endpoint answers first.
      if (options.wait === true) {
        const metered = pool.endpoints.filter(
          (endpoint) => endpoint.capabilities.minIntervalMs !== undefined,
        )
        if (metered.length > 0) {
          context.reporter.note(
            `pacing probes for ${metered.map((endpoint) => endpoint.label).join(', ')}; this will take a while`,
          )
        }
      }
      // One request through the pool first, so every endpoint is probed against
      // the same head. Without it, an endpoint whose own `eth_blockNumber` was
      // refused would report its log and archive probes as "head unknown",
      // hiding the actual reason behind an artefact of probe ordering.
      let head: bigint | undefined
      try {
        const result = await pool.send('eth_blockNumber')
        if (typeof result === 'string') head = BigInt(result)
      } catch {
        // Leave it undefined: the per-endpoint probes still report what they
        // can, and the summary will show nothing is answering.
      }

      const reports = await probeAll(dispatch, pool.endpoints, {
        ...(head === undefined ? {} : { head }),
        ...(options.wait === true ? { wait: true } : {}),
      })

      const payload: DoctorPayload = {
        chainId: 4663,
        head: head?.toString(),
        endpoints: reports,
        summary: {
          usable: reports.filter((report) => report.usable).length,
          total: reports.length,
          paidTierConfigured: pool.endpoints.some((endpoint) => endpoint.tier === 2),
        },
        ...(options.stats === true ? { stats: { ...pool.stats } } : {}),
      }

      context.reporter.emit(payload, render)
    })
}
