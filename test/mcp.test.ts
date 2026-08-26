import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { erc20Abi, numberToHex, type Address } from 'viem'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { v1FactoryAbi, v2CurveAbi, v2FactoryAbi } from '../src/abi/index.js'
import { addresses } from '../src/chain/addresses.js'
import { createMcpContext } from '../src/mcp/context.js'
import { createServer } from '../src/mcp/server.js'
import { fakeChain, type Answer } from './fakeChain.js'
import { createTempHome, type TempHome } from './helpers.js'

/**
 * The MCP server, driven through a real client over an in-memory transport.
 *
 * Not a unit test of the tool functions: the point is that a model connecting
 * to this binary can list the tools and call them, which is a property of the
 * protocol wiring rather than of the handlers.
 */

const V2_TOKEN: Address = '0x44D6736eB4Bc60c17Fe8220062d8fdE3C28920f4'
const CURVE: Address = '0x60CeF8379Aa278F087074bC60595778985c1bD8E'
const DEPLOYER: Address = '0xCAefbb5e99d0c48a7Aa49936662b174a3c2eaD61'
const NATIVE: Address = '0x0000000000000000000000000000000000000000'
const SUPPLY = 1_000_000_000_000_000_000_000_000_000n

/** A live native V2 launch, still on its curve. */
function answers(): Answer[] {
  return [
    {
      address: addresses.v2Factory,
      abi: v2FactoryAbi,
      functionName: 'getLaunchedToken',
      args: [V2_TOKEN],
      result: {
        token: V2_TOKEN,
        curve: CURVE,
        deployer: DEPLOYER,
        creatorFeeRecipient: DEPLOYER,
        pairToken: NATIVE,
        graduationThreshold: 4_200_000_000_000_000_000n,
        poolFee: 0,
        tickSpacing: 200,
        creatorTaxBps: 0,
        buybackEnabled: false,
        phase: 0,
        sweptQuote: 0n,
        sweptTokens: 0n,
        sweptAt: 0n,
        exists: true,
      },
    },
    {
      address: addresses.v1Factory,
      abi: v1FactoryAbi,
      functionName: 'getLaunchedToken',
      args: [V2_TOKEN],
      result: {
        token: NATIVE,
        deployer: NATIVE,
        pairedToken: NATIVE,
        positionManager: NATIVE,
        positionId: 0n,
        dexId: 0n,
        launchConfigId: 0n,
        restrictionsEndBlock: 0n,
        supply: 0n,
        isToken0: false,
        poolFee: 0,
        exists: false,
        initialBuyAmount: 0n,
      },
    },
    { address: CURVE, abi: v2CurveAbi, functionName: 'getReserves', result: [5_000_000_000_000_000_000n, 900_000_000_000_000_000_000_000_000n] },
    { address: CURVE, abi: v2CurveAbi, functionName: 'realQuoteReserve', result: 3_320_000_000_000_000_000n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'phantomQuote', result: 1_680_000_000_000_000_000n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'sellableTokens', result: 614_285_714_285_714_285_714_285_715n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'reservedTokens', result: 285_714_285_714_285_714_285_714_285n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'readyToGraduate', result: false },
    { address: CURVE, abi: v2CurveAbi, functionName: 'graduated', result: false },
    { address: CURVE, abi: v2CurveAbi, functionName: 'launchedAt', result: 1_787_654_670n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'snipeTaxStartBps', result: 9_900n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'snipeTaxSeconds', result: 3n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'currentSnipeTaxBps', args: [NATIVE], result: 0n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'currentSnipeTaxBps', args: [DEPLOYER], result: 0n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'feeBps', result: 100n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'creatorTaxBps', result: 0n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'buybackEnabled', result: false },
    { address: CURVE, abi: v2CurveAbi, functionName: 'buybackQuoteBalance', result: 0n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'quoteFeeBalance', result: 0n },
    { address: CURVE, abi: v2CurveAbi, functionName: 'creatorTaxBalance', result: 0n },
    { address: V2_TOKEN, abi: erc20Abi, functionName: 'name', result: 'Probe' },
    { address: V2_TOKEN, abi: erc20Abi, functionName: 'symbol', result: 'PROBE' },
    { address: V2_TOKEN, abi: erc20Abi, functionName: 'decimals', result: 18 },
    { address: V2_TOKEN, abi: erc20Abi, functionName: 'totalSupply', result: SUPPLY },
    {
      address: addresses.v2Factory,
      abi: v2FactoryAbi,
      functionName: 'getLaunchFeePolicy',
      args: [V2_TOKEN],
      result: {
        protocolFeeRecipient: DEPLOYER,
        protocolFeeShareBps: 3_000,
        buybackBurnBps: 5_000,
        hookFeeBps: 100,
        maxInternalPriceImpactBps: 500,
      },
    },
  ]
}

