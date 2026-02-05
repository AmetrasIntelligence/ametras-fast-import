import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import path from 'path'

const isElectron = process.env.npm_lifecycle_event?.includes('electron') ||
                   process.argv.includes('electron')

export default defineConfig({
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
                formats: ['cjs']
              },
              rollupOptions: {
                external: ['electron'],
                output: {
                  entryFileNames: 'preload.js'
                }
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
      '@': path.resolve(__dirname, 'src')
    }
  },
  base: './'
})
