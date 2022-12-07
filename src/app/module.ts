import { makeLogger } from 'tooling-nanolib-test'
import { makeRequest } from 'tooling-nanolib-test'
import {
  logger as loggerMiddleware,
  notOkError,
  retry,
  abort,
  prom,
} from 'tooling-nanolib-test'
import { makeJobRunner } from 'tooling-nanolib-test'

import dotenv from 'dotenv'

import { makeConfig, makeLoggerConfig } from '../lib/config/index.js'
import { makeConsensusApi, makeExecutionApi } from '../lib/api/index.js'
import { makeMetrics } from '../lib/prom/index.js'
import { makeReader } from '../lib/reader/index.js'
import { makeMessagesProcessor } from '../lib/messages-loader/index.js'
import { makeApp } from './service.js'

dotenv.config()

export const bootstrap = async () => {
  const loggerConfig = makeLoggerConfig({ env: process.env })

  const logger = makeLogger({
    level: loggerConfig.LOGGER_LEVEL,
    pretty: loggerConfig.LOGGER_PRETTY,
  })

  try {
    const config = makeConfig({ logger, env: process.env })

    const metrics = makeMetrics(config)

    const request = makeRequest([
      retry(3),
      loggerMiddleware(logger),
      prom(metrics.requestDurationSeconds),
      notOkError(),
      abort(5000),
    ])

    const consensusApi = makeConsensusApi(request, logger, config)
    const executionApi = makeExecutionApi(request, logger, config)

    const jobRunner = makeJobRunner(
      'validator-ejector',
      { config, logger, metric: metrics.jobDuration },
      { start: config.BLOCKS_PRELOAD, pooling: config.BLOCKS_LOOP }
    )

    const reader = makeReader()

    const messagesProcessor = makeMessagesProcessor({
      logger,
      config,
      reader,
      consensusApi,
    })

    const app = makeApp({
      config,
      logger,
      executionApi,
      jobRunner,
      messagesProcessor,
    })

    await app.run()
  } catch (error) {
    logger.error('Startup error', error)
    process.exit(1)
  }
}
