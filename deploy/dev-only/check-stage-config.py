#!/usr/bin/env python3
"""Fail-closed Fleet DEV staging environment preflight.

Validates a dedicated, private stage configuration without printing secrets,
connecting to the database, or reading credentials from an existing runtime.
This is only configuration validation, not a claim of authenticated E2E.
"""
from __future__ import annotations

import re
import stat
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from uuid import UUID

PROJECT = "xssrfshdrtdfupgqwfdw"
ROLE = "fleet_dev_cst_inventory_reader"
ORIGIN = "https://dev-fleet.cstlogistic.co.id"


def _require(condition: bool, reason: str) -> None:
    if not condition:
        raise ValueError(reason)


def parse_env(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        _require("=" in line, "unsupported environment-file syntax")
        key, value = line.split("=", 1)
        key = key.strip()
        _require(key.isidentifier(), "invalid environment variable name")
        _require(key not in values, f"duplicate environment variable: {key}")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        values[key] = value
    return values


def validate(values: dict[str, str]) -> None:
    _require(values.get("APP_ENV") == "development", "APP_ENV must be development")
    _require(values.get("APP_BASE_URL") == ORIGIN, "APP_BASE_URL must be exact Fleet DEV origin")
    for key, expected in (
        ("DISABLE_BACKGROUND_SCHEDULERS", "true"),
        ("CENTRAL_FINANCE_WRITE_ENABLED", "false"),
        ("GOJEK_CONNECTOR_ENABLED", "false"),
        ("FLEET_DEV_GOOGLE_AUTH_ENABLED", "true"),
    ):
        _require(values.get(key, "").lower() == expected, f"{key} must be {expected}")

    secret = values.get("SESSION_SECRET", "")
    _require(len(secret) >= 32 and "synthetic" not in secret.lower()
             and "example" not in secret.lower(), "dedicated SESSION_SECRET required")

    key = values.get("FLEET_DEV_SUPABASE_PUBLISHABLE_KEY", "")
    _require(len(key) >= 20 and "synthetic" not in key.lower(),
             "CST-DEV Supabase publishable key required")
    try:
        auth_uid = UUID(values.get("FLEET_DEV_GOOGLE_ALLOWED_AUTH_UID", ""))
    except (TypeError, ValueError) as exc:
        raise ValueError("valid DEV Google allowed auth UID required") from None
    _require(auth_uid.int != 0, "nonzero DEV Google auth UID required")
    canonical = values.get("FLEET_DEV_GOOGLE_ALLOWED_CANONICAL_USER_ID", "")
    _require(re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", canonical) is not None,
             "valid DEV Google canonical user ID required")

    database_url = values.get("SUPABASE_DATABASE_URL_DEV", "")
    try:
        parsed = urlsplit(database_url)
        host, user, port = parsed.hostname, parsed.username, parsed.port
    except ValueError as exc:
        raise ValueError("invalid CST-DEV reader database URI") from None
    _require(parsed.scheme in ("postgresql", "postgres"),
             "SUPABASE_DATABASE_URL_DEV must be PostgreSQL URI")
    _require(bool(parsed.password), "dedicated CST-DEV reader password required")
    _require(parsed.path.lstrip("/") == "postgres", "CST-DEV database must be postgres")
    if host == f"db.{PROJECT}.supabase.co":
        _require(user == ROLE and port in (None, 5432),
                 "direct CST-DEV connection must use exact SELECT-only reader")
    elif host and host.endswith(".pooler.supabase.com"):
        _require(user == f"{ROLE}.{PROJECT}" and port in (5432, 6543),
                 "CST-DEV pooler must use exact project-qualified SELECT-only reader")
    else:
        raise ValueError("CST-DEV database hostname is not an approved Supabase endpoint")
    sslmode = parse_qs(parsed.query).get("sslmode", [])
    _require(sslmode == ["require"], "CST-DEV database URI must set sslmode=require")


def check_file(path: Path) -> None:
    _require(path.is_file() and not path.is_symlink(),
             "dedicated stage environment file is missing or is a symlink")
    _require((stat.S_IMODE(path.stat().st_mode) & 0o077) == 0,
             "stage environment file must be owner-only (chmod 600)")
    validate(parse_env(path.read_text(encoding="utf-8")))


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: check-stage-config.py /opt/fleet-intelligence-dev/deploy/.env.dev",
              file=sys.stderr)
        return 2
    try:
        check_file(Path(sys.argv[1]))
    except (ValueError, OSError, UnicodeError) as exc:
        # Only fixed validation errors: no sensitive variable values are emitted.
        print(f"FAIL Fleet DEV stage configuration: {exc}", file=sys.stderr)
        return 1
    print("PASS Fleet DEV stage config: private file, CST-DEV reader, Google and disabled writers")
    print("Note: credentials and signed-in E2E not verified by this preflight")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
