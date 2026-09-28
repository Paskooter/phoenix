"""Small contract tests for the mandatory BE OTA completeness gate."""

from __future__ import annotations

import io
import tarfile
import unittest

from be_ota_integrity import inspect_tar, safe_name, unresolved_mains


def member(name: str, data: bytes = b"x", *, owner: int = 2000) -> tarfile.TarInfo:
    item = tarfile.TarInfo(name)
    item.size = len(data)
    item.uid = item.gid = owner
    return item


class BeOtaIntegrityTest(unittest.TestCase):
    def test_rejects_path_traversal_and_escaping_links(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsafe tar member path"):
            safe_name(member("../../outside"))
        link = tarfile.TarInfo("./node_modules/example/link")
        link.type = tarfile.SYMTYPE
        link.linkname = "../../../outside"
        with self.assertRaisesRegex(ValueError, "escaping tar link"):
            safe_name(link)

    def test_detects_missing_declared_main(self) -> None:
        records = {"node_modules/@be/nimbus/package.json": ("file", "hash")}
        packages = {"node_modules/@be/nimbus/package.json": {"main": "index.js"}}
        self.assertEqual(len(unresolved_mains(records, packages)), 1)
        records["node_modules/@be/nimbus/index.js"] = ("file", "hash")
        self.assertEqual(unresolved_mains(records, packages), [])

    def test_inspection_rejects_wrong_owner_and_duplicate_members(self) -> None:
        content = io.BytesIO()
        with tarfile.open(fileobj=content, mode="w") as archive:
            record = member("./index.js", owner=0)
            archive.addfile(record, io.BytesIO(b"x"))
        content.seek(0)
        with tarfile.open(fileobj=content, mode="r:") as archive:
            with self.assertRaisesRegex(ValueError, "wrong BE OTA ownership"):
                inspect_tar(archive, require_skill_owner=True)

        content = io.BytesIO()
        with tarfile.open(fileobj=content, mode="w") as archive:
            for _ in range(2):
                archive.addfile(member("./index.js"), io.BytesIO(b"x"))
        content.seek(0)
        with tarfile.open(fileobj=content, mode="r:") as archive:
            with self.assertRaisesRegex(ValueError, "duplicate tar member"):
                inspect_tar(archive)


if __name__ == "__main__":
    unittest.main()
