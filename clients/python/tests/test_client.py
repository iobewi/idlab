import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
import socket
import sys
import unittest

from aiohttp import ClientSession, ClientWSTimeout, CookieJar, web

from idlab_client import IDLabClient, IDLabHTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "core"))
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

    async def connect(self, *, console=False):
        socket = await self.browser.ws_connect(
            self.origin + "/agent?device=test-board", origin=self.origin,
            timeout=ClientWSTimeout(ws_close=2),
        )
        self.addAsyncCleanup(socket.close)
        await socket.send_json({"mode": "console", "transport": "usb_uart",
                                "port_key": "00000000-0000-4000-8000-000000000001"} if console else {
            "chip": "esp32s3", "mac": "10:20:30:40:50:60", "loader": "stub",
            "transport": "usb_uart", "flash_size": 16 * 1024 * 1024,
        })
        await socket.receive_json(timeout=2)
        return socket

    @asynccontextmanager
    async def control(self, socket):
        async with self.browser.post(self.origin + "/api/v1/devices/test-board/control/token",
                                     headers={"Origin": self.origin}) as response:
            self.assertEqual(response.status, 200)
            token = (await response.json())["token"]
        self.assertEqual((await socket.receive_json(timeout=2))["control"], "available")
        context = self.client.control("test-board", token)
        board = await asyncio.to_thread(context.__enter__)
        self.assertEqual((await socket.receive_json(timeout=2))["control"], "external")
        try:
            yield board
        finally:
            await asyncio.to_thread(context.__exit__, None, None, None)

    async def test_list_identify_and_read(self):
        socket = await self.connect()
        devices = await asyncio.to_thread(self.client.devices)
        board = await asyncio.to_thread(self.client.identify, "test-board")
        self.assertEqual(devices, {"test-board": board})
        self.assertIn("flash.read", board.capabilities)

        async with self.control(socket) as controller:
            with self.assertRaises(IDLabHTTPError) as refused:
                await asyncio.to_thread(controller.return_console)
            self.assertEqual(refused.exception.code, "operation_unsupported")
            task = asyncio.create_task(asyncio.to_thread(controller.read_flash, 4096, 4))
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

    async def test_one_control_session_writes_uart_and_switches_modes(self):
        socket = await self.connect(console=True)
        async with self.control(socket) as console:
            self.assertEqual(console.mode, "console")
            await socket.send_json({"uart": b"ready\n".hex()})
            for _ in range(10):
                data, cursor, dropped = await asyncio.to_thread(console.read_uart)
                if data:
                    break
                await asyncio.sleep(0.01)
            self.assertEqual((data, cursor, dropped), (b"ready\n", 6, 0))
            observer = await asyncio.to_thread(self.client.identify, "test-board")
            self.assertEqual(await asyncio.to_thread(observer.read_uart), (b"ready\n", 6, 0))
            self.assertEqual(await asyncio.to_thread(observer.read_uart, 6), (b"", 6, 0))
            with self.assertRaises(IDLabHTTPError) as refused:
                await asyncio.to_thread(observer.write_uart, b"blocked")
            self.assertEqual(refused.exception.code, "control_session_required")

            async def command(method, expected, *, data=None, identity=None, value=None):
                args = (data,) if data is not None else ()
                task = asyncio.create_task(asyncio.to_thread(method, *args))
                request = await socket.receive_json(timeout=2)
                self.assertEqual(request["command"], expected)
                self.assertNotIn("generation", request)
                if data is not None:
                    self.assertEqual(bytes.fromhex(request["hex"]), data)
                if identity is not None:
                    await socket.send_json({"identity": identity})
                    updated = await socket.receive_json(timeout=2)
                    self.assertEqual(updated["identity"]["generation"], console.generation)
                await socket.send_json({"result": request["id"], "value": value})
                return await task

            await command(console.write_uart, "uart.write", data=b"status\r\n")
            await command(console.reset, "console.reset")
            loader = await command(console.enter_loader, "mode.loader", identity={
                "mode": "loader", "loader": "stub", "transport": "usb_uart",
                "chip": "esp32s3", "mac": "10:20:30:40:50:60", "flash_size": 16777216,
                "return_to_console": True,
            })
            self.assertEqual(loader.mode, "loader")
            with self.assertRaises(IDLabHTTPError) as reset:
                await asyncio.to_thread(loader.reset)
            self.assertEqual(reset.exception.code, "operation_unsupported")
            again = await command(loader.return_console, "mode.console",
                                  identity={"mode": "console", "transport": "usb_uart"})
            self.assertEqual((again.mode, again.generation), ("console", console.generation))
            await command(again.write_uart, "uart.write", data=b"after\n")
            rom = await command(again.enter_rom, "mode.rom", identity={
                "mode": "loader", "loader": "rom", "transport": "usb_uart",
                "chip": "esp32s3", "mac": "10:20:30:40:50:60", "flash_size": None,
                "return_to_console": True,
            })
            jedec = {"flash_id": 0x184068, "flash_size": 16777216}
            self.assertEqual(await command(rom.read_jedec, "rom.jedec", value=jedec), jedec)
            activity = await asyncio.to_thread(rom.activity)
            self.assertEqual(activity["operations"][0]["detail"], jedec)
            self.assertEqual(activity["device"]["jedec"], jedec)

    async def test_campaign_api_keeps_status_and_tags_commands(self):
        campaign = await asyncio.to_thread(self.client.create_campaign, "Console QA", metadata={"scenario": "boot"})
        campaign_id = campaign["id"]
        self.assertEqual((campaign["state"], campaign["metadata"]), ("active", {"scenario": "boot"}))
        updated = await asyncio.to_thread(self.client.update_campaign, campaign_id, metadata={"scenario": "uart"})
        self.assertEqual(updated["metadata"], {"scenario": "uart"})
        matches = await asyncio.to_thread(self.client.list_campaigns, state=["active"], q="Console QA")
        self.assertEqual(matches["total"], 1)

        socket = await self.connect(console=True)
        async with self.control(socket) as board:
            tracked = board.for_campaign(campaign_id)
            task = asyncio.create_task(asyncio.to_thread(tracked.write_uart, b"status\n"))
            command = await socket.receive_json(timeout=2)
            self.assertEqual(command["command"], "uart.write")
            operations = await asyncio.to_thread(self.client.campaign_operations, campaign_id)
            active = operations["items"][0]
            self.assertEqual((active["id"], active["state"], active["campaign_id"]),
                             (command["id"], "En cours", campaign_id))
            self.assertNotIn("hex", active)
            with self.assertRaises(IDLabHTTPError) as busy:
                await asyncio.to_thread(self.client.finish_campaign, campaign_id, "PASS")
            self.assertEqual(busy.exception.code, "campaign_busy")
            await socket.send_json({"result": command["id"]})
            await task
            finished = await asyncio.to_thread(self.client.finish_campaign, campaign_id, "PASS")
            self.assertEqual((finished["state"], finished["verdict"]), ("finished", "PASS"))
            with self.assertRaises(IDLabHTTPError) as closed:
                await asyncio.to_thread(tracked.write_uart, b"status\n")
            self.assertEqual(closed.exception.code, "campaign_not_active")

        operations = await asyncio.to_thread(self.client.campaign_operations, campaign_id)
        self.assertEqual(operations["items"][0]["state"], "Terminée")
        self.assertEqual(await asyncio.to_thread(self.client.get_campaign, campaign_id), finished)
        with self.assertRaises(IDLabHTTPError) as closed:
            await asyncio.to_thread(self.client.update_campaign, campaign_id, name="Other")
        self.assertEqual(closed.exception.code, "campaign_not_active")

    async def test_truncated_read_is_an_error(self):
        socket = await self.connect()
        async with self.control(socket) as board:
            task = asyncio.create_task(asyncio.to_thread(board.read_flash, 0, 4))
            await socket.receive_json(timeout=2)
            await socket.send_bytes(b"abc")
            with self.assertRaises(IDLabHTTPError) as caught:
                await task
            self.assertEqual((caught.exception.status, caught.exception.code),
                             (502, "read_incomplete_reconnect_required"))
