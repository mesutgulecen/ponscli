#!/usr/bin/env node
/**
 * Fetch verified ABIs from Sourcify and write them into `src/abi/`.
 *
 * The generated files are committed. That is deliberate: the CLI must work
 * offline and must not depend on a third party being reachable at runtime, and
 * a committed ABI shows up in a diff when a redeployment changes it.
 *
 * Sourcify is the source rather than the contract repository because it proves
 * the ABI matches the bytecode actually deployed at that address. A repository
 * checkout only proves what somebody compiled.
 *
 * Two kinds of ABI are produced:
 *
 *  - **Fetched** — the verifier holds an ABI for the address; take it.
 *  - **Derived** — the contract is not verified at its own address, but its
 *    source is part of a verified contract's compilation. Compile that same
 *    standard-JSON input locally and prove the result by matching the compiled
 *    runtime bytecode against a live instance. See `DERIVED` below.
 *
 * Usage: node scripts/fetch-abis.mjs [--check] [--refresh]
 *   --check    verify the committed files are current, without rewriting them
 *   --refresh  re-fetch every ABI, including ones already committed
 *
 * By default a committed ABI is left alone and only missing files are fetched.
 * Blockscout's public API is a token bucket that a nine-contract sweep drains
 * in two consecutive runs, and adding one new contract should not cost the
 * other nine their quota. `--check` and `--refresh` still ask for everything,
 * because that is the whole point of those two modes.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { toEventSelector, toFunctionSelector } from 'viem'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'src', 'abi')
const CHAIN_ID = 4663
const SOURCIFY = 'https://sourcify.dev/server'
const BLOCKSCOUT = 'https://robinhoodchain.blockscout.com/api'
const RPC = 'https://rpc.mainnet.chain.robinhood.com'

/**
 * Identify ourselves. The public endpoints answer 403 to a request that
 * carries no User-Agent; see `src/chain/transport.ts` for the measurement.
 */
const USER_AGENT = 'ponscli-abi-fetch'

