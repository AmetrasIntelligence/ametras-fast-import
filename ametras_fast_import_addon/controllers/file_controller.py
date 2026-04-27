import base64
import logging

from odoo import http
from odoo.http import request

_logger = logging.getLogger(__name__)


class FileController(http.Controller):

    # ------------------------------------------------------------------
    # Upload
    # ------------------------------------------------------------------
    @http.route(
        "/ametras_fast_import/file/upload",
        type="http",
        auth="user",
        methods=["POST"],
        csrf=False,
    )
    def upload(self, **kwargs):
        """Upload a CSV file and store it as ir.attachment."""
        uploaded = request.httprequest.files.get("file")
        if not uploaded:
            return request.make_json_response(
                {"error": "No file provided"},
                status=400,
            )

        content = uploaded.read()
        attachment = request.env["ir.attachment"].create(
            {
                "name": uploaded.filename,
                "datas": base64.b64encode(content),
                "res_model": "ametras_fast_import.file",
                "res_id": 0,
                "type": "binary",
            }
        )

        return request.make_json_response(
            {
                "id": str(attachment.id),
                "name": attachment.name,
                "size": len(content),
            }
        )

    # ------------------------------------------------------------------
    # Read full content
    # ------------------------------------------------------------------
    @http.route(
        "/ametras_fast_import/file/read",
        type="json",
        auth="user",
        methods=["POST"],
    )
    def read_file(self, file_id, encoding="utf-8", **kwargs):
        """Read full attachment content as text."""
        attachment = request.env["ir.attachment"].browse(int(file_id))
        if not attachment.exists():
            return {"error": "Attachment not found"}

        raw = base64.b64decode(attachment.datas)
        return {"content": self._decode(raw, encoding)}

    # ------------------------------------------------------------------
    # Read head (first N bytes)
    # ------------------------------------------------------------------
    @http.route(
        "/ametras_fast_import/file/read_head",
        type="json",
        auth="user",
        methods=["POST"],
    )
    def read_head(self, file_id, bytes=4096, encoding="utf-8", **kwargs):
        """Read the first N bytes of an attachment as text."""
        attachment = request.env["ir.attachment"].browse(int(file_id))
        if not attachment.exists():
            return {"error": "Attachment not found"}

        raw = base64.b64decode(attachment.datas)
        head = raw[: int(bytes)]
        return {"content": self._decode(head, encoding)}

    # ------------------------------------------------------------------
    # Count lines
    # ------------------------------------------------------------------
    @http.route(
        "/ametras_fast_import/file/count_lines",
        type="json",
        auth="user",
        methods=["POST"],
    )
    def count_lines(self, file_id, **kwargs):
        """Count newline bytes in an attachment.

        Counts raw 0x0A bytes without decoding to text — faster and
        uses less memory than a full text decode.

        Note: approximate for CSV files with quoted multi-line fields,
        where embedded newlines inflate the count.
        """
        attachment = request.env["ir.attachment"].browse(int(file_id))
        if not attachment.exists():
            return {"error": "Attachment not found"}

        raw = base64.b64decode(attachment.datas)
        return {"count": raw.count(b"\n")}

    # ------------------------------------------------------------------
    # Streaming: stateless chunk endpoint
    # ------------------------------------------------------------------
    @http.route(
        "/ametras_fast_import/file/stream_chunk",
        type="json",
        auth="user",
        methods=["POST"],
    )
    def stream_chunk(
        self,
        file_id,
        chunk_lines=1000,
        offset=0,
        encoding="utf-8",
        has_header=True,
        **kwargs
    ):
        """Return a specific chunk of lines from an attachment (stateless).

        Each chunk includes the CSV header as the first line.
        Stream state (position) is tracked client-side.

        Uses byte-offset scanning (memchr via bytes.find) to locate line
        boundaries, then decodes only the header + requested slice to text.
        Avoids splitting the entire file into a line list per call.
        """
        attachment = request.env["ir.attachment"].browse(int(file_id))
        if not attachment.exists():
            return {"data": "", "done": True, "error": "Attachment not found"}

        raw = base64.b64decode(attachment.datas)
        chunk_lines = int(chunk_lines)
        offset = int(offset)
        if isinstance(has_header, str):
            has_header = has_header.strip().lower() not in (
                "0",
                "false",
                "no",
                "off",
                "",
            )
        else:
            has_header = bool(has_header)

        if has_header:
            # Find header boundary
            header_end = raw.find(b"\n")
            if header_end == -1:
                return {"data": self._decode(raw, encoding), "done": True}

            # Scan to byte offset of the target data line
            pos = header_end + 1
            for _ in range(offset):
                nl = raw.find(b"\n", pos)
                if nl == -1:
                    return {"data": "", "done": True}
                pos = nl + 1
        else:
            header_end = -1
            pos = 0

        # Scan chunk_lines lines for end boundary
        end = pos
        lines_found = 0
        while lines_found < chunk_lines:
            nl = raw.find(b"\n", end)
            if nl == -1:
                end = len(raw)
                break
            end = nl + 1
            lines_found += 1

        done = end >= len(raw)

        chunk_text = self._decode(raw[pos:end], encoding).rstrip("\n")

        if has_header:
            # Decode only header + chunk slice
            header_text = self._decode(raw[:header_end], encoding)
            if not chunk_text:
                return {"data": header_text, "done": True}
            return {"data": header_text + "\n" + chunk_text, "done": done}

        return {"data": chunk_text, "done": done}

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _decode(raw, encoding="utf-8"):
        """Decode bytes with BOM stripping and encoding fallback."""
        # Strip UTF-8 BOM
        if raw[:3] == b"\xef\xbb\xbf":
            raw = raw[3:]
            encoding = "utf-8"

        try:
            return raw.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            # Fallback chain
            for fallback in ("utf-8", "latin-1", "cp1252"):
                try:
                    return raw.decode(fallback)
                except (UnicodeDecodeError, LookupError):
                    continue
            return raw.decode("latin-1")  # latin-1 never fails
