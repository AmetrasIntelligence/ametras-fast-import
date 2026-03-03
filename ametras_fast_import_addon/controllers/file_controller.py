import base64
import logging
import threading
import time
import uuid

from odoo import http
from odoo.http import request

_logger = logging.getLogger(__name__)

# In-memory stream state (single-worker only)
_streams = {}
_streams_lock = threading.Lock()
_STREAM_TTL = 600  # 10 minutes


def _cleanup_expired_streams():
    """Remove streams older than TTL."""
    now = time.time()
    expired = [
        sid for sid, s in _streams.items()
        if now - s['created'] > _STREAM_TTL
    ]
    for sid in expired:
        del _streams[sid]


class FileController(http.Controller):

    # ------------------------------------------------------------------
    # Upload
    # ------------------------------------------------------------------
    @http.route(
        '/ametras_fast_import/file/upload',
        type='http', auth='user', methods=['POST'], csrf=False,
    )
    def upload(self, **kwargs):
        """Upload a CSV file and store it as ir.attachment."""
        uploaded = request.httprequest.files.get('file')
        if not uploaded:
            return request.make_json_response(
                {'error': 'No file provided'}, status=400,
            )

        content = uploaded.read()
        attachment = request.env['ir.attachment'].create({
            'name': uploaded.filename,
            'datas': base64.b64encode(content),
            'res_model': 'ametras_fast_import.file',
            'res_id': 0,
            'type': 'binary',
        })

        return request.make_json_response({
            'id': str(attachment.id),
            'name': attachment.name,
            'size': len(content),
        })

    # ------------------------------------------------------------------
    # Read full content
    # ------------------------------------------------------------------
    @http.route(
        '/ametras_fast_import/file/read',
        type='json', auth='user', methods=['POST'],
    )
    def read_file(self, file_id, encoding='utf-8', **kwargs):
        """Read full attachment content as text."""
        attachment = request.env['ir.attachment'].browse(int(file_id))
        if not attachment.exists():
            return {'error': 'Attachment not found'}

        raw = base64.b64decode(attachment.datas)
        return {'content': self._decode(raw, encoding)}

    # ------------------------------------------------------------------
    # Read head (first N bytes)
    # ------------------------------------------------------------------
    @http.route(
        '/ametras_fast_import/file/read_head',
        type='json', auth='user', methods=['POST'],
    )
    def read_head(self, file_id, bytes=4096, encoding='utf-8', **kwargs):
        """Read the first N bytes of an attachment as text."""
        attachment = request.env['ir.attachment'].browse(int(file_id))
        if not attachment.exists():
            return {'error': 'Attachment not found'}

        raw = base64.b64decode(attachment.datas)
        head = raw[:int(bytes)]
        return {'content': self._decode(head, encoding)}

    # ------------------------------------------------------------------
    # Count lines
    # ------------------------------------------------------------------
    @http.route(
        '/ametras_fast_import/file/count_lines',
        type='json', auth='user', methods=['POST'],
    )
    def count_lines(self, file_id, **kwargs):
        """Count newline bytes in an attachment.

        Counts raw 0x0A bytes without decoding to text — faster and
        uses less memory than a full text decode.

        Note: approximate for CSV files with quoted multi-line fields,
        where embedded newlines inflate the count.
        """
        attachment = request.env['ir.attachment'].browse(int(file_id))
        if not attachment.exists():
            return {'error': 'Attachment not found'}

        raw = base64.b64decode(attachment.datas)
        return {'count': raw.count(b'\n')}

    # ------------------------------------------------------------------
    # Streaming: start / next / close
    # ------------------------------------------------------------------
    @http.route(
        '/ametras_fast_import/file/stream_start',
        type='json', auth='user', methods=['POST'],
    )
    def stream_start(self, file_id, chunk_lines=1000, encoding='utf-8', **kwargs):
        """Start a streaming read of an attachment, split into chunks."""
        attachment = request.env['ir.attachment'].browse(int(file_id))
        if not attachment.exists():
            return {'error': 'Attachment not found'}

        raw = base64.b64decode(attachment.datas)
        text = self._decode(raw, encoding)
        lines = text.split('\n')

        # Build chunks: first chunk is header + chunk_lines data rows,
        # subsequent chunks are header + chunk_lines data rows
        header = lines[0] if lines else ''
        data_lines = lines[1:]
        chunk_lines = int(chunk_lines)

        chunks = []
        for i in range(0, max(len(data_lines), 1), chunk_lines):
            batch = data_lines[i:i + chunk_lines]
            chunk_text = header + '\n' + '\n'.join(batch)
            chunks.append(chunk_text)

        if not chunks:
            chunks = [header]

        stream_id = str(uuid.uuid4())
        with _streams_lock:
            _cleanup_expired_streams()
            _streams[stream_id] = {
                'chunks': chunks,
                'pos': 0,
                'created': time.time(),
            }

        return {'stream_id': stream_id}

    @http.route(
        '/ametras_fast_import/file/stream_next',
        type='json', auth='user', methods=['POST'],
    )
    def stream_next(self, stream_id, **kwargs):
        """Return the next chunk of a stream."""
        with _streams_lock:
            stream = _streams.get(stream_id)
            if not stream:
                return {'data': '', 'done': True, 'error': 'Stream not found'}

            pos = stream['pos']
            chunks = stream['chunks']

            if pos >= len(chunks):
                return {'data': '', 'done': True}

            data = chunks[pos]
            stream['pos'] = pos + 1
            done = (pos + 1) >= len(chunks)

            return {'data': data, 'done': done}

    @http.route(
        '/ametras_fast_import/file/stream_close',
        type='json', auth='user', methods=['POST'],
    )
    def stream_close(self, stream_id, **kwargs):
        """Clean up a stream."""
        with _streams_lock:
            _streams.pop(stream_id, None)
        return {'ok': True}

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _decode(raw, encoding='utf-8'):
        """Decode bytes with BOM stripping and encoding fallback."""
        # Strip UTF-8 BOM
        if raw[:3] == b'\xef\xbb\xbf':
            raw = raw[3:]
            encoding = 'utf-8'

        try:
            return raw.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            # Fallback chain
            for fallback in ('utf-8', 'latin-1', 'cp1252'):
                try:
                    return raw.decode(fallback)
                except (UnicodeDecodeError, LookupError):
                    continue
            return raw.decode('latin-1')  # latin-1 never fails
