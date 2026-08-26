import { Command } from 'commander'
import { encodeFunctionData, erc20Abi, getAddress, isAddress, type Address } from 'viem'
import { generatePrivateKey } from 'viem/accounts'

import { NATIVE_TRANSFER_GAS_LIMIT } from '../chain/definition.js'
import { setConfigValue } from '../config/index.js'
import type { CommandContext } from '../context.js'
import { parseAmountSpec, resolveAmount } from '../core/amount.js'
import { createPlan, warn, type Plan } from '../core/plan.js'
import { ExitCode, PonsError, UsageError } from '../errors.js'
import { renderTable, type Painter } from '../output/index.js'
import { formatAmount, formatToken } from '../output/format.js'
import {
  decryptKeystore,
  encryptPrivateKey,
  readKeystoreFile,
  writeKeystoreFile,
} from '../wallet/keystore.js'
import { readNewPassword, readPassword } from '../wallet/prompt.js'
import { addWriteFlags, runPlan, type WriteFlags } from './execute.js'

/**
 * `pons wallet` — the key, and what it holds.
 *
 * The private key exists in memory for exactly as long as a signature needs it
 * and is never written anywhere but the encrypted keystore. Nothing in this
 * file accepts a key on the command line: argv is visible in the process table
 * and lands in shell history.
 */

const PRIVATE_KEY_ENV = 'PONS_PRIVATE_KEY'

function assertAddress(raw: string, what = 'address'): Address {
  if (!isAddress(raw, { strict: false })) throw new UsageError(`${raw} is not a valid ${what}`)
  return getAddress(raw)
}

function keystorePath(context: CommandContext): string {
  return context.config.values['wallet.keystore']
}

/** The account, read from the keystore's cleartext address field. */
function accountOf(context: CommandContext, override?: string): Address {
  if (override !== undefined) return assertAddress(override, 'account address')
  return readKeystoreFile(keystorePath(context)).address
}

interface BalanceRow {
  address: Address | null
  symbol: string
  decimals: number
  balance: string
}

interface BalancePayload {
  account: Address
  native: string
  tokens: BalanceRow[]
}

function renderBalance(payload: BalancePayload, paint: Painter): string {
  const rows = [
    ['ETH', formatAmount(BigInt(payload.native), 18), paint('grey', 'native')],
    ...payload.tokens.map((token) => [
      token.symbol,
      formatAmount(BigInt(token.balance), token.decimals),
      paint('grey', token.address ?? ''),
    ]),
  ]
  return [
    `${paint('bold', payload.account)}`,
    '',
    renderTable(
      [{ header: 'ASSET' }, { header: 'BALANCE', align: 'right' as const }, { header: '' }],
      rows,
      '  ',
    ),
  ].join('\n')
}

