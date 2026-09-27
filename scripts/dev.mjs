// 开发启动器：让 `npm run dev -- <参数>` 的参数真正到达 server 进程。
//
// 为什么不能在 package.json 里直接写 concurrently：npm 把 `--` 之后的参数追加到脚本末尾，
// 即 `concurrently -k "npm:dev:server" "npm:dev:vite" --data-dir X`，而 concurrently 会把
// 它们当作自己的命令/选项静默吞掉（v10.0.5 实测：无报错，参数丢失）。
//
// 本文件只做参数路由，进程管理仍交给 concurrently CLI——保留它的 Windows UTF-8 codepage
// 修复、信号处理与 kill-others 语义；两条命令本身仍留在 package.json（dev:server / dev:vite）。
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const extra = process.argv.slice(2)

const di = extra.indexOf('--data-dir')
if (di >= 0 && (extra[di + 1] === undefined || extra[di + 1].startsWith('--'))) {
  console.error('[dev] --data-dir 需要一个路径参数')
  process.exit(1)
}

// concurrently 经 shell 启动命令（Windows 为 cmd.exe），路径参数按平台加引号
const q = (s) => (process.platform === 'win32' ? `"${s}"` : `'${s.replace(/'/g, `'\\''`)}'`)

// concurrently 的 bin 路径由 package.json 的 bin 字段声明
// （其 exports 只开放 "." 与 "./package.json"，无法直接 import 子路径）
const pkgPath = require.resolve('concurrently/package.json')
const cliBin = path.join(path.dirname(pkgPath), JSON.parse(readFileSync(pkgPath, 'utf8')).bin.concurrently)

const child = spawn(
  process.execPath,
  [cliBin, '-k', `npm:dev:server${extra.length ? ` -- ${extra.map(q).join(' ')}` : ''}`, 'npm:dev:vite'],
  { stdio: 'inherit' },
)
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
