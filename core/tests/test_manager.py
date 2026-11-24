import asyncio
from pathlib import Path
import os
import socket
import tempfile
import unittest
from unittest.mock import patch

from aiohttp import CookieJar
from aiohttp.test_utils import TestClient, TestServer

from manager import HTTPService, create_app


class ManagerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        state = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(patch.dict(os.environ, {"IDLAB_STATE_DIR": state}))
        self.service = HTTPService(port)
        self.client = TestClient(
            TestServer(create_app(token="test-token", service=self.service)),
            cookie_jar=CookieJar(unsafe=True),
        )
        self.addAsyncCleanup(self.client.close)
        await self.client.start_server()
        self.headers = {"Host": "127.0.0.1:8080", "Authorization": "Bearer test-token"}
        self.web = {"Host": "127.0.0.1:8080"}

    def request(self, method, action, **kwargs):
        headers = self.headers | kwargs.pop("headers", {})
        return self.client.request(method, f"/api/v1/httpd/{action}", headers=headers, **kwargs)

    async def wait_ready(self):
        async with asyncio.timeout(5):
            while True:
                response = await self.request("GET", "status")
                state = await response.json()
                self.assertEqual(state["state"], "running", state)
                if state["ready"]:
                    return
                await asyncio.sleep(0.05)

    @unittest.skipUnless(
        (Path(__file__).resolve().parents[1] / "node_modules/esptool-js/bundle.js").is_file(),
        "npm ci --prefix core required",
    )
    async def test_manages_http_process_without_stopping_manager(self):
        response = await self.request("GET", "status")
        self.assertEqual(await response.json(), {"state": "stopped", "ready": False})
        self.assertEqual((await self.request("POST", "start")).status, 200)
        await self.wait_ready()
        self.assertEqual((await self.client.get("/health", headers=self.web)).status, 200)
        async with self.client.get("/", headers=self.web) as page:
            self.assertEqual(page.status, 200)
        browser_headers = self.web | {"Origin": "http://127.0.0.1:8080"}
        created = await self.client.post(
            "/api/v1/campaigns", headers=browser_headers, json={"name": "Readback"},
        )
        self.assertEqual(created.status, 201)
        campaign = await created.json()
        agent = await self.client.ws_connect("/agent?device=board", headers=browser_headers)
        await agent.send_json({
            "chip": "esp32s3", "mac": "10:20:30:40:50:60", "loader": "stub",
            "transport": "usb_uart", "flash_size": 16 * 1024 * 1024,
        })
        generation = (await agent.receive_json(timeout=2))["generation"]
        read = asyncio.create_task(self.client.post(
            "/api/v1/devices/board/flash/read", headers=browser_headers,
            json={"generation": generation, "address": 0, "size": 4, "campaign_id": campaign["id"]},
        ))
        self.assertEqual((await agent.receive_json(timeout=2))["command"], "flash.read")
        await agent.send_bytes(b"data")
        response = await asyncio.wait_for(read, timeout=2)
        self.assertEqual(await response.read(), b"data")
        first = self.service.process

        self.assertEqual((await self.request("POST", "start")).status, 200)
        self.assertIs(first, self.service.process)
        self.assertEqual((await self.request("POST", "restart")).status, 200)
        self.assertIsNotNone(first.returncode)
        self.assertIsNot(first, self.service.process)
        await self.wait_ready()
        self.assertEqual((await agent.receive(timeout=2)).type.name, "CLOSE")
        # The web session changes on restart, while campaign records survive.
        await self.client.get("/", headers=self.web)
        retained = await self.client.get("/api/v1/campaigns/" + campaign["id"], headers=browser_headers)
        self.assertEqual(await retained.json(), campaign)

        self.assertEqual((await self.request("POST", "stop")).status, 200)
        self.assertEqual((await self.client.get("/health", headers=self.web)).status, 503)
        response = await self.request("GET", "status")
        self.assertEqual(await response.json(), {"state": "stopped", "ready": False})
        self.assertEqual((await self.request("POST", "start")).status, 200)
        await self.wait_ready()
        final = self.service.process
        await self.client.close()
        self.assertIsNotNone(final.returncode)

    async def test_refuses_untrusted_or_unexpected_requests(self):
        for method, path, kwargs, status in [
            ("POST", "start", {"headers": {"Authorization": "Bearer wrong"}}, 401),
            ("POST", "stop", {"headers": {"Origin": "http://127.0.0.1:8080"}}, 403),
            ("GET", "status", {"headers": {"Host": "other.test"}}, 403),
            ("POST", "start", {"json": {"service": "another"}}, 400),
            ("GET", "restart", {}, 405),
            ("POST", "remove", {}, 404),
        ]:
            self.assertEqual((await self.request(method, path, **kwargs)).status, status)
        self.assertIsNone(self.service.process)
