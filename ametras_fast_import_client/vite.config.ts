import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import VueI18nPlugin from '@intlify/unplugin-vue-i18n/vite'
import path from 'path'
import fs from 'fs'

// Simple plugin to copy preload.cjs to dist-electron
function copyPreload() {
  return {
    name: 'copy-preload',
    writeBundle() {
      const src = path.resolve(__dirname, 'electron/preload.cjs')
      const dest = path.resolve(__dirname, 'dist-electron/preload.cjs')
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(src, dest)
    }
  }
}

const isElectron = process.env.npm_lifecycle_event?.includes('electron') ||
                   process.argv.includes('electron')

// Shared source lives in the addon's vue-app
const sharedSrc = path.resolve(__dirname, '../ametras_fast_import_addon/vue-app/src')

export default defineConfig(({ mode: _mode }) => ({
  plugins: [
    vue(),
    VueI18nPlugin({
      include: [path.resolve(sharedSrc, 'i18n/locales/**')],
      strictMessage: false,
      escapeHtml: false,
      runtimeOnly: true
    }),
    ...(isElectron ? [
      electron([
        {
          entry: 'electron/main.ts',
          vite: {
            build: {
              outDir: 'dist-electron',
              rollupOptions: {
                external: ['electron']
              }
            },
            plugins: [copyPreload()]
          }
        }
      ]),
      renderer()
    ] : [])
  ],
  resolve: {
    alias: {
      '@': sharedSrc,
      'vue-i18n': 'vue-i18n/dist/vue-i18n.runtime.esm-bundler.js'
    }
  },
  base: './'
}))
