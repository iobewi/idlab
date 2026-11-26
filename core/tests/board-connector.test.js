import assert from 'node:assert/strict';
import test from 'node:test';
import * as upstream from '../node_modules/esptool-js/bundle.js';
import {BoardConnector, sha256} from '../board-connector.js';

function fixture({ vid = 0x10c4, pid, failRead = false, inDownload = false, flashBaud, failBaud = false,
  readBlock, shortResponseAt, campaignId, onLinkLost, failLoader = false, stubTimeout = false,
  romIdentificationTimeout = false, programPayload, partialRead = 0, failReset = false } = {}) {
  const events = [];
  const reads = [];
  const progress = [];
  const writes = [];
  let identity, socket, commandResult;
  const responseParts = [];
  const uart = [];
  let deviceBaud = 115200;
  const bytes = Uint8Array.of(0, 255, 13);
  const port = {getInfo: () => ({usbVendorId: vid, usbProductId: pid})};
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
      if ((attempts === 1 && (!inDownload || this.initialBaud !== deviceBaud)) ||
          (entry === 'default_reset' && failLoader)) {
        throw new Error('Failed to connect with the device');
      }
      if (entry === 'default_reset' && romIdentificationTimeout) {
        await this.openAndSync();
        throw new Error('serial_timeout');
      }
    }
    async runStub() {
      if (stubTimeout) throw new Error('serial_timeout');
      this.IS_STUB = true;
    }
    async checkCommand(_description, opcode, data) {
      assert.equal(opcode, 0x0f);
      const payload = new DataView(data.buffer);
      assert.equal(payload.getUint32(4, true), deviceBaud);
      deviceBaud = payload.getUint32(0, true);
      events.push('baud:' + deviceBaud);
    }
    async isResponsive() { return !failBaud && this.transport.baudrate === deviceBaud; }
    async readFlashId() { return 0x184068; }
    async readFlash(address, size, onPacket) {
      if (failRead) {
        if (partialRead) onPacket(new Uint8Array(partialRead), partialRead);
        throw new Error('serial_timeout');
      }
      if (address === shortResponseAt) return new Uint8Array(1);
      const block = readBlock ? readBlock(address, size) : bytes;
      assert.equal(size, block.length);
      onPacket(block, block.length);
      return block;
    }
    async openAndSync() {}
    async writeFlash(options) {
      assert.equal(options.eraseAll, false);
      assert.equal(options.flashSize, 'keep');
      assert.equal(options.flashMode, 'keep');
      assert.equal(options.flashFreq, 'keep');
      for (const [index, file] of options.fileArray.entries()) {
        writes.push(file);
        options.reportProgress(index, file.data.length, file.data.length);
      }
    }
    async usesUsbOtg() { return vid === 0x303a; }
  }
  const card = new BoardConnector('board', port, {
    flashBaud, onChange() {}, campaignId, onLinkLost,
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
      return { done: done.promise, async write(value) { events.push('uart:' + new TextDecoder().decode(value)); }, async close() { events.push('close-console'); done.resolve(); } };
    },
    async reset() {
      events.push('reset');
      if (failReset) throw new Error('serial_closed');
    },
    createSocket() {
      socket = {
        readyState: 1,
        send(message) {
          if (message === 'request') return;
          if (typeof message !== 'string') {
            responseParts.push(message);
            return;
          }
          const payload = JSON.parse(message);
          if (payload.uart) { uart.push(payload.uart); return; }
          if (payload.journal) return;
          if (payload.progress) { progress.push(payload.progress); return; }
          if (payload.result) { commandResult = payload; return; }
          identity = {...(payload.identity ?? payload), generation: 'generation',
            capabilities: ['identify', 'flash.read']};
          if (identity.loader === 'rom' || identity.mode === 'console') identity.capabilities = ['identify'];
          const reply = payload.identity ? {identity} : {generation: 'generation'};
          queueMicrotask(() => socket.onmessage({data: JSON.stringify(reply)}));
        },
        close() { socket.readyState = 3; socket.onclose(); },
      };
      queueMicrotask(() => socket.onopen());
      return socket;
    },
    async request(path, options) {
      if (!options) {
        if (socket.readyState === 3) throw new Error('device_disconnected');
        if (path === '/devices/board/flash/program/write/0') {
          return {arrayBuffer: async () => programPayload.buffer};
        }
        return {json: async () => identity};
      }
      if (path === '/devices/board/command') {
        const payload = JSON.parse(options.body);
        assert.equal(payload.generation, 'generation');
        commandResult = null;
        await socket.onmessage({data: JSON.stringify({...payload, id: 'test-command', generation: undefined})});
        assert.equal(commandResult?.result, 'test-command');
        if (commandResult.error) throw new Error(commandResult.detail ?? commandResult.error);
        return {json: async () => ({...identity, result: commandResult.value})};
      }
      assert.equal(path, '/devices/board/flash/read');
      const fields = JSON.parse(options.body);
      const {generation, address, size} = fields;
      assert.equal(generation, 'generation');
      reads.push(fields);
      responseParts.length = 0;
      commandResult = null;
      await socket.onmessage({data: JSON.stringify({address, size, command: 'flash.read', id: 'request', stream: true})});
      if (commandResult?.error) throw new Error(commandResult.error);
      assert.equal(commandResult?.result, 'request');
      const blob = new Blob(responseParts);
      assert.equal(blob.size, size);
      return {blob: async () => blob, headers: new Headers({'X-IDLab-Flash-Size': commandResult.value})};
    },
  });
  port.readable = null;
  return {card, events, reads, progress, uart, writes,
    get lastResult() { return commandResult; },
    async program(images) {
      commandResult = null;
      await socket.onmessage({data: JSON.stringify({command: 'flash.program', id: 'write', images})});
      return commandResult;
    },
    manualReset() { inDownload = false; deviceBaud = 115200; }};
}