export function createWalletCommand(getContext: () => CommandContext): Command {
  const command = new Command('wallet').description('Create, inspect and spend from the local key')

  command
    .command('create')
    .description('Generate a key and write it to an encrypted keystore')
    .option('--force', 'Overwrite an existing keystore. There is no undo')
    .action(async (flags: { force?: boolean }) => {
      const context = getContext()
      const path = keystorePath(context)
      const password = await readNewPassword({
        env: context.resolveContext.env,
        isTTY: context.resolveContext.isTTY,
      })
      const privateKey = generatePrivateKey()
      const keystore = await encryptPrivateKey(privateKey, password)
      writeKeystoreFile(path, keystore, { force: flags.force === true })
      context.reporter.emit({ address: keystore.address, path }, (payload, paint) =>
        [
          `${paint('green', 'created')} ${payload.address}`,
          paint('grey', `  ${payload.path}`),
          paint('yellow', '  the only copy of this key is that file — back it up before funding it'),
        ].join('\n'),
      )
    })

  command
    .command('import')
    .description(`Encrypt an existing key. Read from ${PRIVATE_KEY_ENV}, never from a flag`)
    .option('--force', 'Overwrite an existing keystore. There is no undo')
    .action(async (flags: { force?: boolean }) => {
      const context = getContext()
      const privateKey = context.resolveContext.env[PRIVATE_KEY_ENV]
      if (privateKey === undefined || privateKey === '') {
        throw new PonsError('WALLET_NO_KEY', `set ${PRIVATE_KEY_ENV} to the key to import`, {
          exitCode: ExitCode.Wallet,
          hint: 'a key passed as an argument would be visible in the process table and the shell history',
        })
      }
      const path = keystorePath(context)
      const password = await readNewPassword({
        env: context.resolveContext.env,
        isTTY: context.resolveContext.isTTY,
      })
      const keystore = await encryptPrivateKey(privateKey, password)
      writeKeystoreFile(path, keystore, { force: flags.force === true })
      context.reporter.emit({ address: keystore.address, path }, (payload, paint) =>
        `${paint('green', 'imported')} ${payload.address}\n${paint('grey', `  ${payload.path}`)}`,
      )
    })

  command
    .command('show')
    .description('Print the keystore address. Needs no password')
    .action(() => {
      const context = getContext()
      const path = keystorePath(context)
      const keystore = readKeystoreFile(path)
      context.reporter.emit(
        { address: keystore.address, path, createdAt: keystore.createdAt },
        (payload, paint) => `${payload.address}\n${paint('grey', `  ${payload.path}`)}`,
      )
    })

  command
    .command('export')
    .description('Decrypt and print the private key')
    .option('--yes', 'Required. Printing a key puts it in your scrollback')
    .action(async (flags: { yes?: boolean }) => {
      const context = getContext()
      if (flags.yes !== true) {
        throw new UsageError('refusing to print a private key without --yes', {
          hint: 'it will land in your terminal scrollback and, if piped, in a file',
        })
      }
      const keystore = readKeystoreFile(keystorePath(context))
      const password = await readPassword(`Password for ${keystore.address}: `, {
        env: context.resolveContext.env,
        isTTY: context.resolveContext.isTTY,
      })
      const privateKey = await decryptKeystore(keystore, password)
      context.reporter.emit({ address: keystore.address, privateKey }, (payload) => payload.privateKey)
    })

  command
    .command('balance')
    .description('Native balance, plus every tracked token')
    .option('--token <address...>', 'Additional tokens to report')
    .option('--account <address>', 'Read a different address than the keystore')
    .action(async (flags: { token?: string[]; account?: string }) => {
      const context = getContext()
      const account = accountOf(context, flags.account)
      const { client } = context.rpc()

      const tracked = [...context.config.values['wallet.tracked'], ...(flags.token ?? [])]
        .map((entry) => assertAddress(entry, 'token address'))
        .filter((entry, index, all) => all.indexOf(entry) === index)

      const native = await client.getBalance({ address: account })
      const tokens: BalanceRow[] = []
      if (tracked.length > 0) {
        const results = await client.multicall({
          contracts: tracked.flatMap((token) => [
            { address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] } as const,
            { address: token, abi: erc20Abi, functionName: 'symbol' } as const,
            { address: token, abi: erc20Abi, functionName: 'decimals' } as const,
          ]),
        })
        tracked.forEach((token, index) => {
          const [balance, symbol, decimals] = results.slice(index * 3, index * 3 + 3)
          tokens.push({
            address: token,
            // An address that will not answer is still reported, with its
            // address as its name: dropping the row would look like a zero.
            symbol: symbol?.status === 'success' ? (symbol.result as string) : token.slice(0, 10),
            decimals: decimals?.status === 'success' ? (decimals.result as number) : 18,
            balance: balance?.status === 'success' ? (balance.result as bigint).toString() : '0',
          })
        })
      }

      context.reporter.emit({ account, native: native.toString(), tokens }, renderBalance)
    })

  command
    .command('track')
    .argument('<token>', 'Token address')
    .description('Add a token to the balance report')
    .action((rawToken: string) => {
      const context = getContext()
      const token = assertAddress(rawToken, 'token address')
      const current = context.config.values['wallet.tracked']
      if (current.some((entry) => entry.toLowerCase() === token.toLowerCase())) {
        context.reporter.note(`${token} is already tracked`)
        context.reporter.emit({ tracked: current }, () => current.join('\n'))
        return
      }
      const next = [...current, token]
      setConfigValue('wallet.tracked', next.join(','), context.resolveContext)
      context.reporter.emit({ tracked: next }, (payload, paint) =>
        `${paint('green', 'tracking')} ${token}\n${paint('grey', `  ${String(payload.tracked.length)} tracked`)}`,
      )
    })

  command
    .command('untrack')
    .argument('<token>', 'Token address')
    .description('Remove a token from the balance report')
    .action((rawToken: string) => {
      const context = getContext()
      const token = assertAddress(rawToken, 'token address')
      const current = context.config.values['wallet.tracked']
      const next = current.filter((entry) => entry.toLowerCase() !== token.toLowerCase())
      if (next.length === current.length) {
        throw new PonsError('NOT_TRACKED', `${token} is not tracked`, { exitCode: ExitCode.Usage })
      }
      setConfigValue('wallet.tracked', next.join(','), context.resolveContext)
      context.reporter.emit({ tracked: next }, (payload, paint) =>
        `${paint('green', 'untracked')} ${token}\n${paint('grey', `  ${String(payload.tracked.length)} tracked`)}`,
      )
    })

  addWriteFlags(
    command
      .command('transfer')
      .argument('<to>', 'Recipient address')
      .argument('<amount>', "Amount, a percentage, or 'all'")
      .option('--token <address>', 'Send an ERC-20 instead of native ETH')
      .description('Send ETH or a token'),
  ).action(async (rawTo: string, rawAmount: string, flags: WriteFlags & { token?: string }) => {
    const context = getContext()
    const to = assertAddress(rawTo, 'recipient address')
    const account = accountOf(context)
    const { client } = context.rpc()

    if (flags.token === undefined) {
      const balance = await client.getBalance({ address: account })
      const spec = parseAmountSpec(rawAmount, 18, 'amount')
      const amount = resolveAmount(spec, balance)
      // 'all' on the native asset cannot mean the whole balance: the gas has
      // to come out of it, and a transfer that leaves nothing for its own fee
      // simply fails. `sweep` exists for that case and does the arithmetic.
      if (spec.kind === 'all') {
        throw new UsageError("use 'pons wallet sweep <recipient>' to move an entire ETH balance", {
          hint: 'a native transfer has to leave enough behind to pay for itself',
        })
      }
      await runPlan({ context, plan: nativeTransferPlan(to, amount), flags })
      return
    }

    const token = assertAddress(flags.token, 'token address')
    const [balance, symbol, decimals] = await client.multicall({
      contracts: [
        { address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] },
        { address: token, abi: erc20Abi, functionName: 'symbol' },
        { address: token, abi: erc20Abi, functionName: 'decimals' },
      ],
      allowFailure: false,
    })
    const amount = resolveAmount(parseAmountSpec(rawAmount, decimals, 'amount'), balance)
    if (amount <= 0n) throw new UsageError(`${account} holds no ${symbol}`)
    if (amount > balance) {
      throw new PonsError('INSUFFICIENT_BALANCE', `${account} holds ${formatToken(balance, decimals, symbol)}`, {
        exitCode: ExitCode.Usage,
        details: { requested: amount.toString(), balance: balance.toString() },
      })
    }

    await runPlan({
      context,
      plan: createPlan({
        kind: 'transfer',
        route: 'erc20',
        to: token,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
        value: 0n,
        gasLimit: undefined,
        summary: `send ${formatToken(amount, decimals, symbol)} to ${to}`,
        warnings: [],
        economics: { token, to, amount: amount.toString() },
      }),
      flags,
    })
  })

  addWriteFlags(
    command
      .command('sweep')
      .argument('<recipient>', 'Where to send the balance')
      .description('Send the whole native balance, less what the transfer itself costs'),
  ).action(async (rawTo: string, flags: WriteFlags) => {
    const context = getContext()
    const to = assertAddress(rawTo, 'recipient address')
    const account = accountOf(context)
    const { client } = context.rpc()

    const [balance, fees] = await Promise.all([
      client.getBalance({ address: account }),
      client.estimateFeesPerGas(),
    ])
    const gasPrice = fees.maxFeePerGas
    // Twenty percent over the fee at the current base rate. The base fee can
    // rise between building this and it landing, and a sweep that leaves too
    // little strands the balance rather than moving it.
    const reserve = (NATIVE_TRANSFER_GAS_LIMIT * gasPrice * 12n) / 10n
    if (balance <= reserve) {
      throw new PonsError('NOTHING_TO_SWEEP', 'the balance would not cover the transfer that moves it', {
        exitCode: ExitCode.Usage,
        details: { balance: balance.toString(), reserve: reserve.toString() },
      })
    }
    const amount = balance - reserve

    await runPlan({
      context,
      plan: {
        ...nativeTransferPlan(to, amount),
        summary: `sweep ${formatToken(amount, 18, 'ETH')} to ${to}`,
        warnings: [
          warn(
            'gas-reserve',
            `${formatToken(reserve, 18, 'ETH')} stays behind to pay for this transfer`,
            'info',
          ),
        ],
      },
      flags,
    })
  })

  return command
}

/**
 * A native transfer, always at a fixed gas limit.
 *
 * Nitro charges the L1 posting cost out of the transaction's own limit and
 * `eth_estimateGas` answers 21,000 for a transfer that burns up to 21,145. It
 * works while L1 is cheap, which is what makes the failure intermittent and the
 * fixed limit non-negotiable.
 */
function nativeTransferPlan(to: Address, amount: bigint): Plan {
  return createPlan({
    kind: 'transfer',
    route: 'native',
    to,
    data: '0x',
    value: amount,
    gasLimit: NATIVE_TRANSFER_GAS_LIMIT,
    summary: `send ${formatToken(amount, 18, 'ETH')} to ${to}`,
    warnings: [],
    economics: { to, amount: amount.toString(), gasLimit: NATIVE_TRANSFER_GAS_LIMIT.toString() },
  })
}
