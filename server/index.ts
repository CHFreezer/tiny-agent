import express from 'express'
import { closeAllMcp, sweepWorkspace, syncMcp } from './mcp.ts'
import { loadAll } from './sessions.ts'
import { registerRoutes } from './routes.ts'
import { registerTts } from './tts.ts'

const PORT = Number(process.env.PORT) || 3000

const app = express()
app.use(express.json({ limit: '20mb' })) // 图片 base64 可能较大
registerRoutes(app)
registerTts(app)

sweepWorkspace() // 启动时清扫工具工作区的过期文件
loadAll()
void syncMcp() // 启动时按持久化配置连接 MCP 服务器

const shutdownMcp = () => {
  void closeAllMcp().then(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGINT', shutdownMcp)
process.on('SIGTERM', shutdownMcp)

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[server] http://127.0.0.1:${PORT}`)
})