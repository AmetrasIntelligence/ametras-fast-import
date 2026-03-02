/** @odoo-module **/

import { registry } from "@web/core/registry";

const { Component, onMounted, onWillUnmount, useRef } = owl;

const SCRIPT_SRC = "/ametras_fast_import_addon/static/vue/app.js";

function ensureCsvImportApp() {
    return new Promise((resolve, reject) => {
        if (window.AmetrasCsvImport && window.AmetrasCsvImport.mountApp) {
            resolve();
            return;
        }
        const existing = document.querySelector(`script[src^="${SCRIPT_SRC}"]`);
        if (existing) {
            existing.remove();
        }
        const s = document.createElement("script");
        s.src = SCRIPT_SRC + "?v=" + Date.now();
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

class CsvImportVueApp extends Component {
    setup() {
        this.containerRef = useRef("vue-container");
        this._unmount = null;

        onMounted(async () => {
            const el = this.containerRef.el;
            if (!el) return;
            try {
                await ensureCsvImportApp();
                const mod = window.AmetrasCsvImport;
                if (!mod || !mod.mountApp) {
                    throw new Error("AmetrasCsvImport global not found");
                }
                const uid = this.env.services.user.userId;
                const db = this.env.services.user.db;
                this._unmount = mod.mountApp(el, {
                    uid: uid,
                    baseUrl: "",
                    db: db,
                });
            } catch (err) {
                console.error("[CsvImportVueApp] Failed to mount Vue app:", err);
                el.innerHTML =
                    '<p style="color:red;">Failed to load CSV Import. Check console.</p>';
            }
        });

        onWillUnmount(() => {
            if (typeof this._unmount === "function") {
                this._unmount();
            }
        });
    }
}

CsvImportVueApp.template = "ametras_fast_import_addon.CsvImportAction";

registry
    .category("actions")
    .add("ametras_csv_import_vue_app", CsvImportVueApp);
