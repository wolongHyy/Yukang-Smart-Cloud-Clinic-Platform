# YuKang Local RAG Worker

Local FastAPI worker for offline Chinese embedding and optional cross-encoder reranking.

- Embedding model: `BAAI/bge-small-zh-v1.5`
- Reranker model: `Xenova/ms-marco-MiniLM-L-6-v2` by default; `BAAI/bge-reranker-base` can be selected when hardware allows.
- Default cache: `D:\CodexModels\fastembed`
- Offline mode: `HF_HUB_OFFLINE=1`

## Run

```powershell
$env:HF_HUB_OFFLINE = "1"
$env:YUKONG_RAG_CACHE_DIR = "D:\CodexModels\fastembed"
D:\CodexEnvs\yukang-rag\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8765
```

## Endpoints

- `GET /health`
- `POST /api/v1/embed`
- `POST /api/v1/rerank`

The worker never calls a cloud model. Patient text is embedded on the clinic computer.
