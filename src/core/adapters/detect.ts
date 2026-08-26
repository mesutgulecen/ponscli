import type { Address, PublicClient } from 'viem'

import { v1FactoryAbi, v2FactoryAbi } from '../../abi/index.js'
import { addresses } from '../../chain/addresses.js'
import { ExitCode, PonsError } from '../../errors.js'

/**
 * Which generation a token belongs to.
 *
 * Both factories keep a registry and both answer `getLaunchedToken` with an
 * `exists` flag, so the question is settled by asking both in one multicall
 * rather than by guessing from the address or trying one and catching the
 * failure. A token belongs to exactly one: the registries are per-factory and
 * a V2 launch's address is a CREATE2 output of the V2 deployer.
 */

export type Generation = 'v1' | 'v2'

export interface Detection {
  generation: Generation
  /** The curve, for V2. Undefined for V1, which has none. */
  curve?: Address
}

/**
 * Ask both factories at once.
 *
 * `allowFailure` is on because a factory answering a malformed reply for an
 * address it does not know is a real possibility on a chain-local deployment,
 * and one factory's failure must not decide the other's answer.
 */
export async function detectGeneration(client: PublicClient, token: Address): Promise<Detection> {
  const [v2, v1] = await client.multicall({
    contracts: [
      { address: addresses.v2Factory, abi: v2FactoryAbi, functionName: 'getLaunchedToken', args: [token] },
      { address: addresses.v1Factory, abi: v1FactoryAbi, functionName: 'getLaunchedToken', args: [token] },
    ],
    allowFailure: true,
  })

  if (v2.status === 'success' && v2.result.exists) {
    return { generation: 'v2', curve: v2.result.curve }
  }
  if (v1.status === 'success' && v1.result.exists) {
    return { generation: 'v1' }
  }

  throw new PonsError('TOKEN_NOT_FOUND', `${token} is not registered with either Pons factory`, {
    exitCode: ExitCode.Usage,
    details: { token, v1Factory: addresses.v1Factory, v2Factory: addresses.v2Factory },
    hint: 'check the address — an ordinary ERC-20 is not a Pons launch',
  })
}