test('only unexpected disconnections report a lost board link', async () => {
  let losses = 0;
  const {card} = fixture({onLinkLost: () => { losses++; }});
  await card.connect();
  await card.disconnect();
  assert.equal(losses, 0);
  await card.connect();
  await card.disconnect(true);
  assert.equal(losses, 1);
  await card.connect();
  card.socket.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(card.mode, 'disconnected');
  assert.equal(losses, 2);
});

test('identification and flash reads from console restore the same console and retain identity', async () => {
  const {card, events, uart} = fixture();
  await card.connect();
  assert.equal(card.mode, 'console');
  assert.equal(card.canEnterLoader, true);
  assert.equal((await card.identify()).mac, '10:20:30:40:50:60');
  assert.equal(card.mode, 'console');
  assert.equal(card.lastIdentity.flash_id, 0x184068);
  assert.equal(card.identity.mode, 'console');
  const result = await card.readFlash(0x8000, 3);
  assert.equal(result.capacity, 16 * 1024 * 1024);
  assert.deepEqual([...new Uint8Array(await result.blob.arrayBuffer())], [0, 255, 13]);
  assert.equal(card.mode, 'console');
  assert.deepEqual(events, ['detect:no_reset', 'close-loader', 'console', 'close-console', 'detect:default_reset', 'close-loader', 'console', 'reset',
    'close-console', 'detect:default_reset', 'close-loader', 'console', 'reset']);
  assert.equal(Buffer.from(uart.join(''), 'hex').toString(), 'READY\nREADY\nREADY\n');
  await card.disconnect();
  assert.equal(card.lastIdentity.flash_id, 0x184068);
  await card.disconnect(true);
  assert.equal(card.lastIdentity, null);
});

test('automatic identification restores the console and skips the reset on a reconnect', async () => {
  const {card, events} = fixture();
  assert.equal(await card.connect({identifyOnConnect: true}), undefined);
  assert.equal(card.mode, 'console');
  assert.equal(card.lastIdentity.mac, '10:20:30:40:50:60');
  assert.equal(card.lastIdentity.flash_id, 0x184068);
  await card.disconnect();
  assert.equal(await card.connect({identifyOnConnect: true}), undefined);
  assert.equal(card.mode, 'console');
  assert.equal(events.filter(event => event === 'detect:default_reset').length, 1);
  await card.disconnect();
});

test('failed automatic identification leaves a usable console and reports the reason', async () => {
  const {card} = fixture({failLoader: true});
  assert.match(await card.connect({identifyOnConnect: true}), /ne répond pas en mode téléchargement/);
  assert.equal(card.mode, 'console');
  await card.write('status');
  await card.disconnect();
});

