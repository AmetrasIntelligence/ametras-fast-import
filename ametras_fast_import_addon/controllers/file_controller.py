import base64
import hashlib
import io
import logging
import os
import shutil
import tempfile

from odoo import http
from odoo.http import request
from odoo.tools import config

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
        """Upload a CSV file and store it as ir.attachment.

        Streams directly to the Odoo filestore in 64 KB chunks so the full file
        is never held in a Python bytes object.  Falls back to the in-memory
        base64 path only if the filestore write fails (e.g. DB-only storage).
        """
        uploaded = request.httprequest.files.get("file")
        if not uploaded:
            return request.make_json_response(
                {"error": "No file provided"},
                status=400,
            )

        try:
            fname, checksum, size = self._stream_to_filestore(
                request.env, uploaded.stream
            )
            attachment = request.env["ir.attachment"].create(
                {
                    "name": uploaded.filename,
                    "res_model": "ametras_fast_import.file",
                    "res_id": 0,
                    "type": "binary",
                    "store_fname": fname,
                    "file_size": size,
                    "checksum": checksum,
                }
            )
        except OSError as exc:
            _logger.warning(
                "Filestore stream write failed (%s); falling back to in-memory path",
                exc,
            )
            uploaded.stream.seek(0)
            content = uploaded.stream.read()
            size = len(content)
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
                "size": size,
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

        with self._attachment_fileobj(attachment) as f:
            raw = f.read()
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

        with self._attachment_fileobj(attachment) as f:
            head = f.read(int(bytes))
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
        """Count logical lines in an attachment without loading it all at once.

        Streams through the file in 64 KB chunks so large files never require
        the full content in memory at the same time. Counts newline bytes, plus
        one for a final line that has no trailing newline — so a file with a
        header and a single data row but no trailing newline reports 2 lines,
        not 1. This matches the Electron ``files:countLines`` readline contract
        the frontend relies on (otherwise the row count is off by one and a
        single-data-row file is analysed as 0 rows).
        """
        attachment = request.env["ir.attachment"].browse(int(file_id))
        if not attachment.exists():
            return {"error": "Attachment not found"}

        count = 0
        last_byte = b""
        with self._attachment_fileobj(attachment) as f:
            for chunk in iter(lambda: f.read(65536), b""):
                count += chunk.count(b"\n")
                last_byte = chunk[-1:]
        # Account for a final line not terminated by a newline.
        if last_byte and last_byte != b"\n":
            count += 1
        return {"count": count}

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

        Each chunk includes the CSV header as the first line so the caller
        can pass it directly to a CSV parser.  Stream state (offset) is
        tracked client-side.

        Uses readline() on the underlying file object so only the requested
        lines ever need to be in memory — the full attachment is never decoded
        up front.
        """
        attachment = request.env["ir.attachment"].browse(int(file_id))
        if not attachment.exists():
            return {"data": "", "done": True, "error": "Attachment not found"}

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

        with self._attachment_fileobj(attachment) as f:
            header_text = ""
            if has_header:
                raw_header = f.readline()
                if not raw_header:
                    return {"data": "", "done": True}
                header_text = self._decode(raw_header.rstrip(b"\r\n"), encoding)

            # Skip `offset` data lines
            for _ in range(offset):
                if not f.readline():
                    return {"data": "", "done": True}

            # Read up to chunk_lines data lines
            lines = []
            for _ in range(chunk_lines):
                raw_line = f.readline()
                if not raw_line:
                    break
                lines.append(self._decode(raw_line.rstrip(b"\r\n"), encoding))

            if not lines:
                return {"data": header_text if has_header else "", "done": True}

            # Determine EOF: fewer lines than requested, or next read is empty
            done = len(lines) < chunk_lines or not f.read(1)

        chunk_text = "\n".join(lines)
        if has_header:
            return {"data": header_text + "\n" + chunk_text, "done": done}
        return {"data": chunk_text, "done": done}

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _stream_to_filestore(env, stream):
        """Write a file stream to the Odoo filestore without loading it into RAM.

        Writes in 64 KB chunks while computing the SHA-1 checksum, then moves
        the temp file to the permanent content-addressed location that Odoo uses
        internally (``sha[:2]/sha``).  Only one chunk buffer is ever in memory.

        Returns (store_fname, checksum, size).
        """
        filestore_dir = config.filestore(env.cr.dbname)
        os.makedirs(filestore_dir, exist_ok=True)

        sha = hashlib.sha1()
        size = 0
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(
                dir=filestore_dir, prefix="upload_", delete=False
            ) as tmp:
                tmp_path = tmp.name
                for chunk in iter(lambda: stream.read(65536), b""):
                    sha.update(chunk)
                    tmp.write(chunk)
                    size += len(chunk)

            checksum = sha.hexdigest()
            fname = checksum[:2] + "/" + checksum
            final_path = os.path.join(filestore_dir, fname)
            os.makedirs(os.path.dirname(final_path), exist_ok=True)

            if os.path.exists(final_path):
                os.unlink(tmp_path)
            else:
                shutil.move(tmp_path, final_path)
            tmp_path = None  # successfully placed; don't clean up
        except Exception:
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
            raise

        return fname, checksum, size

    @staticmethod
    def _attachment_fileobj(attachment):
        """Return an open binary file-like context manager for an attachment.

        For filestore-backed attachments (large files), opens the raw file on
        disk to avoid decoding the entire base64 blob into memory.  For small
        DB-stored attachments, wraps the decoded bytes in a BytesIO.

        Both return types are context managers and support read() / readline().
        """
        if attachment.store_fname:
            return open(attachment._full_path(attachment.store_fname), "rb")
        return io.BytesIO(base64.b64decode(attachment.datas or b""))

    @staticmethod
    def _decode(raw, encoding="utf-8"):
        """Decode bytes with BOM stripping and encoding fallback."""
        if isinstance(raw, str):
            return raw
        # Strip UTF-8 BOM
        if raw[:3] == b"\xef\xbb\xbf":
            raw = raw[3:]
            encoding = "utf-8"

        try:
            return raw.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            for fallback in ("utf-8", "latin-1", "cp1252"):
                try:
                    return raw.decode(fallback)
                except (UnicodeDecodeError, LookupError):
                    continue
            return raw.decode("latin-1")  # latin-1 never fails
