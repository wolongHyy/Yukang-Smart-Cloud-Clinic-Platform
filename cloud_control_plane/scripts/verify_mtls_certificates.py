from __future__ import annotations

import argparse
import ipaddress
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.x509.oid import ExtendedKeyUsageOID


def _load_cert(path: Path) -> x509.Certificate:
    return x509.load_pem_x509_certificate(path.read_bytes())


def _load_private_key(path: Path):
    return serialization.load_pem_private_key(path.read_bytes(), password=None)


def _same_public_key(cert, key) -> bool:
    cert_public = cert.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    key_public = key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    return cert_public == key_public


def _hostname_match(cert: x509.Certificate, host: str) -> bool:
    names = [name for name in cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value]
    try:
        ip = ipaddress.ip_address(host)
        return any(isinstance(name, x509.IPAddress) and name.value == ip for name in names)
    except ValueError:
        return any(isinstance(name, x509.DNSName) and name.value.lower() == host.lower() for name in names)


def _signed_by(child: x509.Certificate, issuer: x509.Certificate) -> bool:
    try:
        issuer.public_key().verify(child.signature, child.tbs_certificate_bytes, padding.PKCS1v15(), child.signature_hash_algorithm)
        return True
    except Exception:
        return False


def verify_certificates(directory: str | Path, host: str) -> dict:
    root = Path(directory)
    ca = _load_cert(root / "ca.crt")
    server = _load_cert(root / "server.crt")
    client = _load_cert(root / "client.crt")
    ca_key = _load_private_key(root / "ca.key")
    server_key = _load_private_key(root / "server.key")
    client_key = _load_private_key(root / "client.key")
    server_eku = server.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
    client_eku = client.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
    checks = {
        "ca_private_key_match": _same_public_key(ca, ca_key),
        "server_private_key_match": _same_public_key(server, server_key),
        "client_private_key_match": _same_public_key(client, client_key),
        "server_signed_by_ca": _signed_by(server, ca),
        "client_signed_by_ca": _signed_by(client, ca),
        "server_hostname_match": _hostname_match(server, host),
        "server_eku": ExtendedKeyUsageOID.SERVER_AUTH in server_eku,
        "client_eku": ExtendedKeyUsageOID.CLIENT_AUTH in client_eku,
    }
    checks["valid"] = all(checks.values())
    return checks


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True)
    parser.add_argument("--host", required=True)
    args = parser.parse_args()
    result = verify_certificates(args.directory, args.host)
    print(result)
    raise SystemExit(0 if result["valid"] else 1)


if __name__ == "__main__":
    main()
