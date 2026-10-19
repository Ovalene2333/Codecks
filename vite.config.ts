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
      '/s/': 'http://127.0.0.1:4174',
      '/ws': { target: 'ws://127.0.0.1:4174', ws: true },
    },
  },
  build: {
    outDir: 'dist-web',
    chunkSizeWarningLimit: 900,
    assetsInlineLimit: 8 * 1024,
    rollupOptions: {
      output: {
        // React 的 CJS 实现与公共 helper 必须同包，避免被 Markdown
        // 间接依赖吸走，导致首页反过来预加载整份 Markdown。
        manualChunks(id) {
          if (id.includes('commonjsHelpers') || /[/\\]node_modules[/\\](react|react-dom|scheduler)[/\\]/.test(id)) {
            return 'vendor-react'
          }
          if (/[/\\]node_modules[/\\]@xterm[/\\]/.test(id)) {
            return 'vendor-xterm'
          }
        },
      },
    },
  },
})
