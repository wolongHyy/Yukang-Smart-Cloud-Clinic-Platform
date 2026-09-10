from __future__ import annotations

import argparse
import hashlib
import platform
import shutil
import subprocess
import tarfile
import urllib.request
from pathlib import Path

MODEL_NAME = "fast-bge-small-zh-v1.5"
URL = f"https://storage.googleapis.com/qdrant-fastembed/{MODEL_NAME}.tar.gz"
SHA256 = "bf023219b6029148fddf764d248808816c0ca1f107f058231bb1ae0fa526f83f"


def download(url: str, target: Path) -> None:
    if platform.system() == "Windows" and shutil.which("curl.exe"):
        subprocess.run(["curl.exe", "--ssl-no-revoke", "-L", url, "-o", str(target)], check=True)
    else:
        urllib.request.urlretrieve(url, target)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache-dir", default=r"D:\CodexModels\fastembed")
    args = parser.parse_args()

    cache = Path(args.cache_dir)
    cache.mkdir(parents=True, exist_ok=True)
    model_dir = cache / MODEL_NAME
    if (model_dir / "model_optimized.onnx").exists():
        print(f"embedding model already present: {model_dir}")
        return

    archive = cache / f"{MODEL_NAME}.tar.gz"
    download(URL, archive)
    actual = file_sha256(archive)
    if actual != SHA256:
        archive.unlink(missing_ok=True)
        raise RuntimeError(f"model checksum mismatch: {actual}")

    with tarfile.open(archive, "r:gz") as tar:
        tar.extractall(cache)
    if not (model_dir / "model_optimized.onnx").exists():
        raise RuntimeError(f"model extraction failed: {model_dir}")
    print(f"embedding model installed: {model_dir}")


if __name__ == "__main__":
    main()
