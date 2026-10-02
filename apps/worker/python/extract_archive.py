"""Validate bounded repository archives before writing any member to disk."""
import argparse
from pathlib import Path, PurePosixPath
import shutil
import sys
import tarfile


def extract(archive, destination, max_files, max_bytes):
    with tarfile.open(archive, "r:gz") as source:
        members, total, root = [], 0, None
        for member in source:
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or not path.parts or len(path.parts) > 64:
                raise ValueError("source_unavailable")
            root = root or path.parts[0]
            if path.parts[0] != root or not (member.isfile() or member.isdir()):
                raise ValueError("source_unavailable")
            if member.isdir():
                continue
            if len(path.parts) < 2:
                raise ValueError("source_unavailable")
            total += member.size
            if total > max_bytes:
                raise ValueError("too_large")
            members.append((member, Path(*path.parts[1:])))
            if len(members) > max_files:
                raise ValueError("too_many_files")
        if not members:
            raise ValueError("source_unavailable")
        destination.mkdir(parents=True, exist_ok=True)
        for member, relative in members:
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(member) as content, target.open("xb") as output:
                shutil.copyfileobj(content, output)
    return len(members)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("max_files", type=int)
    parser.add_argument("max_bytes", type=int)
    arguments = parser.parse_args()
    try:
        print(extract(arguments.archive, arguments.destination, arguments.max_files, arguments.max_bytes))
    except (ValueError, tarfile.TarError, OSError) as error:
        code = str(error)
        print(code if code in ("too_large", "too_many_files") else "source_unavailable", file=sys.stderr)
        sys.exit({"too_large": 2, "too_many_files": 3}.get(code, 4))
