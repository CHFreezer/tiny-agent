// 开发启动器：让 `npm run dev -- <参数>` 的参数真正到达对应进程。
//
// 为什么不能在 package.json 里直接写 concurrently：npm 把 `--` 之后的参数追加到脚本末尾，
// 即 `concurrently -k "npm:dev:server" "npm:dev:vite" --data-dir X`，而 concurrently 会把
// 它们当作自己的命令/选项静默吞掉（v10.0.5 实测：无报错，参数丢失）。
//
// 本文件只做参数路由，进程管理仍交给 concurrently CLI——保留它的 Windows UTF-8 codepage
// 修复、信号处理与 kill-others 语义；两条命令本身仍留在 package.json（dev:server / dev:vite）。
//
// 路由规则：
//   --data-dir <路径>     → server
//   --server-port <端口>  → server `--port`，同时以 SERVER_PORT 下发给 vite（代理目标必须同端口）
//   --port <端口>         → --server-port 的别名（与 npm run dev:server -- --port 一致）
//   --client-port <端口>  → vite `--port`
//   其余参数原样透传给 server（保持 `npm run dev -- <server 参数>` 的语义）
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const extra = process.argv.slice(2)

const serverArgs = []
const viteArgs = []
let serverPort = undefined

const portOf = (name, raw) => {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`[dev] ${name} 需要一个 1-65535 的端口参数`)
    process.exit(1)
  }
  return n
}

for (let i = 0; i < extra.length; i++) {
  const a = extra[i]
  const val = () => {
    const v = extra[++i]
    if (v === undefined || v.startsWith('--')) {
      console.error(`[dev] ${a} 需要一个参数值`)
      process.exit(1)
    }
    return v
  }
  if (a === '--data-dir') serverArgs.push(a, val())
  else if (a === '--server-port' || a === '--port') {
    serverPort = portOf(a, val())
    serverArgs.push('--port', String(serverPort))
  } else if (a === '--client-port') viteArgs.push('--port', String(portOf(a, val())))
  else serverArgs.push(a)
}

// 未显式指定时沿用 server 自身规则（环境变量 PORT > 3000），使 vite 代理与 server 实际端口一致
const proxyPort = serverPort ?? (Number(process.env.PORT) || 3000)

// concurrently 经 shell 启动命令（Windows 为 cmd.exe），路径参数按平台加引号
const q = (s) => (process.platform === 'win32' ? `"${s}"` : `'${s.replace(/'/g, `'\\''`)}'`)
const cmd = (script, args) => `npm:${script}${args.length ? ` -- ${args.map(q).join(' ')}` : ''}`

// concurrently 的 bin 路径由 package.json 的 bin 字段声明
// （其 exports 只开放 "." 与 "./package.json"，无法直接 import 子路径）
const pkgPath = require.resolve('concurrently/package.json')
const cliBin = path.join(path.dirname(pkgPath), JSON.parse(readFileSync(pkgPath, 'utf8')).bin.concurrently)

const child = spawn(process.execPath, [cliBin, '-k', cmd('dev:server', serverArgs), cmd('dev:vite', viteArgs)], {
  stdio: 'inherit',
  env: { ...process.env, SERVER_PORT: String(proxyPort) },
})
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
