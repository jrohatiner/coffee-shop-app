import asyncio
import json
import os
from pathlib import Path
import socket
import sys
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx
import pytest
import uvicorn
import websockets
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool

os.environ.setdefault("DATABASE_URL", "sqlite://")
os.environ.setdefault("JWT_SECRET", "test_jwt_secret")

from app import database  # noqa: E402

test_engine = create_engine(
    "sqlite://",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
database.engine = test_engine
database.SessionLocal.configure(bind=test_engine)

from app import auth, models  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(autouse=True)
def reset_db():
    models.Base.metadata.drop_all(bind=test_engine)
    models.Base.metadata.create_all(bind=test_engine)
    db = database.SessionLocal()
    try:
        user = models.User(
            username="manager",
            hashed_password=auth.get_password_hash("manager123"),
            is_manager=True,
        )
        db.add(user)
        db.commit()
    finally:
        db.close()
    yield


@pytest.fixture
def live_server():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]

    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    base_url = f"http://127.0.0.1:{port}"
    for _ in range(50):
        try:
            res = httpx.get(f"{base_url}/ws/socket.io/?EIO=4&transport=polling")
            if res.status_code == 200:
                break
        except Exception:
            pass
        time.sleep(0.05)

    try:
        yield base_url, port
    finally:
        server.should_exit = True
        thread.join(timeout=5)


def test_engineio_polling_handshake_and_unknown_path():
    with TestClient(app) as client:
        res = client.get(
            "/ws/socket.io/?EIO=4&transport=polling",
            headers={"Origin": "http://localhost:3000"},
        )
        assert res.status_code == 200
        assert res.text.startswith("0{")
        packet = json.loads(res.text[1:])
        assert "sid" in packet
        assert "websocket" in packet["upgrades"]
        assert res.headers.get_list("access-control-allow-origin") == [
            "http://localhost:3000"
        ]

        not_found = client.get("/ws/other")
        assert not_found.status_code == 404


def test_engineio_polling_to_websocket_upgrade_and_live_broadcasts(live_server):
    base_url, port = live_server

    async def run_scenario():
        async with httpx.AsyncClient(base_url=base_url) as http_client:
            # 1. Engine.IO polling handshake -> 200 OK open packet
            open_res = await http_client.get("/ws/socket.io/?EIO=4&transport=polling")
            assert open_res.status_code == 200
            assert open_res.text.startswith("0{")
            sid = json.loads(open_res.text[1:])["sid"]

            # 2. Connect to Socket.IO default '/' namespace over polling
            post_res = await http_client.post(
                f"/ws/socket.io/?EIO=4&transport=polling&sid={sid}",
                content="40",
                headers={"Content-Type": "text/plain"},
            )
            assert post_res.status_code == 200

            poll_res = await http_client.get(
                f"/ws/socket.io/?EIO=4&transport=polling&sid={sid}"
            )
            assert poll_res.status_code == 200
            assert "40{" in poll_res.text

            # 3. Upgrade cleanly from HTTP polling to WebSocket
            ws_url = f"ws://127.0.0.1:{port}/ws/socket.io/?EIO=4&transport=websocket&sid={sid}"
            async with websockets.connect(ws_url) as ws:
                await ws.send("2probe")
                probe_reply = await asyncio.wait_for(ws.recv(), timeout=2)
                assert probe_reply == "3probe"
                await ws.send("5")

                # Authenticate REST client and trigger mutations
                token_res = await http_client.post(
                    "/auth/token",
                    data={"username": "manager", "password": "manager123"},
                )
                assert token_res.status_code == 200
                headers = {"Authorization": f"Bearer {token_res.json()['access_token']}"}

                prod_res = await http_client.post(
                    "/inventory/",
                    json={"name": "Cold Brew Concentrate", "price": 5.25, "stock": 20},
                    headers=headers,
                )
                assert prod_res.status_code == 201
                prod_id = prod_res.json()["id"]

                temp_res = await http_client.post(
                    "/inventory/",
                    json={"name": "Seasonal Syrup", "price": 1.5, "stock": 10},
                    headers=headers,
                )
                assert temp_res.status_code == 201
                temp_id = temp_res.json()["id"]

                upd_res = await http_client.put(
                    f"/inventory/{prod_id}",
                    json={"name": "Cold Brew Concentrate", "price": 5.25, "stock": 25},
                    headers=headers,
                )
                assert upd_res.status_code == 200

                del_res = await http_client.delete(
                    f"/inventory/{temp_id}",
                    headers=headers,
                )
                assert del_res.status_code == 200

                order_res = await http_client.post(
                    "/orders/",
                    json={
                        "status": "pending",
                        "items": [{"product_id": prod_id, "quantity": 2}],
                    },
                    headers=headers,
                )
                assert order_res.status_code == 200
                order_id = order_res.json()["id"]

                cancel_res = await http_client.post(
                    f"/orders/{order_id}/cancel",
                    headers=headers,
                )
                assert cancel_res.status_code == 200

                events = []
                deadline = time.monotonic() + 3.0
                while len(events) < 8 and time.monotonic() < deadline:
                    raw = await asyncio.wait_for(ws.recv(), timeout=2)
                    if raw == "2":
                        await ws.send("3")
                    elif raw.startswith("42"):
                        events.append(json.loads(raw[2:]))

                event_names = [e[0] for e in events]
                assert event_names.count("stock_update") == 6
                assert event_names.count("new_order") == 1
                assert event_names.count("order_cancelled") == 1
                cancelled_payload = next(
                    e[1] for e in events if e[0] == "order_cancelled"
                )
                assert cancelled_payload == {
                    "id": order_id,
                    "status": "cancelled",
                    "created_at": cancel_res.json()["created_at"],
                    "order_id": order_id,
                }

    asyncio.run(run_scenario())
