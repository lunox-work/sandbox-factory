"""DeepWiki-Open's ``api.services.wiki`` package, exporting the refreshing task.

Mounted over ``/app/api/services/wiki/__init__.py`` by the ``deepwiki``
compose profile. The one change from the image's copy: ``generate_repo_wiki``,
which the wiki router imports from here, is ``refresh.py``'s, which brings the
clone and its index up to date before running the image's own. Drop this
file with ``wiki_refresh.py``.
"""

from api.services.wiki.io import (
    export_wiki,
    save_wiki_cache,
    get_wiki_cache_path,
    wiki_cache_exists,
    read_wiki_cache,
    delete_wiki_cache,
    list_wiki_cache,
    list_processed_projects,
)

from api.services.wiki.tasks import (
    WikiTask,
    registry,
)

# The task the router submits: the image's, after the clone and its index are
# brought up to the repository's head. See refresh.py.
from api.services.wiki.refresh import generate_repo_wiki

__all__ = [
    "export_wiki",
    "save_wiki_cache",
    "get_wiki_cache_path",
    "wiki_cache_exists",
    "read_wiki_cache",
    "delete_wiki_cache",
    "list_wiki_cache",
    "list_processed_projects",
    "WikiTask",
    "registry",
    "generate_repo_wiki",
]
