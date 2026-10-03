import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

// 设置「关于」页显示的前端版本；与快照里的服务端版本对比，不一致时提示刷新。
const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
)
const appVersion = pkg.version
// 源代码仓库地址，「关于」页链接用；package.json repository 支持字符串或 {url}。
const appRepo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || ''

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __APP_REPO__: JSON.stringify(appRepo),
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4174',
      '/ws': { target: 'ws://127.0.0.1:4174', ws: true },
    },
  },
  build: {
    outDir: 'dist-web',
    chunkSizeWarningLimit: 900,
    assetsInlineLimit: 8 * 1024,
    rollupOptions: {
      output: {
        // react-markdown（含 remark-gfm）与 xterm 只在会话/终端页用到，
        // 独立分包后首屏只下 react 主包，并行缓存利用率更高。
        // lucide-react 留主包：图标散布各处，单独拆包反而多一次往返。
        manualChunks: {
          // 注意子路径也要显式列出：main.tsx 实际 import 的是 react-dom/client，
          // 光写 'react-dom' 匹配不到，react-dom 会漏回主包。
          'vendor-react': ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
          'vendor-markdown': ['react-markdown', 'remark-gfm'],
          'vendor-xterm': ['@xterm/xterm', '@xterm/addon-fit'],
        },
      },
    },
  },
})
