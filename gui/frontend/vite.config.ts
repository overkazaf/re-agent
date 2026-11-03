import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// Multi-page: index.html is the app; dev-*.html are per-workstream visual
// demo pages used by parallel agents to verify their components in isolation.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        'dev-shell': resolve(__dirname, 'dev-shell.html'),
        'dev-panels': resolve(__dirname, 'dev-panels.html'),
        'dev-interact': resolve(__dirname, 'dev-interact.html'),
      },
    },
  },
})
