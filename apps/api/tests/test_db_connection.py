"""One connection per request, always closed when the request ends, so a
failed or half-finished transaction can neither poison later requests nor
hold locks that block other requests' migrations."""
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient

import app.main as main


class FakeConn:
    def __init__(self):
        self.closed = False
        self.broken = False

    def close(self):
        self.closed = True


def make_client(monkeypatch):
    made = []
    monkeypatch.setattr(main.psycopg, "connect", lambda url: made.append(FakeConn()) or made[-1])

    app = FastAPI(dependencies=[Depends(main.db_request_scope)])

    @app.get("/twice")
    def twice():
        return {"same": main.get_db_connection() is main.get_db_connection()}

    @app.get("/boom")
    def boom():
        main.get_db_connection()
        raise HTTPException(status_code=500, detail="boom")

    @app.get("/nodb")
    def nodb():
        return {}

    return TestClient(app, raise_server_exceptions=False), made


def test_one_connection_per_request_and_it_is_closed_afterwards(monkeypatch):
    client, made = make_client(monkeypatch)
    assert client.get("/twice").json() == {"same": True}
    assert len(made) == 1 and made[0].closed


def test_connection_is_closed_even_when_the_request_fails(monkeypatch):
    client, made = make_client(monkeypatch)
    assert client.get("/boom").status_code == 500
    assert len(made) == 1 and made[0].closed


def test_each_request_gets_a_fresh_connection(monkeypatch):
    client, made = make_client(monkeypatch)
    client.get("/twice")
    client.get("/twice")
    assert len(made) == 2 and made[0] is not made[1]


def test_a_request_that_never_touches_the_db_opens_no_connection(monkeypatch):
    client, made = make_client(monkeypatch)
    client.get("/nodb")
    assert made == []


def test_outside_a_request_the_caller_gets_its_own_connection(monkeypatch):
    made = []
    monkeypatch.setattr(main.psycopg, "connect", lambda url: made.append(FakeConn()) or made[-1])
    conn = main.get_db_connection()
    assert conn is made[0] and not conn.closed
