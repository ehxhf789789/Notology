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
        // 🔴 **한 덩어리 3.7MB 를 나눈다** (사용자 지적, 2026-08-25:
        //    *"notology 최적화는 하고 있는건가? 속도가 버벅거린다"*).
        //
        //    실측: API 는 18~145ms 로 멀쩡한데(가장 느린 `read_directory`
        //    550ms 는 CIFS 훑기다) 번들이 **한 조각 3.7MB** 였다. 열 때마다
        //    그만큼을 받아 파싱한다.
        //
        // 🔴 **코드를 옮기는 일이지 지우는 일이 아니다.** 그래서 배포 전에
        //    `tools/bundle_diff.py` 로 «글자값이 하나도 안 빠졌나» 를 잰다 —
        //    `vite` 는 타입을 안 보므로 빠져도 빌드는 조용히 통과한다.
        //
        // ⚠️ **react 를 쪼개지 않는다.** 갈래를 나눠 두 조각에 들면
        //    `useState` 가 두 벌이 되어 훅이 통째로 깨진다 (`dedupe` 가 위에
        //    있는 까닭). 무거운 것 중 **서로 안 얽히는 것만** 뗀다.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler|use-sync-external-store)[\\/]/.test(id))
            return 'react';
          if (id.includes('@tiptap') || id.includes('prosemirror')) return 'editor';
          if (id.includes('lucide-react')) return 'icons';
          if (id.includes('katex')) return 'katex';
          if (id.includes('mermaid') || id.includes('d3-')) return 'diagram';
          if (id.includes('pdfjs') || id.includes('hangul') || id.includes('hwp'))
            return 'viewer';
          return 'vendor';
        },
      },
    },
  },
})
