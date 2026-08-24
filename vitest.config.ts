import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// The suite deliberately runs in two environments rather than forcing one.
// Most of what is worth testing here is pure — transcript folding, wire
// decoding, tool-call presentation — and pure code has no business paying for
// a DOM. The handful of tests that assert on behaviour a user can perform
// (a chip that refuses to toggle, a row that expands) opt into jsdom with a
// `// @vitest-environment jsdom` docblock.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      // Main-process modules have no alias in the app (they use relative
      // imports), but tests reach across the process boundary often enough
      // that spelling ../../src/main/... every time obscures what is under
      // test.
      '@main': resolve(__dirname, 'src/main')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Electron's main-process modules pull in `electron` itself, which does
    // not exist outside the app. Tests that need one stub it explicitly; this
    // just keeps an accidental import from being a confusing crash.
    setupFiles: ['tests/setup.ts'],
    css: true
  }
})
