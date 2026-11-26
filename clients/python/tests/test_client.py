import asyncio
from contextlib import asynccontextmanager
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from aiohttp import ClientSession, ClientWSTimeout, CookieJar, web

from idlab_client import IDLabClient, IDLabHTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "core"))
from server import create_app


class ConfigurationTests(unittest.TestCase):
    def test_url_is_required_and_explicit_arguments_override_environment(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, "IDLAB_URL"):
                IDLabClient()
            IDLabClient("http://127.0.0.1:8080")
        with patch.dict(os.environ, {"IDLAB_URL": "not a URL", "IDLAB_ALLOW_INSECURE_HTTP": "invalid"}):
            IDLabClient("https://lab.example.test", allow_insecure_http=False)
            with self.assertRaisesRegex(ValueError, "IDLAB_ALLOW_INSECURE_HTTP"):
                IDLabClient("https://lab.example.test")
        with patch.dict(os.environ, {"IDLAB_URL": "http://lab.example.test", "IDLAB_ALLOW_INSECURE_HTTP": "true"}):
            with self.assertRaisesRegex(ValueError, "allow_insecure_http"):
                IDLabClient(allow_insecure_http=False)
            with self.assertRaisesRegex(ValueError, "HTTP or HTTPS origin"):
                IDLabClient("")


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
        async with self.browser.post(self.origin + "/api/v1/web/session", headers={"Origin": self.origin}) as response:
            self.assertEqual(response.status, 204)
        self.client = IDLabClient(self.origin, token="test-token", timeout=3)

    async def connect(self, *, console=False, programmable=False, erasable=False):
        socket = await self.browser.ws_connect(
            self.origin + "/agent?device=test-board", origin=self.origin,
            timeout=ClientWSTimeout(ws_close=2),
        )
        self.addAsyncCleanup(socket.close)
        await socket.send_json({"mode": "console", "transport": "usb_uart",
                                "port_key": "00000000-0000-4000-8000-000000000001"} if console else {
            "chip": "esp32s3", "mac": "10:20:30:40:50:60", "loader": "stub",
            "transport": "usb_uart", "flash_size": 16 * 1024 * 1024, "programmable": programmable,
            "erasable": erasable, "erasable_region": erasable,
        })
        await socket.receive_json(timeout=2)
        return socket

    async def issue_token(self, socket):
        async with self.browser.post(self.origin + "/api/v1/devices/test-board/control/token",
                                     headers={"Origin": self.origin}) as response:
            self.assertEqual(response.status, 200)
            token = (await response.json())["token"]
        self.assertEqual((await socket.receive_json(timeout=2))["control"], "available")
        return token

    @asynccontextmanager
    async def control(self, socket, *, client=None):
        token = await self.issue_token(socket)
        context = (client or self.client).control("test-board", token)
        board = await asyncio.to_thread(context.__enter__)
        self.assertEqual((await socket.receive_json(timeout=2))["control"], "external")
        try:
            yield board
        finally:
            await asyncio.to_thread(context.__exit__, None, None, None)

    async def test_generated_recipe_releases_control_even_on_assertion_failure(self):
        agent = await self.connect(console=True)
        token = await self.issue_token(agent)
        with TemporaryDirectory() as project:
            init = [sys.executable, "-c", "from idlab_client.cli import main; raise SystemExit(main(['init']))"]
            await asyncio.to_thread(subprocess.run, init, cwd=project, check=True, capture_output=True, timeout=10)
            hardware = Path(project) / "tests" / "hardware"
            self.assertEqual({path.name for path in hardware.iterdir()}, {
                "README.md", "requirements.txt", "pytest.ini", "conftest.py", "test_connectivity.py",
            })
            readme = hardware / "README.md"
            readme.write_text("Project documentation\n", encoding="utf-8")
            (hardware / "requirements.txt").unlink()
            await asyncio.to_thread(subprocess.run, init, cwd=project, check=True, capture_output=True, timeout=10)
            self.assertEqual(readme.read_text(encoding="utf-8"), "Project documentation\n")
            self.assertTrue((hardware / "requirements.txt").is_file())

            env = dict(os.environ, IDLAB_URL=self.origin, IDLAB_BOARD="test-board", IDLAB_BOARD_TOKEN=token,
                       IDLAB_ALLOW_INSECURE_HTTP="false", PYTEST_DISABLE_PLUGIN_AUTOLOAD="1")
            env.pop("IDLAB_TOKEN", None)
            env.pop("PYTEST_ADDOPTS", None)
            for expected_status in (0, 1):
                if expected_status:
                    (hardware / "test_failure.py").write_text(
                        "def test_failure(board):\n    assert not board.generation\n", encoding="utf-8",
                    )
                process = await asyncio.create_subprocess_exec(
                    sys.executable, "-m", "pytest", "tests/hardware/", "-v", cwd=project, env=env,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                )
                try:
                    output, _ = await asyncio.wait_for(process.communicate(), timeout=20)
                finally:
                    if process.returncode is None:
                        process.kill()
                        await process.wait()
                self.assertEqual(process.returncode, expected_status, output.decode(errors="replace"))
                for _ in range(1 + expected_status):
                    self.assertEqual((await agent.receive_json(timeout=2))["control"], "external")
                    self.assertEqual((await agent.receive_json(timeout=2))["control"], "available")

    async def test_docker_http_allows_delegated_control_without_global_token(self):
        origin = self.origin.replace("127.0.0.1", "host.docker.internal")
        with patch.dict(os.environ, {"IDLAB_URL": origin}, clear=True):
            with self.assertRaisesRegex(ValueError, "allow_insecure_http"):
                IDLabClient()
        with patch.dict(os.environ, {"IDLAB_URL": origin, "IDLAB_ALLOW_INSECURE_HTTP": "true"}, clear=True):
            client = IDLabClient(timeout=3)
        agent = await self.connect(console=True)
        system_getaddrinfo = socket.getaddrinfo

        def resolve(host, *args, **kwargs):
            if host == "host.docker.internal":
                host = "127.0.0.1"
            return system_getaddrinfo(host, *args, **kwargs)

        with patch("socket.getaddrinfo", side_effect=resolve):
            with self.assertRaises(IDLabHTTPError) as anonymous:
                await asyncio.to_thread(client.devices)
            self.assertEqual(anonymous.exception.status, 401)
            async with self.control(agent, client=client) as board:
                await agent.send_json({"uart": b"ready\n".hex()})
                async with asyncio.timeout(2):
                    while True:
                        data, cursor, dropped = await asyncio.to_thread(board.read_uart)
                        if data:
                            break
                        await asyncio.sleep(0.01)
                self.assertEqual((data, cursor, dropped), (b"ready\n", 6, 0))
            self.assertEqual((await agent.receive_json(timeout=2))["control"], "available")

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
            activity = await asyncio.to_thread(controller.activity)
            operation = activity["operations"][0]
            self.assertEqual(operation["source"], "python")
            self.assertRegex(operation["session_id"], r"^[0-9a-f]{12}$")
            self.assertEqual(activity["journal"][-1]["session_id"], operation["session_id"])

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

    async def test_erase_requires_confirmation_and_rejects_nonblank_readback(self):
        agent = await self.connect(erasable=True)
        async with self.control(agent) as board:
            self.assertIn("flash.erase", board.capabilities)
            with self.assertRaises(ValueError):
                board.erase_flash(confirmation="another-board")
            path = self.origin + "/api/v1/devices/test-board/command"
            async with self.browser.post(path, headers={"Origin": self.origin}, json={
                "command": "flash.erase", "generation": board.generation,
            }) as refused:
                self.assertEqual((await refused.json())["error"], "flash_erase_confirmation_required")
            for first in (7, None):
                task = asyncio.create_task(asyncio.to_thread(board.erase_flash, confirmation=board.name))
                command = await agent.receive_json(timeout=2)
                self.assertEqual(command["command"], "flash.erase")
                result = {"address": 0, "size": board.flash_size, "first_non_ff": first}
                await agent.send_json({"result": command["id"], "value": result})
                if first is None:
                    self.assertEqual(await task, result)
                else:
                    with self.assertRaises(IDLabHTTPError) as failed:
                        await task
                    self.assertEqual(failed.exception.code, "flash_erase_verification_failed")
        self.assertEqual((await agent.receive_json(timeout=2))["control"], "available")
        history = (await asyncio.to_thread(self.client.identify, "test-board"))
        entries = (await asyncio.to_thread(history.activity))["operations"]
        self.assertEqual([(entry["state"], entry["verification"]["first_non_ff"]) for entry in entries],
                         [("Terminée", None), ("Échec", 7)])

    async def test_manifest_and_erase_region_open_loader_from_console(self):
        agent = await self.connect(console=True)
        campaign = await asyncio.to_thread(self.client.create_campaign, "Flash maintenance")
        loader = {"mode": "loader", "chip": "esp32s3", "mac": "10:20:30:40:50:60", "loader": "stub",
                  "transport": "usb_uart", "flash_size": 16 * 1024 * 1024, "programmable": True,
                  "erasable": True, "erasable_region": True, "return_to_console": True}

        async def switch(expected, identity):
            request = await agent.receive_json(timeout=2)
            self.assertEqual(request["command"], expected)
            await agent.send_json({"identity": identity})
            await agent.receive_json(timeout=2)
            await agent.send_json({"result": request["id"]})

        async with self.control(agent) as console:
            console = console.for_campaign(campaign["id"])
            with TemporaryDirectory() as folder:
                path = Path(folder) / "manifest.json"
                (path.parent / "app.bin").write_bytes(b"firmware")
                path.write_text(json.dumps({"builds": [
                    {"chipFamily": "ESP32-C6", "parts": [{"path": "missing.bin", "offset": 0}]},
                    {"chipFamily": "ESP32-S3", "parts": [{"path": "app.bin", "offset": 4096}]},
                ]}), encoding="utf-8")
                preparing = asyncio.create_task(asyncio.to_thread(console.prepare_flash_manifest, path))
                await switch("mode.loader", loader)
                plan, binaries = await preparing
                self.assertEqual((plan["images"][0]["address"], binaries), (4096, [b"firmware"]))
            back = asyncio.create_task(asyncio.to_thread(console.return_console))
            await switch("mode.console", {"mode": "console", "transport": "usb_uart"})
            console = await back
            erase = asyncio.create_task(asyncio.to_thread(console.erase_flash_region, 4096, 4096,
                                                          confirmation=console.name))
            await switch("mode.loader", loader)
            request = await agent.receive_json(timeout=2)
            self.assertEqual((request["command"], request["address"], request["size"]), ("flash.erase.region", 4096, 4096))
            verified = {"address": 4096, "size": 4096, "first_non_ff": None}
            await agent.send_json({"result": request["id"], "value": verified})
            self.assertEqual(await erase, verified)
        history = await asyncio.to_thread(self.client.campaign_operations, campaign["id"])
        self.assertCountEqual([entry["command"] for entry in history["items"]],
                              ["mode.loader", "mode.console", "mode.loader", "flash.erase.region"])

    async def test_erase_region_requires_exact_sector_bounds(self):
        agent = await self.connect(erasable=True)
        async with self.control(agent) as board:
            with self.assertRaises(ValueError):
                board.erase_flash_region(4096, 4095, confirmation=board.name)
            for fields, code in (({"address": 4096}, "invalid_arguments"),
                                 ({"address": 1, "size": 4096}, "invalid_flash_range"),
                                 ({"address": board.flash_size, "size": 4096}, "invalid_flash_range")):
                with self.assertRaises(IDLabHTTPError) as refused:
                    await asyncio.to_thread(board._operate, "flash.erase.region", confirmation=board.name, **fields)
                self.assertEqual(refused.exception.code, code)
            task = asyncio.create_task(asyncio.to_thread(board.erase_flash_region, 4096, 8192, confirmation=board.name))
            request = await agent.receive_json(timeout=2)
            self.assertEqual((request["command"], request["address"], request["size"]),
                             ("flash.erase.region", 4096, 8192))
            result = {"address": 4096, "size": 8192, "first_non_ff": None}
            await agent.send_json({"result": request["id"], "value": result})
            self.assertEqual(await task, result)

    async def test_program_confirmed_plan_and_record_readback(self):
        agent = await self.connect(programmable=True)
        campaign = await asyncio.to_thread(self.client.create_campaign, "Firmware delivery")
        binaries = [b"a" * 8192, b"second image"]
        async with self.control(agent) as board:
            board = board.for_campaign(campaign["id"])
            with self.assertRaises(IDLabHTTPError) as overlap:
                await asyncio.to_thread(board.prepare_flash, [(0, binaries[0]), (4096, binaries[1])])
            self.assertEqual(overlap.exception.code, "invalid_flash_range")
            plan = await asyncio.to_thread(board.prepare_flash, [(0, binaries[0]), (8192, binaries[1])])
            with self.assertRaises(IDLabHTTPError) as modified:
                await asyncio.to_thread(board.program_flash, plan["plan_id"], [b"x" * 8192, binaries[1]])
            self.assertEqual(modified.exception.code, "flash_image_mismatch")

            for mismatch in (None, "preview", "sha256"):
                program = asyncio.create_task(asyncio.to_thread(board.program_flash, plan["plan_id"], binaries))
                command = await agent.receive_json(timeout=2)
                self.assertEqual(command["command"], "flash.program")
                self.assertEqual(command["images"], plan["images"])
                path = f"/api/v1/devices/test-board/flash/program/{command['id']}"
                for index, data in enumerate(binaries):
                    async with self.browser.get(self.origin + f"{path}/{index}") as download:
                        self.assertEqual(download.status, 200)
                        self.assertEqual(await download.read(), data)
                digests = [hashlib.sha256(data).hexdigest() for data in binaries]
                previews = [data[:256].hex() for data in binaries]
                if mismatch == "preview":
                    previews[1] = "00" + previews[1][2:]
                elif mismatch == "sha256":
                    digests[1] = "0" * 64
                await agent.send_json({"result": command["id"], "value": digests, "previews": previews})
                if mismatch is None:
                    verification = (await program)["verification"]
                    self.assertTrue(all(row["matches"] for row in verification))
                    self.assertEqual([row["readback_preview"] for row in verification], previews)
                    with self.assertRaises(IDLabHTTPError) as reused:
                        await asyncio.to_thread(board.program_flash, plan["plan_id"], binaries)
                    self.assertEqual(reused.exception.code, "flash_plan_confirmation_required")
                else:
                    with self.assertRaises(IDLabHTTPError) as failed:
                        await program
                    self.assertEqual(failed.exception.code, "flash_verification_failed")
                if mismatch != "sha256":
                    plan = await asyncio.to_thread(board.prepare_flash, [(0, binaries[0]), (8192, binaries[1])])

        history = await asyncio.to_thread(self.client.campaign_operations, campaign["id"])
        states = {row["state"]: row["verification"][1]["matches"] for row in history["items"]}
        self.assertEqual(states, {"Terminée": True, "Échec": False})

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
