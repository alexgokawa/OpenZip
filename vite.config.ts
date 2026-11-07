import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  // Packaged Electron loads index.html through file://, so asset URLs must be
  // relative. The dev server keeps absolute URLs.
  base: command === 'build' ? './' : '/',
  plugins: [react()],
}))
