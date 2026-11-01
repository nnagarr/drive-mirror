import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: 'src/main/index.ts',
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: 'src/preload/index.ts',
        output: {
          // A sandboxed preload script cannot be an ES module: Electron
          // runs sandboxed preloads as CommonJS, and an `.mjs` preload
          // only works with the sandbox turned off. The sandbox stays on,
          // so the preload is built as CommonJS with a `.cjs` name.
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: {
      rollupOptions: {
        // The input is resolved against the renderer's root, which is
        // already src/renderer.
        input: 'index.html',
      },
    },
  },
})
