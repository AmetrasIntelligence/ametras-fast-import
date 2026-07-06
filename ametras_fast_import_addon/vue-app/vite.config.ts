import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import VueI18nPlugin from '@intlify/unplugin-vue-i18n/vite'
import path from 'path'
import fs from 'fs'

// Extract version from the Odoo addon manifest (single source of truth).
// The manifest uses double quotes; match either quote style so this can't
// silently fall back to "unknown" (which it did before).
function getManifestVersion(): string {
  const manifest = fs.readFileSync(path.resolve(__dirname, '../__manifest__.py'), 'utf-8')
  const match = manifest.match(/["']version["']\s*:\s*["']([^"']+)["']/)
  return match?.[1] ?? 'unknown'
}

export default defineConfig({
  plugins: [
    vue(),
    VueI18nPlugin({
      include: [path.resolve(__dirname, 'src/i18n/locales/**')],
      strictMessage: false,
      escapeHtml: false,
      runtimeOnly: true,
    }),
  ],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    '__APP_VERSION__': JSON.stringify(getManifestVersion()),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      'vue-i18n': 'vue-i18n/dist/vue-i18n.runtime.esm-bundler.js',
    },
  },
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/main.ts'),
      name: 'AmetrasCsvImport',
      formats: ['iife'],
      fileName: () => 'app.js',
    },
    outDir: path.resolve(__dirname, '../static/vue'),
    emptyOutDir: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        extend: true,
        assetFileNames: 'style.css',
      },
    },
  },
  server: {
    proxy: {
      '/web': 'http://localhost:8069',
      '/ametras_fast_import': 'http://localhost:8069',
    },
  },
})