/** Each entry becomes `src/abi/<name>.ts` exporting `<name>Abi`. */
const CONTRACTS = [
  { name: 'v2Factory', address: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e' },
  { name: 'v1Factory', address: '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB' },
  { name: 'memeHook', address: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044' },
  { name: 'feeEscrow', address: '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e' },
  { name: 'buybackVault', address: '0x42df2a798f82289e177311362e8f5ccc45c1219c' },
  { name: 'v3SwapRouter', address: '0xcaf681a66d020601342297493863e78c959e5cb2' },
  { name: 'universalRouter', address: '0x8876789976decbfcbbbe364623c63652db8c0904' },
  { name: 'poolManager', address: '0x8366a39cc670b4001a1121b8f6a443a643e40951' },
  { name: 'v4Quoter', address: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94' },
  { name: 'v4StateView', address: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b' },
  { name: 'launchAndBuy', address: '0xe33E9E479dF8802cb0866d5d05258bEc4cF62948' },
  { name: 'launchDeployer', address: '0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42' },
  { name: 'v3Quoter', address: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7' },
  { name: 'v1Locker', address: '0x736D76699C26D0d966744cAe304C000d471f7F35' },
]

/**
 * ABIs read from one verified instance of a contract deployed many times.
 *
 * A Uniswap V3 pool has no single canonical address: the factory makes one per
 * pair, all from the same creation code. One of them is verified on
 * Blockscout, and its ABI describes every other — but "describes every other"
 * is an assertion, so the generator proves it the way it proves Permit2:
 * every function selector must also be present in the bytecode of a second,
 * independently chosen pool, and both runtimes must be the same length.
 *
 * The two pools are not byte-identical and cannot be. A V3 pool holds
 * `factory`, `token0`, `token1`, `fee` and `tickSpacing` as immutables, which
 * live inside the runtime code.
 */
const INSTANCE = [
  {
    name: 'v3Pool',
    /** The pool for a Pons V1 launch, verified on Blockscout as UniswapV3Pool. */
    address: '0x2D0edeF70886383C395D8207Bf22B8c29c974a7c',
    /** A different Pons V1 launch's pool, to prove the ABI is not specific. */
    other: '0x4783B5fEB1BfA4c030e18170aD01eB790722Aa4D',
  },
  {
    /**
     * V1's launch token, one per launch and verified at some of them.
     *
     * Not derived from the factory's standard-JSON the way V2's token is: the
     * V1 factory was compiled with **solc 0.8.30**, V2 with 0.8.35, and the
     * `solc` package installs exactly one version. Rather than pull a second
     * compiler over the network at generate time, this takes the ABI from an
     * instance a verifier already matched against deployed bytecode, and
     * proves it generalises against a second instance.
     *
     * The ABI matters for the same reason V2's does: a `sell` that was never
     * approved reverts from the token, and V1's launch-window transfer caps
     * (`maxWalletLimit`, `maxTxLimit`) are readable nowhere else.
     */
    name: 'v1Token',
    address: '0x97133372cC4391A4F6889b4d52387649B76BC7EC',
    other: '0x8859036BBD9D8c51b7146aeaC45f1e5D6056aBDf',
  },
]

/**
 * ABIs taken from another chain's verification of the same deployment.
 *
 * Permit2 is deployed deterministically: the same bytecode at the same address
 * on every chain. Robinhood's copy is verified nowhere, but Base's is on
 * Sourcify, and the two are the same contract. Rather than trusting that
 * assertion, the generator proves it here — every function selector in the
 * fetched ABI must appear in the bytecode actually deployed on this chain, and
 * the two runtimes must be the same length. An interface that had drifted
 * would be missing selectors.
 *
 * The two runtimes are *not* byte-identical and cannot be: Permit2 caches its
 * EIP-712 domain separator, which contains the chain id, in an immutable.
 */
const CROSS_CHAIN = [
  {
    name: 'permit2',
    address: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    /** Base. Chosen because its Permit2 is Sourcify-verified. */
    referenceChain: 8453,
  },
]

/**
 * ABIs compiled locally from a verified contract's own standard-JSON input.
 *
 * The bonding curve is deployed once per launch and none of those instances is
 * verified anywhere — but its source is one of the 87 files inside the V2
 * factory's verified compilation, so the exact compiler, settings and imports
 * that produced the deployed curve are all published. Compiling that input and
 * matching the result against a live curve is a stronger claim than a verifier
 * record: it shows the ABI belongs to the bytecode that is actually running.
 */
const DERIVED = [
  {
    name: 'v2Curve',
    contract: 'PonsV2BondingCurve',
    source: 'contracts/src/v2/PonsV2BondingCurve.sol',
    /** The verified contract whose compilation includes `source`. */
    verifiedAt: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
    /** Where to find a live instance to check the compiled bytecode against. */
    witness: {
      address: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
      event: 'TokenLaunched(address,address,address,address,uint256,uint256)',
      /** The instance address sits in this indexed position of the event. */
      topic: 2,
    },
  },
  {
    // The launch token carries OpenZeppelin's ERC-20 errors, which is what a
    // failed `sell` actually reverts with — an allowance shortfall surfaces
    // from the token, not from the curve.
    name: 'v2Token',
    contract: 'PonsV2LauncherToken',
    source: 'contracts/src/v2/PonsV2LauncherToken.sol',
    verifiedAt: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
    witness: {
      address: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
      event: 'TokenLaunched(address,address,address,address,uint256,uint256)',
      topic: 1,
    },
  },
]

/**
 * One HTTP GET with bounded retries.
 *
 * Blockscout answered a 500 for one address and 200 for the same address
 * seconds later. Regenerating ABIs must not depend on which second it runs in,
 * or `--check` becomes a flaky CI gate.
 */
async function getJson(url, attempts = 4) {
  let lastStatus = 0
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    })
    if (response.status === 404) return { status: 404, body: null }
    if (response.ok) return { status: response.status, body: await response.json() }
    lastStatus = response.status
    if (response.status < 500 && response.status !== 429) break
    // Blockscout's public API is a token bucket and it refills slowly enough
    // that a 400 ms backoff runs out of attempts on the second consecutive run.
    const delay = response.status === 429 ? 2000 * attempt : 400 * attempt
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
  return { status: lastStatus, body: null }
}

/** One JSON-RPC call against the official endpoint. */
async function rpc(method, params) {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`)
  const body = await response.json()
  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result
}

async function fromSourcify(address, chainId = CHAIN_ID) {
  const url = `${SOURCIFY}/v2/contract/${chainId}/${address}?fields=abi,compilation`
  const { status, body } = await getJson(url)
  if (body === null) {
    if (status === 404) return null
    throw new Error(`sourcify ${status} for ${address}`)
  }
  if (!Array.isArray(body.abi)) return null
  return {
    abi: body.abi,
    provenance: 'Sourcify',
    contract: body.compilation?.name,
    compiler: body.compilation?.compilerVersion,
    detail: `${body.match ?? 'unknown'} (verified ${body.verifiedAt ?? 'unknown'})`,
  }
}

async function fromBlockscout(address) {
  const url = `${BLOCKSCOUT}?module=contract&action=getabi&address=${address}`
  const { status, body } = await getJson(url)
  if (body === null) throw new Error(`blockscout ${status} for ${address}`)
  if (body.message !== 'OK' || typeof body.result !== 'string') return null
  const abi = JSON.parse(body.result)
  if (!Array.isArray(abi) || abi.length === 0) return null
  return { abi, provenance: 'Blockscout', detail: 'source-verified' }
}

/**
 * Sourcify first, Blockscout second.
 *
 * Sourcify records an explicit exact/partial match against deployed bytecode,
 * which is a stronger claim than "somebody uploaded matching source". The chain
 * hosts its own Uniswap deployments and those are only on Blockscout, so the
 * fallback is necessary rather than optional; the provenance is written into
 * the generated file so the weaker guarantee is visible in review.
 */
async function fetchContract(address) {
  const preferred = await fromSourcify(address)
  if (preferred !== null) return preferred
  const fallback = await fromBlockscout(address)
  if (fallback !== null) return fallback
  throw new Error(`no verified ABI on Sourcify or Blockscout for ${address}`)
}

/** The verified standard-JSON input that produced `address`, plus its settings. */
async function fetchStandardInput(address) {
  const url = `${SOURCIFY}/v2/contract/${CHAIN_ID}/${address}?fields=stdJsonInput,compilation`
  const { status, body } = await getJson(url)
  if (body?.stdJsonInput === undefined) {
    throw new Error(`sourcify ${status} holds no standard-JSON input for ${address}`)
  }
  return { input: body.stdJsonInput, compiler: body.compilation?.compilerVersion }
}

/**
 * Compile one contract out of a standard-JSON input.
 *
 * Only the target contract's ABI and runtime bytecode are requested. solc still
 * parses all 87 sources, but it generates code for one contract, which is why
 * this takes about two seconds rather than the minutes a full viaIR build of
 * the factory would.
 */
function compileOne(input, source, contract, expectedCompiler) {
  const require = createRequire(import.meta.url)
  let solc
  try {
    solc = require('solc')
  } catch {
    throw new Error("solc is not installed; run 'npm install' to get the dev dependencies")
  }
  // The compiler is pinned in package.json because the ABI is only as good as
  // the bytecode match below, and that match is compiler-specific.
  const actual = solc.version().replace('.Emscripten.clang', '')
  if (expectedCompiler !== undefined && actual !== expectedCompiler) {
    throw new Error(`solc ${actual} installed, but ${expectedCompiler} verified the source`)
  }
  const request = {
    ...input,
    settings: { ...input.settings, outputSelection: { [source]: { [contract]: ['abi', 'evm.deployedBytecode'] } } },
  }
  const output = JSON.parse(solc.compile(JSON.stringify(request)))
  const errors = (output.errors ?? []).filter((entry) => entry.severity === 'error')
  if (errors.length > 0) throw new Error(errors.map((entry) => entry.formattedMessage).join('\n'))
  const compiled = output.contracts?.[source]?.[contract]
  if (compiled === undefined) throw new Error(`${contract} is not in ${source}`)
  return {
    abi: compiled.abi,
    runtime: compiled.evm.deployedBytecode.object,
    immutables: compiled.evm.deployedBytecode.immutableReferences ?? {},
    compiler: actual,
  }
}

/** Address of the most recently deployed instance, read out of an event log. */
async function findInstance(witness) {
  const head = BigInt(await rpc('eth_blockNumber', []))
  const topic0 = toEventSelector(witness.event)
  // Widening rather than one large window: the official endpoint serves a
  // million-block query in about a second, but a narrow one is cheaper and
  // almost always enough on a chain launching tokens every few minutes.
  for (const span of [20_000n, 200_000n, 2_000_000n]) {
    const from = head > span ? head - span : 0n
    const logs = await rpc('eth_getLogs', [
      { address: witness.address, topics: [topic0], fromBlock: `0x${from.toString(16)}`, toBlock: 'latest' },
    ])
    const last = logs.at(-1)
    if (last !== undefined) {
      return { address: `0x${last.topics[witness.topic].slice(-40)}`, block: BigInt(last.blockNumber) }
    }
  }
  throw new Error(`no ${witness.event} log found in the last 2,000,000 blocks`)
}

/**
 * Blank out immutable values so two instances of one contract compare equal.
 *
 * Immutables are written into the runtime bytecode at construction, so the
 * compiler's output carries zeroes where a deployed instance carries its
 * factory address, fee policy and curve parameters. Everything outside those
 * spans must match byte for byte.
 */
function maskImmutables(hex, immutables) {
  const nibbles = hex.split('')
  for (const spans of Object.values(immutables)) {
    for (const { start, length } of spans) {
      for (let index = start * 2; index < (start + length) * 2; index += 1) nibbles[index] = '.'
    }
  }
  return nibbles.join('')
}

async function deriveContract(spec) {
  const { input, compiler } = await fetchStandardInput(spec.verifiedAt)
  const compiled = compileOne(input, spec.source, spec.contract, compiler)
  const instance = await findInstance(spec.witness)
  const deployed = (await rpc('eth_getCode', [instance.address, 'latest'])).slice(2)
  const immutableCount = Object.keys(compiled.immutables).length
  if (
    maskImmutables(compiled.runtime, compiled.immutables) !==
    maskImmutables(deployed, compiled.immutables)
  ) {
    throw new Error(
      `compiled ${spec.contract} does not match the instance at ${instance.address}; ` +
        'the deployed curve may have been rebuilt from newer source',
    )
  }
  return {
    abi: compiled.abi,
    provenance: `local solc, from the verified standard-JSON input of ${spec.verifiedAt}`,
    contract: spec.contract,
    compiler: compiled.compiler,
    detail: `runtime bytecode matches a live instance exactly, modulo ${immutableCount} immutables`,
    instance,
  }
}

/**
 * Four-byte selectors of every function in an ABI, computed the way the EVM
 * dispatcher does.
 *
 * The ABI entry is handed to viem whole rather than being flattened into a
 * signature string first: a tuple parameter's canonical form is its component
 * types in parentheses, and writing the literal word `tuple` produces a
 * plausible-looking selector that matches nothing. Eight of Permit2's fifteen
 * functions take tuples, so the shortcut fails most of the contract.
 */
function selectorsOf(abi) {
  return abi
    .filter((entry) => entry.type === 'function')
    .map((entry) => toFunctionSelector(entry).slice(2))
}

/**
 * Prove one verified instance's ABI describes its siblings.
 *
 * Same standard as the cross-chain check: selector presence in a second
 * deployment's bytecode, plus equal runtime length. What it rules out is an
 * ABI taken from a pool that turned out to be a different implementation.
 */
async function instanceContract(spec) {
  const reference = await fetchContract(spec.address)
  if (reference === null) throw new Error(`no verifier record for ${spec.address}`)

  const other = (await rpc('eth_getCode', [spec.other, 'latest'])).slice(2).toLowerCase()
  const self = (await rpc('eth_getCode', [spec.address, 'latest'])).slice(2).toLowerCase()
  if (other.length === 0) throw new Error(`nothing is deployed at ${spec.other}`)
  if (other.length !== self.length) {
    throw new Error(
      `${spec.address} and ${spec.other} have different runtime lengths (${self.length / 2} vs ${other.length / 2} bytes)`,
    )
  }

  const selectors = selectorsOf(reference.abi)
  const missing = selectors.filter((selector) => !other.includes(selector))
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} of ${selectors.length} selectors are absent from the sibling instance ${spec.other}`,
    )
  }
  return {
    ...reference,
    detail: `all ${selectors.length} selectors present in a second instance (${spec.other}), both ${self.length / 2} bytes`,
  }
}

async function crossChainContract(spec) {
  const reference = await fromSourcify(spec.address, spec.referenceChain)
  if (reference === null) {
    throw new Error(`no Sourcify record on chain ${spec.referenceChain} for ${spec.address}`)
  }
  const deployed = (await rpc('eth_getCode', [spec.address, 'latest'])).slice(2).toLowerCase()
  if (deployed.length === 0) throw new Error(`nothing is deployed at ${spec.address} on chain ${CHAIN_ID}`)

  const selectors = selectorsOf(reference.abi)
  const missing = selectors.filter((selector) => !deployed.includes(selector))
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} of ${selectors.length} selectors from the chain-${spec.referenceChain} ABI are absent from the bytecode on chain ${CHAIN_ID}`,
    )
  }
  return {
    ...reference,
    provenance: `Sourcify on chain ${spec.referenceChain}`,
    detail: `all ${selectors.length} selectors present in the chain-${CHAIN_ID} bytecode (${deployed.length / 2} bytes)`,
  }
}

function render(name, address, body) {
  const exportName = `${name}Abi`
  return `// Generated by scripts/fetch-abis.mjs — do not edit by hand.
// Source:   ${body.provenance}, chain ${CHAIN_ID}
// Address:  ${address}
// Contract: ${body.contract ?? 'unknown'}
// Compiler: ${body.compiler ?? 'unknown'}
// Match:    ${body.detail}
//
// \`as const\` is load-bearing: viem infers argument and return types from the
// literal ABI, and widening it to \`Abi\` throws that inference away.
export const ${exportName} = ${JSON.stringify(body.abi, null, 2)} as const
`
}

const check = process.argv.includes('--check')
const refresh = process.argv.includes('--refresh')
let drift = 0

/** Write or compare one generated file. Returns true when it changed. */
function emit(name, contents, summary) {
  const target = join(OUT_DIR, `${name}.ts`)
  const current = existsSync(target) ? readFileSync(target, 'utf8') : ''
  if (current === contents) {
    console.log(`= ${name} (${summary})`)
    return
  }
  if (check) {
    console.error(`! ${name} is out of date`)
    drift += 1
    return
  }
  writeFileSync(target, contents)
  console.log(`${current === '' ? '+' : '~'} ${name} (${summary})`)
}

for (const { name, address } of CONTRACTS) {
  if (!check && !refresh && existsSync(join(OUT_DIR, `${name}.ts`))) {
    console.log(`. ${name} (already committed; --refresh to re-fetch)`)
    continue
  }
  let body
  try {
    body = await fetchContract(address)
  } catch (error) {
    console.error(`! ${name}: ${error.message}`)
    process.exitCode = 1
    continue
  }
  emit(name, render(name, address, body), `${body.abi.length} entries, ${body.provenance}`)
}

for (const spec of CROSS_CHAIN) {
  if (!check && !refresh && existsSync(join(OUT_DIR, `${spec.name}.ts`))) {
    console.log(`. ${spec.name} (already committed; --refresh to re-fetch)`)
    continue
  }
  let body
  try {
    body = await crossChainContract(spec)
  } catch (error) {
    console.error(`! ${spec.name}: ${error.message}`)
    process.exitCode = 1
    continue
  }
  emit(spec.name, render(spec.name, spec.address, body), `${body.abi.length} entries, ${body.provenance}`)
}

for (const spec of INSTANCE) {
  if (!check && !refresh && existsSync(join(OUT_DIR, `${spec.name}.ts`))) {
    console.log(`. ${spec.name} (already committed; --refresh to re-fetch)`)
    continue
  }
  let body
  try {
    body = await instanceContract(spec)
  } catch (error) {
    console.error(`! ${spec.name}: ${error.message}`)
    process.exitCode = 1
    continue
  }
  emit(
    spec.name,
    render(spec.name, `${spec.address} — one instance of many`, body),
    `${body.abi.length} entries, ${body.provenance}`,
  )
}

for (const spec of DERIVED) {
  let body
  try {
    body = await deriveContract(spec)
  } catch (error) {
    console.error(`! ${spec.name}: ${error.message}`)
    process.exitCode = 1
    continue
  }
  // The witness address is printed rather than written into the file: it is
  // whichever launch happened most recently, so recording it would make every
  // run a diff.
  emit(
    spec.name,
    // The generated header names the verified compilation, not the instance,
    // for the same reason.
    render(spec.name, `deployed per launch — verified via ${spec.verifiedAt}`, body),
    `${body.abi.length} entries, compiled locally`,
  )
  console.log(`  witness ${body.instance.address} at block ${body.instance.block}`)
}

if (check && drift > 0) {
  console.error(`${drift} ABI file(s) differ from their verified source; run: node scripts/fetch-abis.mjs`)
  process.exitCode = 1
}
