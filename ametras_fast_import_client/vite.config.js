var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
var _a;
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import VueI18nPlugin from '@intlify/unplugin-vue-i18n/vite';
import path from 'path';
import fs from 'fs';
// Simple plugin to copy preload.cjs to dist-electron
function copyPreload() {
    return {
        name: 'copy-preload',
        writeBundle: function () {
            var src = path.resolve(__dirname, 'electron/preload.cjs');
            var dest = path.resolve(__dirname, 'dist-electron/preload.cjs');
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
        }
    };
}
var isElectron = ((_a = process.env.npm_lifecycle_event) === null || _a === void 0 ? void 0 : _a.includes('electron')) ||
    process.argv.includes('electron');
// Shared source lives in the addon's vue-app
var sharedSrc = path.resolve(__dirname, '../ametras_fast_import_addon/vue-app/src');
export default defineConfig(function (_a) {
    var mode = _a.mode;
    return ({
        plugins: __spreadArray([
            vue(),
            VueI18nPlugin({
                include: [path.resolve(sharedSrc, 'i18n/locales/**')],
                strictMessage: false,
                escapeHtml: false,
                runtimeOnly: true
            })
        ], (isElectron ? [
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
        ] : []), true),
        resolve: {
            alias: {
                '@': sharedSrc,
                'vue-i18n': 'vue-i18n/dist/vue-i18n.runtime.esm-bundler.js'
            }
        },
        base: './'
    });
});
