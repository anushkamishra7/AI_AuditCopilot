"""Authentication: auditor-facing endpoints need a valid Clerk-style JWT; the
stakeholder upload accepts an auditor token OR the request's own magic-link
token. Tokens here are real RS256 JWTs signed with throwaway keys."""
import jwt
import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from types import SimpleNamespace

import app.main as main
from app.auth import AuthError, AuthUnavailable, bearer_token, verify_clerk_token
from tests.auth_helpers import OTHER_PRIVATE_KEY, PRIVATE_KEY, PUBLIC_KEY_PEM, bearer, install, make_token
from tests.test_upload_review import FakeDb, FakeGroq, FakeStorage, MODEL_SAYS_COMPLETE, make_pdf


@pytest.fixture
def api(monkeypatch):
    install(monkeypatch, main)
    db = FakeDb()
    storage = FakeStorage()
    groq = FakeGroq(MODEL_SAYS_COMPLETE)
    monkeypatch.setattr(main, "get_db_connection", lambda: db)
    monkeypatch.setattr(main, "groq_client", groq)
    monkeypatch.setattr(main, "supabase_client", SimpleNamespace(storage=storage))
    monkeypatch.setattr(main, "lookup_upload", lambda token: {"kind": "invalid"})
    return SimpleNamespace(client=TestClient(main.app, raise_server_exceptions=False), db=db, storage=storage, groq=groq)


def concrete(path: str) -> str:
    import re
    return re.sub(r"\{[^}]+\}", "x", path)


def app_routes():
    return [r for r in main.app.routes if isinstance(r, APIRoute)]


# --- every route is protected unless it is explicitly public ---------------

def test_every_non_public_route_rejects_a_request_with_no_token(api):
    checked = 0
    for route in app_routes():
        for method in route.methods - {"HEAD", "OPTIONS"}:
            if (method, route.path) in main.PUBLIC_ROUTES:
                continue
            response = api.client.request(method, concrete(route.path))
            assert response.status_code == 401, f"{method} {route.path} answered {response.status_code} without a token"
            checked += 1
    assert checked >= 15  # guards against the loop silently checking nothing


def test_the_public_routes_are_exactly_the_documented_ones():
    declared = {(m, r.path) for r in app_routes() for m in r.methods - {"HEAD", "OPTIONS"}}
    assert main.PUBLIC_ROUTES <= declared  # no stale entries
    assert main.PUBLIC_ROUTES == {
        ("GET", "/health"),
        ("GET", "/upload/{token}"),
        ("POST", "/evidence-requests/{request_id}/upload"),
    }


def test_health_and_the_stakeholder_lookup_need_no_token(api):
    assert api.client.get("/health").status_code == 200
    assert api.client.get("/upload/some-magic-token").status_code == 200


# --- tokens that must be refused --------------------------------------------

def forge_hs256_with_public_key() -> str:
    import base64, hashlib, hmac, json

    def b64(data: bytes) -> bytes:
        return base64.urlsafe_b64encode(data).rstrip(b"=")

    header = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = b64(json.dumps({"sub": "u", "iss": "https://clerk.test.example", "exp": 4102444800, "iat": 1, "nbf": 1}).encode())
    signature = b64(hmac.new(PUBLIC_KEY_PEM, header + b"." + payload, hashlib.sha256).digest())
    return (header + b"." + payload + b"." + signature).decode()


BAD_TOKENS = {
    "garbage": lambda: "not-a-jwt",
    "signed with another key": lambda: make_token(key=OTHER_PRIVATE_KEY),
    "expired": lambda: make_token(exp=1),
    "not valid yet": lambda: make_token(nbf=4102444800, exp=4102448400),
    "wrong issuer": lambda: make_token(iss="https://evil.example"),
    "missing subject": lambda: make_token(drop=("sub",)),
    "missing expiry": lambda: make_token(drop=("exp",)),
    "unsigned (alg none)": lambda: jwt.encode({"sub": "u", "iss": "https://clerk.test.example"}, key=None, algorithm="none"),
    # the classic confusion attack: HMAC-sign using the PUBLIC key as the
    # secret. PyJWT refuses to build this token, so it is forged by hand.
    "HS256 signed with the public key": lambda: forge_hs256_with_public_key(),
}


@pytest.mark.parametrize("name", list(BAD_TOKENS))
def test_bad_tokens_are_401(api, name):
    token = BAD_TOKENS[name]()
    response = api.client.post("/evidence-files/file_x/analyse", headers=bearer(token))
    assert response.status_code == 401, name
    assert api.groq.calls == 0


@pytest.mark.parametrize("header", ["Basic abc", "Bearer", "Bearer ", "token abc", ""])
def test_malformed_authorization_headers_are_401(api, header):
    response = api.client.post("/evidence-files/file_x/analyse", headers={"Authorization": header})
    assert response.status_code == 401


