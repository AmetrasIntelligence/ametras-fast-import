"""
Copyright (C) Thibault Francois

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Lesser General Public License as
published by the Free Software Foundation, version 3.

This program is distributed in the hope that it will be useful, but
WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
Lesser General Lesser Public License for more details.

You should have received a copy of the GNU Lesser General Public License
along with this program. If not, see <http://www.gnu.org/licenses/>.
"""

import csv
import sys
from time import time
from xmlrpc.client import Fault

from .lib.conf_lib import log, log_error, log_info
from .lib.internal.csv_reader import UnicodeWriter
from .lib.internal.csv_thread import CSVThread
from .lib.internal.io import open_write
from .lib.internal.tools import batch


class ThreadImport(CSVThread):
    def __init__(
        self,
        max_connection,
        model,
        header,
        writer,
        batch_size=20,
        backend_importer_id=None,
        context=None,
    ):
        super(ThreadImport, self).__init__(max_connection)
        self.model = model
        self.header = header
        self.batch_size = batch_size
        self.writer = writer
        self.context = context
        self.backend_importer_id = backend_importer_id
        self.model_name = context.get("import_model_name", "")
        self.registry = context.get("registry", "")
        self.superuser = context.get("superuser", "")
        self.environment = context.get("environment", "")
        self.dbname = context.get("dbname", "")
        self.uid = context.get("uid", "")
        self.remove_ids = context.get("remove_ids", False)
        self.replace_id = context.get("replace_id", False)

    def launch_batch(self, data_lines, batch_number, check=False, o2m=False):
        def launch_batch_fun(lines, batch_number, check=False):
            i = 0
            batch_size = len(lines) if o2m else self.batch_size
            for lines_batch in batch(lines, batch_size):
                lines_batch = [j for j in lines_batch]
                self.sub_batch_run(
                    lines_batch, batch_number, i, len(lines), check=check
                )
                i += 1

        self.spawn_thread(
            launch_batch_fun, [data_lines, batch_number], {"check": check}
        )

    def sub_batch_run(
        self, lines, batch_number, sub_batch_number, total_line_nb, check=False
    ):
        success = False
        st = time()
        try:
            success = self._send_rpc(lines, batch_number, sub_batch_number, check=check)
        except Fault as e:
            log_error("Line %s %s failed" % (batch_number, sub_batch_number))
            log_error(e.faultString)
        except ValueError:
            log_error(
                "Line %s %s failed value error" % (batch_number, sub_batch_number)
            )
        except Exception as e:
            log_info("Unknown Problem %s" % (e))
            exc_type, exc_value, _ = sys.exc_info()
            log_error(exc_type)
            log_error(exc_value)

        if not success:
            self.writer.writerows(lines)

        log_from = sub_batch_number * self.batch_size + 1
        log_to = (sub_batch_number + 1) * self.batch_size
        if log_to > total_line_nb:
            log_to = total_line_nb
        batch_number_display = (
            batch_number + 1 if isinstance(batch_number, int) else batch_number
        )
        log_info(
            "time for batch #%s (subbatch #%s) - %s to %s of %s validated records: %s s"
            % (
                batch_number_display,
                sub_batch_number + 1,
                log_from,
                log_to,
                total_line_nb,
                time() - st,
            )
        )

    def _send_rpc(self, lines, batch_number, sub_batch_number, check=False):
        header = list(self.header)
        if self.remove_ids:
            if "id" in self.header:
                id_index = self.header.index("id")
                header.pop(id_index)
                for line in lines:
                    line.pop(id_index)

        if self.replace_id:
            if "id" in self.header:
                id_index = self.header.index("id")
                header[id_index] = ".id"
        execute_kw = self.model
        with self.registry.manage_changes():
            res = execute_kw(
                self.dbname, self.uid, self.model_name, "load", (header, lines)
            )

        if res.get("messages", False):
            for msg in res["messages"]:
                message = msg.get("message", "")
                description = f"batch {batch_number}, {sub_batch_number}: {message}"
                log_error(description)
                if self.backend_importer_id and self.registry and self.environment:
                    try:
                        with self.registry.cursor() as cr:
                            env = self.environment(cr, self.superuser, {})
                            job = env["ametras.backend.importer.job"].browse(
                                self.backend_importer_id
                            )
                            if job.exists():
                                job.create_log("Error during import", description)
                    except Exception as e:
                        log_error("Failed to log import error: %s" % e)
                log_error(lines[msg.get("record", "no record in error msg")])
            return False
        if res.get("ids", False) and len(res["ids"]) != len(lines) and check:
            log_error(
                "number of record import is different from the record to import,"
                " probably duplicate xml_id"
            )
            return False
        return True


