import { defineConfig, type Plugin } from 'vite'
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

// Force all shared dependency imports to resolve to the client's
// node_modules.  Without this, addon source files (imported via the
// @ alias) resolve vue/pinia/vue-router from the addon's own
// node_modules, creating duplicate instances that break Vue's
// provide/inject (useRouter() returns undefined).
//
// Two-pronged approach:
// 1. Bare specifier interception — catches direct imports like 'vue'
// 2. Resolved-path redirect — catches imports already resolved to the
//    addon's node_modules by other plugins (e.g. VueI18nPlugin)
function dedupeSharedDeps(): Plugin {
  const nm = path.resolve(__dirname, 'node_modules')
  const addonNM = path.resolve(sharedSrc, '../node_modules')

  const forced: Record<string, string> = {
    'vue': path.resolve(nm, 'vue/dist/vue.runtime.esm-bundler.js'),
    'vue-router': path.resolve(nm, 'vue-router/dist/vue-router.mjs'),
    'pinia': path.resolve(nm, 'pinia/dist/pinia.mjs'),
    'vue-i18n': path.resolve(nm, 'vue-i18n/dist/vue-i18n.runtime.esm-bundler.js'),
    '@intlify/shared': path.resolve(nm, '@intlify/shared/dist/shared.mjs'),
    '@intlify/core-base': path.resolve(nm, '@intlify/core-base/dist/core-base.mjs'),
    '@intlify/message-compiler': path.resolve(nm, '@intlify/message-compiler/dist/message-compiler.mjs'),
  }
  return {
    name: 'dedupe-shared-deps',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      // Fast path: bare specifier match
      if (source in forced) {
        return forced[source]
      }
      // Let other plugins resolve first, then check if the result
      // lands in the addon's node_modules and redirect if so
      if (importer && !source.startsWith('\0')) {
        const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
        if (resolved && !resolved.external && resolved.id.startsWith(addonNM)) {
          const tail = resolved.id.slice(addonNM.length + 1) // strip leading /
          const redirected = path.resolve(nm, tail)
          if (fs.existsSync(redirected)) {
            return redirected
          }
        }
      }
    }
  }
}

export default defineConfig(({ mode: _mode }) => ({
  plugins: [
    dedupeSharedDeps(),
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
    alias: [
      { find: '@', replacement: sharedSrc },
    ],
    dedupe: ['vue', 'vue-router', 'pinia']
  },
  base: './'
}))
