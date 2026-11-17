import importlib.util
from pathlib import Path
import unittest
spec = importlib.util.spec_from_file_location("fleet_cash_preflight", Path(__file__).with_name("check-cash-stage-config.py"))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

def fixture():
    return {
        "APP_ENV": "development", "APP_BASE_URL": "https://dev-fleet.cstlogistic.co.id",
        "DISABLE_BACKGROUND_SCHEDULERS": "true", "GOJEK_CONNECTOR_ENABLED": "false",
        "FLEET_DEV_GOOGLE_AUTH_ENABLED": "true",
        "SESSION_SECRET": "test-only-not-real-session-secret-1234567890",
        "FLEET_DEV_SUPABASE_PUBLISHABLE_KEY": "sb_publishable_test_only_not_a_real_key",
        "FLEET_DEV_GOOGLE_ALLOWED_AUTH_UID": "00000000-0000-4000-8000-000000000001",
        "FLEET_DEV_GOOGLE_ALLOWED_CANONICAL_USER_ID": "42",
        "SUPABASE_DATABASE_URL_DEV": "postgresql://fleet_dev_stage_reader.xssrfshdrtdfupgqwfdw:testonly@aws-1-ap-southeast-2.pooler.supabase.com:6543/postgres?sslmode=require",
        "FLEET_CASH_DATABASE_ENABLED_DEV": "true",
        "FLEET_CASH_DATABASE_URL_DEV": "postgresql://fleet_cash_source_login_dev:testonly@db.xssrfshdrtdfupgqwfdw.supabase.co:5432/postgres?sslmode=verify-full",
        "CENTRAL_FINANCE_WRITE_ENABLED": "true",
        "CENTRAL_FINANCE_BASE_URL": "http://fleet-finance-dev:19888",
        "CENTRAL_FINANCE_SERVICE_TOKEN": "test-only-dedicated-service-token-1234567890",
        "FLEET_FINANCE_COMPANY_MAP": '{"1":3}',
    }

class CashStageConfiguration(unittest.TestCase):
    def test_accepts_only_explicit_cash_overlay(self):
        guard.validate(fixture())

    def test_read_only_rehearsal_requires_explicit_mode(self):
        values = fixture(); values["CENTRAL_FINANCE_WRITE_ENABLED"] = "false"
        guard.validate(values, writer_enabled=False)
        with self.assertRaises(ValueError):
            guard.validate(values)

    def test_rejects_each_scope_auth_and_destination_misconfiguration(self):
        replacements = [
            ("APP_ENV", "production"), ("APP_BASE_URL", "https://fleet.cstlogistic.co.id"),
            ("FLEET_DEV_GOOGLE_AUTH_ENABLED", "false"), ("DISABLE_BACKGROUND_SCHEDULERS", "false"),
            ("GOJEK_CONNECTOR_ENABLED", "true"), ("FLEET_CASH_DATABASE_ENABLED_DEV", "false"),
            ("CENTRAL_FINANCE_WRITE_ENABLED", "false"), ("CENTRAL_FINANCE_SERVICE_TOKEN", ""),
            ("CENTRAL_FINANCE_BASE_URL", "https://bizportal.cstlogistic.co.id"),
            ("FLEET_FINANCE_COMPANY_MAP", '{"1":1}'), ("FLEET_FINANCE_COMPANY_MAP", '{"1":3,"2":3}'),
            ("FLEET_CASH_DATABASE_URL_DEV", fixture()["FLEET_CASH_DATABASE_URL_DEV"].replace("fleet_cash_source_login_dev", "postgres")),
            ("FLEET_CASH_DATABASE_URL_DEV", fixture()["FLEET_CASH_DATABASE_URL_DEV"].replace("xssrfshdrtdfupgqwfdw", "nzdweipzckfszczzqtuw")),
            ("FLEET_CASH_DATABASE_URL_DEV", fixture()["FLEET_CASH_DATABASE_URL_DEV"].replace("verify-full", "disable")),
            ("SUPABASE_DATABASE_URL_DEV", fixture()["SUPABASE_DATABASE_URL_DEV"].replace("fleet_dev_stage_reader", "postgres")),
        ]
        for key, value in replacements:
            with self.subTest(key=key, value=value):
                values = fixture(); values[key] = value
                with self.assertRaises(ValueError):
                    guard.validate(values)

if __name__ == "__main__":
    unittest.main()
