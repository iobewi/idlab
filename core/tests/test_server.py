import asyncio
import os
from pathlib import Path
from unittest.mock import patch
import unittest

from aiohttp import CookieJar, WSServerHandshakeError
from aiohttp.test_utils import TestClient, TestServer

from server import create_app, validate_identity


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
            f"/api/v1/devices/{name}/flash/read", headers=headers or self.local,
            json={"generation": generation, "address": address, "size": size},
        )

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
        self.assertNotEqual((await ws.receive_json(timeout=2))["session"], session)
        revoked = asyncio.create_task(self.browser.post(base + "revoke", headers=self.local))
        await ws.receive(timeout=2)
        self.assertEqual((await revoked).status, 200)
        with self.assertRaises(WSServerHandshakeError) as caught:
            await self.browser.ws_connect(base + "connect", headers=headers)
        self.assertEqual(caught.exception.status, 403)

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

    async def start_campaign(self):
        response = await self.browser.post("/api/v1/campaigns", headers=self.script, json={"name": "Readback"})
        self.assertEqual(response.status, 201)
        campaign = await response.json()
        self.assertEqual(response.headers["Location"], "/api/v1/campaigns/" + campaign["id"])
        return campaign

    async def test_abort_blocks_new_reads_but_drains_in_flight_reads(self):
        a, ga = await self.board("a")
        _, gb = await self.board("b")
        campaign = await self.start_campaign()
        campaign_id = campaign["id"]
        base = f"/api/v1/campaigns/{campaign_id}"

        def read(name, generation):
            return self.browser.post(
                f"/api/v1/devices/{name}/flash/read", headers=self.local,
                json={"generation": generation, "address": 0, "size": 4, "campaign_id": campaign_id},
            )

        active = asyncio.create_task(read("a", ga))
        await a.receive_json(timeout=2)
        finish = await self.browser.post(base + "/finish", headers=self.script, json={"verdict": "PASS"})
        self.assertEqual((finish.status, await finish.json()), (409, {"error": "campaign_busy"}))
        abort = await self.browser.post(base + "/abort", headers=self.script, json={"reason": "operator stop"})
        self.assertEqual(abort.status, 202)
        self.assertEqual((await abort.json())["state"], "abort_requested")

        blocked = await read("b", gb)
        self.assertEqual((blocked.status, await blocked.json()), (409, {"error": "campaign_not_active"}))
        await a.send_bytes(b"data")
        self.assertEqual(await (await active).read(), b"data")

        response = await self.browser.get(base, headers=self.script)
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
        for path in ("/web/app.js", "/esptool.js"):
            response = await self.browser.get(path, headers=self.local)
            self.assertEqual(response.status, 200)
            self.assertIn("javascript", response.content_type)
