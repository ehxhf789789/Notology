import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
  },
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
      '@features': path.resolve(__dirname, 'src/features'),
      '@services': path.resolve(__dirname, 'src/core/services'),
    },
    dedupe: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
  },
  build: {
    sourcemap: false,
    minify: 'esbuild',
    rollupOptions: {
      output: {
        compact: true,
        // 🔴 **한 덩어리 3.8MB 를 「앱」과 「vendor」 둘로 나눈다** (A65 · 2026-08-27).
        //    고칠 때마다 3.8MB 를 통째로 다시 받던 것이, 앱 조각만 다시 받게 된다
        //    (vendor 는 의존성을 올리기 전까지 해시가 안 변해 브라우저 캐시에 남는다).
        //
        // ⚠️ **c6bacaf(08-25) 의 사고를 되풀이하지 않는다.** 그때는 editor·icons·
        //    vendor … 로 잘게 갈랐는데, @tiptap→tippy(vendor) 와 tiptap-markdown
        //    (vendor)→prosemirror(editor) 처럼 **조각 사이 import 가 순환**이 되어
        //    초기화 순서가 깨졌다 (pageerror `reading 'empty'` · 무한 로딩).
        //    vendor 가 «한» 조각이면 조각 그래프가 index→vendor 한 방향뿐이라
        //    순환이 원리상 생길 수 없다.
        manualChunks(id: string) {
          // 앱 코드는 손대지 않는다 — 라우트 지연 분할(GraphView 등)은 vite 기본에 맡긴다
          if (!id.includes('node_modules')) return
          // 그래프 전용 딸림(force-graph 와 그 의존성 · 앱이 직접 import 하는 곳 0건 —
          // _a65_lodash_check 실측)은 지연 조각(GraphView)에 남긴다.
          // vendor 에 넣으면 첫 화면이 그만큼 커진다.
          if (/[\\/]node_modules[\\/](force-graph|d3-[^\\/]+|@tweenjs|accessor-fn|bezier-js|canvas-color-tracker|float-tooltip|index-array-by|kapsule|internmap|delaunator|robust-predicates|lodash-es)[\\/]/.test(id)) return
          return 'vendor'
        },
      },
    },
  },
})
