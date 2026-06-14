"""Functional tests for the ClaimFlow Python client (no network)."""

from __future__ import annotations

import json
from typing import Any

import pytest

from claimflow import ClaimFlowClient, ClaimFlowError


class FakeResponse:
    def __init__(self, status: int, body: Any, content_type: str = "application/json") -> None:
        self.status_code = status
        self._body = body
        self.headers = {"content-type": content_type}
        self.content = json.dumps(body).encode()
        self.text = json.dumps(body)

    @property
    def ok(self) -> bool:
        return 200 <= self.status_code < 300

    def json(self) -> Any:
        return self._body


class FakeSession:
    def __init__(self, responses: list[FakeResponse]) -> None:
        self._responses = responses
        self._i = 0
        self.calls: list[dict[str, Any]] = []

    def request(self, method: str, url: str, **kwargs: Any) -> FakeResponse:
        self.calls.append({"method": method, "url": url, **kwargs})
        resp = self._responses[min(self._i, len(self._responses) - 1)]
        self._i += 1
        return resp


SCORE = {
    "claimId": "c1",
    "auditId": "a1",
    "payer": {"slug": "sha", "name": "SHA"},
    "decision": "PASS",
    "riskScore": 10,
    "riskLevel": "LOW",
    "recommendedAction": "READY_FOR_SUBMISSION",
    "flags": [],
    "counts": {"failed": 0, "warning": 0, "incomplete": 0, "passed": 5},
}


def test_requires_credentials() -> None:
    with pytest.raises(ValueError):
        ClaimFlowClient("https://x")


def test_score_claim_sends_api_key_and_idempotency_key() -> None:
    session = FakeSession([FakeResponse(201, {"data": SCORE})])
    client = ClaimFlowClient("https://x/", api_key="cf_test", session=session)

    result = client.score_claim({"resourceType": "Claim"}, idempotency_key="idem-1")

    assert result["riskLevel"] == "LOW"
    call = session.calls[0]
    assert call["url"] == "https://x/v1/claims/score"
    assert call["headers"]["X-Api-Key"] == "cf_test"
    assert call["headers"]["Idempotency-Key"] == "idem-1"


def test_submit_and_get_batch() -> None:
    accepted = {"batchId": "b1", "status": "QUEUED", "totalClaims": 2, "createdAt": "2026-01-01T00:00:00Z"}
    session = FakeSession([
        FakeResponse(202, {"data": accepted}),
        FakeResponse(200, {"data": {"batchId": "b1", "status": "COMPLETED"}}),
    ])
    client = ClaimFlowClient("https://x", api_key="cf_test", session=session)

    res = client.submit_claim_batch({"claims": []})
    assert res["batchId"] == "b1"
    status = client.get_claim_batch("b1")
    assert status["status"] == "COMPLETED"


def test_oauth_token_is_cached() -> None:
    session = FakeSession([
        FakeResponse(200, {"access_token": "tok-abc", "token_type": "Bearer", "expires_in": 3600, "scope": "claim:create"}),
        FakeResponse(201, {"data": SCORE}),
        FakeResponse(201, {"data": SCORE}),
    ])
    client = ClaimFlowClient(
        "https://x", client_id="id", client_secret="secret", scope="claim:create", session=session
    )

    client.score_claim({"resourceType": "Claim"})
    client.score_claim({"resourceType": "Claim"})

    # token exchange once + two scores
    assert len(session.calls) == 3
    assert session.calls[0]["url"] == "https://x/v1/oauth/token"
    assert session.calls[1]["headers"]["Authorization"] == "Bearer tok-abc"


def test_problem_json_raises_typed_error() -> None:
    problem = {
        "type": "about:blank",
        "title": "Validation failed",
        "status": 400,
        "code": "VALIDATION_ERROR",
        "detail": "claims must be non-empty",
        "errors": [{"code": "VALIDATION_ERROR", "message": "claims must be non-empty", "field": "claims"}],
        "meta": {"requestId": "req-99"},
    }
    session = FakeSession([FakeResponse(400, problem, "application/problem+json")])
    client = ClaimFlowClient("https://x", api_key="cf_test", session=session)

    with pytest.raises(ClaimFlowError) as exc:
        client.score_claim({"resourceType": "Claim"})
    err = exc.value
    assert err.status == 400
    assert err.code == "VALIDATION_ERROR"
    assert err.request_id == "req-99"
    assert err.errors[0]["field"] == "claims"


def test_envelope_error_shape() -> None:
    envelope = {"errors": [{"code": "NOT_FOUND", "message": "Batch not found"}], "meta": {"requestId": "r2"}}
    session = FakeSession([FakeResponse(404, envelope)])
    client = ClaimFlowClient("https://x", api_key="cf_test", session=session)

    with pytest.raises(ClaimFlowError) as exc:
        client.get_claim_batch("missing")
    assert exc.value.status == 404
    assert exc.value.code == "NOT_FOUND"
    assert str(exc.value) == "Batch not found"
