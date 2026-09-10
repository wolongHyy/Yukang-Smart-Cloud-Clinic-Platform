from fastapi.testclient import TestClient

from app.main import Settings, create_app


class FakeEmbedding:
    def embed(self, texts):
        for text in texts:
            yield [float(len(text)), 1.0, 0.5]


class FakeReranker:
    def rerank(self, query, documents, batch_size=64):
        for document in documents:
            yield float(len(set(query) & set(document)))


def test_health_embed_and_rerank() -> None:
    settings = Settings(cache_dir="D:/CodexTemp/yukang-rag-test", preload=False)
    app = create_app(
        settings,
        embedding_factory=lambda _settings: FakeEmbedding(),
        reranker_factory=lambda _settings: FakeReranker(),
    )
    with TestClient(app) as client:
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json()["embedding_loaded"] is False

        embedded = client.post("/api/v1/embed", json={"texts": ["咳嗽", "发热"]})
        assert embedded.status_code == 200
        assert len(embedded.json()["vectors"]) == 2

        reranked = client.post(
            "/api/v1/rerank",
            json={"query": "咳嗽发热", "documents": ["咳嗽", "腹痛"], "top_k": 1},
        )
        assert reranked.status_code == 200
        assert reranked.json()["results"][0]["index"] == 0
