# YuKang Local RAG Worker

FastAPI worker for local embedding and optional reranking. Patient text stays on the clinic machine.

## Environment

- Model cache: `D:\CodexModels\fastembed`
- Health: `GET /health`
- Embedding: `POST /api/v1/embed`
- Reranking: `POST /api/v1/rerank`

## Build the full SQLite hybrid index

Start this worker, then from `愈康项目源码/clinic_system` run:

```powershell
node tools/build_knowledge_package.js --output D:\YukangKnowledge\v5-full --url http://127.0.0.1:8765 --batch 64
```

The output contains the full index, a manifest with counts/checksum, and `knowledge-package.zip`. A CUDA-capable builder is available at `tools/build_hybrid_index_gpu.py`; without CUDA use the CPU path above.

## Tests

```powershell
$env:PYTHONPATH = (Resolve-Path .).Path
D:\CodexEnvs\yukang-rag\Scripts\python.exe -m pytest -q tests
```
