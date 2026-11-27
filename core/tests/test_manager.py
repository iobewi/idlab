import asyncio
import base64
import hashlib
from pathlib import Path
import os
import socket
import tempfile
import unittest
from unittest.mock import patch

from aiohttp import CookieJar, web
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
            TestServer(create_app(token="test-token", service=self.service), handler_cancellation=True),
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
        self.assertEqual((await self.client.post("/api/v1/web/session", headers=browser_headers)).status, 204)
        created = await self.client.post(
            "/api/v1/campaigns", headers=browser_headers,
            json={"name": "Readback", "metadata": {"scenario": "backup"}},
        )
        self.assertEqual(created.status, 201)
        campaign = await created.json()
        activity = await self.client.ws_connect("/api/v1/activity", headers=browser_headers)
        self.assertEqual(await activity.receive_json(timeout=2), {"active": False})
        agent = await self.client.ws_connect("/agent?device=board", headers=browser_headers)
        await agent.send_json({
            "chip": "esp32s3", "mac": "10:20:30:40:50:60", "loader": "stub",
            "transport": "usb_uart", "flash_size": 16 * 1024 * 1024,
            "mode": "loader", "port_key": "00000000-0000-4000-8000-000000000001", "programmable": True,
        })
        generation = (await agent.receive_json(timeout=2))["generation"]
        chunk = b"a" * (4 * 1024 * 1024)
        read = asyncio.create_task(self.client.post(
            "/api/v1/devices/board/flash/read", headers=browser_headers,
            json={"generation": generation, "address": 0, "size": len(chunk) + 4, "campaign_id": campaign["id"]},
        ))
        command = await agent.receive_json(timeout=2)
        self.assertEqual(await activity.receive_json(timeout=2), {"active": True})
        self.assertEqual(command["command"], "flash.read")
        self.assertTrue(command["stream"])
        await agent.send_bytes(chunk)
        await agent.send_bytes(b"data")
        await agent.send_json({"result": command["id"], "value": 16 * 1024 * 1024})
        response = await asyncio.wait_for(read, timeout=2)
        self.assertEqual(await response.read(), chunk + b"data")
        self.assertEqual(await activity.receive_json(timeout=2), {"active": False})
        await activity.close()
        first = self.service.process

        binary = b"firmware" * 1024
        image = {"address": 0x10000, "size": len(binary), "sha256": hashlib.sha256(binary).hexdigest()}
        flash = "/api/v1/devices/board/flash"
        validated = await self.client.post(flash + "/plan", headers=browser_headers,
                                           json={"generation": generation, "images": [image]})
        self.assertEqual(validated.status, 201)
        plan = await validated.json()
        program = asyncio.create_task(self.client.post(
            flash + "/program", headers=browser_headers,
            json={"generation": generation, "plan_id": plan["plan_id"],
                  "binaries": [base64.b64encode(binary).decode("ascii")]},
        ))
        command = await agent.receive_json(timeout=2)
        self.assertEqual(command["command"], "flash.program")
        payload = await self.client.get(f"{flash}/program/{command['id']}/0", headers=browser_headers)
        self.assertEqual(await payload.read(), binary)
        await agent.send_json({"result": command["id"], "value": [image["sha256"]]})
        response = await asyncio.wait_for(program, timeout=2)
        self.assertEqual(response.status, 200)
        self.assertTrue((await response.json())["verification"][0]["matches"])

        issued = await self.client.post("/api/v1/devices/board/control/token", headers=browser_headers)
        self.assertEqual(issued.status, 200)
        token = (await issued.json())["token"]
        self.assertTrue((await agent.receive_json(timeout=2))["has_token"])
        path = "/api/v1/devices/board/control/connect"
        denied = await self.client.get(path, headers=self.web | {
            "Authorization": "Bearer invalid", "Upgrade": "websocket",
        })
        self.assertEqual((denied.status, await denied.json()), (403, {"error": "invalid_control_token"}))
        async with self.client.ws_connect(
            "/api/v1/devices/board/control/connect",
            headers=self.web | {"Authorization": "Bearer " + token},
        ) as control:
            self.assertTrue((await control.receive_json(timeout=2))["session"])
            self.assertEqual((await agent.receive_json(timeout=2))["control"], "external")
            denied = await self.client.get(path, headers=self.web | {
                "Authorization": "Bearer " + token, "Upgrade": "websocket",
            })
            self.assertEqual((denied.status, await denied.json()), (409, {"error": "device_busy"}))
        self.assertEqual((await agent.receive_json(timeout=2))["control"], "available")

        self.assertEqual((await self.request("POST", "start")).status, 200)
        self.assertIs(first, self.service.process)
        self.assertEqual((await self.request("POST", "restart")).status, 200)
        self.assertIsNotNone(first.returncode)
        self.assertIsNot(first, self.service.process)
        await self.wait_ready()
        self.assertEqual((await agent.receive(timeout=2)).type.name, "CLOSE")
        # The browser keeps its campaign scope across a server restart.
        await self.client.get("/", headers=self.web)
        retained = await self.client.get("/api/v1/campaigns/" + campaign["id"], headers=browser_headers)
        self.assertEqual(await retained.json(), campaign)
        operations = await self.client.get("/api/v1/campaigns/" + campaign["id"] + "/operations", headers=browser_headers)
        history = await operations.json()
        self.assertEqual(history["total"], 1)
        self.assertEqual(history["items"][0]["bytesRead"], len(chunk) + 4)

        self.assertEqual((await self.request("POST", "stop")).status, 200)
        self.assertEqual((await self.client.get("/health", headers=self.web)).status, 503)
        response = await self.request("GET", "status")
        self.assertEqual(await response.json(), {"state": "stopped", "ready": False})
        self.assertEqual((await self.request("POST", "start")).status, 200)
        await self.wait_ready()
        final = self.service.process
        await self.client.close()
        self.assertIsNotNone(final.returncode)

    @unittest.skipUnless(
        (Path(__file__).resolve().parents[1] / "node_modules/esptool-js/bundle.js").is_file(),
        "npm ci --prefix core required",
    )
    async def test_abandoned_http_read_cancels_through_manager(self):
        self.assertEqual((await self.request("POST", "start")).status, 200)
        await self.wait_ready()
        headers = self.web | {"Origin": "http://127.0.0.1:8080"}
        self.assertEqual((await self.client.post("/api/v1/web/session", headers=headers)).status, 204)
        agent = await self.client.ws_connect("/agent?device=board", headers=headers)
        await agent.send_json({"chip": "esp32s3", "mac": "10:20:30:40:50:60",
                               "loader": "stub", "transport": "usb_uart", "flash_size": 16 * 1024 * 1024,
                               "port_key": "00000000-0000-4000-8000-000000000001"})
        generation = (await agent.receive_json(timeout=2))["generation"]
        path = "/api/v1/devices/board"
        payload = {"generation": generation, "address": 0, "size": 4}
        request = asyncio.create_task(self.client.post(path + "/flash/read", headers=headers, json=payload))
        command = await agent.receive_json(timeout=2)
        request.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await request
        self.assertEqual((await agent.receive_json(timeout=2))["control"], "stopping")
        self.assertEqual(await agent.receive_json(timeout=2), {"cancel": command["id"]})
        blocked = await self.client.post(path + "/flash/read", headers=headers, json=payload)
        self.assertEqual(blocked.status, 409)
        await agent.send_json({"result": command["id"], "error": "operation_cancelled",
                               "console_restored": True})
        self.assertEqual((await agent.receive_json(timeout=2))["control"], "available")
        retry = asyncio.create_task(self.client.post(path + "/flash/read", headers=headers, json=payload))
        command = await agent.receive_json(timeout=2)
        await agent.send_bytes(b"data")
        await agent.send_json({"result": command["id"], "value": 16 * 1024 * 1024})
        self.assertEqual(await (await retry).read(), b"data")
        await agent.close()

    async def test_proxy_preserves_destructive_http_diagnostic(self):
        payload = {"error": "serial_timeout", "operation": {"flashState": "indeterminate",
                   "verification": [{"preview": "ab" * 256}] * 16}}
        async def upstream(request):
            return web.json_response(payload, status=502, headers={"X-IDLab-Error": "serial_timeout"})
        app = web.Application()
        app.router.add_post("/api/v1/devices/board/flash/program", upstream)
        backend = TestServer(app)
        await backend.start_server()
        self.addAsyncCleanup(backend.close)
        self.service.port = backend.port
        class Running:
            returncode = None
        self.service.process = Running()
        try:
            response = await self.client.post("/api/v1/devices/board/flash/program", headers=self.web, json={})
            self.assertEqual(response.status, 502)
            self.assertEqual(response.headers.get("X-IDLab-Error"), "serial_timeout")
            self.assertEqual(await response.json(), payload)
        finally:
            self.service.process = None

    async def test_proxy_preserves_handshake_status_and_close_reason(self):
        async def upstream(request):
            code = request.query.get("code")
            if "status" in request.query:
                status = int(request.query["status"])
                return web.json_response({"error": code}, status=status,
                                         headers={"X-IDLab-Error": code} if code else {})
            socket = web.WebSocketResponse()
            await socket.prepare(request)
            await socket.close(code=1008, message=b"control_revoked")
            return socket

        app = web.Application()
        app.router.add_get("/agent", upstream)
        backend = TestServer(app)
        await backend.start_server()
        self.addAsyncCleanup(backend.close)
        self.service.port = backend.port
        # A simulated running child; no real process or hardware is involved.
        class Running:
            returncode = None
        self.service.process = Running()
        self.addCleanup(setattr, self.service, "process", None)
        try:
            for status, code in [(403, "control_token_device_mismatch"),
                                 (404, "device_disconnected"),
                                 (409, "device_busy"),
                                 (503, "idlab_http_unavailable")]:
                response = await self.client.get(
                    "/agent", params={"status": status, "code": code},
                    headers=self.web | {"Upgrade": "websocket"},
                )
                self.assertEqual((response.status, await response.json()), (status, {"error": code}))
            for code in ("", "invalid header", "secret=value"):
                response = await self.client.get(
                    "/agent", params={"status": 403, "code": code},
                    headers=self.web | {"Upgrade": "websocket"},
                )
                self.assertEqual((response.status, await response.json()),
                                 (403, {"error": "agent_connection_refused"}))
            socket = await self.client.ws_connect("/agent", headers=self.web)
            message = await socket.receive(timeout=2)
            self.assertEqual((message.type.name, message.data, message.extra),
                             ("CLOSE", 1008, "control_revoked"))
            await socket.close()
            await backend.close()
            response = await self.client.get("/agent", headers=self.web | {"Upgrade": "websocket"})
            self.assertEqual((response.status, await response.json()), (503, {"error": "idlab_http_unavailable"}))
        finally:
            self.service.process = None

    async def test_refuses_untrusted_or_unexpected_requests(self):
        for method, path, kwargs, status in [
            ("POST", "start", {"headers": {"Authorization": "Bearer wrong"}}, 401),
            ("POST", "stop", {"headers": {"Origin": "http://127.0.0.1:8080"}}, 403),
            ("GET", "status", {"headers": {"Host": "other.test"}}, 200),
            ("POST", "start", {"json": {"service": "another"}}, 400),
            ("GET", "restart", {}, 405),
            ("POST", "remove", {}, 404),
        ]:
            self.assertEqual((await self.request(method, path, **kwargs)).status, status)
        self.assertIsNone(self.service.process)
