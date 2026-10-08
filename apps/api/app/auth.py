"""Verification of Clerk session JWTs for the auditor-facing endpoints.

Only public values are involved: the instance's JWKS URL and issuer. The
Clerk secret key is neither needed nor used -- the token is checked against
the instance's published public keys.
"""
from typing import Callable

import jwt
from jwt import PyJWKClient


class AuthError(Exception):
    """The token is missing, malformed, expired, or not ours: answer 401."""


class AuthUnavailable(Exception):
    """The key server could not be reached, so the token could not be judged.
    Answer 503, not 401: "we could not check" is not "you are not allowed"."""


def bearer_token(authorization: str | None) -> str | None:
    """The token from an 'Authorization: Bearer <token>' header, else None."""
    if not authorization:
        return None
    scheme, _, value = authorization.partition(" ")
    value = value.strip()
    if scheme.lower() != "bearer" or not value:
        return None
    return value


def make_jwks_signing_key_getter(jwks_url: str) -> Callable[[str], object]:
    """A function token -> public key, backed by a cached JWKS client. The
    cache is refreshed once when a token names a key id it does not hold,
    which is how key rotation is picked up. Nothing is fetched until the
    first token is checked."""
    client = PyJWKClient(jwks_url, cache_keys=True, lifespan=3600, timeout=5)

    def get(token: str):
        return client.get_signing_key_from_jwt(token).key

    return get


def verify_clerk_token(
    token: str,
    *,
    signing_key_getter: Callable[[str], object],
    issuer: str,
    authorized_parties: tuple[str, ...] = (),
) -> dict:
    """Returns the token's claims, or raises AuthError / AuthUnavailable.

    Pinned to RS256, so a token claiming "none" or an HMAC algorithm cannot be
    verified against the public key. exp, nbf, iat, iss and sub are required.
    Clerk session tokens carry no audience (the "azp" claim names the origin
    that requested them), so audience is not checked; azp is checked against
    `authorized_parties` when any are configured."""
    try:
        key = signing_key_getter(token)
        claims = jwt.decode(
            token,
            key,
            algorithms=["RS256"],
            issuer=issuer,
            leeway=10,
            options={"require": ["exp", "iat", "nbf", "iss", "sub"], "verify_aud": False},
        )
    except jwt.PyJWKClientConnectionError as exc:
        raise AuthUnavailable("The identity provider's keys could not be fetched") from exc
    except jwt.PyJWTError as exc:
        raise AuthError("Invalid or expired token") from exc

    if authorized_parties and claims.get("azp") not in authorized_parties:
        raise AuthError("Token was issued for a different application")
    return claims
