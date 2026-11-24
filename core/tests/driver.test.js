import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionPlan, EspDriver } from '../web/esp-driver.js';
import { serialTransport } from '../web/serial-transport.js';
import * as upstream from '../node_modules/esptool-js/bundle.js';

test('transport and loader choices are independent', () => {
  const uart = { usbVendorId: 0x10c4, usbProductId: 0xea60 };
  const jtag = { usbVendorId: 0x303a, usbProductId: 0x1001 };
  assert.deepEqual(connectionPlan(uart, {}), { transport: 'usb_uart', entry: 'default_reset', useStub: true });
  assert.deepEqual(connectionPlan(jtag, { romOnly: true }), { transport: 'usb_serial_jtag', entry: 'no_reset', useStub: false });
  assert.equal(connectionPlan(uart, { manualEntry: true }).entry, 'no_reset');
  assert.equal(connectionPlan({}, {}).entry, 'no_reset');
});

test('packs split serial chunks without dropping a buffered packet', async () => {
  const Transport = serialTransport(upstream.Transport, upstream.ESPError);
  const transport = new Transport({});
  const read = transport.read(100);
  transport.buffer = Uint8Array.of(0xc0, 17, 0xdb);
  await Promise.resolve();
  transport.buffer = Uint8Array.of(0xdc, 0xc0, 0xc0, 26, 0xc0);
  assert.deepEqual(await read, Uint8Array.of(17, 0xc0));
  assert.deepEqual(await transport.read(100), Uint8Array.of(26));
});

test('ROM identifies without launching a stub; production reads use one reader', async () => {
  const port = { getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 18 }) };
  class FakeLoader {
    chip = {
      CHIP_NAME: 'ESP32-P4',
      readMac: async () => '10:20:30:40:50:60',
      postConnect: async () => {},
    };
    async detectChip(entry) { assert.equal(entry, 'no_reset'); }
    async usesUsbOtg() { return true; }
    async runStub() { this.IS_STUB = true; }
    async readFlashId() { return 0x1940c8; }
    async readFlash(address, size, check) {
      check();
      return new Uint8Array(size).fill(address ? 2 : 1);
    }
  }

  const dependencies = { ...upstream, ESPLoader: FakeLoader };
  const rom = new EspDriver(port, dependencies);
  const identity = await rom.connect({ romOnly: true });
  assert.equal(identity.loader, 'rom');
  assert.equal(identity.flash_size, null);
  await assert.rejects(rom.readFlash(0, 1, () => {}), /operation_unsupported/);

  const stub = new EspDriver(port, dependencies);
  const loaded = await stub.connect({});
  assert.equal(loaded.loader, 'stub');
  assert.equal(loaded.transport, 'usb_otg');
  const bytes = await stub.readFlash(0, 1048577, () => {});
  assert.equal(bytes[0], 1);
  assert.equal(bytes.at(-1), 2);
  await assert.rejects(stub.readFlash(0, 1, () => { throw new Error('closed'); }), /closed/);
});

test('automatic connection uses an already responding downloader without reset', async () => {
  class FakeLoader {
    chip = {
      CHIP_NAME: 'ESP32-S3',
      readMac: async () => '10:20:30:40:50:60',
      getChipDescription: async () => 'ESP32-S3 (revision v0.2)',
    };
    async openAndSync(mode, attempts) {
      assert.equal(mode, 'no_reset');
      assert.equal(attempts, 1);
    }
    async detectChip(...args) { await this.openAndSync(...args); }
    async runStub() { this.IS_STUB = true; }
    async readFlashId() { return 0x184068; }
  }

  const port = {getInfo: () => ({usbVendorId: 0x303a, usbProductId: 0x1001})};
  const driver = new EspDriver(port, {...upstream, ESPLoader: FakeLoader});
  assert.deepEqual(await driver.connect({auto: true}), {
    chip: 'esp32s3', model: 'ESP32-S3 (revision v0.2)', mac: '10:20:30:40:50:60',
    flash_size: 16 * 1024 * 1024, flash_id: 0x184068,
    transport: 'usb_serial_jtag', usb_vid: 0x303a, usb_pid: 0x1001, loader: 'stub',
  });
});

test('automatic connection falls back only when no downloader answered', async () => {
  class NoAnswer {
    async openAndSync() { throw new Error('Failed to connect with the device'); }
    async detectChip(...args) { await this.openAndSync(...args); }
  }
  class FailingIdentification extends NoAnswer {
    async openAndSync() {}
    async detectChip(...args) {
      await this.openAndSync(...args);
      throw new Error('Failed to connect with the device');
    }
  }
  const port = {getInfo: () => ({}), readable: {}, writable: {}};
  const silent = new EspDriver(port, {...upstream, ESPLoader: NoAnswer});
  assert.equal(await silent.connect({auto: true}), null);
  const known = new EspDriver(port, {...upstream, ESPLoader: FailingIdentification});
  await assert.rejects(known.connect({auto: true}), /Failed to connect/);
});

test('transport can read again after esptool reopens it for identification', async () => {
  class FakeTransport extends upstream.Transport {
    async connect() {}
    async disconnect() {}
  }
  const Transport = serialTransport(FakeTransport, upstream.ESPError);
  const transport = new Transport({});
  await transport.connect();
  await transport.disconnect();
  await assert.rejects(transport.read(100), /serial_closed/);
  await transport.connect();
  transport.buffer = Uint8Array.of(0xc0, 42, 0xc0);
  assert.deepEqual(await transport.read(100), Uint8Array.of(42));
});
