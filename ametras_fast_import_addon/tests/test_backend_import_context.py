"""
Regression tests for the import call context (APX-3828).

A bulk import must create/write with mail.thread side-effects disabled
(follower auto-subscription, tracking, creation log). Without it, creating a
record runs full mail machinery; on stacks with custom create() overrides that
also subscribe a partner, the same follower can be inserted twice in one create
and hit the mail_followers unique constraint
("a partner cannot follow the same object twice").

These tests assert that RpcBackend.create/write pass IMPORT_CALL_CONTEXT to
execute_kw. Run with:
    python3 ametras_fast_import_addon/tests/test_backend_import_context.py
"""
import os
import sys
import unittest
from unittest.mock import MagicMock

_engine_path = os.path.join(os.path.dirname(__file__), "..", "models")
if _engine_path not in sys.path:
    sys.path.insert(0, os.path.abspath(_engine_path))

from import_engine.backend import RpcBackend  # noqa: E402
from import_engine.constants import IMPORT_CALL_CONTEXT  # noqa: E402


class TestImportCallContext(unittest.TestCase):
    def _backend_with_mock_proxy(self, lang=None):
        backend = RpcBackend(
            "http://localhost:8069", "db", 2, "pw", lang=lang
        )
        proxy = MagicMock()
        proxy.execute_kw.return_value = 42
        backend._get_proxy = lambda: proxy
        return backend, proxy

    @staticmethod
    def _context_of(proxy):
        # execute_kw(db, uid, pw, model, method, args, call_kwargs)
        call_kwargs = proxy.execute_kw.call_args[0][6]
        return call_kwargs.get("context", {})

    def test_create_passes_mail_suppression_context(self):
        backend, proxy = self._backend_with_mock_proxy()
        backend.create("product.template", {"name": "Widget"})
        ctx = self._context_of(proxy)
        for key, value in IMPORT_CALL_CONTEXT.items():
            self.assertEqual(ctx.get(key), value, f"missing/incorrect {key}")

    def test_write_passes_mail_suppression_context(self):
        backend, proxy = self._backend_with_mock_proxy()
        backend.write("product.template", [1], {"name": "Widget"})
        ctx = self._context_of(proxy)
        self.assertTrue(ctx.get("mail_create_nosubscribe"))
        self.assertTrue(ctx.get("tracking_disable"))

    def test_context_merges_with_lang(self):
        # The configured import language must survive alongside the mail flags.
        backend, proxy = self._backend_with_mock_proxy(lang="de_DE")
        backend.create("product.template", {"name": "Widget"})
        ctx = self._context_of(proxy)
        self.assertEqual(ctx.get("lang"), "de_DE")
        self.assertTrue(ctx.get("mail_create_nosubscribe"))

    def test_reads_do_not_carry_import_context(self):
        # search/search_read must not be polluted with create-only flags.
        backend, proxy = self._backend_with_mock_proxy()
        proxy.execute_kw.return_value = []
        backend.search("product.template", [("name", "=", "x")])
        ctx = self._context_of(proxy)
        self.assertNotIn("mail_create_nosubscribe", ctx)


if __name__ == "__main__":
    unittest.main(verbosity=2)
