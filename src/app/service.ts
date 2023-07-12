import type { Dependencies } from './interface.js'

export const makeApp = ({
  config,
  logger,
  job,
  messagesProcessor,
  httpHandler,
  executionApi,
  consensusApi,
  appInfoReader,
}: Dependencies) => {
  const { BLOCKS_PRELOAD, BLOCKS_LOOP, JOB_INTERVAL } = config

  const run = async () => {
    const version = await appInfoReader.getVersion()
    const mode = config.MESSAGES_LOCATION ? 'message' : 'webhook'
    logger.info(`Validator Ejector v${version} started in ${mode} mode`, config)

    await executionApi.checkSync()
    await consensusApi.checkSync()

    await httpHandler.run()

    const messages = await messagesProcessor.load()
    const verifiedMessages = await messagesProcessor.verify(messages)

    logger.info(`Loading initial events for ${BLOCKS_PRELOAD} last blocks`)
    await job.once({ scanBlocks: BLOCKS_PRELOAD, verifiedMessages })

    logger.info(
      `Starting ${
        JOB_INTERVAL / 1000
      } seconds polling for ${BLOCKS_LOOP} last blocks`
    )

    job.pooling({ scanBlocks: BLOCKS_LOOP, verifiedMessages })
  }

  return { run }
}