interface ToolText {
  content: { type: string; text?: string }[]
  isError?: boolean
}

describe('pons-mcp', () => {
  let home: TempHome
  let client: Client

  beforeEach(async () => {
    home = createTempHome()
    const context = createMcpContext({
      env: home.env,
      home: home.home,
      dispatch: fakeChain({
        answers: answers(),
        methods: { eth_blockNumber: numberToHex(45_676_251) },
      }),
    })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'test', version: '0' })
    await Promise.all([client.connect(clientSide), createServer(context).connect(serverSide)])
  })

  afterEach(async () => {
    await client.close()
    home.cleanup()
  })

  function textOf(result: unknown): string {
    return (result as ToolText).content[0]?.text ?? ''
  }

  it('advertises its tools', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'pons_endpoints',
      'pons_info',
      'pons_pairs',
      'pons_plan_buy',
      'pons_plan_sell',
      'pons_transaction',
    ])
  })

  it('offers no tool that signs or sends', async () => {
    const { tools } = await client.listTools()
    // The boundary that makes the server safe to leave running: it reads and it
    // plans. A tool named send/sign/broadcast/confirm here would be a bug.
    expect(tools.filter((tool) => /send|sign|broadcast|confirm/i.test(tool.name))).toEqual([])
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true)
    }
  })

  it('reads a launch and names its generation', async () => {
    const result = await client.callTool({ name: 'pons_info', arguments: { token: V2_TOKEN } })
    const payload = JSON.parse(textOf(result)) as { generation: string; symbol: string; venue: string }
    expect(payload.generation).toBe('v2')
    expect(payload.symbol).toBe('PROBE')
    expect(payload.venue).toBe('bonding curve')
  })

  it('answers in base units, not formatted numbers', async () => {
    const result = await client.callTool({ name: 'pons_info', arguments: { token: V2_TOKEN } })
    const payload = JSON.parse(textOf(result)) as { totalSupply: string; decimals: number }
    // A model can do exact arithmetic on this and cannot on "1,000,000,000".
    expect(payload.totalSupply).toBe(SUPPLY.toString())
    expect(payload.decimals).toBe(18)
  })

  it('builds an unsigned buy with a simulation', async () => {
    const result = await client.callTool({
      name: 'pons_plan_buy',
      arguments: { token: V2_TOKEN, amount: '0.05', account: DEPLOYER },
    })
    const payload = JSON.parse(textOf(result)) as {
      plan: { to: Address; route: string; data: string; value: string }
      simulation: { ok: boolean }
      signing: string
    }
    expect(payload.plan.route).toBe('curve')
    expect(payload.plan.to).toBe(CURVE)
    expect(payload.plan.value).toBe('50000000000000000')
    expect(payload.plan.data.startsWith('0x')).toBe(true)
    expect(payload.signing).toMatch(/never signs/)
  })

  it('reports a bad address as a tool error rather than crashing the server', async () => {
    const result = (await client.callTool({
      name: 'pons_info',
      arguments: { token: 'not-an-address' },
    })) as ToolText
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/not an address/)
    // The connection has to survive it: a stdio server that dies on bad input
    // takes the whole session with it.
    const { tools } = await client.listTools()
    expect(tools.length).toBeGreaterThan(0)
  })

  it('rejects an out-of-range slippage at the schema, before any RPC', async () => {
    const result = (await client.callTool({
      name: 'pons_plan_buy',
      arguments: { token: V2_TOKEN, amount: '0.05', account: DEPLOYER, slippageBps: 50_000 },
    })) as ToolText
    expect(result.isError).toBe(true)
  })
})
