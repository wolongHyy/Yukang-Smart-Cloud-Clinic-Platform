from __future__ import annotations

import os

from contextlib import asynccontextmanager
from threading import Lock
from typing import Callable

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


os.environ.setdefault('HF_HUB_OFFLINE', '1')


class Settings(BaseSettings):
    model_name: str = "BAAI/bge-small-zh-v1.5"
    reranker_model: str = "Xenova/ms-marco-MiniLM-L-6-v2"
    cache_dir: str = r"D:\CodexModels\fastembed"
    threads: int | None = None
    preload: bool = False

    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="YUKONG_RAG_",
        extra="ignore",
    )


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=512)


class EmbedResponse(BaseModel):
    model: str
    dimension: int
    vectors: list[list[float]]


class RerankRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    documents: list[str] = Field(min_length=1, max_length=200)
    top_k: int = Field(default=5, ge=1, le=50)


class RerankResult(BaseModel):
    index: int
    score: float
    document: str


class RerankResponse(BaseModel):
    model: str
    results: list[RerankResult]


def default_embedding_factory(settings: Settings):
    from fastembed import TextEmbedding

    return TextEmbedding(
        model_name=settings.model_name,
        cache_dir=settings.cache_dir,
        threads=settings.threads,
    )


def default_reranker_factory(settings: Settings):
    from fastembed.rerank.cross_encoder import TextCrossEncoder

    return TextCrossEncoder(
        model_name=settings.reranker_model,
        cache_dir=settings.cache_dir,
        threads=settings.threads,
    )


class ModelRegistry:
    def __init__(
        self,
        settings: Settings,
        embedding_factory: Callable[[Settings], object],
        reranker_factory: Callable[[Settings], object],
    ) -> None:
        self.settings = settings
        self.embedding_factory = embedding_factory
        self.reranker_factory = reranker_factory
        self._embedding = None
        self._reranker = None
        self._lock = Lock()

    def embedding(self):
        if self._embedding is None:
            with self._lock:
                if self._embedding is None:
                    self._embedding = self.embedding_factory(self.settings)
        return self._embedding

    def reranker(self):
        if self._reranker is None:
            with self._lock:
                if self._reranker is None:
                    self._reranker = self.reranker_factory(self.settings)
        return self._reranker

    @property
    def embedding_loaded(self) -> bool:
        return self._embedding is not None

    @property
    def reranker_loaded(self) -> bool:
        return self._reranker is not None


def create_app(
    settings: Settings | None = None,
    embedding_factory: Callable[[Settings], object] = default_embedding_factory,
    reranker_factory: Callable[[Settings], object] = default_reranker_factory,
) -> FastAPI:
    settings = settings or Settings()
    registry = ModelRegistry(settings, embedding_factory, reranker_factory)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if settings.preload:
            registry.embedding()
            registry.reranker()
        yield

    app = FastAPI(title="YuKang Local RAG Worker", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.models = registry

    @app.get("/health")
    def health() -> dict:
        return {
            "status": "ok",
            "embedding_model": settings.model_name,
            "reranker_model": settings.reranker_model,
            "cache_dir": settings.cache_dir,
            "embedding_loaded": registry.embedding_loaded,
            "reranker_loaded": registry.reranker_loaded,
        }

    @app.post("/api/v1/embed", response_model=EmbedResponse)
    def embed(body: EmbedRequest) -> EmbedResponse:
        try:
            vectors = [list(map(float, vector)) for vector in registry.embedding().embed(body.texts)]
        except Exception as exc:
            raise HTTPException(status_code=503, detail=f"embedding unavailable: {exc}") from exc
        dimension = len(vectors[0]) if vectors else 0
        return EmbedResponse(model=settings.model_name, dimension=dimension, vectors=vectors)

    @app.post("/api/v1/rerank", response_model=RerankResponse)
    def rerank(body: RerankRequest) -> RerankResponse:
        try:
            scores = list(registry.reranker().rerank(body.query, body.documents))
        except Exception as exc:
            raise HTTPException(status_code=503, detail=f"reranker unavailable: {exc}") from exc
        ranked = sorted(enumerate(scores), key=lambda item: item[1], reverse=True)[: body.top_k]
        return RerankResponse(
            model=settings.reranker_model,
            results=[
                RerankResult(index=index, score=float(score), document=body.documents[index])
                for index, score in ranked
            ],
        )

    return app


app = create_app()
