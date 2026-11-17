#!/usr/bin/env python3
"""Synthetic, offline DEV stage release-config regression tests."""
from __future__ import annotations

import importlib.util
import os
import stat
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("check-stage-config.py")
spec = importlib.util.spec_from_file_location("fleet_stage_config_preflight", SCRIPT)
assert spec is not None and spec.loader is not None
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


def sample() -> dict[str, str]:
    # These are deliberately test-only, not usable credentials or identities.
    return {
        "APP_ENV": "development",
        "APP_BASE_URL": "https://dev-fleet.cstlogistic.co.id",
        "DISABLE_BACKGROUND_SCHEDULERS": "true",
        "CENTRAL_FINANCE_WRITE_ENABLED": "false",
        "GOJEK_CONNECTOR_ENABLED": "false",
        "FLEET_DEV_GOOGLE_AUTH_ENABLED": "true",
        "SESSION_SECRET": "test-only-dev-stage-replace-this-with-private-random-128bit",
        "FLEET_DEV_SUPABASE_PUBLISHABLE_KEY": "sb_publishable_test_only_not_working_key",
        "FLEET_DEV_GOOGLE_ALLOWED_AUTH_UID": "00000000-0000-4000-8000-000000000001",
        "FLEET_DEV_GOOGLE_ALLOWED_CANONICAL_USER_ID": "42",
        "SUPABASE_DATABASE_URL_DEV": (
            "postgresql://fleet_dev_cst_inventory_reader.xssrfshdrtdfupgqwfdw:fake-not-real@"
            "aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=require"
        ),
    }


class StagePreflightTests(unittest.TestCase):
    def test_valid_dedicated_pooler_config(self):
        preflight.validate(sample())

    def test_valid_direct_project_reader(self):
        vals = sample()
        vals["SUPABASE_DATABASE_URL_DEV"] = (
            "postgresql://fleet_dev_cst_inventory_reader:fake-not-real@"
            "db.xssrfshdrtdfupgqwfdw.supabase.co:5432/postgres?sslmode=require"
        )
        preflight.validate(vals)

    def test_rejects_prod_project(self):
        vals = sample()
        vals["SUPABASE_DATABASE_URL_DEV"] = (
            "postgresql://fleet_dev_cst_inventory_reader.nzdweipzckfszczzqtuw:fake@"
            "aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=require"
        )
        with self.assertRaisesRegex(ValueError, "SELECT-only reader"):
            preflight.validate(vals)

    def test_rejects_username_spoofing_host(self):
        vals = sample()
        vals["SUPABASE_DATABASE_URL_DEV"] = (
            "postgresql://fleet_dev_cst_inventory_reader.xssrfshdrtdfupgqwfdw:fake@"
            "not-supabase.example:6543/postgres?sslmode=require"
        )
        with self.assertRaisesRegex(ValueError, "hostname"):
            preflight.validate(vals)

    def test_rejects_writer_role(self):
        vals = sample()
        vals["SUPABASE_DATABASE_URL_DEV"] = vals["SUPABASE_DATABASE_URL_DEV"].replace(
            "fleet_dev_cst_inventory_reader.", "postgres.")
        with self.assertRaisesRegex(ValueError, "reader"):
            preflight.validate(vals)

    def test_rejects_unencrypted_database(self):
        vals = sample()
        vals["SUPABASE_DATABASE_URL_DEV"] = vals["SUPABASE_DATABASE_URL_DEV"].replace(
            "sslmode=require", "sslmode=disable")
        with self.assertRaisesRegex(ValueError, "sslmode=require"):
            preflight.validate(vals)

    def test_rejects_wrong_origin(self):
        vals = sample()
        vals["APP_BASE_URL"] = "https://fleet.cstlogistic.co.id"
        with self.assertRaisesRegex(ValueError, "APP_BASE_URL"):
            preflight.validate(vals)

    def test_rejects_active_background_jobs(self):
        vals = sample()
        vals["DISABLE_BACKGROUND_SCHEDULERS"] = "false"
        with self.assertRaisesRegex(ValueError, "DISABLE_BACKGROUND_SCHEDULERS"):
            preflight.validate(vals)

    def test_rejects_finance_writer(self):
        vals = sample()
        vals["CENTRAL_FINANCE_WRITE_ENABLED"] = "true"
        with self.assertRaisesRegex(ValueError, "CENTRAL_FINANCE_WRITE_ENABLED"):
            preflight.validate(vals)

    def test_rejects_gojek_writer(self):
        vals = sample()
        vals["GOJEK_CONNECTOR_ENABLED"] = "true"
        with self.assertRaisesRegex(ValueError, "GOJEK_CONNECTOR_ENABLED"):
            preflight.validate(vals)

    def test_rejects_google_auth_off(self):
        vals = sample()
        vals["FLEET_DEV_GOOGLE_AUTH_ENABLED"] = "false"
        with self.assertRaisesRegex(ValueError, "FLEET_DEV_GOOGLE_AUTH_ENABLED"):
            preflight.validate(vals)

    def test_rejects_missing_google_identity(self):
        vals = sample()
        vals["FLEET_DEV_GOOGLE_ALLOWED_AUTH_UID"] = "00000000-0000-0000-0000-000000000000"
        with self.assertRaisesRegex(ValueError, "nonzero"):
            preflight.validate(vals)

    def test_rejects_weak_session_secret(self):
        vals = sample()
        vals["SESSION_SECRET"] = "short"
        with self.assertRaisesRegex(ValueError, "SESSION_SECRET"):
            preflight.validate(vals)

    def test_rejects_duplicate_env_keys(self):
        with self.assertRaisesRegex(ValueError, "duplicate environment variable"):
            preflight.parse_env("APP_ENV=development\nAPP_ENV=production\n")

    def test_rejects_world_readable_stage_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env.dev"
            path.write_text("\n".join(f"{k}={v}" for k, v in sample().items()))
            path.chmod(0o644)
            with self.assertRaisesRegex(ValueError, "owner-only"):
                preflight.check_file(path)

    def test_accepts_private_stage_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env.dev"
            path.write_text("\n".join(f"{k}={v}" for k, v in sample().items()))
            path.chmod(0o600)
            preflight.check_file(path)

    def test_rejects_symlink_stage_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "target"
            target.write_text("not actually valid")
            target.chmod(0o600)
            link = Path(tmp) / ".env.dev"
            link.symlink_to(target)
            with self.assertRaisesRegex(ValueError, "symlink"):
                preflight.check_file(link)


if __name__ == "__main__":
    unittest.main()
