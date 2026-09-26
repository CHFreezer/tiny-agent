import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DATA_DIR, errMsg } from './config.ts'

// ===== TTS（pwsh 7 + System.Speech 10，本地 Xiaoxiao 音色，合成 wav 返回浏览器播放） =====
const PWSH7 = (() => {
  try {
    const p = execSync('where pwsh', { windowsHide: true, stdio: 'ignore' }).toString().split(/\r?\n/)[0].trim()
    if (p) return p
  } catch {
    // 不在 PATH
  }
  const fallback = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
  return fs.existsSync(fallback) ? fallback : ''
})()

// 固定缓存文件：同文本反复播放直接复用，不重新合成；不同文本重新合成覆盖
const TTS_WAV = path.join(DATA_DIR, 'tts.wav')
let ttsCacheText: string | null = null
let ttsGen = 0

function streamWav(res: express.Response, file: string): void {
  res.setHeader('Content-Type', 'audio/wav')
  res.setHeader('Content-Length', fs.statSync(file).size)
  fs.createReadStream(file).pipe(res)
}

export function registerTts(app: express.Express): void {
  app.post('/api/tts', (req, res) => {
    const { text } = req.body as { text?: string }
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text required' })
    if (!PWSH7) return res.status(500).json({ error: '未找到 pwsh 7（TTS 需要）' })
    const body = text.slice(0, 8000)
    if (ttsCacheText === body && fs.existsSync(TTS_WAV)) {
      streamWav(res, TTS_WAV)
      return
    }
    const gen = ++ttsGen
    const textFile = path.join(os.tmpdir(), `tts-${randomUUID()}.txt`)
    fs.writeFileSync(textFile, body, 'utf8')
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tts.ps1')
    execFile(PWSH7, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, TTS_WAV, textFile], { timeout: 90000 }, (err) => {
      try {
        fs.unlinkSync(textFile)
      } catch {
        // 忽略
      }
      if (gen !== ttsGen) {
        // 已被更新的合成请求取代（客户端单实例会 abort 旧请求）
        if (!res.headersSent) res.status(409).json({ error: '已被新的朗读请求取代' })
        return
      }
      if (err || !fs.existsSync(TTS_WAV)) {
        if (!res.headersSent) res.status(500).json({ error: errMsg(err) || 'TTS 合成失败' })
        return
      }
      ttsCacheText = body
      streamWav(res, TTS_WAV)
    })
  })
}