import asyncio
import os
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
from unittest.mock import patch
import unittest

from aiohttp import CookieJar, WSServerHandshakeError
from aiohttp.test_utils import TestClient, TestServer

from campaigns import Campaigns
from server import create_app, validate_identity


class CampaignStorageTests(unittest.TestCase):
    def test_migrates_existing_campaigns_and_recovers_unfinished_operations(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "campaigns.sqlite3"
            db = sqlite3.connect(path)
            try:
                db.execute("""
                    CREATE TABLE campaigns (
                        id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL,
                        started_at TEXT NOT NULL, ended_at TEXT, abort_requested_at TEXT,
                        verdict TEXT, reason TEXT
                    )
                """)
                db.execute("INSERT INTO campaigns (id, name, state, started_at) VALUES (?, ?, 'active', ?)",
                           ("old", "Existing campaign", "2026-01-01T00:00:00+00:00"))
                db.commit()
            finally:
                db.close()
            campaigns = Campaigns(path)
            try:
                self.assertEqual(campaigns.get("old")["metadata"], {})
                campaigns.enter("old", {"id": "op", "startedAt": "2026-01-01T00:00:00+00:00", "state": "En cours"})
            finally:
                campaigns.close()
            campaigns = Campaigns(path)
            try:
                record = campaigns.operations("old", limit=25, offset=0)["items"][0]
                self.assertEqual(record["state"], "Échec")
                self.assertEqual(campaigns.get("old")["in_flight"], 0)
            finally:
                campaigns.close()


class IdentityTests(unittest.TestCase):
    def test_identification_retains_loader_details_and_read_capability(self):
        value = {
            "chip": "esp32s3", "model": "ESP32-S3 (revision v0.2)", "mac": "10:20:30:40:50:60",
            "flash_size": 16 * 1024 * 1024, "flash_id": 0x184068, "loader": "stub",
            "transport": "usb_serial_jtag", "usb_vid": 0x303a, "usb_pid": 0x1001,
        }
        self.assertEqual(validate_identity(value), value | {"capabilities": ["identify", "flash.read"]})
        with self.assertRaises(ValueError):
            validate_identity(value | {"flash_id": -1})


class CoreTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.server = TestServer(create_app(port=0, token="test-token", read_timeout=0.2, command_timeout=0.5))
        # Use a nominated Host for origin validation while connecting to an
        # ephemeral test port, so parallel test runs never share a socket.
        self.browser = TestClient(self.server, cookie_jar=CookieJar(unsafe=True))
        await self.browser.start_server()
        self.local = {"Host": "127.0.0.1:0", "Origin": "http://127.0.0.1:0"}
        self.script = {"Host": "127.0.0.1:0", "Authorization": "Bearer test-token"}
        response = await self.browser.post("/api/v1/web/session", headers=self.local)
        self.assertEqual(response.status, 204)

    async def asyncTearDown(self):
        await self.browser.close()

    async def board(self, name, loader="stub", *, browser=None, port_key=None):
        ws = await (browser or self.browser).ws_connect("/agent?device=" + name, headers=self.local)
        await ws.send_json({
            "chip": "esp32s3", "mac": "10:20:30:40:50:60",
            "loader": loader, "transport": "usb_serial_jtag",
            "flash_size": 16 * 1024 * 1024 if loader == "stub" else None,
            "port_key": port_key,
        })
        return ws, (await ws.receive_json())["generation"]

    async def test_browser_sessions_isolate_boards_campaigns_and_activity(self):
        async with TestClient(self.server, cookie_jar=CookieJar(unsafe=True)) as visitor:
            page = await visitor.get("/", headers=self.local)
            self.assertNotIn("idlab_session", page.cookies)
            self.assertEqual((await visitor.get("/api/v1/devices")).status, 401)
            with self.assertRaises(WSServerHandshakeError) as anonymous:
                await visitor.ws_connect("/agent?device=board", headers=self.local)
            self.assertEqual(anonymous.exception.status, 403)
            denied = await visitor.post("/api/v1/web/session", headers=self.local | {"Origin": "http://other.test"})
            self.assertEqual(denied.status, 403)
            created = await visitor.post("/api/v1/web/session", headers=self.local)
            self.assertEqual(created.status, 204)
            self.assertTrue(created.cookies["idlab_session"]["httponly"])

            owner_board, generation = await self.board("board")
            self.assertEqual(await (await visitor.get("/api/v1/devices")).json(), {})
            path = "/api/v1/devices/board"
            self.assertEqual((await visitor.get(path)).status, 404)
            self.assertEqual((await visitor.post(path + "/control/token", headers=self.local)).status, 404)
            _, other_generation = await self.board("board", browser=visitor)
            self.assertNotEqual(generation, other_generation)
            self.assertEqual((await (await visitor.get(path)).json())["generation"], other_generation)

            campaign = await self.browser.post("/api/v1/campaigns", headers=self.local, json={"name": "Private"})
            campaign_path = campaign.headers["Location"]
            self.assertEqual((await visitor.get(campaign_path)).status, 404)
            self.assertEqual((await visitor.get(campaign_path + "/operations")).status, 404)
            self.assertEqual((await (await visitor.get("/api/v1/campaigns")).json())["total"], 0)

            issued = await self.browser.post(path + "/control/token", headers=self.local)
            token = (await issued.json())["token"]
            await owner_board.receive_json(timeout=2)
            async with visitor.ws_connect(path + "/control/connect", headers={"Authorization": "Bearer " + token}) as control:
                session = await control.receive_json(timeout=2)
                self.assertEqual(session["generation"], generation)
                await owner_board.receive_json(timeout=2)
                read = asyncio.create_task(self.read("board", generation, headers={"Authorization": "Bearer " + session["session"]}))
                await owner_board.receive_json(timeout=2)
                async with visitor.ws_connect("/api/v1/activity", headers=self.local) as stream:
                    self.assertEqual(await stream.receive_json(timeout=2), {"active": False})
                await owner_board.send_bytes(b"data")
                self.assertEqual(await (await read).read(), b"data")

    def read(self, name, generation, *, address=0, size=4, headers=None):
        return self.browser.post(
            f"/api/v1/devices/{name}/flash/read", headers=headers or self.local,
            json={"generation": generation, "address": address, "size": size},
        )

    async def test_public_origin_uses_secure_cookie_and_bearer_does_not_depend_on_host(self):
        origin = "https://lab.example.test"
        async with TestClient(TestServer(create_app(public_origin=origin, token="test-token"))) as client:
            headers = {"Host": "lab.example.test", "Origin": origin}
            web_session = await client.post("/api/v1/web/session", headers=headers)
            self.assertEqual(web_session.status, 204)
            self.assertTrue(web_session.cookies["idlab_session"]["secure"])
            self.assertEqual(web_session.cookies["idlab_session"]["samesite"], "Strict")
            rejected = await client.post("/api/v1/web/session", headers=headers | {"Host": "elsewhere.test"})
            self.assertEqual(rejected.status, 403)
            bearer = {"Host": "docker.internal", "Authorization": "Bearer test-token"}
            self.assertEqual((await client.get("/api/v1/devices", headers=bearer)).status, 200)
            self.assertEqual((await client.get("/api/v1/web/session", headers=bearer)).status, 401)

    async def test_workbench_files_are_revalidated_after_deploy(self):
        for path in ("/", "/web/app.js", "/web/board-connector.js", "/web/style.css"):
            with self.subTest(path=path):
                async with self.browser.get(path, headers=self.local) as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.headers["Cache-Control"], "no-cache")
                    etag = response.headers["ETag"]
                async with self.browser.get(path, headers=self.local | {"If-None-Match": etag}) as response:
                    self.assertEqual(response.status, 304)
                    self.assertEqual(response.headers["Cache-Control"], "no-cache")

    async def test_web_read_and_script_observation(self):
        ws, generation = await self.board("board")
        response = await self.browser.get("/api/v1/devices/board", headers=self.script)
        self.assertEqual((await response.json())["capabilities"], ["identify", "flash.read"])
        denied = await self.read("board", generation, headers=self.script)
        self.assertEqual((denied.status, await denied.json()), (403, {"error": "control_session_required"}))
        for headers, data in ((self.local, b"abcd"), (self.local, b"efgh")):
            read = asyncio.create_task(self.read("board", generation, headers=headers))
            command = await ws.receive_json()
            self.assertEqual((command["command"], command["address"], command["size"]), ("flash.read", 0, 4))
            await ws.send_bytes(data)
            response = await read
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.read(), data)

    async def test_device_api_does_not_expose_hardware_reset(self):
        _, rom_generation = await self.board("rom", loader="rom")
        stub, stub_generation = await self.board("stub")
        for name, generation in (("rom", rom_generation), ("stub", stub_generation)):
            path = f"/api/v1/devices/{name}"
            for action in ("reset", "restart"):
                response = await self.browser.post(
                    f"{path}/{action}", headers=self.script, json={"generation": generation},
                )
                self.assertEqual(response.status, 404)
            response = await self.browser.post(
                f"{path}/flash/read", headers=self.script,
                json={"generation": generation, "address": 0, "size": 4, "command": "reset"},
            )
            self.assertEqual((response.status, await response.json()), (400, {"error": "invalid_arguments"}))
            session = await self.browser.get(path, headers=self.script)
            self.assertEqual((await session.json())["generation"], generation)

        read = asyncio.create_task(self.read("stub", stub_generation))
        self.assertEqual((await stub.receive_json(timeout=2))["command"], "flash.read")
        await stub.send_bytes(b"data")
        self.assertEqual(await (await read).read(), b"data")

    async def test_loader_switch_reports_failure_and_can_be_retried_on_the_same_session(self):
        agent = await self.browser.ws_connect("/agent?device=board", headers=self.local)
        console = {"mode": "console", "transport": "usb_serial_jtag"}
        await agent.send_json(console)
        generation = (await agent.receive_json(timeout=2))["generation"]

        async def command(name):
            request = asyncio.create_task(self.browser.post(
                "/api/v1/devices/board/command", headers=self.local,
                json={"generation": generation, "command": name},
            ))
            message = await agent.receive_json(timeout=2)
            self.assertEqual(message["command"], name)
            return request, message["id"]

        request, identifier = await command("mode.loader")
        await agent.send_json({"identity": console})
        self.assertEqual((await agent.receive_json(timeout=2))["identity"]["generation"], generation)
        detail = "Failed to connect with the device"
        await agent.send_json({"result": identifier, "error": "device_command_failed", "detail": detail})
        response = await request
        self.assertEqual((response.status, await response.json()),
                         (502, {"error": "device_command_failed", "detail": detail}))

        request, identifier = await command("mode.loader")
        await agent.send_json({"identity": {
            "mode": "loader", "loader": "stub", "chip": "esp32p4", "mac": "10:20:30:40:50:60",
            "transport": "usb_serial_jtag", "return_to_console": True, "flash_size": 32 * 1024 * 1024,
        }})
        self.assertIn("mode.console", (await agent.receive_json(timeout=2))["identity"]["capabilities"])
        await agent.send_json({"result": identifier})
        response = await request
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())["generation"], generation)

    async def test_uart_wait_wakes_on_data_and_disconnect(self):
        agent = await self.browser.ws_connect("/agent?device=board", headers=self.local)
        await agent.send_json({"mode": "console", "transport": "usb_serial_jtag"})
        generation = (await agent.receive_json(timeout=2))["generation"]
        path = "/api/v1/devices/board/uart"
        params = {"generation": generation, "cursor": "0", "wait_ms": "5000"}
        read = asyncio.create_task(self.browser.get(path, headers=self.local, params=params))
        await asyncio.wait({read}, timeout=0.02)
        self.assertFalse(read.done())
        await agent.send_json({"uart": "616263"})
        response = await asyncio.wait_for(read, timeout=1)
        self.assertEqual(await response.json(), {"hex": "616263", "cursor": 3, "dropped": 0})
        read = asyncio.create_task(self.browser.get(path, headers=self.local, params=params | {"cursor": "3"}))
        await asyncio.wait({read}, timeout=0.02)
        self.assertFalse(read.done())
        await agent.close()
        self.assertEqual((await asyncio.wait_for(read, timeout=1)).status, 404)

    async def test_loader_command_timeout_has_a_distinct_error(self):
        agent = await self.browser.ws_connect("/agent?device=board", headers=self.local)
        await agent.send_json({"mode": "console", "transport": "usb_serial_jtag"})
        generation = (await agent.receive_json(timeout=2))["generation"]
        request = asyncio.create_task(self.browser.post(
            "/api/v1/devices/board/command", headers=self.local,
            json={"generation": generation, "command": "mode.loader"},
        ))
        self.assertEqual((await agent.receive_json(timeout=2))["command"], "mode.loader")
        await agent.receive(timeout=2)
        response = await request
        self.assertEqual((response.status, await response.json()), (504, {"error": "device_command_timeout"}))

    async def test_operator_can_stop_a_local_read_and_reuse_the_connection(self):
        agent, generation = await self.board("board")
        read = asyncio.create_task(self.read("board", generation))
        command = await agent.receive_json(timeout=2)
        stop = await self.browser.post("/api/v1/devices/board/control/stop", headers=self.local)
        self.assertEqual(await stop.json(), {"control": "stopping"})
        self.assertEqual((await agent.receive_json(timeout=2))["control"], "stopping")
        self.assertEqual(await agent.receive_json(timeout=2), {"cancel": command["id"]})
        self.assertEqual((await self.read("board", generation)).status, 409)
        await agent.send_json({"result": command["id"], "error": "operation_cancelled",
                               "read_diagnostic": {"error": "serial_timeout"}})
        response = await read
        self.assertEqual((response.status, await response.json()), (409, {"error": "operation_cancelled"}))
        self.assertEqual((await agent.receive_json(timeout=2))["control"], "available")
        path = f"/api/v1/devices/board/activity?generation={generation}"
        stopped = (await (await self.browser.get(path, headers=self.local)).json())["operations"][0]
        self.assertEqual((stopped["state"], stopped["error"], stopped["bytesReceived"], stopped["bytesTransferred"]),
                         ("Échec", "operation_cancelled", None, 0))
        self.assertEqual(stopped["agentError"], "serial_timeout")
        retry = asyncio.create_task(self.read("board", generation))
        await agent.receive_json(timeout=2)
        await agent.send_bytes(b"data")
        self.assertEqual(await (await retry).read(), b"data")

    async def test_closed_control_keeps_reservation_until_terminal_agent_response(self):
        agent, generation = await self.board("board", port_key="00000000-0000-4000-8000-000000000001")
        base = "/api/v1/devices/board/control/"
        issued = await self.browser.post(base + "token", headers=self.local)
        token = (await issued.json())["token"]
        await agent.receive_json(timeout=2)
        headers = self.script | {"Authorization": "Bearer " + token}
        ws = await self.browser.ws_connect(base + "connect", headers=headers)
        session = (await ws.receive_json(timeout=2))["session"]
        await agent.receive_json(timeout=2)
        read = asyncio.create_task(self.read("board", generation,
                    headers=self.script | {"Authorization": "Bearer " + session}))
        command = await agent.receive_json(timeout=2)
        await ws.close()
        self.assertEqual((await agent.receive_json(timeout=2))["control"], "stopping")
        self.assertEqual(await agent.receive_json(timeout=2), {"cancel": command["id"]})
        with self.assertRaises(WSServerHandshakeError) as busy:
            await self.browser.ws_connect(base + "connect", headers=headers)
        self.assertEqual(busy.exception.status, 409)
        activity = await self.browser.get("/api/v1/devices/board/activity", headers=self.local,
                                          params={"generation": generation})
        record = (await activity.json())["operations"][0]
        self.assertEqual(record["state"], "En cours")
        self.assertIn("cancelRequestedAt", record)
        self.assertNotIn("termination", record)
        await agent.send_json({"result": command["id"], "error": "operation_cancelled",
                               "console_restored": True})
        response = await read
        self.assertEqual((response.status, await response.json()), (403, {"error": "control_stopped"}))

    async def test_timeout_history_does_not_claim_confirmed_termination(self):
        port_key = "00000000-0000-4000-8000-000000000002"
        agent, generation = await self.board("board", port_key=port_key)
        read = asyncio.create_task(self.read("board", generation))
        await agent.receive_json(timeout=2)
        self.assertEqual((await agent.receive(timeout=2)).type.name, "CLOSE")
        response = await read
        self.assertEqual(response.status, 504)
        fresh, new_generation = await self.board("board", port_key=port_key)
        activity = await self.browser.get("/api/v1/devices/board/activity", headers=self.local,
                                          params={"generation": new_generation})
        record = (await activity.json())["operations"][0]
        self.assertEqual(record["termination"], "unknown")
        self.assertTrue(record["recoveryRequired"])
        await fresh.close()

    async def test_exclusive_control_stops_and_reuses_token_then_revokes(self):
        agent, generation = await self.board("board")
        base = "/api/v1/devices/board/control/"
        issued = await self.browser.post(base + "token", headers=self.local)
        token = (await issued.json())["token"]
        self.assertTrue((await agent.receive_json(timeout=2))["has_token"])
        headers = self.script | {"Authorization": "Bearer " + token}
        ws = await self.browser.ws_connect(base + "connect", headers=headers)
        session = (await ws.receive_json(timeout=2))["session"]
        self.assertEqual((await agent.receive_json(timeout=2))["control"], "external")
        denied = await self.browser.post("/api/v1/devices/board/command", headers=self.local,
                                         json={"generation": generation, "command": "identify"})
        self.assertEqual((denied.status, await denied.json()), (409, {"error": "externally_controlled"}))
        with self.assertRaises(WSServerHandshakeError) as busy:
            await self.browser.ws_connect(base + "connect", headers=headers)
        self.assertEqual(busy.exception.status, 409)
        self.assertEqual((await self.read("board", generation)).status, 409)
        response = await self.browser.get("/api/v1/devices/board", headers=self.script)
        self.assertEqual((await response.json())["control"], "external")
        read = asyncio.create_task(self.read(
            "board", generation, headers=self.script | {"Authorization": "Bearer " + session},
        ))
        command = await agent.receive_json(timeout=2)
        stopping = asyncio.create_task(self.browser.post(base + "stop", headers=self.local))
        self.assertEqual((await agent.receive_json(timeout=2))["control"], "stopping")
        self.assertEqual((await agent.receive_json(timeout=2))["cancel"], command["id"])
        self.assertEqual((await self.read("board", generation)).status, 409)
        await ws.receive(timeout=2)
        await stopping
        await agent.send_bytes(b"abcd")
        response = await read
        self.assertEqual((response.status, await response.json()), (403, {"error": "control_stopped"}))
        self.assertEqual((await agent.receive_json(timeout=2))["control"], "available")
        ws = await self.browser.ws_connect(base + "connect", headers=headers)
        second = (await ws.receive_json(timeout=2))["session"]
        self.assertNotEqual(second, session)
        self.assertEqual((await agent.receive_json(timeout=2))["control"], "external")
        read = asyncio.create_task(self.read("board", generation, headers=self.script | {"Authorization": "Bearer " + second}))
        await agent.receive_json(timeout=2)
        await agent.send_bytes(b"data")
        self.assertEqual(await (await read).read(), b"data")
        activity = await self.browser.get("/api/v1/devices/board/activity", headers=self.script,
                                          params={"generation": generation})
        latest, previous = (await activity.json())["operations"]
        self.assertEqual((latest["source"], previous["source"]), ("api", "api"))
        self.assertNotEqual(latest["session_id"], previous["session_id"])
        revoked = asyncio.create_task(self.browser.post(base + "revoke", headers=self.local))
        await ws.receive(timeout=2)
        self.assertEqual((await revoked).status, 200)
        with self.assertRaises(WSServerHandshakeError) as caught:
            await self.browser.ws_connect(base + "connect", headers=headers)
        self.assertEqual(caught.exception.status, 403)

    async def test_api_activity_tracks_concurrent_clients_and_explicit_reads(self):
        a, ga = await self.board("a")
        b, gb = await self.board("b")
        issued = await self.browser.post("/api/v1/devices/b/control/token", headers=self.local)
        token = (await issued.json())["token"]
        await b.receive_json(timeout=2)
        control = await self.browser.ws_connect("/api/v1/devices/b/control/connect",
                                                headers=self.script | {"Authorization": f"Bearer {token}"})
        session = (await control.receive_json(timeout=2))["session"]
        await b.receive_json(timeout=2)
        stream = await self.browser.ws_connect("/api/v1/activity", headers=self.local)
        self.assertEqual(await stream.receive_json(timeout=2), {"active": False})
        read_a = asyncio.create_task(self.read("a", ga))
        await a.receive_json(timeout=2)
        self.assertEqual(await stream.receive_json(timeout=2), {"active": True})
        read_b = asyncio.create_task(self.read("b", gb, headers=self.script | {"Authorization": f"Bearer {session}"}))
        await b.receive_json(timeout=2)
        await a.send_bytes(b"aaaa")
        self.assertEqual(await (await read_a).read(), b"aaaa")
        # The oldest request completed while the other board is still busy.
        async with self.browser.ws_connect("/api/v1/activity", headers=self.local) as late_observer:
            self.assertEqual(await late_observer.receive_json(timeout=2), {"active": True})
        await b.send_bytes(b"bbbb")
        self.assertEqual(await (await read_b).read(), b"bbbb")
        self.assertEqual(await stream.receive_json(timeout=2), {"active": False})

        self.assertEqual((await self.browser.get("/api/v1/devices", headers=self.script)).status, 200)
        response = await self.browser.get("/api/v1/campaigns", headers=self.local | {"X-IDLab-Action": "1"})
        self.assertEqual(response.status, 200)
        self.assertEqual(await stream.receive_json(timeout=2), {"active": True})
        self.assertEqual(await stream.receive_json(timeout=2), {"active": False})
        await stream.close()
        await control.close()

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

    async def test_activity_and_large_flash_use_one_server_operation(self):
        ws = await self.browser.ws_connect("/agent?device=board", headers=self.local)
        await ws.send_json({"mode": "loader", "loader": "stub", "chip": "esp32s3",
                            "mac": "10:20:30:40:50:60", "transport": "usb_uart", "flash_size": 16777216,
                            "port_key": "00000000-0000-4000-8000-000000000001"})
        generation = (await ws.receive_json(timeout=2))["generation"]
        mib = 1024 * 1024
        size = 4 * mib + 1
        path = "/api/v1/devices/board/activity"

        async def activity():
            response = await self.browser.get(path, headers=self.script, params={"generation": generation})
            self.assertEqual(response.status, 200)
            return await response.json()

        read = asyncio.create_task(self.read("board", generation, size=size))
        command = await ws.receive_json(timeout=2)
        self.assertTrue(command["stream"])
        self.assertEqual(command["size"], size)
        self.assertEqual((await activity())["operations"][0]["id"], command["id"])
        await ws.send_json({"journal": "Transfert", "operation": command["id"]})
        await ws.send_json({"id": command["id"], "progress": {"address": 0, "received": 4 * mib, "total": size}})
        await ws.send_bytes(b"a" * (4 * mib))
        self.assertFalse(read.done())
        await ws.send_bytes(b"b")
        await ws.send_json({"result": command["id"], "value": 16777216})
        response = await read
        self.assertEqual(response.status, 200)
        self.assertEqual(await response.read(), b"a" * (4 * mib) + b"b")
        observed = await activity()
        self.assertEqual(observed["journal"][-1]["message"], "Transfert")
        self.assertEqual(observed["journal"][-1]["source"], "web")
        self.assertRegex(observed["journal"][-1]["session_id"], r"^[0-9a-f]{12}$")
        self.assertEqual(observed["journal"][-1]["session_id"], observed["operations"][0]["session_id"])
        self.assertIsNone(observed["progress"])
        self.assertEqual(len(observed["operations"]), 1)
        self.assertEqual(observed["operations"][0]["bytesRead"], size)
        self.assertEqual(observed["operations"][0]["bytesTransferred"], size)

    async def test_partial_read_preserves_agent_progress_and_original_error_after_console_recovery(self):
        port_key = "00000000-0000-4000-8000-000000000001"
        ws, generation = await self.board("board", port_key=port_key)
        start, size, received = 0x10000, 4 * 1024 * 1024 + 4096, 4 * 1024 * 1024 + 256
        read = asyncio.create_task(self.read("board", generation, address=start, size=size))
        command = await ws.receive_json(timeout=2)
        await ws.send_bytes(b"a" * (4 * 1024 * 1024))
        await ws.send_json({"id": command["id"], "progress": {
            "address": start, "received": received, "total": size, "baudrate": 115200,
        }})
        await ws.send_json({"identity": {"mode": "console", "transport": "usb_uart"}})
        await ws.receive_json(timeout=2)
        await ws.send_json({"result": command["id"], "error": "device_command_failed", "console_restored": True,
                            "read_diagnostic": {"error": "serial_timeout", "console_restored": True}})
        response = await read
        self.assertEqual((response.status, await response.json()), (502, {"error": "serial_timeout"}))
        activity = await self.browser.get(f"/api/v1/devices/board/activity?generation={generation}", headers=self.local)
        observed = await activity.json()
        operation = observed["operations"][0]
        self.assertEqual({field: operation[field] for field in (
            "state", "address", "size", "bytesReceived", "bytesTransferred", "lastOffset", "baudrate", "error", "consoleRestored", "source",
        )}, {"state": "Échec", "address": start, "size": size, "bytesReceived": received,
             "bytesTransferred": 4 * 1024 * 1024, "lastOffset": start + received, "baudrate": 115200,
             "error": "serial_timeout", "consoleRestored": True, "source": "web"})
        self.assertRegex(operation["duration"], r"^\d+ ms$")
        self.assertEqual(operation["session_id"], observed["journal"][-1]["session_id"])
        self.assertIn("serial_timeout", observed["journal"][-1]["message"])
        self.assertIsNone(observed["progress"])

    async def test_interrupted_read_history_survives_reconnect_of_same_connector(self):
        port_key = "00000000-0000-4000-8000-000000000001"
        for cause in ("flash_read_server_timeout", "agent_disconnected", "serial_timeout"):
            with self.subTest(cause=cause):
                ws, generation = await self.board("board", port_key=port_key)
                read = asyncio.create_task(self.read("board", generation, address=4096))
                command = await ws.receive_json(timeout=2)
                if cause == "agent_disconnected":
                    await ws.close()
                else:
                    await ws.send_json({"id": command["id"], "progress": {
                        "address": 4096, "received": 0, "total": 4, "baudrate": 115200,
                    }})
                    if cause == "serial_timeout":
                        await ws.send_json({"result": command["id"], "error": "device_command_failed",
                                            "read_diagnostic": {"error": cause, "console_restored": False,
                                                                "console_error": "serial_closed"}})
                    self.assertEqual((await ws.receive(timeout=2)).type.name, "CLOSE")
                response = await read
                self.assertEqual(response.status, 504 if cause == "flash_read_server_timeout" else 502)
                self.assertEqual((await response.json())["error"], cause)
                fresh, new_generation = await self.board("board", port_key=port_key)
                self.assertNotEqual(generation, new_generation)
                response = await self.browser.get(f"/api/v1/devices/board/activity?generation={new_generation}", headers=self.local)
                record = (await response.json())["operations"][0]
                self.assertEqual((record["state"], record["error"], record["bytesTransferred"]), ("Échec", cause, 0))
                if cause == "agent_disconnected":
                    self.assertIsNone(record["bytesReceived"])
                    self.assertIsNone(record["lastOffset"])
                else:
                    self.assertEqual((record["bytesReceived"], record["lastOffset"]), (0, 4096))
                self.assertIs(record["consoleRestored"], False if cause == "serial_timeout" else None)
                if cause == "serial_timeout":
                    self.assertEqual(record["consoleRecoveryError"], "serial_closed")
                if cause in ("flash_read_server_timeout", "agent_disconnected"):
                    blocked = await self.read("board", new_generation)
                    self.assertEqual((blocked.status, await blocked.json()),
                                     (409, {"error": "device_recovery_required"}))
                    recovered = await self.browser.post(
                        "/api/v1/devices/board/control/recover", headers=self.local,
                        json={"generation": new_generation, "confirmation": "board"})
                    self.assertEqual((recovered.status, await recovered.json()),
                                     (200, {"control": "available"}))
                    self.assertEqual((await fresh.receive_json(timeout=2))["control"], "available")
                await fresh.close()

    async def test_revocation_preserves_secondary_serial_error(self):
        port_key = "00000000-0000-4000-8000-000000000001"
        agent, generation = await self.board("board", port_key=port_key)
        base = "/api/v1/devices/board/control/"
        issued = await self.browser.post(base + "token", headers=self.local)
        token = (await issued.json())["token"]
        await agent.receive_json(timeout=2)
        control = await self.browser.ws_connect(base + "connect",
                    headers=self.script | {"Authorization": "Bearer " + token})
        session = (await control.receive_json(timeout=2))["session"]
        await agent.receive_json(timeout=2)
        read = asyncio.create_task(self.read("board", generation,
                    headers=self.script | {"Authorization": "Bearer " + session}))
        command = await agent.receive_json(timeout=2)
        revoke = asyncio.create_task(self.browser.post(base + "revoke", headers=self.local))
        await agent.receive_json(timeout=2)
        self.assertEqual((await agent.receive_json(timeout=2))["cancel"], command["id"])
        close = await control.receive(timeout=2)
        self.assertEqual((close.data, close.extra), (1008, "control_revoked"))
        self.assertEqual((await revoke).status, 200)
        await agent.send_json({"result": command["id"], "error": "operation_cancelled",
                               "read_diagnostic": {"error": "serial_timeout"}})
        response = await read
        self.assertEqual((response.status, await response.json()), (403, {"error": "control_revoked"}))
        fresh, new_generation = await self.board("board", port_key=port_key)
        activity = await self.browser.get("/api/v1/devices/board/activity",
                    headers=self.local, params={"generation": new_generation})
        record = (await activity.json())["operations"][0]
        self.assertEqual((record["error"], record["agentError"]), ("control_revoked", "serial_timeout"))
        await fresh.close()

    async def test_nonstream_error_status_survives_recovery(self):
        for code, status in (("device_session_changed", 409), ("operation_unsupported", 409),
                             ("invalid_flash_range", 400), ("serial_timeout", 502),
                             ("unrecognized_internal_message", 502)):
            with self.subTest(code=code):
                agent, generation = await self.board("board")
                read = asyncio.create_task(self.read("board", generation))
                command = await agent.receive_json(timeout=2)
                self.assertNotIn("stream", command)
                await agent.send_json({"result": command["id"], "error": code})
                response = await read
                expected = "read_incomplete_reconnect_required" if code.startswith("unrecognized") else code
                self.assertEqual((response.status, await response.json()), (status, {"error": expected}))
                self.assertEqual((await agent.receive(timeout=2)).type.name, "CLOSE")

    async def test_short_read_invalidates_session(self):
        port_key = "00000000-0000-4000-8000-000000000001"
        ws, generation = await self.board("board", port_key=port_key)
        read = asyncio.create_task(self.read("board", generation))
        command = await ws.receive_json()
        await ws.send_bytes(b"abc")
        await ws.send_json({"result": command["id"], "value": 16 * 1024 * 1024})
        response = await read
        self.assertEqual(response.status, 502)
        self.assertEqual((await response.json())["error"], "read_incomplete_reconnect_required")
        new, new_generation = await self.board("board", port_key=port_key)
        activity = await self.browser.get("/api/v1/devices/board/activity", headers=self.local,
                                          params={"generation": new_generation})
        self.assertEqual((await activity.json())["operations"][0]["error"],
                         "read_incomplete_reconnect_required")
        self.assertNotEqual(generation, new_generation)
        self.assertEqual((await self.read("board", generation)).status, 409)
        await new.close()

    async def test_timeout_invalidates_session_without_replay(self):
        ws, generation = await self.board("board")
        read = asyncio.create_task(self.read("board", generation))
        await ws.receive_json()
        reply = await ws.receive(timeout=2)
        self.assertEqual(reply.type.name, "CLOSE")
        response = await read
        self.assertEqual((response.status, await response.json()), (504, {"error": "flash_read_server_timeout"}))
        self.assertEqual((await self.read("board", generation)).status, 409)

    async def test_rom_range_and_origin_refused(self):
        _, rom = await self.board("rom", loader="rom")
        _, stub = await self.board("stub")
        self.assertEqual((await self.read("rom", rom)).status, 409)
        self.assertEqual((await self.read("stub", stub, address=-1)).status, 400)
        foreign = dict(self.local, Origin="http://example.test")
        self.assertEqual((await self.read("stub", stub, headers=foreign)).status, 403)
        self.assertEqual((await self.read("stub", stub, headers={"Host": self.local["Host"]})).status, 401)

    async def start_campaign(self):
        response = await self.browser.post("/api/v1/campaigns", headers=self.script, json={"name": "Readback"})
        self.assertEqual(response.status, 201)
        campaign = await response.json()
        self.assertEqual(response.headers["Location"], "/api/v1/campaigns/" + campaign["id"])
        return campaign

    async def test_abort_blocks_new_reads_but_drains_in_flight_reads(self):
        a, ga = await self.board("a")
        _, gb = await self.board("b")
        created = await self.browser.post("/api/v1/campaigns", headers=self.local, json={"name": "Readback"})
        self.assertEqual(created.status, 201)
        campaign = await created.json()
        campaign_id = campaign["id"]
        base = f"/api/v1/campaigns/{campaign_id}"

        def read(name, generation):
            return self.browser.post(
                f"/api/v1/devices/{name}/flash/read", headers=self.local,
                json={"generation": generation, "address": 0, "size": 4, "campaign_id": campaign_id},
            )

        active = asyncio.create_task(read("a", ga))
        await a.receive_json(timeout=2)
        finish = await self.browser.post(base + "/finish", headers=self.local, json={"verdict": "PASS"})
        self.assertEqual((finish.status, await finish.json()), (409, {"error": "campaign_busy"}))
        abort = await self.browser.post(base + "/abort", headers=self.local, json={"reason": "operator stop"})
        self.assertEqual(abort.status, 202)
        self.assertEqual((await abort.json())["state"], "abort_requested")

        blocked = await read("b", gb)
        self.assertEqual((blocked.status, await blocked.json()), (409, {"error": "campaign_not_active"}))
        await a.send_bytes(b"data")
        self.assertEqual(await (await active).read(), b"data")

        response = await self.browser.get(base, headers=self.local)
        final = await response.json()
        self.assertEqual((final["state"], final["in_flight"], final["reason"]), ("aborted", 0, "operator stop"))
        self.assertIsNotNone(final["ended_at"])
        self.assertIsNone(final["verdict"])

    async def test_finish_is_idempotent_and_preserves_verdict(self):
        campaign = await self.start_campaign()
        path = "/api/v1/campaigns/" + campaign["id"] + "/finish"
        verdict = {"verdict": "INDETERMINATE"}
        first = await self.browser.post(path, headers=self.script, json=verdict)
        self.assertEqual(first.status, 200)
        finished = await first.json()
        self.assertEqual((finished["state"], finished["verdict"]), ("finished", "INDETERMINATE"))
        again = await self.browser.post(path, headers=self.script, json=verdict)
        self.assertEqual(await again.json(), finished)
        conflict = await self.browser.post(path, headers=self.script, json={"verdict": "PASS"})
        self.assertEqual(conflict.status, 409)

    async def test_campaign_search_filters_and_paginates(self):
        path = "/api/v1/campaigns"
        names = ["Étalonnage flash", "OTA S3", "OTA C6", "Diagnostic UART"]
        ids = []
        for name in names:
            response = await self.browser.post(path, headers=self.script, json={"name": name})
            self.assertEqual(response.status, 201)
            ids.append((await response.json())["id"])
        await self.browser.post(path + "/" + ids[1] + "/finish", headers=self.script, json={"verdict": "PASS"})
        await self.browser.post(path + "/" + ids[2] + "/finish", headers=self.script, json={"verdict": "FAIL"})
        await self.browser.post(path + "/" + ids[3] + "/abort", headers=self.script, json={"reason": "operator"})

        async def search(params):
            response = await self.browser.get(path, headers=self.script, params=params)
            self.assertEqual(response.status, 200)
            return await response.json()

        result = await search([("state", "finished"), ("state", "aborted"), ("limit", "2")])
        self.assertEqual(result["total"], 3)
        self.assertEqual(result["counts"], {"active": 0, "abort_requested": 0, "aborted": 1, "finished": 2})
        self.assertEqual(len(result["items"]), 2)
        tail = await search([("state", "finished"), ("state", "aborted"), ("limit", "2"), ("offset", "2")])
        combined = result["items"] + tail["items"]
        self.assertEqual({item["id"] for item in combined}, set(ids[1:]))
        self.assertEqual(combined, sorted(combined, key=lambda c: (c["started_at"], c["id"]), reverse=True))

        match = await search({"q": "oTa", "verdict": "PASS"})
        self.assertEqual([item["id"] for item in match["items"]], [ids[1]])
        match = await search({"q": "ÉTALONNAGE"})
        self.assertEqual([item["id"] for item in match["items"]], [ids[0]])
        started = match["items"][0]["started_at"][:10]
        self.assertEqual((await search({"q": ids[0][:12], "from": started, "to": started}))["total"], 1)
        self.assertEqual((await search({"to": "2000-01-01"}))["total"], 0)

    async def test_campaign_search_rejects_invalid_filters(self):
        for filters in (
            {"state": "unknown"}, {"limit": "0"}, {"limit": "101"}, {"offset": "-1"},
            {"from": "2026-02-29"}, {"from": "2026-12-01", "to": "2026-11-24"},
            [("q", "one"), ("q", "two")], {"unknown": "value"},
        ):
            response = await self.browser.get("/api/v1/campaigns", headers=self.script, params=filters)
            self.assertEqual((response.status, await response.json()), (400, {"error": "invalid_campaign_filters"}))

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
        for module in ("app", "boot-identity", "campaign-view", "console-buffer", "partitions",
                       "console-view", "control-help", "dom", "operations-view", "rom-dialog", "workbench-shell",
                       "board-connector", "esp-driver", "serial-console", "serial-transport"):
            with self.subTest(module=module):
                async with self.browser.get(f"/web/{module}.js", headers=self.local) as response:
                    self.assertEqual(response.status, 200)
                    self.assertIn("javascript", response.content_type)
        async with self.browser.get("/esptool.js", headers=self.local) as response:
            self.assertEqual(response.status, 200)
            self.assertIn("javascript", response.content_type)
        async with self.browser.get("/web/server.py", headers=self.local) as response:
            self.assertEqual(response.status, 404)
