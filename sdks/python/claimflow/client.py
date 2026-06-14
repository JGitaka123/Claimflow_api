"""Thin, typed ClaimFlow API client for Python.

The request/response models in ``models.py`` are generated from
``docs/openapi.yaml`` (the source of truth). This client is a small, stable
hand-written wrapper that handles API-key + OAuth2 client-credentials auth, the
``Idempotency-Key`` header, and problem+json / envelope error parsing. It exposes
scores, flags, reason codes and the closed audit summary only — never
detection-rule internals.
"""

from __future__ import annotations

import time
from typing import Any, Mapping

import requests


class ClaimFlowError(Exception):
    """Raised for any non-2xx response.

    Parses both the RFC 7807 ``application/problem+json`` body (machine
    credentials) and the ``{"errors", "meta"}`` envelope (human sessions) into a
    single surface.
    """

    def __init__(self, status: int, body: Any) -> None:
        problem = body if isinstance(body, Mapping) else {}
        errors = problem.get("errors") if isinstance(problem.get("errors"), list) else []
        first = errors[0] if errors else {}
        message = (
            problem.get("detail")
            or problem.get("title")
            or (first.get("message") if isinstance(first, Mapping) else None)
            or f"ClaimFlow request failed with status {status}"
        )
        super().__init__(message)
        self.status = status
        self.code = problem.get("code") or (first.get("code") if isinstance(first, Mapping) else None)
        self.title = problem.get("title")
        self.detail = problem.get("detail")
        self.errors = errors
        meta = problem.get("meta") if isinstance(problem.get("meta"), Mapping) else {}
        self.request_id = meta.get("requestId")
        self.body = body


class ClaimFlowClient:
    """ClaimFlow API client (API key or OAuth2 client-credentials)."""

    def __init__(
        self,
        base_url: str,
        *,
        api_key: str | None = None,
        client_id: str | None = None,
        client_secret: str | None = None,
        scope: str | None = None,
        timeout: float = 30.0,
        session: requests.Session | None = None,
    ) -> None:
        if not api_key and not (client_id and client_secret):
            raise ValueError("Provide either api_key or client_id + client_secret.")
        self.base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._client_id = client_id
        self._client_secret = client_secret
        self._scope = scope
        self._timeout = timeout
        self._session = session or requests.Session()
        self._token: str | None = None
        self._token_expiry: float = 0.0

    # -- convenience methods ---------------------------------------------------

    def score_claim(self, claim: Mapping[str, Any], idempotency_key: str | None = None) -> dict[str, Any]:
        """Score a FHIR R4 Claim; returns the public-safe score (no rule internals)."""
        return self._request("POST", "/v1/claims/score", json=claim, idempotency_key=idempotency_key)["data"]

    def submit_claim_batch(
        self, body: Mapping[str, Any], idempotency_key: str | None = None
    ) -> dict[str, Any]:
        """Submit a batch of claims for async scoring; returns the 202 acceptance."""
        return self._request("POST", "/v1/claims/batch", json=body, idempotency_key=idempotency_key)["data"]

    def get_claim_batch(self, batch_id: str) -> dict[str, Any]:
        """Poll batch status + per-claim closed scores."""
        return self._request("GET", f"/v1/claims/batch/{batch_id}")["data"]

    def create_claim(self, body: Mapping[str, Any], idempotency_key: str | None = None) -> dict[str, Any]:
        return self._request("POST", "/v1/claims", json=body, idempotency_key=idempotency_key)["data"]

    def list_claims(self, *, cursor: str | None = None, limit: int | None = None) -> list[dict[str, Any]]:
        params: dict[str, Any] = {}
        if cursor:
            params["cursor"] = cursor
        if limit:
            params["limit"] = limit
        return self._request("GET", "/v1/claims", params=params or None)["data"]

    # -- core plumbing ---------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        *,
        json: Mapping[str, Any] | None = None,
        params: Mapping[str, Any] | None = None,
        idempotency_key: str | None = None,
        no_auth: bool = False,
    ) -> Any:
        headers: dict[str, str] = {"accept": "application/json"}
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        if not no_auth:
            self._apply_auth(headers)

        response = self._session.request(
            method,
            self.base_url + path,
            json=json,
            params=params,
            headers=headers,
            timeout=self._timeout,
        )
        body: Any = None
        if response.content:
            try:
                body = response.json()
            except ValueError:
                body = response.text
        if not response.ok:
            raise ClaimFlowError(response.status_code, body)
        return body

    def _apply_auth(self, headers: dict[str, str]) -> None:
        if self._api_key:
            headers["X-Api-Key"] = self._api_key
            return
        headers["Authorization"] = f"Bearer {self._access_token()}"

    def _access_token(self) -> str:
        now = time.time()
        if self._token and self._token_expiry > now:
            return self._token
        payload: dict[str, str] = {
            "grant_type": "client_credentials",
            "client_id": self._client_id or "",
            "client_secret": self._client_secret or "",
        }
        if self._scope:
            payload["scope"] = self._scope
        token = self._request("POST", "/v1/oauth/token", json=payload, no_auth=True)
        self._token = token["access_token"]
        # Refresh 30s before the server-stated expiry.
        self._token_expiry = now + max(0, int(token["expires_in"]) - 30)
        return self._token


__all__ = ["ClaimFlowClient", "ClaimFlowError"]
