from __future__ import annotations

import base64
import json

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey


class SigningService:
    def __init__(self, private_key_pem: str | None = None, public_key_pem: str | None = None) -> None:
        if private_key_pem:
            key = serialization.load_pem_private_key(private_key_pem.encode("utf-8"), password=None)
            if not isinstance(key, Ed25519PrivateKey):
                raise ValueError("signing key must be Ed25519")
            self.private_key = key
            self.public_key = key.public_key()
        elif public_key_pem:
            key = serialization.load_pem_public_key(public_key_pem.encode("utf-8"))
            if not isinstance(key, Ed25519PublicKey):
                raise ValueError("public key must be Ed25519")
            self.private_key = None
            self.public_key = key
        else:
            self.private_key = Ed25519PrivateKey.generate()
            self.public_key = self.private_key.public_key()

    @staticmethod
    def _canonical_manifest(manifest: dict) -> bytes:
        return json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")

    def public_key_pem(self) -> str:
        return self.public_key.public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode("utf-8")

    def sign_manifest(self, manifest: dict) -> str:
        if self.private_key is None:
            raise RuntimeError("private signing key is not configured")
        signature = self.private_key.sign(self._canonical_manifest(manifest))
        return base64.b64encode(signature).decode("ascii")

    def verify_manifest(self, manifest: dict, signature: str) -> bool:
        try:
            self.public_key.verify(base64.b64decode(signature), self._canonical_manifest(manifest))
            return True
        except Exception:
            return False
