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
                const action = this.props.action || {};
                // Read routing data from params (preferred) with context fallback.
                // Dynamic actions use params; stored XML actions use context.
                const params = action.params || {};
                const ctx = action.context || {};
                const defaultView = params.default_view || ctx.default_view || 'import';
                const resumeLogId = params.resume_log_id || ctx.resume_log_id || null;
                const logId = params.log_id || ctx.log_id || null;
                const profileId = params.profile_id || ctx.profile_id || null;
                const inDialog = action.target === 'new' || false;
                console.log("[CsvImportVueApp] mount", { defaultView, logId, profileId, resumeLogId, inDialog });
                this._unmount = mod.mountApp(el, {
                    uid: uid,
                    baseUrl: "",
                    db: db,
                    defaultView: defaultView,
                    resumeLogId: resumeLogId,
                    logId: logId,
                    profileId: profileId,
                    inDialog: inDialog,
                    closeDialog: () => {
                        this.env.services.action.doAction({ type: 'ir.actions.act_window_close' });
                    },
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
