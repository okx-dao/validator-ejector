import { makeLogger } from 'lido-nanolib'
import { makeRequest } from 'lido-nanolib'

import { ethers } from 'ethers'

import { ConfigService } from 'services/config/service.js'
import { MetricsService } from '../prom/service'

import {
  syncingDTO,
  lastBlockNumberDTO,
  logsDTO,
  funcDTO,
  txDTO,
  genericArrayOfStringsDTO,
} from './dto.js'

const ORACLE_FRAME_BLOCKS = 7200

export type ExecutionApiService = ReturnType<typeof makeExecutionApi>

export const makeExecutionApi = (
  request: ReturnType<typeof makeRequest>,
  logger: ReturnType<typeof makeLogger>,
  {
    EXECUTION_NODE,
    LOCATOR_ADDRESS,
    STAKING_MODULE_ID,
    OPERATOR_ID,
    ORACLE_ADDRESSES_ALLOWLIST,
    DISABLE_SECURITY_DONT_USE_IN_PRODUCTION,
  }: ConfigService,
  { eventSecurityVerification }: MetricsService
) => {
  const normalizedUrl = EXECUTION_NODE.endsWith('/')
    ? EXECUTION_NODE.slice(0, -1)
    : EXECUTION_NODE

  let depositNodeManagerAddress: string

  const syncing = async () => {
    const res = await request(normalizedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_syncing',
        params: [],
        id: 1,
      }),
    })
    const json = await res.json()
    const { result } = syncingDTO(json)
    logger.debug('fetched syncing status')
    return result
  }

  const checkSync = async () => {
    if (await syncing()) {
      logger.warn('Execution node is still syncing! Proceed with caution.')
    }
  }

  const latestBlockNumber = async () => {
    const res = await request(normalizedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_getBlockByNumber',
        params: ['finalized', false],
        id: 1,
      }),
    })
    const json = await res.json()
    const {
      result: { number },
    } = lastBlockNumberDTO(json)
    logger.debug('fetched latest block number')
    return ethers.BigNumber.from(number).toNumber()
  }

  const getTransaction = async (transactionHash: string) => {
    const res = await request(normalizedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_getTransactionByHash',
        params: [transactionHash],
        id: 1,
      }),
    })

    const json = await res.json()

    const { result } = txDTO(json)

    return result
  }

  const logs = async (fromBlock: number, toBlock: number) => {
    const event = ethers.utils.Fragment.from(
      'event SigningKeyExiting(uint256 indexed validatorId, address indexed operator, bytes pubkey)'
    )
    const iface = new ethers.utils.Interface([event])
    const eventTopic = iface.getEventTopic(event.name)

    const res = await request(normalizedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_getLogs',
        params: [
          {
            fromBlock: ethers.utils.hexStripZeros(
              ethers.BigNumber.from(fromBlock).toHexString()
            ),
            toBlock: ethers.utils.hexStripZeros(
              ethers.BigNumber.from(toBlock).toHexString()
            ),
            address: depositNodeManagerAddress,
            topics: [eventTopic],
          },
        ],
        id: 1,
      }),
    })

    const json = await res.json()

    const { result } = logsDTO(json)

    logger.info('Loaded ValidatorExitRequest events', { amount: result.length })

    const validatorsToEject: {
      validatorId: string
      operator: string
      pubkey: string
    }[] = []

    logger.info('Verifying validity of exit requests')

    for (const [ix, log] of result.entries()) {
      logger.info(`${ix + 1}/${result.length}`)

      const parsedLog = iface.parseLog(log)

      const [validatorId, operator, pubkey] = parsedLog.args as unknown as [
        validatorId: ethers.BigNumber,
        operator: string,
        pubkey: string
      ]

      {
        logger.warn('WARNING')
        logger.warn('Skipping protocol exit requests security checks.')
        logger.warn('Please double-check this is intentional.')
        logger.warn('WARNING')
      }

      validatorsToEject.push({
        validatorId: validatorId.toString(),
        operator: operator,
        pubkey: pubkey,
      })
    }

    return validatorsToEject
  }

  const resolveDepositNodeManagerAddress = async () => {
    const func = ethers.utils.Fragment.from(
      'function getAddress(bytes32 key) external view returns (address)'
    )
    const iface = new ethers.utils.Interface([func])
    const sig = iface.encodeFunctionData(func.name, [
      ethers.utils.keccak256(
        ethers.utils.solidityPack(
          ['string', 'string'],
          ['contract.address', 'DepositNodeManager']
        )
      ),
    ])

    try {
      const res = await request(normalizedUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_call',
          params: [
            {
              from: null,
              to: LOCATOR_ADDRESS,
              data: sig,
            },
            'finalized',
          ],
          id: 1,
        }),
      })

      const json = await res.json()

      const { result } = funcDTO(json)

      const decoded = iface.decodeFunctionResult(func.name, result)

      const validated = genericArrayOfStringsDTO(decoded)

      depositNodeManagerAddress = validated[0] // only returns one value

      logger.info('Resolved Exit Bus contract address using the Locator', {
        depositNodeManagerAddress,
      })
    } catch (e) {
      logger.error('Unable to resolve Exit Bus contract', e)
      throw new Error(
        'Unable to resolve Exit Bus contract address using the Locator. Please make sure LOCATOR_ADDRESS is correct.'
      )
    }
  }

  return {
    syncing,
    checkSync,
    latestBlockNumber,
    logs,
    resolveDepositNodeManagerAddress,
  }
}
