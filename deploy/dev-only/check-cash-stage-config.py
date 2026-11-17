#!/usr/bin/env python3
"""Validate the explicitly authorized DEV cash overlay without printing secrets."""
from __future__ import annotations
import importlib.util
import json
from pathlib import Path
import stat
import sys
from urllib.parse import parse_qs, urlsplit

spec = importlib.util.spec_from_file_location("fleet_readonly_preflight", Path(__file__).with_name("check-stage-config.py"))
readonly = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(readonly)

def validate(values: dict[str, str], writer_enabled: bool = True) -> None:
    # Retain the original Google, reader, environment and disabled-worker guards.
    readonly.validate({**values, "CENTRAL_FINANCE_WRITE_ENABLED": "false"})
    require = readonly._require
    require(values.get("FLEET_CASH_DATABASE_ENABLED_DEV") == "true", "dedicated cash source must be enabled")
    expected_writer = "true" if writer_enabled else "false"
    require(values.get("CENTRAL_FINANCE_WRITE_ENABLED") == expected_writer, "cash caller writer does not match selected activation mode")
    require(values.get("CENTRAL_FINANCE_BASE_URL") == "http://fleet-finance-dev:19888", "Finance must use the private canonical DEV receiver")
    token = values.get("CENTRAL_FINANCE_SERVICE_TOKEN", "")
    require(len(token) >= 32 and "synthetic" not in token.lower() and "example" not in token.lower(), "dedicated Finance service token required")
    try:
        mapping = json.loads(values.get("FLEET_FINANCE_COMPANY_MAP", ""))
    except (ValueError, TypeError):
        raise ValueError("Fleet company mapping must be exactly source 1 to Diva 3") from None
    require(mapping == {"1": 3}, "Fleet company mapping must be exactly source 1 to Diva 3")
    try:
        source = urlsplit(values.get("FLEET_CASH_DATABASE_URL_DEV", ""))
        host, user, port = source.hostname, source.username, source.port
    except ValueError:
        raise ValueError("invalid dedicated Fleet cash database URI") from None
    require(source.scheme in ("postgres", "postgresql") and bool(source.password) and source.path == "/postgres", "dedicated Fleet cash PostgreSQL URI required")
    if host == f"db.{readonly.PROJECT}.supabase.co":
        require(user == "fleet_cash_source_login_dev" and port in (None, 5432), "wrong dedicated Fleet cash direct role")
    elif host and host.endswith(".pooler.supabase.com"):
        require(user == f"fleet_cash_source_login_dev.{readonly.PROJECT}" and port in (5432, 6543), "wrong dedicated Fleet cash pooler role")
    else:
        raise ValueError("dedicated Fleet cash target must be CST-DEV")
    require(parse_qs(source.query).get("sslmode") in (["require"], ["verify-ca"], ["verify-full"]), "dedicated Fleet cash strict TLS required")

def private_values(path: Path) -> dict[str, str]:
    readonly._require(path.is_file() and not path.is_symlink(), "cash stage environment must be a regular private file")
    readonly._require(stat.S_IMODE(path.stat().st_mode) & 0o077 == 0, "cash stage environment file must be chmod 600")
    return readonly.parse_env(path.read_text(encoding="utf-8"))

def check_files(paths: list[Path], writer_enabled: bool = True) -> None:
    values = private_values(paths[0])
    if len(paths) == 2:
        readonly.validate(values)
        extra = private_values(paths[1])
        allowed = {"FLEET_CASH_DATABASE_ENABLED_DEV", "FLEET_CASH_DATABASE_URL_DEV", "FLEET_FINANCE_COMPANY_MAP", "CENTRAL_FINANCE_BASE_URL", "CENTRAL_FINANCE_SERVICE_TOKEN", "CENTRAL_FINANCE_WRITE_ENABLED"}
        readonly._require(set(extra).issubset(allowed), "cash override must not replace inventory, Google, scheduler or other runtime settings")
        values = {**values, **extra}
    validate(values, writer_enabled=writer_enabled)

if __name__ == "__main__":
    try:
        args = sys.argv[1:]
        read_only = "--read-only" in args
        args = [arg for arg in args if arg != "--read-only"]
        if len(args) not in (1, 2):
            raise ValueError("Usage: check-cash-stage-config.py [--read-only] stage.env [protected-cash.env]")
        check_files([Path(arg) for arg in args], writer_enabled=not read_only)
    except (ValueError, OSError, UnicodeError) as error:
        print("FAIL Fleet DEV cash configuration: " + str(error), file=sys.stderr)
        raise SystemExit(1)
    print("PASS Fleet DEV cash config: Google source1, dedicated source role, private Finance target3, unrelated workers OFF")
    print("Caller writer: " + ("OFF (read-only rehearsal)" if read_only else "ON (explicit activation)"))
    print("Runtime identity/RLS and authenticated payment acceptance must also pass.")
