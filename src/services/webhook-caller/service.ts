import { LoggerService, RequestService } from 'lido-nanolib'
import { MetricsService } from '../prom/service.js'
import { privateKeyToAccount } from 'web3-eth-accounts'
import { decrypt } from '@chainsafe/bls-keystore'

export type WebhookProcessorService = ReturnType<typeof makeWebhookProcessor>

export const makeWebhookProcessor = (
  request: RequestService,
  logger: LoggerService,
  metrics: MetricsService
) => {
  const sendEvent = async (
    webhook: {
      node: string
      send: string
      auth: string
      privateKey: string
      appName: string
    },
    event: {
      index: number
      operator: string
      pubkey: string
    }
  ) => {
    const { node, send, auth, privateKey, appName } = webhook
    try {
      await tryToSendExitEvent(node, send, auth, privateKey, appName, event)
      logger.info('Voluntary exit webhook called successfully', event)
      metrics.exitActions.inc({ result: 'success' })
    } catch (e) {
      logger.error('Failed to call the exit webhook', e)
      metrics.exitActions.inc({ result: 'error' })
    }
  }

  let authToken: string

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
    })
  }

  const tryToSendExitEvent = async (
    node: string,
    send: string,
    auth: string,
    privateKey: string,
    appName: string,
    event: {
      index: number
      operator: string
      pubkey: string
    }
  ) => {
    try {
      return await sendExitEvent(node + send, event)
    } catch (e) {
      await authToNode(node + auth, privateKey, appName)
      return await sendExitEvent(node + send, event)
    }
  }

  const decryptMessage = async (encrypted: string, secret: string) => {
    const content = await decrypt(JSON.parse(encrypted), secret)
    const decrypted = new TextDecoder().decode(content)
    return decrypted
  }

  const tryToGetOneValidator = async (
    node: string,
    get: string,
    auth: string,
    privateKey: string,
    appName: string,
    index: number
  ) => {
    try {
      return await getOneValidator(node + get, index)
    } catch (e) {
      await authToNode(node + auth, privateKey, appName)
      return await getOneValidator(node + get, index)
    }
  }

  const getExitMessage = async (
    webhook: {
      node: string
      get: string
      auth: string
      privateKey: string
      appName: string
      decryptSecret: string
    },
    event: {
      index: number
      operator: string
      pubkey: string
    }
  ) => {
    try {
      const { node, get, auth, privateKey, appName, decryptSecret } = webhook
      const encrypted = await tryToGetOneValidator(
        node,
        get,
        auth,
        privateKey,
        appName,
        event.index
      )
      const exitMessage = decryptMessage(encrypted, decryptSecret)
      return exitMessage
    } catch (e) {
      logger.info('Get validator failed', e)
    }
  }

  return {
    getExitMessage,
    sendEvent,
  }
}
