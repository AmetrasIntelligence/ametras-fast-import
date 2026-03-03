/** @odoo-module **/

import { ListController } from "@web/views/list/list_controller";
import { listView } from "@web/views/list/list_view";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

class CsvImportLogListController extends ListController {
    setup() {
        super.setup();
        this.actionService = useService("action");
        this.orm = useService("orm");
    }

    /**
     * Override row click to open the Vue dialog via action_open_log
     * instead of the native Odoo form view.
     */
    async openRecord(record) {
        const action = await this.orm.call(
            "csv.import.log",
            "action_open_log",
            [record.resId],
        );
        this.actionService.doAction(action, {
            onClose: async () => {
                await this.model.load();
            },
        });
    }

    /**
     * Open a fresh import dialog from the control panel button.
     */
    onStartNewImport() {
        this.actionService.doAction({
            type: "ir.actions.client",
            tag: "ametras_csv_import_vue_app",
            name: "Start Import",
            target: "new",
            params: { default_view: "import" },
            context: { dialog_size: "extra-large" },
        }, {
            onClose: () => this.model.load(),
        });
    }
}

registry.category("views").add("csv_import_log_list", {
    ...listView,
    Controller: CsvImportLogListController,
    buttonTemplate: "ametras_fast_import_addon.CsvImportLogListButtons",
});
