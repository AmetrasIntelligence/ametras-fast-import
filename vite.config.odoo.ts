import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import VueI18nPlugin from '@intlify/unplugin-vue-i18n/vite'
import path from 'path'

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
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      'vue-i18n': 'vue-i18n/dist/vue-i18n.runtime.esm-bundler.js',
    },
  },
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/mainOdoo.ts'),
      name: 'AmetrasCsvImport',
      formats: ['iife'],
      fileName: () => 'app.js',
    },
    outDir: path.resolve(__dirname, 'ametras_fast_import_addon/static/vue'),
    emptyOutDir: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        extend: true,
        assetFileNames: 'style.css',
      },
    },
  },
})
