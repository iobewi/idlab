import assert from 'node:assert/strict';
import test from 'node:test';
import * as upstream from '../node_modules/esptool-js/bundle.js';
import {BoardConnector} from '../web/board-connector.js';

function fixture({ vid = 0x10c4, failRead = false, inDownload = false, flashBaud, failBaud = false,
  readBlock, shortResponseAt } = {}) {
  const events = [];
  const reads = [];
  let identity, socket, responseBytes;
  let deviceBaud = 115200;
  const bytes = Uint8Array.of(0, 255, 13);
  const port = {getInfo: () => ({usbVendorId: vid})};
  class Loader {
    ESP_CHANGE_BAUDRATE = 0x0f;
    chip = {
      CHIP_NAME: 'ESP32-S3',
      readMac: async () => '10:20:30:40:50:60',
      getChipDescription: async () => 'ESP32-S3',
    };
    constructor({transport, romBaudrate}) {
      this.transport = transport;
      this.initialBaud = romBaudrate;
    }
    async detectChip(entry, attempts) {
      events.push('detect:' + entry);
      port.readable = {};
      port.writable = {};
      this.transport.baudrate = this.initialBaud;
      if (attempts === 1 && (!inDownload || this.initialBaud !== deviceBaud)) {
        throw new Error('Failed to connect with the device');
      }
    }
    async runStub() { this.IS_STUB = true; }
    async checkCommand(_description, opcode, data) {
      assert.equal(opcode, 0x0f);
      const payload = new DataView(data.buffer);
      assert.equal(payload.getUint32(4, true), deviceBaud);
      deviceBaud = payload.getUint32(0, true);
      events.push('baud:' + deviceBaud);
    }
    async isResponsive() { return !failBaud && this.transport.baudrate === deviceBaud; }
    async readFlashId() { return 0x184068; }
    async readFlash(address, size, check) {
      check();
      if (failRead) throw new Error('error during read');
      if (readBlock) return readBlock(address, size);
      assert.equal(size, bytes.length);
      return bytes;
    }
    async openAndSync() {}
    async usesUsbOtg() { return vid === 0x303a; }
  }
  const card = new BoardConnector('board', port, {
    flashBaud, onChange() {}, onCapture() {}, onJournal() {},
  }, {
    origin: 'http://127.0.0.1:8080/',
    loadTools: async () => ({
      ...upstream,
      ESPLoader: Loader,
      Transport: class extends upstream.Transport {
        async disconnect() { events.push('close-loader'); port.readable = port.writable = null; }
        async changeBaudrate(value) { this.baudrate = value; }
        async drainInput() {}
      },
    }),
    async openConsole(_port, _baud, _text, onBytes) {
      assert.equal(port.readable, null);
      assert.equal(_baud, 115200);
      events.push('console');
      onBytes(new TextEncoder().encode('READY\n'));
      const done = Promise.withResolvers();
      return { done: done.promise, async close() { events.push('close-console'); done.resolve(); } };
    },
    async reset() { events.push('reset'); },
    createSocket() {
      socket = {
        readyState: 1,
        send(message) {
          if (message === 'request') return;
          if (typeof message !== 'string') {
            responseBytes = message;
            return;
          }
          identity = {...JSON.parse(message), generation: 'generation', capabilities: ['identify', 'flash.read']};
          if (identity.loader === 'rom') identity.capabilities = ['identify'];
          queueMicrotask(() => socket.onmessage({data: '{"generation":"generation"}'}));
        },
        close() { socket.readyState = 3; socket.onclose(); },
      };
      queueMicrotask(() => socket.onopen());
      return socket;
    },
    async request(path, options) {
      if (!options) {
        if (socket.readyState === 3) throw new Error('device_disconnected');
        return {json: async () => identity};
      }
      assert.equal(path, '/devices/board/flash/read');
      const {generation, address, size} = JSON.parse(options.body);
      assert.equal(generation, 'generation');
      reads.push({generation, address, size});
      responseBytes = null;
      await socket.onmessage({data: JSON.stringify({address, size, command: 'flash.read', id: 'request'})});
      if (failRead) {
        socket.close();
        throw new Error('read_incomplete_reconnect_required');
      }
      assert.equal(responseBytes?.byteLength, size);
      const data = address === shortResponseAt ? responseBytes.subarray(0, 1) : responseBytes;
      return {blob: async () => new Blob([data])};
    },
  });
  port.readable = null;
  return {card, events, reads, manualReset() { inDownload = false; deviceBaud = 115200; }};
}

