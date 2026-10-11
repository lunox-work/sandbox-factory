"""Bring DeepWiki-Open's clone and index up to the repository before a wiki.

Mounted as ``/app/api/services/wiki/refresh.py`` by the ``deepwiki`` compose
profile, and wired in by ``wiki_init.py``. The image indexes a repository
once and never again: a clone that exists is used as it stands, and an index
that exists is loaded, so every later wiki described the commit of the first
one. Before each wiki task this:

- fetches the default branch's head into the shallow clone, with the task's
  token sent in a header from the environment, never on a command line or in
  the clone's configuration (and drops one an earlier clone left in its
  remote URL);
- when the head moved since the index was built, re-indexes: every file is
  read and split as the image does, and a chunk whose file and text are
  unchanged keeps the vector it had, so only what changed is embedded. A
  merge costs seconds of embedding, not the whole repository's.

The commit an index was built from is kept beside it in ``<db>.commit``.
A failed fetch or re-index fails the task rather than writing a wiki of a
stale clone.

Drop this file once the image refreshes its own clones.
"""

import asyncio
import base64
import os
import subprocess

from adalflow.components.data_process import ToEmbeddings
from adalflow.core.db import LocalDB

from api.config import configs, get_embedder, get_embedder_config, get_embedder_type
from api.logger import get_logger
from api.rag.pipeline import (
    LineTrackingTextSplitter,
    get_repo_db,
    prepare_data_pipeline,
    read_all_documents,
)
from api.repository import Repo
from api.schemas import TaskStatus
from api.services.wiki.tasks import WikiTask
from api.services.wiki.tasks import generate_repo_wiki as generate_from_index

logger = get_logger(__name__)

KEY = "split_and_embed"


class RefreshError(RuntimeError):
    """A fixed message: git's own output may name the remote."""


def _git(path: str, *args: str, env: dict[str, str] | None = None) -> str:
    try:
        return subprocess.run(
            ["git", "-C", path, *args],
            check=True,
            capture_output=True,
            text=True,
            timeout=600,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0", **(env or {})},
        ).stdout.strip()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
        raise RefreshError(f"git {args[0]} failed") from e


def _auth_env(token: str | None) -> dict[str, str]:
    """The token as a header git reads from its environment."""
    if not token:
        return {}
    basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
    return {
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "http.extraHeader",
        "GIT_CONFIG_VALUE_0": f"Authorization: Basic {basic}",
    }


def _has_vector(chunk) -> bool:
    vector = getattr(chunk, "vector", None)
    try:
        return vector is not None and len(vector) > 0
    except TypeError:
        return False


def _reindex(path: str, db_file: str, request) -> None:
    """Re-split the clone, reusing the vector of every unchanged chunk."""
    embedder_type = get_embedder_type()
    reuse = {}
    for chunk in LocalDB.load_state(db_file).get_transformed_data(key=KEY):
        if _has_vector(chunk):
            reuse[((chunk.meta_data or {}).get("file_path"), chunk.text)] = chunk.vector

    documents = read_all_documents(
        path,
        embedder_type=embedder_type,
        excluded_dirs=request.excluded_dirs,
        excluded_files=request.excluded_files,
        included_dirs=request.included_dirs,
        included_files=request.included_files,
    )
    chunks = LineTrackingTextSplitter(**configs["text_splitter"]).call(documents)
    fresh = []
    for chunk in chunks:
        vector = reuse.get(((chunk.meta_data or {}).get("file_path"), chunk.text))
        if vector is None:
            fresh.append(chunk)
        else:
            chunk.vector = vector
    if fresh:
        embed = ToEmbeddings(
            embedder=get_embedder(embedder_type=embedder_type),
            batch_size=get_embedder_config().get("batch_size", 500),
        )
        embedded = {chunk.id: chunk for chunk in embed(fresh)}
        chunks = [embedded.get(chunk.id, chunk) for chunk in chunks]

    db = LocalDB()
    db.register_transformer(transformer=prepare_data_pipeline(embedder_type), key=KEY)
    db.load(documents)
    db.transformed_items[KEY] = chunks
    partial = f"{db_file}.partial"
    db.save_state(filepath=partial)
    os.replace(partial, db_file)
    logger.info(
        "Re-indexed: %d of %d chunks embedded, the rest reused",
        len(fresh),
        len(chunks),
    )


def refresh_repo_index(request) -> None:
    """Fetch the default branch's head and re-index if it moved."""
    if request.type != "github":
        return  # The worker only asks for GitHub; others keep the image's way.
    repo = Repo(request.repo_url, request.type, access_token=request.token)
    if repo.is_local or not repo.downloaded:
        return  # A first wiki clones and indexes the head itself.
    path = repo.save_path
    db_file = get_repo_db(repo)
    stamp = f"{db_file}.commit"

    if os.path.exists(stamp):
        with open(stamp) as f:
            indexed = f.read().strip()
    else:
        # An index from before this patch was built from the clone as it
        # stands. Kept now, so a re-index that fails below is retried.
        indexed = _git(path, "rev-parse", "HEAD")
        if os.path.exists(db_file):
            with open(stamp, "w") as f:
                f.write(indexed)

    _git(path, "remote", "set-url", "origin", request.repo_url)
    _git(path, "fetch", "--depth=1", "--quiet", "origin", "HEAD", env=_auth_env(request.token))
    head = _git(path, "rev-parse", "FETCH_HEAD")
    if head != _git(path, "rev-parse", "HEAD"):
        _git(path, "reset", "--hard", "--quiet", head)
        _git(path, "clean", "-fdxq")
    if not os.path.exists(db_file) or head == indexed:
        return  # Indexed from scratch by the task, or already current.

    logger.info("Clone moved from %s to %s; re-indexing", indexed[:12], head[:12])
    _reindex(path, db_file, request)
    with open(stamp, "w") as f:
        f.write(head)


async def generate_repo_wiki(task: WikiTask) -> None:
    """The image's task, after the clone and index are brought up to date."""
    task.status = TaskStatus.INDEXING
    try:
        await asyncio.to_thread(refresh_repo_index, task.request)
    except Exception as e:
        task.status = TaskStatus.FAILED
        task.error = str(e) if isinstance(e, RefreshError) else "refresh failed"
        logger.exception("Refreshing the clone failed for %s", task.repo_key)
        return
    await generate_from_index(task)
