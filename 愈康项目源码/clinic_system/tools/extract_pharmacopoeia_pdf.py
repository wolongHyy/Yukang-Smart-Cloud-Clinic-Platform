import glob
import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from pypdf import PdfReader

SOURCE_DIR = str(Path(__file__).resolve().parents[3] / "药典2025原始数据" / "药典2025知识库_最终版")
OUTPUT_PATH = str(Path(__file__).resolve().parents[1] / "data" / "pharmacopoeia_texts.jsonl")


def book_name(filename):
    if "2020年版 第一部" in filename:
        return "中华人民共和国药典 2020年版 第一部"
    if "2020年版 第二部" in filename:
        return "中华人民共和国药典 2020年版 第二部"
    if "2020年版 第三部" in filename:
        return "中华人民共和国药典 2020年版 第三部"
    if "2025年版 四部" in filename:
        return "中华人民共和国药典 2025年版 第四部"
    return Path(filename).stem


def clean_text(text):
    return re.sub(r"\s+", " ", text or "").strip()


def chunks(text, size=1200, overlap=100):
    text = clean_text(text)
    if len(text) <= size:
        return [text] if text else []
    result = []
    start = 0
    while start < len(text):
        part = text[start:start + size]
        result.append(part)
        if start + size >= len(text):
            break
        start += size - overlap
    return result


def extract_book(filename):
    book = book_name(filename)
    part_path = OUTPUT_PATH + "." + str(os.getpid()) + "." + str(abs(hash(filename))) + ".part"
    reader = PdfReader(filename)
    page_count = len(reader.pages)
    chunk_count = 0

    with open(part_path, "w", encoding="utf-8", newline="\n") as out:
        for page_index, page in enumerate(reader.pages, 1):
            try:
                text = page.extract_text() or ""
            except Exception as exc:
                print(f"skip {book} p{page_index}: {exc}", flush=True)
                continue

            for part in chunks(text):
                row = {"book": book, "page": page_index, "text": part}
                out.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
                chunk_count += 1

            if page_index % 200 == 0:
                print(f"{book}: {page_index}/{page_count} pages", flush=True)

    return book, page_count, chunk_count, part_path


def main():
    files = sorted(glob.glob(os.path.join(SOURCE_DIR, "*.pdf")))
    if not files:
        raise SystemExit("未找到药典 PDF")

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    temp_path = OUTPUT_PATH + ".tmp"
    total_pages = 0
    total_chunks = 0

    for part_path in glob.glob(OUTPUT_PATH + ".*.part"):
        try:
            os.remove(part_path)
        except OSError:
            pass

    with ThreadPoolExecutor(max_workers=min(4, len(files))) as pool:
        futures = [pool.submit(extract_book, filename) for filename in files]
        for future in as_completed(futures):
            book, page_count, chunk_count, part_path = future.result()
            total_pages += page_count
            total_chunks += chunk_count
            print(f"done {book}: pages={page_count}, chunks={chunk_count}", flush=True)

    with open(temp_path, "w", encoding="utf-8", newline="\n") as out:
        for part_path in sorted(glob.glob(OUTPUT_PATH + ".*.part")):
            with open(part_path, "r", encoding="utf-8") as src:
                out.write(src.read())

    os.replace(temp_path, OUTPUT_PATH)
    print(f"complete: books={len(files)}, pages={total_pages}, chunks={total_chunks}, output={OUTPUT_PATH}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("stopped", flush=True)
        sys.exit(130)
