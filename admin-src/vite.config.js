import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// In `npm run dev`, serve the site's /env.js and /env-staging.js from the repo root
// (in production they sit next to /admin/ on the same host).
const siteEnvFiles = {
  name: 'barkhaus-site-env',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const file = { '/env.js': 'env.js', '/env-staging.js': 'env-staging.js' }[req.url.split('?')[0]]
      if (!file) return next()
      res.setHeader('Content-Type', 'text/javascript')
      res.end(readFileSync(resolve(__dirname, '..', file)))
    })
  },
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), siteEnvFiles],
  base: '/admin/',
  build: {
    outDir: '../admin',
    emptyOutDir: true,
  },
})