test('automatic identification leaves manual-only ports in console', async () => {
  const {card, events} = fixture({vid: 0x303a});
  assert.match(await card.connect({identifyOnConnect: true}), /BOOT et RESET/);
  assert.equal(card.mode, 'console');
  assert.deepEqual(events, ['detect:no_reset', 'close-loader', 'console']);
  await card.disconnect();
});

test('an automatically detected loader stays in download mode through reads and rejects software restart', async () => {
  const {card, events, manualReset} = fixture({inDownload: true});
  assert.equal(await card.connect({identifyOnConnect: true}), undefined);
  await card.identify();
  await card.readFlash(0, 3);
  assert.equal(card.mode, 'loader');
  assert.equal(card.consoleUnavailable, true);
  assert.equal(card.canResetIntoRom, false);
  assert.equal(card.canReturnToConsole, false);
  await assert.rejects(card.returnConsole(), /RESET manuel/);
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

test('web reads send the selected campaign only while the campaign is selected', async () => {
  let selected = '0'.repeat(32);
  const {card, reads} = fixture({inDownload: true, campaignId: () => selected});
  await card.connect();
  await card.readFlash(0, 3);
  assert.equal(reads[0].campaign_id, selected);
  selected = null;
  await card.readFlash(0, 3);
  assert.equal('campaign_id' in reads[1], false);
  await card.disconnect();
});

test('the explicit loader action can return to console and switch again', async () => {
  const {card, events} = fixture();
  await card.connect();
  const socket = card.socket;
  await card.write('status');
  assert.equal(events.at(-1), 'uart:status');
  await card.enterLoader();
  assert.equal(card.socket, socket);
  assert.equal(card.canReturnToConsole, true);
  card.control = 'external';
  await assert.rejects(card.returnConsole(), /Carte indisponible/);
  card.control = 'available';
  await card.returnConsole();
  assert.equal(card.socket, socket);
  assert.equal(card.mode, 'console');
  assert.equal(card.consoleUnavailable, false);
  assert.deepEqual(events.slice(-3), ['close-loader', 'console', 'reset']);
  await card.enterLoader();
  assert.equal(card.canReturnToConsole, true);
  await card.disconnect();
});

test('a failed USB Serial/JTAG loader entry reports the cause and restores the same console session', async () => {
  const {card, events} = fixture({vid: 0x303a, pid: 0x1001, failLoader: true});
  await card.connect();
  const socket = card.socket;
  await assert.rejects(card.enterLoader(), /Failed to connect with the device/);
  assert.equal(card.mode, 'console');
  assert.equal(card.socket, socket);
  assert.deepEqual(events.slice(-5), ['close-console', 'detect:default_reset', 'close-loader', 'console', 'reset']);
  await card.write('status');
  assert.equal(events.at(-1), 'uart:status');
  await card.disconnect();
});

test('an identification timeout after SYNC on USB Serial/JTAG suggests manual RESET', async () => {
  const {card} = fixture({vid: 0x303a, pid: 0x1001, romIdentificationTimeout: true});
  await card.connect();
  await assert.rejects(card.enterLoader(), /SYNC reçu.*serial_timeout.*RESET sans maintenir BOOT, recharge la page/);
  assert.equal(card.mode, 'console');
  await card.disconnect();
});

test('a serial timeout during stub startup identifies the stage and restores UART', async () => {
  const {card} = fixture({vid: 0x303a, pid: 0x1001, stubTimeout: true});
  await card.connect();
  await assert.rejects(card.enterLoader(), /Chargement et démarrage du stub.*serial_timeout/);
  assert.equal(card.mode, 'console');
  await card.disconnect();
});

test('a failed flash read before any bytes restores console without retrying', async () => {
  const scenario = fixture({failRead: true});
  const {card, events, progress} = scenario;
  await card.connect();
  await assert.rejects(card.readFlash(0, 3), /serial_timeout/);
  assert.deepEqual(progress, [{address: 0, received: 0, total: 3, baudrate: 115200}]);
  assert.deepEqual(scenario.lastResult.read_diagnostic, {error: 'serial_timeout', console_restored: true});
  assert.equal(card.mode, 'console');
  assert.deepEqual(events, ['detect:no_reset', 'close-loader', 'console', 'close-console',
    'detect:default_reset', 'close-loader', 'console', 'reset']);
  await card.disconnect();
});

test('a failed read reports throttled progress and keeps the serial error even if console recovery fails', async () => {
  const scenario = fixture({failRead: true, partialRead: 2, failReset: true});
  const {card, progress, events} = scenario;
  await card.connect();
  await assert.rejects(card.readFlash(0x1000, 3), /serial_timeout/);
  assert.deepEqual(progress.at(-1), {address: 0x1000, received: 2, total: 3, baudrate: 115200});
  assert.deepEqual(scenario.lastResult.read_diagnostic,
    {error: 'serial_timeout', console_restored: false, console_error: 'serial_closed'});
  assert.equal(events.filter(event => event === 'reset').length, 1);
});

test('reads the complete factory partition in ordered chunks on one loader session', async () => {
  const mib = 1024 * 1024;
  const factory = 0x10000;
  const size = 0xfa0000;
  const {card, events, reads, progress} = fixture({
    readBlock: (address, length) => new Uint8Array(length).fill((address - factory) / mib + 1),
  });
  await card.connect();
  const {blob} = await card.readFlash(factory, size);
  assert.equal(blob.size, size);
  assert.deepEqual(reads, [{generation: 'generation', address: factory, size}]);
  assert.deepEqual(progress.at(0), {address: factory, received: 0, total: size, baudrate: 115200});
  assert.deepEqual(progress.at(-1), {address: factory, received: size, total: size, baudrate: 115200});
  for (let offset = 0; offset < size; offset += mib) {
    const byte = new Uint8Array(await blob.slice(offset, offset + 1).arrayBuffer());
    assert.equal(byte[0], offset / mib + 1);
  }
  assert.equal(events.filter(e => e === 'detect:default_reset').length, 1);
  assert.equal(events.filter(e => e === 'reset').length, 1);
  assert.equal(card.mode, 'console');
  await card.disconnect();
});

test('programs only the validated bytes, then hashes the actual flash readback', async () => {
  const firmware = Uint8Array.of(1, 2, 3);
  const stored = Uint8Array.of(1, 2, 4);
  const {card, program, progress, writes} = fixture({
    inDownload: true, programPayload: firmware, readBlock: () => stored,
  });
  await card.connect();
  const image = {address: 4096, size: 3, sha256: await sha256(firmware)};
  const bad = await program([{...image, sha256: await sha256(stored)}]);
  assert.equal(bad.error, 'device_command_failed');
  assert.equal(writes.length, 0);
  const result = await program([image]);
  assert.deepEqual(writes, [{address: 4096, data: firmware}]);
  assert.deepEqual(result.value, [await sha256(stored)]);
  assert.deepEqual(result.previews, ['010204']);
  assert(progress.some(entry => entry.phase === 'write'));
  assert(progress.some(entry => entry.phase === 'verify'));
  assert.equal(card.mode, 'loader');
  await card.disconnect();
});

test('a short chunk aborts the dump and an invalid range is rejected', async () => {
  const mib = 1024 * 1024;
  const {card, reads} = fixture({
    inDownload: true, shortResponseAt: 4 * mib, readBlock: (_, length) => new Uint8Array(length),
  });
  await card.connect();
  await assert.rejects(card.readFlash(15 * mib, 2 * mib), /invalid_flash_range/);
  assert.equal(reads.length, 1);
  await assert.rejects(card.readFlash(0, 9 * mib), /device_command_failed/);
  assert.deepEqual(reads.map(read => read.address), [15 * mib, 0]);
  await card.disconnect();
});

test('UART flash uses the selected baud and reconnects to the same stub without reset', async () => {
  const {card, events, manualReset} = fixture({inDownload: true, flashBaud: 921600});
  await card.connect();
  assert.equal(card.activeBaud, 921600);
  await card.readFlash(0, 3);
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
  await card.disconnect();
});

test('a manual transport leaves the running console open and requests manual download mode', async () => {
  const {card, events} = fixture({vid: 0x303a});
  await card.connect();
  assert.equal(card.canEnterLoader, false);
  await assert.rejects(card.identify(), /Place la carte en mode téléchargement/);
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
  assert.deepEqual((await card.readRomJedec()).result, {flash_id: 0x184068, flash_size: 16 * 1024 * 1024});
  await assert.rejects(card.readFlash(0, 3), /invalid_flash_range/);
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
