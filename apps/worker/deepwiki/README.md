# DeepWiki-Open configuration

The configuration directory the `deepwiki` compose profile mounts into
DeepWiki-Open (`DEEPWIKI_CONFIG_DIR`), so the `deepwiki` context builder has
a service to ask. See the `deepwiki` and `ollama` services in
`docker-compose.yml` and the worker README's "Context builders" section.

- `generator.json`: the model that writes the wiki. DeepWiki-Open has no
  Anthropic provider, so its LiteLLM provider (any OpenAI-compatible
  endpoint) is pointed at DeepSeek, which sizing already uses; the compose
  file passes `DEEPSEEK_API_KEY` as `LITELLM_API_KEY`. Ollama is kept as a
  fully local fallback (`DEEPWIKI_OPEN_PROVIDER=ollama`).
- `embedder.json`: embeddings for its retrieval, from the Ollama sidecar
  (`nomic-embed-text`, pulled on first start), since no embedding provider
  needs a key that way. The model is named with its `:latest` tag because
  DeepWiki-Open compares the name exactly against what Ollama lists.
- `repo.json` and `lang.json`: DeepWiki-Open's own defaults, kept verbatim
  apart from the language list, because the loader reads every file from
  this directory.

- `patches/litellm.py`: the image's LiteLLM client with a constructor that
  works against the adalflow the image ships; the compose file mounts it
  over the original. Remove it once upstream constructs cleanly.
- `patches/wiki_refresh.py` and `patches/wiki_init.py`: the image indexes a
  repository once and never refreshes its clone, so every later wiki
  described the first commit it saw. Mounted as
  `api/services/wiki/refresh.py` and over the package's `__init__.py`, they
  fetch the default branch's head before each wiki task and, when it moved,
  re-index, re-embedding only chunks whose file and text changed. The token
  goes to git in a header from the environment and is no longer left in the
  clone's remote URL. Remove them once upstream refreshes its clones.

Pages are written eight at a time (`DEEPWIKI_WIKI_PAGE_CONCURRENCY` in the
compose file) rather than one by one; the worker asks for a concise wiki
(four to six pages), so a wiki takes about a minute rather than eight.

The repository read token is sent to the service with each task, so this
profile is for a trusted, local deployment only.
