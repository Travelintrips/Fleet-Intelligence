#!/usr/bin/env python3
"""Read-only public Fleet DEV health and Google OAuth redirect contract.

No cookie, credentials, OAuth state, token, POST, DB query or deployment.
A successful result does not prove signed-in access or a newly deployed build.
"""
from __future__ import annotations

import json
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

BASE = "https://dev-fleet.cstlogistic.co.id"
AUTH_HOST = "xssrfshdrtdfupgqwfdw.supabase.co"
REDIRECT_PATH = "/logistics/fleet-intelligence/vehicles"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


opener = build_opener(NoRedirect)


def check_get(route: str, expected: int) -> tuple[dict, bytes]:
    assert route.startswith("/") and not route.startswith("//")
    assert "://" not in route
    req = Request(BASE + route, method="GET", headers={"Accept": "application/json"})
    try:
        with opener.open(req, timeout=10) as response:
            status = response.status
            headers = dict(response.headers.items())
            body = response.read(8192)
    except HTTPError as exc:
        status = exc.code
        headers = dict(exc.headers.items())
        body = exc.read(8192)
    if status != expected:
        raise AssertionError(f"Fleet DEV {route}: expected HTTP {expected}, got {status}")
    print(f"PASS public Fleet DEV GET {route.split('?')[0]} HTTP {status}")
    return headers, body


def main() -> None:
    check_get("/logistics/fleet-intelligence/vehicles", 200)
    check_get("/logistics/fleet-intelligence/transactions", 200)
    status_headers, status_body = check_get("/api/auth/google/status", 200)
    del status_headers
    obj = json.loads(status_body)
    if obj.get("enabled") is not True or obj.get("devGoogleOnly") is not True:
        raise AssertionError("Fleet DEV Google status is not DEV-only enabled")
    redirect_headers, _ = check_get("/api/auth/google/start", 302)
    location = urlparse(redirect_headers.get("Location", ""))
    params = parse_qs(location.query)
    if location.scheme != "https" or location.hostname != AUTH_HOST:
        raise AssertionError("Fleet DEV Google OAuth points outside CST-DEV")
    if location.path != "/auth/v1/authorize" or params.get("provider") != ["google"]:
        raise AssertionError("Fleet DEV Google authorization target is unexpected")
    redirect = urlparse(params.get("redirect_to", [""])[0])
    if (
        redirect.scheme != "https"
        or redirect.hostname != "dev-fleet.cstlogistic.co.id"
        or redirect.path != REDIRECT_PATH
    ):
        raise AssertionError("Fleet DEV OAuth callback does not point to Fleet DEV Vehicles")
    print("PASS Google OAuth provider and CST-DEV callback (without following redirect)")
    check_get("/api/auth/user", 401)
    check_get("/api/logistics/fleet/vehicles", 401)
    check_get(
        "/api/logistics/fleet/transactions?startDate=2026-11-01&endDate=2026-11-04",
        401,
    )
    print("PASS public Fleet DEV read-only smoke 7 HTTP gates; no signed-in claim")


if __name__ == "__main__":
    main()