test('identification and flash reads from console restore the same console and retain identity', async () => {
  const {card, events} = fixture();
  await card.connect();
  assert.equal(card.mode, 'console');
  assert.equal(card.canEnterLoader, true);
  assert.equal((await card.identify()).mac, '10:20:30:40:50:60');
  assert.equal(card.mode, 'console');
  assert.equal(card.lastIdentity.flash_id, 0x184068);
  assert.equal(card.identity, null);
  const result = await card.readFlash(0x8000, 3);
  assert.equal(result.capacity, 16 * 1024 * 1024);
  assert.deepEqual([...new Uint8Array(await result.blob.arrayBuffer())], [0, 255, 13]);
  assert.equal(card.mode, 'console');
  assert.deepEqual(events, ['detect:no_reset', 'close-loader', 'console', 'close-console', 'detect:default_reset', 'close-loader', 'console', 'reset',
    'close-console', 'detect:default_reset', 'close-loader', 'console', 'reset']);
  assert.equal(new TextDecoder().decode(card.capture.bytes()), 'READY\nREADY\nREADY\n');
  await card.disconnect();
  assert.equal(card.lastIdentity, null);
});

test('an automatically detected loader stays in download mode through reads and rejects software restart', async () => {
  const {card, events, manualReset} = fixture({inDownload: true});
  await card.connect();
  await card.identify();
  await card.readFlash(0, 3);
  assert.equal(card.mode, 'loader');
  assert.equal(card.consoleUnavailable, true);
  assert.equal(card.canResetIntoRom, false);
  await assert.rejects(card.restart(), /Reset indisponible/);
  assert.deepEqual(events, ['detect:no_reset']);
  await card.disconnect();
  await card.connect();
  assert.equal(card.mode, 'loader');
  await card.disconnect();
  manualReset();
  await card.connect();
  assert.equal(card.mode, 'console');
  assert.equal(card.consoleUnavailable, false);
  assert.deepEqual(events, ['detect:no_reset', 'close-loader', 'detect:no_reset',
    'close-loader', 'detect:no_reset', 'close-loader', 'console']);
  await card.disconnect();
});

test('a failed flash read restores console without retrying the read', async () => {
  const {card, events} = fixture({failRead: true});
  await card.connect();
  await assert.rejects(card.readFlash(0, 3), /read_incomplete/);
  assert.equal(card.mode, 'console');
  assert.deepEqual(events, ['detect:no_reset', 'close-loader', 'console', 'close-console',
    'detect:default_reset', 'close-loader', 'console', 'reset']);
  await card.disconnect();
});

test('reads the complete factory partition in ordered chunks on one loader session', async () => {
  const mib = 1024 * 1024;
  const factory = 0x10000;
  const size = 0xfa0000;
  const {card, events, reads} = fixture({
    readBlock: (address, length) => new Uint8Array(length).fill((address - factory) / mib + 1),
  });
  await card.connect();
  const {blob} = await card.readFlash(factory, size);
  assert.equal(blob.size, size);
  assert.deepEqual(reads, [0, 4, 8, 12].map(offset => ({
    generation: 'generation', address: factory + offset * mib, size: Math.min(4 * mib, size - offset * mib),
  })));
  for (let offset = 0; offset < size; offset += mib) {
    const byte = new Uint8Array(await blob.slice(offset, offset + 1).arrayBuffer());
    assert.equal(byte[0], offset / mib + 1);
  }
  assert.equal(events.filter(e => e === 'detect:default_reset').length, 1);
  assert.equal(events.filter(e => e === 'reset').length, 1);
  assert.equal(card.mode, 'console');
  await card.disconnect();
});

