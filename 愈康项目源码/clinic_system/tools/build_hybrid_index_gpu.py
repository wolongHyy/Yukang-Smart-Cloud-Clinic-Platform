from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path


def split_text(text: str, size: int = 600, overlap: int = 90) -> list[str]:
    value = " ".join(str(text or "").split())
    if len(value) <= size:
        return [value] if value else []
    parts: list[str] = []
    start = 0
    while start < len(value):
        parts.append(value[start:start + size])
        if start + size >= len(value):
            break
        start += size - overlap
    return parts


def main() -> None:
    parser = argparse.ArgumentParser(description="GPU/CPU builder for the YuKang SQLite hybrid knowledge index")
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="BAAI/bge-small-zh-v1.5")
    parser.add_argument("--device", choices=["cuda", "cpu", "auto"], default="auto")
    parser.add_argument("--batch", type=int, default=128)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--allow-cpu", action="store_true")
    args = parser.parse_args()

    try:
        import torch
        from sentence_transformers import SentenceTransformer
    except Exception as exc:
        raise SystemExit(
            "缺少 GPU 构建依赖。请在 D: 盘环境安装 torch + sentence-transformers，"
            "也可先运行 CPU 构建：node tools/build_hybrid_index.js --url http://127.0.0.1:8765"
        ) from exc

    if args.device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    else:
        device = args.device
    if device == "cuda" and not torch.cuda.is_available():
        raise SystemExit("当前环境没有可用的 CUDA GPU")
    if device == "cpu" and not args.allow_cpu:
        raise SystemExit("拒绝未显式允许的 CPU 构建；请增加 --allow-cpu，或使用 CUDA 环境")

    source = Path(args.source)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()

    chunks: list[dict] = []
    with source.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            for text in split_text(row.get("text", "")):
                chunks.append({"book": row.get("book", ""), "page": int(row.get("page") or 0), "text": text})
            if args.limit and len(chunks) >= args.limit:
                break
    chunks = chunks[: args.limit or None]
    if not chunks:
        raise SystemExit("没有可构建的知识块")

    model = SentenceTransformer(args.model, device=device)
    embeddings = model.encode(
        [item["text"] for item in chunks],
        batch_size=args.batch,
        normalize_embeddings=True,
        show_progress_bar=True,
    )

    db = sqlite3.connect(output)
    try:
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript(
            """
            CREATE TABLE chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                book TEXT NOT NULL,
                page INTEGER NOT NULL,
                text TEXT NOT NULL,
                embedding BLOB NOT NULL
            );
            CREATE VIRTUAL TABLE chunks_fts USING fts5(
                text, book, page, content='chunks', content_rowid='id', tokenize='trigram'
            );
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            """
        )
        for item, vector in zip(chunks, embeddings):
            blob = vector.astype("float32").tobytes()
            cursor = db.execute(
                "INSERT INTO chunks (book, page, text, embedding) VALUES (?, ?, ?, ?)",
                (item["book"], item["page"], item["text"], blob),
            )
            db.execute(
                "INSERT INTO chunks_fts (rowid, text, book, page) VALUES (?, ?, ?, ?)",
                (cursor.lastrowid, item["text"], item["book"], item["page"]),
            )
        db.execute("INSERT INTO meta (key, value) VALUES ('dimension', ?)", (str(embeddings.shape[1]),))
        db.execute("INSERT INTO meta (key, value) VALUES ('chunk_count', ?)", (str(len(chunks)),))
        db.execute("INSERT INTO meta (key, value) VALUES ('built_at', ?)", (__import__('datetime').datetime.now().astimezone().isoformat(),))
        db.commit()
    finally:
        db.close()
    print(json.dumps({"dbPath": str(output), "chunks": len(chunks), "dimension": int(embeddings.shape[1]), "device": device, "model": args.model}, ensure_ascii=False))


if __name__ == "__main__":
    main()
