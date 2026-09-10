from pathlib import Path

from scripts.generate_mtls_ca import generate_certificates
from scripts.verify_mtls_certificates import verify_certificates


def test_generate_and_verify_mtls_certificate_chain(tmp_path: Path) -> None:
    result = generate_certificates(tmp_path, host="control.test", valid_days=30)

    assert Path(result["ca_cert"]).exists()
    assert Path(result["server_cert"]).exists()
    assert Path(result["client_cert"]).exists()
    verification = verify_certificates(tmp_path, host="control.test")
    assert verification["valid"] is True
    assert verification["server_hostname_match"] is True
    assert verification["client_eku"] is True


def test_verify_rejects_wrong_hostname(tmp_path: Path) -> None:
    generate_certificates(tmp_path, host="control.test", valid_days=30)
    verification = verify_certificates(tmp_path, host="wrong.test")
    assert verification["valid"] is False
    assert verification["server_hostname_match"] is False
