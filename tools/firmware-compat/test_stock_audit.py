"""Exercise audit completeness and cleanup without downloading vendor images."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("stock_audit", Path(__file__).with_name("stock-audit.py"))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def archive_bytes(names=("rootfs", "services", "skills")):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:bz2") as tar:
        for name in names:
            body = (name.encode() + b"\x00") * 20
            member = tarfile.TarInfo("./images/" + name + ".ext4")
            member.size = len(body)
            tar.addfile(member, io.BytesIO(body))
    return stream.getvalue()


class Response(io.BytesIO):
    def __init__(self, body, length=None):
        super().__init__(body)
        self.headers = {"Content-Length": str(length if length is not None else len(body))}


class StockAuditTest(unittest.TestCase):
    def run_audit(self, body, expected=None, length=None, free=None, verifier_code=0):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            scratch = root / "scratch"
            output = root / "reports"
            scratch.mkdir()
            record = {"label": "fixture", "version": "13.0.0", "url": "https://example.invalid/fixture",
                      "expected_sha256": expected, "scope": "fixture"}
            contexts = [patch.object(audit.urllib.request, "urlopen", return_value=Response(body, length)),
                        patch.object(audit, "probe_image", return_value={"files": []}),
                        patch.object(audit, "dbg", return_value=b"v6.9.2\x00"),
                        patch.object(audit.subprocess, "run", return_value=subprocess.CompletedProcess([], verifier_code, "{}", ""))]
            if free is not None:
                contexts.append(patch.object(audit.shutil, "disk_usage", return_value=type("Usage", (), {"free": free})()))
            from contextlib import ExitStack
            with ExitStack() as stack:
                for context in contexts:
                    stack.enter_context(context)
                ok = audit.audit(record, output, scratch, Path("node4"), Path("node6"))
            report = json.loads((output / "fixture.json").read_text())
            self.assertEqual([p.name for p in scratch.iterdir()], ["objects"], "large images are always removed")
            return ok, report

    def test_complete_archive_and_published_checksum(self):
        body = archive_bytes()
        ok, report = self.run_audit(body, hashlib.sha256(body).hexdigest())
        self.assertTrue(ok)
        self.assertTrue(report["published_checksum_verified"])
        self.assertEqual(report["download_bytes"], len(body))
        self.assertEqual(set(report["images"]), {"rootfs", "services", "skills"})

    def test_checksum_failure_never_passes(self):
        ok, report = self.run_audit(archive_bytes(), "0" * 64)
        self.assertFalse(ok)
        self.assertIn("SHA-256", report["error"])

    def test_truncated_http_never_passes(self):
        body = archive_bytes()
        ok, report = self.run_audit(body, length=len(body) + 1)
        self.assertFalse(ok)
        self.assertIn("truncated", report["error"])

    def test_missing_and_duplicate_images_never_pass(self):
        for names in [("rootfs", "skills"), ("rootfs", "rootfs", "services", "skills")]:
            with self.subTest(names=names):
                ok, report = self.run_audit(archive_bytes(names))
                self.assertFalse(ok)
                self.assertEqual(report["status"], "error")

    def test_low_disk_space_stops_and_cleans_up(self):
        ok, report = self.run_audit(archive_bytes(), free=1)
        self.assertFalse(ok)
        self.assertIn("insufficient free space", report["error"])

    def test_file_verifier_failure_is_preserved(self):
        ok, report = self.run_audit(archive_bytes(), verifier_code=1)
        self.assertFalse(ok)
        self.assertEqual(report["status"], "failed-checks")


if __name__ == "__main__":
    unittest.main()
