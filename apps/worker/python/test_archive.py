import io
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest


class ArchiveTest(unittest.TestCase):
    def extract(self, entries, files=10, size=100):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "source.tar.gz"
            with tarfile.open(archive, "w:gz") as output:
                for name, content, kind in entries:
                    entry = tarfile.TarInfo(name)
                    entry.type = kind
                    entry.size = len(content) if kind == tarfile.REGTYPE else 0
                    entry.linkname = "/etc/passwd" if kind == tarfile.SYMTYPE else ""
                    output.addfile(entry, io.BytesIO(content))
            result = subprocess.run([sys.executable, str(Path(__file__).with_name("extract_archive.py")), str(archive), str(root / "out"), str(files), str(size)], capture_output=True)
            return result.returncode, sorted(path.relative_to(root / "out").as_posix() for path in (root / "out").rglob("*") if path.is_file())

    def test_valid(self):
        code, files = self.extract([("repo/src/file.ts", b"source", tarfile.REGTYPE)])
        self.assertEqual((code, files), (0, ["src/file.ts"]))

    def test_limits(self):
        self.assertEqual(self.extract([("repo/a", b"ab", tarfile.REGTYPE)], size=1)[0], 2)
        self.assertEqual(self.extract([("repo/a", b"", tarfile.REGTYPE), ("repo/b", b"", tarfile.REGTYPE)], files=1), (3, []))

    def test_traversal_and_multiple_roots(self):
        for name in ["repo/../../escape", "/etc/passwd"]:
            self.assertEqual(self.extract([(name, b"", tarfile.REGTYPE)]), (4, []))
        self.assertEqual(self.extract([("one/a", b"", tarfile.REGTYPE), ("two/b", b"", tarfile.REGTYPE)]), (4, []))

    def test_links_are_skipped_never_written(self):
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE]:
            # Links alone leave nothing to analyze; beside a file they are left out.
            self.assertEqual(self.extract([("repo/link", b"", kind)]), (4, []))
            self.assertEqual(self.extract([("repo/link", b"", kind), ("repo/src/file.ts", b"source", tarfile.REGTYPE)]), (0, ["src/file.ts"]))


if __name__ == "__main__":
    unittest.main()
