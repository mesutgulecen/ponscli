import { Command } from 'commander'

import {
  CONFIG_KEYS,
  ENV_ONLY,
  SCHEMA,
  assertConfigKey,
  displayValue,
  setConfigValue,
  unsetConfigValue,
  type ConfigKey,
  type ConfigSource,
} from '../config/index.js'
import { readFactoryPolicy } from '../core/adapters/v2.js'
import { ConfigError } from '../errors.js'
import { renderTable, type Painter } from '../output/index.js'
import { formatAmount, formatBps, formatDuration } from '../output/format.js'
import type { CommandContext } from '../context.js'

interface ConfigEntry {
  key: ConfigKey
  value: unknown
  display: string
  source: ConfigSource
  secret: boolean
  describe: string
}

interface LaunchConfigEntry {
  id: number
  supply: string
  curveFeeBps: number
  phantomQuote: string
  graduationThreshold: string
  poolFee: number
  tickSpacing: number
  enabled: boolean
}

interface FactoryPayload {
  address: string
  launchEnabled: boolean
  launchFeeWei: string
  maxCreatorTaxBps: number
  snipeTaxStartBps: number
  snipeTaxSeconds: number
  configs: LaunchConfigEntry[]
}

interface ConfigListPayload {
  file: { path: string; exists: boolean }
  entries: ConfigEntry[]
  /**
   * Read from the environment but never stored, and never flags.
   *
   * Listed without values: the point is to tell somebody the variable exists,
   * not to print a password back to a terminal they may be sharing.
   */
  envOnly: { name: string; describe: string }[]
  /** Present only with `--configs`, which is the flag that goes to the chain. */
  factory?: FactoryPayload
}

const SOURCE_COLOR: Record<ConfigSource, Parameters<Painter>[0]> = {
  flag: 'cyan',
  env: 'blue',
  file: 'green',
  default: 'grey',
}

/** Placeholder shown for a key that has no value. Never an empty cell. */
const UNSET = '-'

function collect(context: CommandContext): ConfigListPayload {
  const { values, sources, filePath, fileExists } = context.config
  return {
    file: { path: filePath, exists: fileExists },
    entries: CONFIG_KEYS.map((key) => ({
      key,
      // `undefined` would vanish from JSON output entirely; `null` says
      // "this key exists and is unset", which is what a consumer needs.
      value: values[key] ?? null,
      display: displayValue(key, values[key]),
      source: sources[key],
      secret: SCHEMA[key].secret === true,
      describe: SCHEMA[key].describe,
    })),
    envOnly: Object.entries(ENV_ONLY).map(([name, describe]) => ({ name, describe })),
  }
}

/**
 * The factory's live settings, rendered under the local configuration.
 *
 * Every number here is owner-mutable, which is the reason the command reads
 * them rather than printing constants: the contract source declares
 * `snipeTaxSeconds = 15` and the chain answers 3.
 */
function renderFactory(factory: FactoryPayload, paint: Painter): string {
  const lines = [
    `${paint('dim', 'factory')} ${factory.address}`,
    '',
    renderTable(
      [{ header: '' }, { header: '' }],
      [
        [
          'launching',
          factory.launchEnabled
            ? paint('green', 'open')
            : paint('yellow', 'restricted to whitelisted addresses'),
        ],
        ['launch fee', `${formatAmount(BigInt(factory.launchFeeWei), 18)} ETH`],
        ['max creator tax', formatBps(factory.maxCreatorTaxBps)],
        [
          'snipe tax',
          `${formatBps(factory.snipeTaxStartBps)} decaying over ${formatDuration(BigInt(factory.snipeTaxSeconds))}`,
        ],
      ],
      '  ',
    ),
    '',
    renderTable(
      [
        { header: 'ID', align: 'right' as const },
        { header: 'SUPPLY', align: 'right' as const },
        { header: 'CURVE FEE', align: 'right' as const },
        { header: 'PHANTOM', align: 'right' as const },
        { header: 'THRESHOLD', align: 'right' as const },
        { header: 'TICK', align: 'right' as const },
        { header: 'STATE' },
      ],
      factory.configs.map((config) => [
        config.id.toString(),
        formatAmount(BigInt(config.supply), 18),
        formatBps(config.curveFeeBps),
        `${formatAmount(BigInt(config.phantomQuote), 18)} ETH`,
        `${formatAmount(BigInt(config.graduationThreshold), 18)} ETH`,
        config.tickSpacing.toString(),
        config.enabled ? paint('green', 'enabled') : paint('grey', 'disabled'),
      ]),
      '  ',
    ),
    paint(
      'grey',
      "  Phantom and threshold are the native-ETH figures; a launch quoted in another asset uses that asset's own economics.",
    ),
  ]
  return lines.join('\n')
}

