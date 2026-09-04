import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