test('a short chunk aborts the dump and an invalid full range sends no read', async () => {
  const mib = 1024 * 1024;
  const {card, reads} = fixture({
    inDownload: true, shortResponseAt: 4 * mib, readBlock: (_, length) => new Uint8Array(length),
  });
  await card.connect();
  await assert.rejects(card.readFlash(15 * mib, 2 * mib), /plage demandée/);
  assert.equal(reads.length, 0);
  await assert.rejects(card.readFlash(0, 9 * mib), /incomplete_flash_read/);
  assert.deepEqual(reads.map(read => read.address), [0, 4 * mib]);
  await card.disconnect();
});

test('UART flash uses the selected baud and reconnects to the same stub without reset', async () => {
  const {card, events, manualReset} = fixture({inDownload: true, flashBaud: 921600});
  await card.connect();
  assert.equal(card.activeBaud, 921600);
  await card.readFlash(0, 3);
  assert.ok(card.flashReadRate > 0);
  await card.disconnect();
  await card.connect();
  assert.equal(card.activeBaud, 921600);
  assert.deepEqual(events, ['detect:no_reset', 'baud:921600', 'close-loader',
    'detect:no_reset', 'close-loader', 'detect:no_reset']);
  await card.disconnect();
  manualReset();
  await card.connect();
  assert.equal(card.mode, 'console');
  assert.equal(card.activeBaud, 115200);
  await card.disconnect();
});

test('an unconfirmed flash baud fails before registration without resetting the board', async () => {
  const {card, events} = fixture({inDownload: true, flashBaud: 921600, failBaud: true});
  await assert.rejects(card.connect(), /921600 bauds non confirmé/);
  assert.equal(card.mode, 'disconnected');
  assert.equal(card.identity, null);
  assert.deepEqual(events, ['detect:no_reset', 'baud:921600', 'close-loader']);
});

test('native USB flash leaves the port configuration alone at any selected UART speed', async () => {
  const {card, events} = fixture({vid: 0x303a, inDownload: true, flashBaud: 921600});
  await card.connect();
  assert.equal(card.identity.transport, 'usb_otg');
  await card.readFlash(0, 3);
  assert.deepEqual(events, ['detect:no_reset']);
  assert.ok(card.flashReadRate > 0);
  await card.disconnect();
});

test('a manual transport leaves the running console open and requests manual download mode', async () => {
  const {card, events} = fixture({vid: 0x303a});
  await card.connect();
  assert.equal(card.canEnterLoader, false);
  await assert.rejects(card.identify(), /mode téléchargement/);
  assert.equal(card.mode, 'console');
  assert.deepEqual(events, ['detect:no_reset', 'close-loader', 'console']);
  await card.disconnect();
});

test('entering ROM from a loader does not pulse reset and permits JEDEC reads', async () => {
  const {card, events} = fixture({inDownload: true});
  await card.connect();
  assert.equal(card.identity.loader, 'stub');
  assert.equal((await card.enterRom({reset: true})).loader, 'rom');
  assert.deepEqual(card.identity.capabilities, ['identify']);
  assert.equal(card.consoleUnavailable, true);
  assert.deepEqual(await card.readRomJedec(), {flash_id: 0x184068, flash_size: 16 * 1024 * 1024});
  await assert.rejects(card.readFlash(0, 3), /Lecture flash indisponible/);
  await assert.rejects(card.restart(), /Reset indisponible/);
  assert.equal(card.mode, 'loader');
  assert.deepEqual(events, ['detect:no_reset', 'close-loader', 'detect:no_reset']);
  await card.disconnect();
});

test('the ROM action can request a reset from a console on a supported transport', async () => {
  const {card, events} = fixture();
  await card.connect();
  assert.equal(card.canResetIntoRom, true);
  assert.equal((await card.enterRom()).loader, 'rom');
  assert.equal(card.consoleUnavailable, true);
  assert.deepEqual(events, ['detect:no_reset', 'close-loader', 'console', 'close-console', 'detect:default_reset']);
  await card.disconnect();
});
