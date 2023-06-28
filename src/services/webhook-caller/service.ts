import { LoggerService, RequestService } from 'lido-nanolib'
import { MetricsService } from '../prom/service.js'
import { privateKeyToAccount } from 'web3-eth-accounts'
import { decrypt } from '@chainsafe/bls-keystore'
import * as https from 'https'

export type WebhookProcessorService = ReturnType<typeof makeWebhookProcessor>

export const makeWebhookProcessor = (
  request: RequestService,
  logger: LoggerService,
  metrics: MetricsService,
  webhook: {
    ignoreFirstCert: boolean
    node: string
    get: string
    send: string
    auth: string
    privateKey: string
    appName: string
    decryptSecret: string
  }
) => {
  const sendEvent = async (event: {
    index: number
    operator: string
    pubkey: string
  }) => {
    try {
      await tryToSendExitEvent(event)
      logger.info('Voluntary exit webhook called successfully', event)
      metrics.exitActions.inc({ result: 'success' })
    } catch (e) {
      logger.error('Failed to call the exit webhook', e)
      metrics.exitActions.inc({ result: 'error' })
    }
  }

  let authToken: string
  const agent = webhook.ignoreFirstCert
    ? new https.Agent({
        rejectUnauthorized: false, // 忽略证书验证，只在开发环境中使用
      })
    : undefined

  const authToNode = async (
    url: string,
    privateKey: string,
    appName: string
  ) => {
    const account = privateKeyToAccount(privateKey)
    const signedMessage = account.sign(appName)
    const res = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        signer: account.address,
        signed: signedMessage,
      }),
      agent,
    })
    authToken = await res.text()
    logger.info(account.address + ' auth successfully', authToken)
  }

  const getOneValidator = async (url: string, validatorId: number) => {
    const res = await request(url + `/${validatorId}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${authToken}`,
      },
      agent,
    })
    const encrypted = await res.text()
    logger.info('Get one validator', encrypted)
    return encrypted
  }

  const sendExitEvent = async (
    url: string,
    event: {
      index: number
      operator: string
      pubkey: string
    }
  ) => {
    await request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(event),
      agent,
    })
  }

  const tryToSendExitEvent = async (event: {
    index: number
    operator: string
    pubkey: string
  }) => {
    const { node, send, auth, privateKey, appName } = webhook
    try {
      return await sendExitEvent(node + send, event)
    } catch (e) {
      if (e.statusCode === 401) {
        await authToNode(node + auth, privateKey, appName)
        return await sendExitEvent(node + send, event)
      }
      throw e
    }
  }

  const decryptMessage = async (encrypted: string) => {
    const content = await decrypt(JSON.parse(encrypted), webhook.decryptSecret)
    return new TextDecoder().decode(content)
  }

  const tryToGetOneValidator = async (index: number) => {
    const { node, get, auth, privateKey, appName } = webhook
    try {
      return await getOneValidator(node + get, index)
    } catch (e) {
      await authToNode(node + auth, privateKey, appName)
      return await getOneValidator(node + get, index)
    }
  }

  const getExitMessage = async (event: {
    index: number
    operator: string
    pubkey: string
  }) => {
    try {
      const encrypted = await tryToGetOneValidator(event.index)
      return decryptMessage(encrypted)
    } catch (e) {
      logger.info('Get validator failed', e)
    }
  }

  return {
    getExitMessage,
    sendEvent,
  }
}
