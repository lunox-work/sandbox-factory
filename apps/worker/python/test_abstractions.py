import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

FIXTURE = Path(__file__).resolve().parent.parent / "fixtures" / "polyglot"
LISTING = [
    {"path": "py/users.py", "language": "python"},
    {"path": "py/helpers.py", "language": "python"},
    {"path": "go/store.go", "language": "go"},
    {"path": "go/user.go", "language": "go"},
    {"path": "java/UserService.java", "language": "java"},
    {"path": "../outside.py", "language": "python"},
    {"path": "py/missing.py", "language": "python"},
    {"path": "README.md", "language": "markdown"},
]


class AbstractionsTest(unittest.TestCase):
    def extract(self, source=FIXTURE, listing=None):
        with tempfile.TemporaryDirectory() as directory:
            listing_path = Path(directory) / "listing.json"
            out = Path(directory) / "out.json"
            listing_path.write_text(json.dumps(LISTING if listing is None else listing))
            subprocess.run([sys.executable, str(Path(__file__).with_name("abstractions.py")), str(source), str(listing_path), str(out)], check=True, capture_output=True)
            text = out.read_text()
            return text, json.loads(text)

    def exports(self, result, path):
        module = next(module for module in result["modules"] if module["path"] == path)
        return {entry["name"]: entry for entry in module["exports"]}

    def test_python_follows_all_and_lists_public_methods(self):
        _, result = self.extract()
        users = self.exports(result, "py/users.py")
        self.assertEqual(sorted(users), ["LIMIT", "User", "User.__init__", "User.display", "get_user"])
        self.assertEqual(users["get_user"]["signature"], "def get_user(id: int) -> User")
        self.assertEqual(users["get_user"]["references"], ["User", "int"])
        self.assertEqual(users["User"]["signature"], "@dataclass\nclass User")
        self.assertEqual(users["User"]["line"], 10)
        self.assertEqual(users["LIMIT"]["signature"], "LIMIT: int = 10")
        helpers = self.exports(result, "py/helpers.py")
        self.assertEqual(sorted(helpers), ["Alias", "VERSION", "public_helper"])
        self.assertEqual(helpers["Alias"]["kind"], "type")

    def test_go_exports_capitalised_names_and_receivers(self):
        _, result = self.extract()
        store = self.exports(result, "go/store.go")
        self.assertEqual(sorted(store), ["MaxUsers", "NewStore", "Store", "User.Display"])
        self.assertEqual(store["NewStore"]["signature"], "func NewStore(dsn string) Store")
        self.assertEqual(store["Store"]["kind"], "interface")
        self.assertEqual(store["User.Display"]["kind"], "method")
        user = self.exports(result, "go/user.go")
        self.assertEqual(user["User"]["kind"], "class")
        self.assertIn('gorm:"primaryKey"', user["User"]["signature"])

    def test_java_lists_public_and_protected_members(self):
        _, result = self.extract()
        service = self.exports(result, "java/UserService.java")
        self.assertEqual(sorted(service), ["UserService", "UserService.LIMIT", "UserService.Mode", "UserService.UserService", "UserService.audit", "UserService.find"])
        self.assertEqual(service["UserService.find"]["signature"], "public User find(long id) throws NotFound")
        self.assertEqual(service["UserService.Mode"]["kind"], "enum")

    def test_reads_only_regular_files_inside_the_source(self):
        _, result = self.extract()
        self.assertEqual([(o["code"], o["file"]) for o in result["omissions"]], [("read_failed", "../outside.py"), ("read_failed", "py/missing.py")])
        self.assertNotIn("README.md", [module["path"] for module in result["modules"]])

    def test_syntax_errors_are_recorded_and_output_is_deterministic(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "broken.py").write_text("def ok() -> int:\n    return 1\n\ndef broken(:\n")
            os.symlink("/etc/hosts", root / "link.py")
            listing = [{"path": "broken.py", "language": "python"}, {"path": "link.py", "language": "python"}]
            first, result = self.extract(root, listing)
            second, _ = self.extract(root, listing)
            self.assertEqual(first, second)
            self.assertEqual([o["code"] for o in result["omissions"]], ["parse_failed", "read_failed"])
            self.assertIn("ok", self.exports(result, "broken.py"))


if __name__ == "__main__":
    unittest.main()
