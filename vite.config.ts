import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs, so the built site works wherever it is dropped: the
  // web root, a sub-folder like /circuit/, a shared drive, even file://.
  base: './',
  server: { port: 5173, open: false },
})
