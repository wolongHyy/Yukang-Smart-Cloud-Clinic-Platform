from __future__ import annotations

import argparse
import ipaddress
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID


def _key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _write_key(path: Path, key) -> None:
    path.write_bytes(key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ))


def _write_cert(path: Path, cert: x509.Certificate) -> None:
    path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))


def _name(common_name: str) -> x509.Name:
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])


def _sign(subject, public_key, issuer_cert, issuer_key, days: int, extensions) -> x509.Certificate:
    now = datetime.now(timezone.utc)
    builder = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer_cert.subject)
        .public_key(public_key)
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=days))
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(public_key), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(issuer_cert.public_key()), critical=False)
    )
    for extension in extensions:
        builder = builder.add_extension(extension, critical=False)
    return builder.sign(issuer_key, hashes.SHA256())


def generate_certificates(output_dir: str | Path, host: str, valid_days: int = 825) -> dict[str, str]:
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    ca_key = _key()
    now = datetime.now(timezone.utc)
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(_name("YuKang Local CA"))
        .issuer_name(_name("YuKang Local CA"))
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=max(valid_days, 3650)))
        .add_extension(x509.BasicConstraints(ca=True, path_length=1), critical=True)
        .add_extension(x509.KeyUsage(True, False, False, False, False, True, True, False, False), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256())
    )

    try:
        ip = ipaddress.ip_address(host)
        san = x509.SubjectAlternativeName([x509.IPAddress(ip), x509.DNSName("localhost")])
    except ValueError:
        san = x509.SubjectAlternativeName([x509.DNSName(host), x509.DNSName("localhost")])

    server_key = _key()
    server_cert = _sign(_name(host), server_key.public_key(), ca_cert, ca_key, valid_days, [
        x509.BasicConstraints(ca=False, path_length=None),
        x509.KeyUsage(True, False, True, False, False, False, False, False, False),
        x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), san,
    ])
    client_key = _key()
    client_cert = _sign(_name("yukang-edge-client"), client_key.public_key(), ca_cert, ca_key, valid_days, [
        x509.BasicConstraints(ca=False, path_length=None),
        x509.KeyUsage(True, False, True, False, False, False, False, False, False),
        x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH]),
        x509.SubjectAlternativeName([x509.DNSName("yukang-edge-client")]),
    ])
    paths = {
        "ca_key": output / "ca.key", "ca_cert": output / "ca.crt",
        "server_key": output / "server.key", "server_cert": output / "server.crt",
        "server_chain": output / "server-chain.crt",
        "client_key": output / "client.key", "client_cert": output / "client.crt",
        "client_chain": output / "client-chain.crt",
    }
    _write_key(paths["ca_key"], ca_key); _write_cert(paths["ca_cert"], ca_cert)
    _write_key(paths["server_key"], server_key); _write_cert(paths["server_cert"], server_cert)
    paths["server_chain"].write_bytes(paths["server_cert"].read_bytes() + paths["ca_cert"].read_bytes())
    _write_key(paths["client_key"], client_key); _write_cert(paths["client_cert"], client_cert)
    paths["client_chain"].write_bytes(paths["client_cert"].read_bytes() + paths["ca_cert"].read_bytes())
    return {key: str(value) for key, value in paths.items()}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--host", required=True)
    parser.add_argument("--days", type=int, default=825)
    args = parser.parse_args()
    print(generate_certificates(args.output, args.host, args.days))


if __name__ == "__main__":
    main()
