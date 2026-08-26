import {
  createPublicClient,
  createWalletClient,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'

import type { RpcPool } from '../chain/pool.js'
import { robinhoodChain } from '../chain/definition.js'
import { leaseTransport } from '../chain/transport.js'
import { ExitCode, PonsError } from '../errors.js'
import type { Plan } from '../core/plan.js'
import { decryptKeystore, readKeystoreFile } from './keystore.js'
import { readPassword } from './prompt.js'

/**
 * Signing, and the one place a transaction leaves this machine.
 *
 * The signer is only ever constructed when the user asked for it. Every other
 * path — read-only, `--unsigned`, `--dry-run` — never reaches this module, so
 * an agent cannot sign by accident: it would have to name a keystore and supply
 * its password.
 */

export interface Signer {
  address: Address
  account: PrivateKeyAccount
}

export interface LoadSignerOptions {
  keystorePath: string
  env?: NodeJS.ProcessEnv
  isTTY?: boolean
}

export async function loadSigner(options: LoadSignerOptions): Promise<Signer> {
  const keystore = readKeystoreFile(options.keystorePath)
  const password = await readPassword(`Password for ${keystore.address}: `, {
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.isTTY === undefined ? {} : { isTTY: options.isTTY }),
  })
  const privateKey = await decryptKeystore(keystore, password)
  const account = privateKeyToAccount(privateKey)
  return { address: account.address, account }
}

export interface SendResult {
  hash: Hex
  receipt: TransactionReceipt | undefined
  /** The endpoint the whole send was pinned to. */
  endpoint: string
  /** True when a hash exists but no receipt was seen before the timeout. */
  unconfirmed: boolean
}

export interface SendOptions {
  /** Gas limit to sign with. Required: nothing here guesses one. */
  gasLimit: bigint
  priorityFeeGwei?: number | undefined
  /** How long to wait for a receipt before returning the hash unconfirmed. */
  timeoutMs?: number
  onSubmitted?: (hash: Hex) => void
}

const RECEIPT_POLL_MS = 1_000
const RECEIPT_TIMEOUT_MS = 120_000

/**
 * Sign and broadcast a plan, then wait for its receipt.
 *
 * **Broadcast happens exactly once.** Once a hash exists the transaction may
 * land at any moment, and a retry — or a fallback to another endpoint — risks
 * a second transaction doing the same thing again with the user's money. If the
 * receipt does not arrive, the hash is returned unconfirmed and the user is
 * told to look it up; that is the honest outcome, and `pons tx <hash>` exists
 * for exactly this moment.
 *
 * **A failed broadcast is not the same as an unsent one.** The transaction is
 * signed before it is sent, so the hash always exists, and a failure is
 * resolved against the account's pending nonce instead of being asserted away.
 * Telling a user "nothing was sent" about a transaction the node already holds
 * is how the same trade gets made twice.
 *
 * The whole sequence is pinned to one endpoint. A nonce taken from one node and
 * broadcast to another is `nonce too low`, and a node 24 blocks behind has not
 * seen the transaction it is being asked about.
 */
export async function sendPlan(
  pool: RpcPool,
  signer: Signer,
  plan: Plan,
  options: SendOptions,
): Promise<SendResult> {
  const lease = pool.lease()
  const transport = leaseTransport(lease)
  const wallet: WalletClient = createWalletClient({
    account: signer.account,
    chain: robinhoodChain,
    transport,
  })
  // A reader over the same pinned endpoint, so the receipt poll cannot land on
  // a node that has not seen the broadcast.
  const pinned = createPublicClient({ chain: robinhoodChain, transport })

  const priorityFee =
    options.priorityFeeGwei === undefined
      ? undefined
      : BigInt(Math.round(options.priorityFeeGwei * 1e9))

  // Signed here rather than inside `sendTransaction`, so the hash exists before
  // anything leaves the machine. That is what makes an ambiguous failure
  // reportable: if the connection drops after the node has the bytes, the user
  // needs the hash to find out what happened, and a client that never computed
  // one can only shrug.
  const request = await wallet.prepareTransactionRequest({
    account: signer.account,
    chain: robinhoodChain,
    to: plan.to,
    data: plan.data,
    value: plan.value,
    gas: options.gasLimit,
    ...(priorityFee === undefined ? {} : { maxPriorityFeePerGas: priorityFee }),
  })
  const serialized = await signer.account.signTransaction(request as never)
  const hash = keccak256(serialized)

  try {
    await pinned.request({ method: 'eth_sendRawTransaction', params: [serialized] })
  } catch (error) {
    // The node may already hold it. `eth_sendRawTransaction` can fail after the
    // bytes arrive — a dropped connection, a timeout on the response — and the
    // client cannot tell that from a rejection. Ask the pinned endpoint whether
    // the nonce moved rather than guessing.
    const accepted = await noncePassed(pinned, signer.address, request.nonce)
    if (accepted) {
      throw new PonsError('BROADCAST_UNCERTAIN', 'the node may already have this transaction', {
        exitCode: ExitCode.Network,
        details: { plan: plan.id, hash, nonce: request.nonce, endpoint: lease.endpoint.label },
        cause: error,
        hint: `do not retry blindly — 'pons tx ${hash}' says whether it landed`,
      })
    }
    throw new PonsError('BROADCAST_FAILED', 'the transaction was not accepted', {
      exitCode: ExitCode.Network,
      details: { plan: plan.id, hash, nonce: request.nonce, endpoint: lease.endpoint.label },
      cause: error,
      hint: `the account's nonce is still ${String(request.nonce)}, so nothing was sent`,
    })
  }

  options.onSubmitted?.(hash)

  const deadline = Date.now() + (options.timeoutMs ?? RECEIPT_TIMEOUT_MS)
  while (Date.now() < deadline) {
    const receipt = await pollReceipt(pinned, hash)
    if (receipt !== undefined) {
      return { hash, receipt, endpoint: lease.endpoint.label, unconfirmed: false }
    }
    await new Promise((resolve) => setTimeout(resolve, RECEIPT_POLL_MS))
  }
  return { hash, receipt: undefined, endpoint: lease.endpoint.label, unconfirmed: true }
}

/**
 * Whether the account's pending nonce has moved past the one we signed.
 *
 * The only evidence available after an ambiguous broadcast. A node that
 * accepted the transaction counts it as pending; one that rejected it does not.
 * An endpoint that cannot answer leaves the question open, and an open question
 * has to be reported as uncertain rather than resolved in the direction that
 * happens to be convenient.
 */
async function noncePassed(
  client: PublicClient,
  address: Address,
  nonce: number | undefined,
): Promise<boolean> {
  if (nonce === undefined) return true
  try {
    const pending = await client.getTransactionCount({ address, blockTag: 'pending' })
    return pending > nonce
  } catch {
    return true
  }
}

/**
 * Ask the pinned endpoint for the receipt, treating an error as "not yet".
 *
 * A node answers `null` for a transaction it has not mined and can also refuse
 * the request outright while it catches up. Neither is a reason to give up on a
 * transaction that has already been broadcast.
 */
async function pollReceipt(client: PublicClient, hash: Hex): Promise<TransactionReceipt | undefined> {
  try {
    return await client.getTransactionReceipt({ hash })
  } catch {
    return undefined
  }
}

/** Balance of the signing account, read through the waterfall. */
export async function nativeBalance(client: PublicClient, address: Address): Promise<bigint> {
  return client.getBalance({ address })
}
