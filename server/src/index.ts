import { buildApp } from './app'
import { loadConfig } from './config'

const config = loadConfig()
const app = await buildApp(config)

let closing = false
const shutdown = () => {
  if (closing) return
  closing = true
  void app.close().then(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

try {
  await app.listen({ port: config.port, host: config.host })
}
catch (err) {
  app.log.error(err)
  process.exit(1)
}