def filter_line_ignore(ignore, header, line):
    new_line = []
    for k, val in zip(header, line):
        if k not in ignore:
            new_line.append(val)
    return new_line


def filter_header_ignore(ignore, header):
    new_header = []
    for val in header:
        if val not in ignore:
            new_header.append(val)
    return new_header


def split_sort(split, header, data):
    split_index = 0
    if split:
        try:
            split_index = header.index(split)
        except ValueError as ve:
            log("column %s not defined" % split)
            raise ve
        data = sorted(data, key=lambda d: d[split_index])
    return data, split_index


def do_not_split(split, previous_split_value, split_index, line, o2m=False, id_index=0):
    # Do not split if you want to keep the one2many line with it's parent
    # The column id should be empty
    if o2m and not line[id_index]:
        return True
    if not split:  # If no split no need to continue
        return False
    split_value = line[split_index]
    if split_value != previous_split_value:  # Different Value no need to not split
        return False
    return True


def import_data(
    odoo_kw_method,
    model,
    header=None,
    data=None,
    file_csv=None,
    context=None,
    fail_file=False,
    encoding="utf-8",
    separator=";",
    ignore=False,
    split=False,
    check=True,
    max_connection=1,
    batch_size=10,
    skip=0,
    o2m=False,
    registry=None,
    dbname=None,
    uid=None,
    quoting=csv.QUOTE_ALL,
    backend_importer_id=None,
    environment=None,
    superuser=None,
):
    """
    Import data direct from the validation model

    """
    ignore = ignore or []
    context = context or {}
    if not header or data is None:
        raise ValueError("Please provide either a data file or a header and data")
    if fail_file:
        file_result = open_write(fail_file, encoding=encoding)
    context.update(
        {
            "import_model_name": model,
            "registry": registry,
            "dbname": dbname,
            "uid": uid,
            "environment": environment,
            "superuser": superuser,
        }
    )
    writer = UnicodeWriter(
        file_result, delimiter=separator, encoding=encoding, quoting=quoting
    )
    writer.writerow(filter_header_ignore(ignore, header))
    file_result.flush()
    rpc_thread = ThreadImport(
        int(max_connection),
        odoo_kw_method,
        filter_header_ignore(ignore, header),
        writer,
        batch_size,
        backend_importer_id,
        context,
    )
    st = time()
    id_index = header.index("id")
    data, split_index = split_sort(split, header, data)
    i = 0
    previous_split_value = False
    while i < len(data):
        lines = []
        j = 0
        while i < len(data) and (
            j < batch_size
            or do_not_split(
                split,
                previous_split_value,
                split_index,
                data[i],
                o2m=o2m,
                id_index=id_index,
            )
        ):
            line = data[i][: len(header)]
            lines.append(filter_line_ignore(ignore, header, line))
            previous_split_value = line[split_index]
            j += 1
            i += 1
        batch_number = (
            split
            and "%s - %s" % (rpc_thread.thread_number(), previous_split_value)
            or "%s" % rpc_thread.thread_number()
        )
        rpc_thread.launch_batch(lines, batch_number, check, o2m=o2m)
    rpc_thread.wait()
    file_result.close()
    num_imported = len(data)
    total_time = time() - st
    msg = f"{num_imported} {model} imported"
    description = f"{msg}, total time {total_time} seconds"
    log_info(description)
    if backend_importer_id and rpc_thread.registry and environment:
        try:
            with rpc_thread.registry.cursor() as cr:
                env = environment(cr, superuser, {})
                job = env["ametras.backend.importer.job"].browse(backend_importer_id)
                if job.exists():
                    job.create_log(msg, description)
        except Exception as e:
            log_error("Failed to log import summary: %s" % e)
    return False, False
