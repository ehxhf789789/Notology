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
      },
    },
  },
})
