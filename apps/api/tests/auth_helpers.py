"""Real RS256 tokens signed with throwaway keys, so the auth tests exercise
the actual verification path (signature, issuer, expiry, algorithm pinning)
rather than a mock of it."""
import time

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

ISSUER = "https://clerk.test.example"
PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def make_token(key=PRIVATE_KEY, algorithm="RS256", drop=(), **overrides) -> str:
    now = int(time.time())
    claims = {"sub": "user_123", "iss": ISSUER, "iat": now - 5, "nbf": now - 5, "exp": now + 60, "azp": "http://localhost:3100"}
    claims.update(overrides)
    for name in drop:
        claims.pop(name, None)
    return jwt.encode(claims, key, algorithm=algorithm, headers={"kid": "test-key"})


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def install(monkeypatch, main, authorized_parties=()):
    """Point the app's verifier at the throwaway public key."""
    monkeypatch.setattr(main, "_signing_key", lambda token: PRIVATE_KEY.public_key())
    monkeypatch.setattr(main, "CLERK_ISSUER", ISSUER)
    monkeypatch.setattr(main, "CLERK_AUTHORIZED_PARTIES", authorized_parties)


PUBLIC_KEY_PEM = PRIVATE_KEY.public_key().public_bytes(
    serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
)
