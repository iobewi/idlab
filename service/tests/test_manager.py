import asyncio
from pathlib import Path
import socket
import unittest

from aiohttp import ClientSession, ClientTimeout
from aiohttp.test_utils import TestClient, TestServer

from service.manager import HTTPService, create_app


class ManagerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        self.service = HTTPService(port)
        self.client = TestClient(TestServer(create_app(token="test-token", service=self.service)))
        self.addAsyncCleanup(self.client.close)
        await self.client.start_server()
        self.headers = {"Host": "127.0.0.1:8081", "Authorization": "Bearer test-token"}
        self.endpoint = f"http://127.0.0.1:{port}/health"

    def request(self, method, action, **kwargs):
        headers = self.headers | kwargs.pop("headers", {})
        return self.client.request(method, f"/v1/{action}", headers=headers, **kwargs)

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
        (Path(__file__).resolve().parents[2] / "core/node_modules/esptool-js/bundle.js").is_file(),
        "npm ci --prefix core required",
    )
    async def test_manages_http_process_without_stopping_manager(self):
        response = await self.request("GET", "status")
        self.assertEqual(await response.json(), {"state": "stopped", "ready": False})
        self.assertEqual((await self.request("POST", "start")).status, 200)
        await self.wait_ready()
        first = self.service.process

        self.assertEqual((await self.request("POST", "start")).status, 200)
        self.assertIs(first, self.service.process)
        self.assertEqual((await self.request("POST", "restart")).status, 200)
        self.assertIsNotNone(first.returncode)
        self.assertIsNot(first, self.service.process)
        await self.wait_ready()

        self.assertEqual((await self.request("POST", "stop")).status, 200)
        async with ClientSession(timeout=ClientTimeout(total=2)) as session:
            with self.assertRaises(OSError):
                await session.get(self.endpoint)
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
            ("POST", "stop", {"headers": {"Origin": "http://127.0.0.1:8081"}}, 403),
            ("GET", "status", {"headers": {"Host": "other.test"}}, 403),
            ("POST", "start", {"json": {"service": "another"}}, 400),
            ("GET", "restart", {}, 405),
            ("POST", "remove", {}, 404),
        ]:
            self.assertEqual((await self.request(method, path, **kwargs)).status, status)
        self.assertIsNone(self.service.process)
