import asyncio
import unittest
from unittest.mock import AsyncMock

from aiohttp.test_utils import TestClient, TestServer

from service.manager import COMMANDS, ComposeError, create_app


class ManagerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.compose = AsyncMock(return_value=b"")
        self.client = TestClient(TestServer(create_app(token="test-token", compose=self.compose)))
        await self.client.start_server()
        self.headers = {"Host": "127.0.0.1:8081", "Authorization": "Bearer test-token"}
        self.addAsyncCleanup(self.client.close)

    def request(self, method, action, **kwargs):
        headers = self.headers | kwargs.pop("headers", {})
        return self.client.request(method, f"/v1/{action}", headers=headers, **kwargs)

    async def test_lifecycle_targets_only_core(self):
        for action in ("start", "stop", "restart"):
            response = await self.request("POST", action)
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {"action": action})
            self.compose.assert_awaited_with(COMMANDS[action])

    async def test_status_distinguishes_absent_stopped_and_ready(self):
        for output, state, ready in [
            (b"", "absent", False),
            (b'{"State":"exited","Health":""}\n', "exited", False),
            (b'{"State":"running","Health":"starting"}\n', "running", False),
            (b'[{"State":"running","Health":"healthy"}]', "running", True),
        ]:
            self.compose.return_value = output
            result = await (await self.request("GET", "status")).json()
            self.assertEqual((result["state"], result["ready"]), (state, ready))
        self.compose.assert_awaited_with(COMMANDS["status"])

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
        self.compose.assert_not_awaited()

    async def test_serializes_commands(self):
        started = asyncio.Event()
        release = asyncio.Event()

        async def stop(args):
            self.assertEqual(args, COMMANDS["stop"])
            started.set()
            await release.wait()
            return b""

        self.compose.side_effect = stop
        first = asyncio.create_task(self.request("POST", "stop"))
        try:
            await asyncio.wait_for(started.wait(), timeout=2)
            second = await self.request("POST", "start")
            self.assertEqual(second.status, 409)
            self.assertEqual(await second.json(), {"error": "manager_busy"})
        finally:
            release.set()
            self.assertEqual((await first).status, 200)

    async def test_compose_error_and_timeout_are_distinct(self):
        for error, status, code in [
            (ComposeError, 502, "compose_failed"), (TimeoutError, 504, "compose_timeout"),
        ]:
            self.compose.side_effect = error
            response = await self.request("POST", "restart")
            self.assertEqual(response.status, status)
            self.assertEqual(await response.json(), {"error": code})
