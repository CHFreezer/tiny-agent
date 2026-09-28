import type { Server } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { gens } from './generate.ts'
import { getCurrentId, listSorted } from './sessions.ts'

// ===== 跨设备实时同步：WebSocket =====
// 端点 /api/events（与 HTTP 同端口，升级握手），服务器把"会话层"状态变更推给所有连接的客户端：
//   { list, currentId }                     会话列表元数据变化（新建/删除/重命名）+ 连接时的初始快照
//   { sid, gen: true,  title }              某会话开始生成（客户端据此附加该会话流，重放缓冲事件重建实时视图）
//   { sid, gen: false, title, last*Tokens } 某会话结束生成
//   { sid, entry }                          条目被其他设备编辑
//   { sid, history }                        条目被其他设备删除（含级联清理后的完整历史）
// 会话文本流（h/a/c/r/t/x/m/h/d 增量）不走这里：仍是 GET /api/sessions/:id/stream 的 NDJSON 流，只发给正在看该会话的客户端。

interface Conn {
  ws: WebSocket
  alive: boolean
}

const clients = new Set<Conn>()

export function broadcast(o: unknown): void {
  const text = JSON.stringify(o)
  for (const c of clients) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(text)
}

// 会话列表元数据（不含 history——历史可能含 base64 图片，通知里不重复传输）
export const sessionMeta = () =>
  listSorted().map((s) => ({
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    lastPromptTokens: s.lastPromptTokens,
    lastCompletionTokens: s.lastCompletionTokens,
    generating: gens.has(s.id),
  }))

export const syncList = () => broadcast({ list: sessionMeta(), currentId: getCurrentId() })

// 心跳：协议级 ping/pong（25s）。客户端不回应 pong 即判定死连接并 terminate——不需要应用层心跳消息
const HEARTBEAT_MS = 25000

export function attachEvents(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/api/events' })
  wss.on('connection', (ws) => {
    const conn: Conn = { ws, alive: true }
    clients.add(conn)
    ws.on('pong', () => {
      conn.alive = true
    })
    ws.on('close', () => clients.delete(conn))
    ws.on('error', () => clients.delete(conn))
    // 连接即发快照：页面休眠/断线重连后据此校正会话列表与"是否有生成在进行"，无需等下一次变更
    ws.send(JSON.stringify({ list: sessionMeta(), currentId: getCurrentId() }))
  })

  const timer = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.ws.terminate()
        clients.delete(c)
        continue
      }
      c.alive = false
      c.ws.ping()
    }
  }, HEARTBEAT_MS)
  timer.unref() // 不吊住进程退出
}
