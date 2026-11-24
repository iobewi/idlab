import assert from 'node:assert/strict';
import test from 'node:test';
import * as upstream from '../node_modules/esptool-js/bundle.js';
import {BoardConnector} from '../web/board-connector.js';

function fixture({ use = 'console', vid = 0x10c4, manual = false, failRead = false } = {}) {
  const events = [];
  let identity, socket;
  const bytes = Uint8Array.of(0, 255, 13);
  const port = {getInfo: () => ({usbVendorId: vid})};
  class Loader {
    chip = {
      CHIP_NAME: 'ESP32-S3',
      readMac: async () => '10:20:30:40:50:60',
      getChipDescription: async () => 'ESP32-S3',
    };
    constructor({transport}) { this.transport = transport; }
    async detectChip(entry) {
      events.push('detect:' + entry);
      port.readable = {};
    }
    async runStub() { this.IS_STUB = true; }
    async readFlashId() { return 0x184068; }
    async readFlash(address, size, check) {
      check();
      assert.equal(size, bytes.length);
      if (failRead) throw new Error('error during read');
      return bytes;
    }
    async openAndSync() {}
  }
  const card = new BoardConnector('board', port, {
    baud: 115200, use, manual, onChange() {}, onCapture() {}, onJournal() {},
  }, {
    origin: 'http://127.0.0.1:8080/',
    loadTools: async () => ({
      ...upstream,
      ESPLoader: Loader,
      Transport: class extends upstream.Transport {
        async disconnect() { events.push('close-loader'); port.readable = null; }
      },
    }),
    async openConsole(_port, _baud, _text, onBytes) {
      assert.equal(port.readable, null);
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
          if (typeof message !== 'string') return;
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
      const params = JSON.parse(options.body);
      assert.equal(params.generation, 'generation');
      await socket.onmessage({data: JSON.stringify({...params, command: 'flash.read', id: 'request'})});
      if (failRead) {
        socket.close();
        throw new Error('read_incomplete_reconnect_required');
      }
      return {blob: async () => new Blob([bytes])};
    },
  });
  port.readable = null;
  return {card, events};
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
  assert.deepEqual(events, ['console', 'close-console', 'detect:default_reset', 'close-loader', 'console', 'reset',
    'close-console', 'detect:default_reset', 'close-loader', 'console', 'reset']);
  assert.equal(new TextDecoder().decode(card.capture.bytes()), 'READY\nREADY\nREADY\n');
  await card.disconnect();
  assert.equal(card.lastIdentity, null);
});

test('flash operations reuse an existing loader and do not switch to console', async () => {
  const {card, events} = fixture({use: 'stub'});
  await card.connect();
  await card.identify();
  await card.readFlash(0, 3);
  assert.equal(card.mode, 'loader');
  assert.deepEqual(events, ['detect:default_reset']);
  await card.disconnect();
});

test('a failed flash read restores console without retrying the read', async () => {
  const {card, events} = fixture({failRead: true});
  await card.connect();
  await assert.rejects(card.readFlash(0, 3), /read_incomplete/);
  assert.equal(card.mode, 'console');
  assert.deepEqual(events, ['console', 'close-console', 'detect:default_reset', 'close-loader', 'console', 'reset']);
  await card.disconnect();
});

test('a manual transport leaves the running console open and requests manual download mode', async () => {
  const {card, events} = fixture({manual: true});
  await card.connect();
  assert.equal(card.canEnterLoader, false);
  await assert.rejects(card.identify(), /mode téléchargement/);
  assert.equal(card.mode, 'console');
  assert.deepEqual(events, ['console']);
  await card.disconnect();
});

test('ROM is an explicit operation that replaces the stub and permits only JEDEC reads', async () => {
  const {card, events} = fixture({use: 'stub'});
  await card.connect();
  assert.equal(card.identity.loader, 'stub');
  assert.equal((await card.enterRom()).loader, 'rom');
  assert.deepEqual(card.identity.capabilities, ['identify']);
  assert.deepEqual(await card.readRomJedec(), {flash_id: 0x184068, flash_size: 16 * 1024 * 1024});
  await assert.rejects(card.readFlash(0, 3), /Lecture flash indisponible/);
  await card.returnConsole();
  assert.equal(card.mode, 'console');
  assert.deepEqual(events, ['detect:default_reset', 'close-loader', 'detect:default_reset',
    'close-loader', 'console', 'reset']);
  await card.disconnect();
});

test('ROM can open from a selected disconnected card and preserves manual entry', async () => {
  const {card, events} = fixture({manual: true});
  assert.equal((await card.enterRom()).loader, 'rom');
  assert.deepEqual(events, ['detect:no_reset']);
  await card.disconnect();
});
