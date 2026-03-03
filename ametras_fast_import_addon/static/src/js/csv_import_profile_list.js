/** @odoo-module **/

import { ListController } from "@web/views/list/list_controller";
import { listView } from "@web/views/list/list_view";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

class CsvImportProfileListController extends ListController {
    setup() {
        super.setup();
        this.actionService = useService("action");
        this.orm = useService("orm");
    }

    /**
     * Override row click to open the Vue profile viewer in a dialog
     * instead of the native Odoo form view.
     */
    async openRecord(record) {
        const action = await this.orm.call(
            "csv.import.profile",
            "action_open_editor",
            [record.resId],
        );
        this.actionService.doAction(action, {
            onClose: async () => {
                await this.model.load();
            },
        });
    }
}

registry.category("views").add("csv_import_profile_list", {
    ...listView,
    Controller: CsvImportProfileListController,
});
