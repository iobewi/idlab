import asyncio
import os
from pathlib import Path
from unittest.mock import patch
import unittest

from aiohttp import CookieJar
from aiohttp.test_utils import TestClient, TestServer

from server import create_app


class CoreTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.server = TestServer(create_app(port=0, token="test-token", read_timeout=0.2))
        # Use a nominated Host for origin validation while connecting to an
        # ephemeral test port, so parallel test runs never share a socket.
        self.browser = TestClient(self.server, cookie_jar=CookieJar(unsafe=True))
        await self.browser.start_server()
        self.local = {"Host": "127.0.0.1:0", "Origin": "http://127.0.0.1:0"}
        self.script = {"Host": "127.0.0.1:0", "Authorization": "Bearer test-token"}
        response = await self.browser.get("/", headers=self.local)
        self.assertEqual(response.status, 200)

    async def asyncTearDown(self):
        await self.browser.close()

    async def board(self, name, loader="stub"):
        ws = await self.browser.ws_connect("/agent?device=" + name, headers=self.local)
        await ws.send_json({
            "chip": "esp32s3", "mac": "10:20:30:40:50:60",
            "loader": loader, "transport": "usb_serial_jtag",
            "flash_size": 16 * 1024 * 1024 if loader == "stub" else None,
        })
        return ws, (await ws.receive_json())["generation"]

    def read(self, name, generation, *, address=0, size=4, headers=None):
        return self.browser.post(
            f"/api/v1/devices/{name}/flash/read", headers=headers or self.script,
            json={"generation": generation, "address": address, "size": size},
        )

    async def test_web_and_script_use_same_read(self):
        ws, generation = await self.board("board")
        response = await self.browser.get("/api/v1/devices/board", headers=self.script)
        self.assertEqual((await response.json())["capabilities"], ["identify", "flash.read"])
        for headers, data in ((self.script, b"abcd"), (self.local, b"efgh")):
            read = asyncio.create_task(self.read("board", generation, headers=headers))
            command = await ws.receive_json()
            self.assertEqual((command["command"], command["address"], command["size"]), ("flash.read", 0, 4))
            await ws.send_bytes(data)
            response = await read
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.read(), data)

    async def test_two_boards_stay_independent(self):
        a, ga = await self.board("a")
        b, gb = await self.board("b")
        read_a = asyncio.create_task(self.read("a", ga))
        await a.receive_json()
        self.assertEqual((await self.read("a", ga)).status, 409)
        read_b = asyncio.create_task(self.read("b", gb))
        await b.receive_json()
        await b.send_bytes(b"bbbb")
        await a.send_bytes(b"aaaa")
        self.assertEqual(await (await read_b).read(), b"bbbb")
        self.assertEqual(await (await read_a).read(), b"aaaa")

    async def test_short_read_invalidates_session(self):
        ws, generation = await self.board("board")
        read = asyncio.create_task(self.read("board", generation))
        await ws.receive_json()
        await ws.send_bytes(b"abc")
        response = await read
        self.assertEqual(response.status, 502)
        self.assertEqual((await response.json())["error"], "read_incomplete_reconnect_required")
        new, new_generation = await self.board("board")
        self.assertNotEqual(generation, new_generation)
        self.assertEqual((await self.read("board", generation)).status, 409)
        await new.close()

    async def test_timeout_invalidates_session_without_replay(self):
        ws, generation = await self.board("board")
        read = asyncio.create_task(self.read("board", generation))
        await ws.receive_json()
        reply = await ws.receive(timeout=2)
        self.assertEqual(reply.type.name, "CLOSE")
        self.assertEqual((await read).status, 502)
        self.assertEqual((await self.read("board", generation)).status, 409)

    async def test_rom_range_and_origin_refused(self):
        _, rom = await self.board("rom", loader="rom")
        _, stub = await self.board("stub")
        self.assertEqual((await self.read("rom", rom)).status, 409)
        self.assertEqual((await self.read("stub", stub, address=-1)).status, 400)
        foreign = dict(self.local, Origin="http://example.test")
        self.assertEqual((await self.read("stub", stub, headers=foreign)).status, 403)
        self.assertEqual((await self.read("stub", stub, headers={"Host": self.local["Host"]})).status, 401)

    async def test_health_requires_browser_bundle(self):
        with patch("server.BUNDLE", Path(__file__)):
            response = await self.browser.get("/health", headers=self.local)
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {"status": "ready"})
        with patch("server.BUNDLE", Path(__file__).parent):
            response = await self.browser.get("/health", headers=self.local)
            self.assertEqual(response.status, 503)

    async def test_shutdown_closes_agent_and_interrupts_pending_read(self):
        ws, generation = await self.board("board")
        read = asyncio.create_task(self.read("board", generation))
        await ws.receive_json()
        await asyncio.wait_for(self.server.app.shutdown(), timeout=2)
        self.assertEqual((await ws.receive(timeout=2)).type.name, "CLOSE")
        response = await asyncio.wait_for(read, timeout=2)
        self.assertEqual(response.status, 502)

    @unittest.skipUnless(os.path.isfile("node_modules/esptool-js/bundle.js"), "npm ci required")
    async def test_browser_assets(self):
        for path in ("/web/app.js", "/esptool.js"):
            response = await self.browser.get(path, headers=self.local)
            self.assertEqual(response.status, 200)
            self.assertIn("javascript", response.content_type)
