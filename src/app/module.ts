import { makeLogger } from 'lido-nanolib'
import { makeRequest } from 'lido-nanolib'
import {
  logger as loggerMiddleware,
  notOkError,
  retry,
  abort,
  prom,
} from 'lido-nanolib'
import { makeJobRunner } from 'lido-nanolib'

import dotenv from 'dotenv'

import { makeConfig, makeLoggerConfig } from '../services/config/service.js'
import { makeConsensusApi } from '../services/consensus-api/service.js'
import { makeExecutionApi } from '../services/execution-api/service.js'
import { makeMetrics, register } from '../services/prom/service.js'
import { makeLocalFileReader } from '../services/local-file-reader/service.js'
import { makeMessagesProcessor } from '../services/messages-processor/service.js'
import { makeHttpHandler } from '../services/http-handler/service.js'
import { makeAppInfoReader } from '../services/app-info-reader/service.js'
import { makeJobProcessor } from '../services/job-processor/service.js'
import { makeWebhookProcessor } from '../services/webhook-caller/service.js'
import { makeS3Store } from '../services/s3-store/service.js'
import { makeGsStore } from '../services/gs-store/service.js'

import { makeApp } from './service.js'

dotenv.config()

export const bootstrap = async () => {
  const defaultLogger = makeLogger({
    level: 'debug',
    format: 'simple',
  })

  try {
    const loggerConfig = makeLoggerConfig({ env: process.env })

    const logger = makeLogger({
      level: loggerConfig.LOGGER_LEVEL,
      format: loggerConfig.LOGGER_FORMAT,
      sanitizer: {
        secrets: loggerConfig.LOGGER_SECRETS,
        replacer: '<secret>',
      },
    })

    const config = makeConfig({ logger, env: process.env })

    const metrics = makeMetrics()

    const executionApi = makeExecutionApi(
      makeRequest([
        retry(3),
        loggerMiddleware(logger),
        prom(metrics.executionRequestDurationSeconds),
        notOkError(),
        abort(30_000),
      ]),
      logger,
      config
    )

    const consensusApi = makeConsensusApi(
      makeRequest([
        retry(3),
        loggerMiddleware(logger),
        prom(metrics.consensusRequestDurationSeconds),
        abort(30_000),
      ]),
      logger,
      config
    )

    const localFileReader = makeLocalFileReader({ logger })

    const s3Service = makeS3Store({ logger })
    const gsService = makeGsStore({ logger })

    const messagesProcessor = makeMessagesProcessor({
      logger,
      config,
      localFileReader,
      consensusApi,
      metrics,
      s3Service,
      gsService,
    })

    const webhookProcessor = makeWebhookProcessor(
      makeRequest([loggerMiddleware(logger), notOkError(), abort(10_000)]),
      logger,
      metrics,
      {
        ignoreFirstCert: config.IGNORE_FIRST_CERTIFICATION,
        node: config.VALIDATOR_WEBHOOK_NODE,
        get: config.VALIDATOR_WEBHOOK_GET ?? '',
        send: config.VALIDATOR_WEBHOOK_SEND,
        auth: config.VALIDATOR_WEBHOOK_AUTH,
        privateKey: config.VALIDATOR_WEBHOOK_PRIVATE_KEY,
        appName: config.VALIDATOR_WEBHOOK_APP_NAME,
        decryptSecret: config.VALIDATOR_WEBHOOK_DECRYPT_SECRET ?? '',
      }
    )

    const jobProcessor = makeJobProcessor({
      logger,
      config,
      executionApi,
      consensusApi,
      messagesProcessor,
      webhookProcessor,
      metrics,
    })

    const job = makeJobRunner('validator-ejector', {
      config,
      logger,
      metric: metrics.jobDuration,
      handler: jobProcessor.handleJob,
    })

    const httpHandler = makeHttpHandler({ register, config })

    const appInfoReader = makeAppInfoReader({ localFileReader })

    const app = makeApp({
      config,
      logger,
      job,
      messagesProcessor,
      metrics,
      httpHandler,
      executionApi,
      consensusApi,
      appInfoReader,
    })

    await app.run()
  } catch (error) {
    defaultLogger.error('Startup error', error)
    process.exit(1)
  }
}
