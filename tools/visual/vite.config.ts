import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

const root = resolve(__dirname, '../..')

// Built to a scratch directory on purpose: the harness must never end up in
// the shipped bundle, and keeping its output out of `out/` keeps
// electron-builder's `files` globs honest.
export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(root, 'src/shared'),
      '@renderer': resolve(root, 'src/renderer/src')
    }
  },
  build: {
    outDir: process.env.VISUAL_OUT ?? resolve(root, '.visual-dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        studio: resolve(__dirname, 'studio.html'),
        chrome: resolve(__dirname, 'chrome.html')
      }
    }
  }
})
