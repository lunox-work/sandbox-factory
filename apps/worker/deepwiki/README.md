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

The repository read token is sent to the service with each task, so this
profile is for a trusted, local deployment only.