function renderList(payload: ConfigListPayload, paint: Painter): string {
  const header = payload.file.exists
    ? `${paint('dim', 'config file')} ${payload.file.path}`
    : `${paint('dim', 'config file')} ${payload.file.path} ${paint('grey', '(not created yet)')}`

  const table = renderTable(
    [{ header: 'KEY' }, { header: 'VALUE' }, { header: 'SOURCE' }],
    payload.entries.map((entry) => [
      entry.key,
      entry.display === '' ? paint('grey', UNSET) : entry.display,
      paint(SOURCE_COLOR[entry.source], entry.source),
    ]),
  )

  const sections = [`${header}\n\n${table}`]
  sections.push(
    [
      paint('dim', 'environment only, never written to the config file and never a flag'),
      ...payload.envOnly.map((entry) => `  ${entry.name}  ${paint('grey', entry.describe)}`),
    ].join('\n'),
  )
  if (payload.factory !== undefined) sections.push(renderFactory(payload.factory, paint))
  return sections.join('\n\n')
}

export function createConfigCommand(getContext: () => CommandContext): Command {
  const command = new Command('config').description('Inspect and edit configuration')

  command
    .command('list', { isDefault: true })
    .alias('ls')
    .description('Show every key with its resolved value and where it came from')
    .option('--configs', "Also read the factory's live launch policy and configs")
    .action(async (options: { configs?: boolean }) => {
      const context = getContext()
      const payload = collect(context)
      if (options.configs === true) {
        const policy = await readFactoryPolicy(context.rpc().client)
        payload.factory = {
          address: policy.factory,
          launchEnabled: policy.launchEnabled,
          launchFeeWei: policy.launchFee.toString(),
          maxCreatorTaxBps: Number(policy.maxCreatorTaxBps),
          snipeTaxStartBps: Number(policy.snipeTaxStartBps),
          snipeTaxSeconds: Number(policy.snipeTaxSeconds),
          configs: policy.configs.map((config) => ({
            id: config.id,
            supply: config.supply.toString(),
            curveFeeBps: Number(config.curveFeeBps),
            phantomQuote: config.phantomQuote.toString(),
            graduationThreshold: config.graduationThreshold.toString(),
            poolFee: config.poolFee,
            tickSpacing: config.tickSpacing,
            enabled: config.enabled,
          })),
        }
      }
      context.reporter.emit(payload, renderList)
    })

  command
    .command('get')
    .argument('<key>', 'Configuration key, for example rpc.url')
    .description('Print one resolved value')
    .action((rawKey: string) => {
      const context = getContext()
      const key = assertConfigKey(rawKey)
      const value = context.config.values[key]
      // `get` prints secrets in full, unlike `list`. Naming a single key is an
      // explicit request for its value, and the usual reason to do so is
      // `PONS_ALCHEMY_KEY=$(pons config get rpc.alchemyKey)`. Redacting here
      // would make the command useless while `list` already covers the case
      // where a secret would be shown without being asked for.
      const raw = SCHEMA[key].format(value as never)
      context.reporter.emit(
        { key, value: value ?? null, source: context.config.sources[key] },
        () => (raw === '' ? UNSET : raw),
      )
    })

  command
    .command('set')
    .argument('<key>', 'Configuration key')
    .argument('<value>', 'New value')
    .description('Write a value to the config file')
    .action((rawKey: string, rawValue: string) => {
      const context = getContext()
      const key = assertConfigKey(rawKey)
      const stored = setConfigValue(key, rawValue, context.resolveContext)
      const source = context.config.sources[key]
      // Writing the file does not necessarily change what the next command
      // sees: a flag or environment variable still outranks it. Saying so now
      // is cheaper than the user rediscovering it through surprising behaviour.
      if (source === 'flag' || source === 'env') {
        context.reporter.warn(
          `${key} is currently overridden by ${source === 'env' ? SCHEMA[key].env : 'a command-line flag'}, so the stored value will not take effect until that is removed`,
        )
      }
      context.reporter.emit(
        { key, value: stored ?? null, display: displayValue(key, stored), path: context.config.filePath },
        (payload, paint) =>
          `${paint('green', 'set')} ${payload.key} = ${payload.display === '' ? UNSET : payload.display}`,
      )
    })

  command
    .command('unset')
    .argument('<key>', 'Configuration key')
    .description('Remove a value from the config file, reverting it to the default')
    .action((rawKey: string) => {
      const context = getContext()
      const key = assertConfigKey(rawKey)
      const removed = unsetConfigValue(key, context.resolveContext)
      if (!removed) {
        throw new ConfigError(`${key} is not set in the config file`, {
          details: { key, path: context.config.filePath },
          hint: `its current value comes from '${context.config.sources[key]}'`,
        })
      }
      context.reporter.emit({ key, removed }, (payload, paint) =>
        `${paint('green', 'unset')} ${payload.key}`,
      )
    })

  command
    .command('path')
    .description('Print the config file path')
    .action(() => {
      const context = getContext()
      context.reporter.emit(
        { path: context.config.filePath, exists: context.config.fileExists },
        (payload) => payload.path,
      )
    })

  return command
}
