import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import VueI18nPlugin from '@intlify/unplugin-vue-i18n/vite'
import path from 'path'

const isElectron = process.env.npm_lifecycle_event?.includes('electron') ||
                   process.argv.includes('electron')

export default defineConfig(({ mode }) => ({
  plugins: [
    vue(),
    VueI18nPlugin({
      include: [path.resolve(__dirname, 'src/i18n/locales/**')],
      strictMessage: false,
      escapeHtml: false
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
            }
          }
        },
        {
          entry: 'electron/preload.ts',
          onstart(options) {
            options.reload()
          },
          vite: {
            build: {
              outDir: 'dist-electron',
              lib: {
                entry: 'electron/preload.ts',
                formats: ['cjs'],
                fileName: () => 'preload.cjs'
              },
              rollupOptions: {
                external: ['electron']
              },
              commonjsOptions: {
                transformMixedEsModules: true
              }
            }
          }
        }
      ]),
      renderer()
    ] : [])
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // Use runtime-only build - messages are pre-compiled by VueI18nPlugin
      'vue-i18n': 'vue-i18n/dist/vue-i18n.runtime.esm-bundler.js'
    }
  },
  base: './'
}))