def test_a_valid_token_reaches_the_handler(api):
    api.db.has_review = True  # handler answers 409 -- proof it ran
    response = api.client.post("/evidence-files/file_x/analyse", headers=bearer(make_token()))
    assert response.status_code == 409


def test_authorized_party_is_enforced_when_configured(api, monkeypatch):
    install(monkeypatch, main, authorized_parties=("http://localhost:3100",))
    api.db.has_review = True
    ok = api.client.post("/evidence-files/file_x/analyse", headers=bearer(make_token(azp="http://localhost:3100")))
    wrong = api.client.post("/evidence-files/file_x/analyse", headers=bearer(make_token(azp="https://evil.example")))
    missing = api.client.post("/evidence-files/file_x/analyse", headers=bearer(make_token(drop=("azp",))))
    assert (ok.status_code, wrong.status_code, missing.status_code) == (409, 401, 401)


def test_an_unreachable_key_server_is_503_not_401(api, monkeypatch):
    def down(token):
        raise jwt.PyJWKClientConnectionError("jwks host unreachable")

    monkeypatch.setattr(main, "_signing_key", down)
    response = api.client.post("/evidence-files/file_x/analyse", headers=bearer(make_token()))
    assert response.status_code == 503


# --- stakeholder upload: auditor token OR the request's magic-link token ---

def post_upload(api, headers=None, pdf=None):
    return api.client.post(
        "/evidence-requests/req_1/upload",
        files={"file": ("policy.pdf", pdf or make_pdf("Access control policy requires least privilege. " * 5), "application/pdf")},
        headers=headers or {},
    )


def test_upload_with_the_matching_magic_link_token_is_allowed(api):
    response = post_upload(api, {"X-Upload-Token": "tok_valid"})
    assert response.status_code == 200
    assert len(api.storage.uploads) == 1


def test_upload_with_a_wrong_token_is_403_and_stores_nothing(api):
    response = post_upload(api, {"X-Upload-Token": "tok_wrong"})
    assert response.status_code == 403
    assert api.storage.uploads == [] and api.groq.calls == 0
    assert api.db.inserted("evidence_files") == [] and api.db.commits == 0


def test_upload_with_no_credentials_is_401(api):
    response = post_upload(api)
    assert response.status_code == 401
    assert api.storage.uploads == []


def test_a_token_for_an_unknown_request_is_403_not_404(api):
    api.db.request_exists = False
    response = post_upload(api, {"X-Upload-Token": "tok_valid"})
    assert response.status_code == 403  # must not reveal which ids exist


def test_a_request_that_was_never_sent_has_no_token_so_nothing_matches(api):
    api.db.request_token = None
    assert post_upload(api, {"X-Upload-Token": "None"}).status_code == 403
    assert post_upload(api, {"X-Upload-Token": ""}).status_code == 401


def test_upload_with_an_auditor_token_is_allowed(api):
    assert post_upload(api, bearer(make_token())).status_code == 200


def test_auditor_upload_to_an_unknown_request_is_404(api):
    api.db.request_exists = False
    assert post_upload(api, bearer(make_token())).status_code == 404


def test_an_invalid_bearer_token_is_401_even_with_a_valid_upload_token(api):
    response = post_upload(api, {**bearer(make_token(key=OTHER_PRIVATE_KEY)), "X-Upload-Token": "tok_valid"})
    assert response.status_code == 401
    assert api.storage.uploads == []


def test_the_magic_link_token_does_not_unlock_auditor_endpoints(api):
    assert api.client.post("/evidence-files/file_x/analyse", headers={"X-Upload-Token": "tok_valid"}).status_code == 401
    assert api.client.get("/evidence-requests/req_1/review", headers={"X-Upload-Token": "tok_valid"}).status_code == 401


# --- the verifier itself -----------------------------------------------------

def test_bearer_token_parsing():
    assert bearer_token("Bearer abc") == "abc"
    assert bearer_token("bearer abc") == "abc"
    assert bearer_token(None) is None and bearer_token("Basic abc") is None and bearer_token("Bearer ") is None


def test_verify_returns_claims_for_a_good_token():
    claims = verify_clerk_token(
        make_token(), signing_key_getter=lambda t: PRIVATE_KEY.public_key(), issuer="https://clerk.test.example"
    )
    assert claims["sub"] == "user_123"


def test_verify_raises_autherror_not_a_library_exception_for_a_bad_token():
    with pytest.raises(AuthError):
        verify_clerk_token("junk", signing_key_getter=lambda t: PRIVATE_KEY.public_key(), issuer="https://clerk.test.example")


def test_verify_raises_unavailable_when_keys_cannot_be_fetched():
    def down(token):
        raise jwt.PyJWKClientConnectionError("down")

    with pytest.raises(AuthUnavailable):
        verify_clerk_token(make_token(), signing_key_getter=down, issuer="https://clerk.test.example")
