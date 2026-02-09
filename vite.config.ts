import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import path from 'path'

const isElectron = process.env.npm_lifecycle_event?.includes('electron') ||
                   process.argv.includes('electron')

export default defineConfig(({ mode }) => ({
  plugins: [
    vue(),
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
      // Use runtime-only build of vue-i18n in production to avoid CSP issues with eval in Electron
      // In dev mode, use full build which supports runtime compilation
      ...(mode === 'production' || mode === 'electron' ? {
        'vue-i18n': 'vue-i18n/dist/vue-i18n.runtime.esm-bundler.js'
      } : {})
    }
  },
  base: './'
}))
