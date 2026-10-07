"""DeepWiki-Open's LiteLLM client, made to work against adalflow 1.1.x.

Mounted over ``/app/api/clients/litellm.py`` by the ``deepwiki`` compose
profile. Two things differ from the image's copy:

- The constructor no longer passes ``chat_completion_parser`` and
  ``env_base_url_name`` to ``OpenAIClient``, which adalflow 1.1 refuses,
  so every task failed at "determining structure".
- LLM calls go through chat completions. adalflow 1.1's ``OpenAIClient``
  sends them to the Responses API, whose stream events DeepWiki's
  OpenAI-compatible streamer cannot read (it reads ``chunk.choices``), and
  which an OpenAI-compatible endpoint such as DeepSeek or a LiteLLM proxy
  may not serve. Embeddings still go through the parent.

Drop this file once the image's client works as shipped.
"""

import os
from typing import Any, Callable, Dict, Optional

from adalflow.components.model_client.openai_client import OpenAIClient
from adalflow.core.types import CompletionUsage, GeneratorOutput, ModelType
from openai import AsyncOpenAI, OpenAI

_LLM_TYPES = (ModelType.LLM, ModelType.LLM_REASONING)


class LiteLLMClient(OpenAIClient):
    """An OpenAI-compatible endpoint named by LITELLM_BASE_URL and LITELLM_API_KEY."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        chat_completion_parser: Optional[Callable] = None,  # noqa: ARG002 - accepted, ignored
        input_type: str = "text",
        base_url: Optional[str] = None,
        env_base_url_name: str = "LITELLM_BASE_URL",
        env_api_key_name: str = "LITELLM_API_KEY",
    ):
        resolved_base_url = base_url or os.getenv(
            env_base_url_name, "http://localhost:4000"
        )
        if not resolved_base_url.endswith("/v1"):
            resolved_base_url = f"{resolved_base_url.rstrip('/')}/v1"
        super().__init__(
            api_key=api_key,
            input_type=input_type,
            base_url=resolved_base_url,
            env_api_key_name=env_api_key_name,
        )

    def init_sync_client(self):
        api_key = self._api_key or os.getenv(self._env_api_key_name, "dummy")
        return OpenAI(api_key=api_key, base_url=self.base_url)

    def init_async_client(self):
        api_key = self._api_key or os.getenv(self._env_api_key_name, "dummy")
        return AsyncOpenAI(api_key=api_key, base_url=self.base_url)

    def convert_inputs_to_api_kwargs(
        self,
        input: Optional[Any] = None,
        model_kwargs: Dict = {},
        model_type: ModelType = ModelType.UNDEFINED,
    ) -> Dict:
        if model_type not in _LLM_TYPES:
            return super().convert_inputs_to_api_kwargs(input, model_kwargs, model_type)
        kwargs = {k: v for k, v in model_kwargs.items() if k != "images"}
        kwargs["messages"] = (
            input
            if isinstance(input, list)
            else [{"role": "user", "content": str(input)}]
        )
        return kwargs

    def call(self, api_kwargs: Dict = {}, model_type: ModelType = ModelType.UNDEFINED):
        if model_type not in _LLM_TYPES:
            return super().call(api_kwargs, model_type)
        self._api_kwargs = api_kwargs
        return self.sync_client.chat.completions.create(**api_kwargs)

    async def acall(
        self, api_kwargs: Dict = {}, model_type: ModelType = ModelType.UNDEFINED
    ):
        if model_type not in _LLM_TYPES:
            return await super().acall(api_kwargs, model_type)
        self._api_kwargs = api_kwargs
        if self.async_client is None:
            self.async_client = self.init_async_client()
        return await self.async_client.chat.completions.create(**api_kwargs)

    def parse_chat_completion(self, completion: Any) -> GeneratorOutput:
        """A non-streaming chat completion; a stream is handed back as is."""
        choices = getattr(completion, "choices", None)
        if not choices:
            return GeneratorOutput(data=None, raw_response=completion, api_response=completion)
        usage = getattr(completion, "usage", None)
        return GeneratorOutput(
            data=None,
            raw_response=choices[0].message.content,
            api_response=completion,
            usage=CompletionUsage(
                completion_tokens=getattr(usage, "completion_tokens", None),
                prompt_tokens=getattr(usage, "prompt_tokens", None),
                total_tokens=getattr(usage, "total_tokens", None),
            ),
        )
