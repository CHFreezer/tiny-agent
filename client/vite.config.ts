import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// /api 代理目标端口必须与 server 监听端口一致：scripts/dev.mjs 按 --server-port 下发 SERVER_PORT；
// 独立跑 `npm run dev:vite` 时缺省 3000（可用 SERVER_PORT=xxxx 覆盖）
const serverPort = Number(process.env.SERVER_PORT) || 3000

export default defineConfig({
  // 前端根目录 = 本文件所在目录（client/）；构建产物输出到 client/dist（server 静态托管）
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': import.meta.dirname,
    },
  },
  build: {
    outDir: path.join(import.meta.dirname, 'dist'),
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0',
    port: 5173, // 缺省端口；--port 参数（scripts/dev.mjs --client-port）优先
    proxy: {
      // 浏览器请求 /api/* -> 本地 Node server（OpenAI SDK 在 server 端运行）
      // ws: /api/events 是跨设备同步的 WebSocket，需让代理转发 Upgrade 握手
      '/api': {
        target: `http://127.0.0.1:${serverPort}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
})