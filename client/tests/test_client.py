import asyncio
from pathlib import Path
import socket
import sys
import unittest

from aiohttp import ClientSession, ClientWSTimeout, CookieJar, web

from idlab_client import IDLabClient, IDLabHTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "core"))
from server import create_app


class ClientTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.listener = socket.socket()
        self.addCleanup(self.listener.close)
        self.listener.bind(("127.0.0.1", 0))
        port = self.listener.getsockname()[1]
        self.origin = f"http://127.0.0.1:{port}"
        runner = web.AppRunner(create_app(port=port, token="test-token", read_timeout=2))
        await runner.setup()
        self.addAsyncCleanup(runner.cleanup)
        await web.SockSite(runner, self.listener).start()
        self.browser = ClientSession(cookie_jar=CookieJar(unsafe=True))
        self.addAsyncCleanup(self.browser.close)
        async with self.browser.get(self.origin) as response:
            self.assertEqual(response.status, 200)
        self.client = IDLabClient(self.origin, token="test-token", timeout=3)

    async def connect(self):
        socket = await self.browser.ws_connect(
            self.origin + "/agent?device=test-board", origin=self.origin,
            timeout=ClientWSTimeout(ws_close=2),
        )
        self.addAsyncCleanup(socket.close)
        await socket.send_json({
            "chip": "esp32s3", "mac": "10:20:30:40:50:60", "loader": "stub",
            "transport": "usb_uart", "flash_size": 16 * 1024 * 1024,
        })
        await socket.receive_json(timeout=2)
        return socket

    async def test_list_identify_and_read(self):
        socket = await self.connect()
        devices = await asyncio.to_thread(self.client.devices)
        board = await asyncio.to_thread(self.client.identify, "test-board")
        self.assertEqual(devices, {"test-board": board})
        self.assertIn("flash.read", board.capabilities)

        task = asyncio.create_task(asyncio.to_thread(board.read_flash, 4096, 4))
        command = await socket.receive_json(timeout=2)
        self.assertEqual((command["command"], command["address"], command["size"]),
                         ("flash.read", 4096, 4))
        await socket.send_bytes(b"abcd")
        self.assertEqual(await task, b"abcd")

    async def test_old_handle_refused_after_reconnection(self):
        socket = await self.connect()
        old = await asyncio.to_thread(self.client.identify, "test-board")
        await socket.close()
        await self.connect()
        fresh = await asyncio.to_thread(self.client.identify, "test-board")
        self.assertNotEqual(old.generation, fresh.generation)
        with self.assertRaises(IDLabHTTPError) as caught:
            await asyncio.to_thread(old.read_flash, 0, 4)
        self.assertEqual((caught.exception.status, caught.exception.code), (409, "device_session_changed"))

    async def test_truncated_read_is_an_error(self):
        socket = await self.connect()
        board = await asyncio.to_thread(self.client.identify, "test-board")
        task = asyncio.create_task(asyncio.to_thread(board.read_flash, 0, 4))
        await socket.receive_json(timeout=2)
        await socket.send_bytes(b"abc")
        with self.assertRaises(IDLabHTTPError) as caught:
            await task
        self.assertEqual((caught.exception.status, caught.exception.code),
                         (502, "read_incomplete_reconnect_required"))
