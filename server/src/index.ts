import { buildApp } from './app'
import { loadConfig } from './config'
import { openDb } from './db'

const config = loadConfig()
const db = openDb(config.dataDir)
const app = await buildApp(config, db)

let closing = false
const shutdown = () => {
  if (closing) return
  closing = true
  void app.close().then(() => {
    db.close()
    process.exit(0)
  })
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
