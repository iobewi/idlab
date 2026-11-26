import { serialTransport } from './serial-transport.js';

const UART_BRIDGES = new Set([0x0403, 0x067b, 0x10c4, 0x1a86]);
const FLASH_BLOCK = 1024 * 1024;
export const ESP_SYNC_BAUD = 115200;
export const MAX_FLASH_READ = 4 * FLASH_BLOCK;
export const FLASH_SECTOR = 4096;

export function connectionPlan(portInfo, { romOnly, manualEntry, resetToRom }) {
  const { usbVendorId: vid, usbProductId: pid } = portInfo;
  let transport = 'unknown';
  if (vid === 0x303a && pid === 0x1001) transport = 'usb_serial_jtag';
  else if (UART_BRIDGES.has(vid)) transport = 'usb_uart';

  const autoReset = !manualEntry && (!romOnly || resetToRom) && transport !== 'unknown';
  return { transport, entry: autoReset ? 'default_reset' : 'no_reset', useStub: !romOnly };
}

export class EspDriver {
  constructor(port, { ESPLoader, Transport, ESPError }, initialBaud = ESP_SYNC_BAUD) {
    const SerialTransport = serialTransport(Transport, ESPError);
    this.port = port;
    this.transport = new SerialTransport(port);
    this.loader = new ESPLoader({
      transport: this.transport,
      baudrate: initialBaud,
      romBaudrate: initialBaud,
      terminal: { clean() {}, write() {}, writeLine() {} },
    });
  }

  async connect(options) {
    const {romOnly, auto, flashBaud = ESP_SYNC_BAUD} = options;
    const usb = this.port.getInfo();
    const plan = connectionPlan(usb, options);
    const loader = this.loader;
    this.identificationAfterSync = false;
    this.connectionStage = 'Synchronisation du chargeur ROM';
    let synced = false;
    const openAndSync = loader.openAndSync;
    loader.openAndSync = async (...args) => {
      this.identificationAfterSync = false;
      if (synced) this.connectionStage = 'Resynchronisation du chargeur ROM';
      await openAndSync.apply(loader, args);
      synced = true;
      this.identificationAfterSync = true;
      this.connectionStage = 'Identification de la puce par la ROM (SYNC reçu)';
    };
    try {
      // An unanswered, reset-free probe can fall back to the console.
      if (auto) await loader.detectChip('no_reset', 1);
      else await loader.detectChip(plan.entry);
    } catch (error) {
      if (auto && !synced && !this.transport.closed && this.port.readable && this.port.writable &&
          error.message === 'Failed to connect with the device') return null;
      throw error;
    } finally {
      loader.openAndSync = openAndSync;
    }
    this.identificationAfterSync = false;
    if (romOnly && loader.syncStubDetected) throw new Error('Un stub tourne déjà. Remets la carte en mode ROM.');
    if (loader.secureDownloadMode) throw new Error('Identité indisponible en mode téléchargement sécurisé.');
    const security = loader.securityInfoCache;
    const erasable = security?.parsedFlags?.SECURE_BOOT_EN === false &&
      security.parsedFlags.SECURE_DOWNLOAD_ENABLE === false && security.flashCryptCnt === 0;

    this.connectionStage = 'Lecture de l’identité matérielle';
    let transport = plan.transport;
    if (transport === 'unknown' && await loader.usesUsbOtg()) transport = 'usb_otg';
    const mac = await loader.chip.readMac(loader);
    const model = await loader.chip.getChipDescription?.(loader) ?? loader.chip.CHIP_NAME;
    if (plan.useStub) {
      this.connectionStage = 'Préparation du chargeur';
      if (!loader.syncStubDetected) await loader.chip.postConnect?.(loader);
      this.connectionStage = 'Chargement et démarrage du stub';
      await loader.runStub();
      if (loader.IS_STUB && transport === 'usb_uart' && flashBaud !== this.transport.baudrate) {
        await this.#changeFlashBaud(flashBaud);
      }
    }
    let flashId = null, flashSize = null;
    if (loader.IS_STUB) {
      this.connectionStage = 'Lecture du JEDEC';
      ({flash_id: flashId, flash_size: flashSize} = await this.readJedec());
    }
    const chip = loader.chip.CHIP_NAME.toLowerCase().replace(/[^a-z0-9]/g, '');
    this.identity = {
      chip, model, mac, flash_size: flashSize, flash_id: flashId, transport,
      usb_vid: usb.usbVendorId ?? null, usb_pid: usb.usbProductId ?? null,
      loader: loader.IS_STUB ? 'stub' : 'rom',
      ...(loader.IS_STUB && flashSize && erasable ? {
        erasable: true, erasable_region: Number.isInteger(loader.ESP_ERASE_REGION),
      } : {}),
    };
    return this.identity;
  }

  async #changeFlashBaud(baud) {
    const {loader, transport} = this;
    const packet = new DataView(new ArrayBuffer(8));
    packet.setUint32(0, baud, true);
    packet.setUint32(4, transport.baudrate, true);
    try {
      await loader.checkCommand('change baud rate', loader.ESP_CHANGE_BAUDRATE, new Uint8Array(packet.buffer));
      await new Promise(resolve => setTimeout(resolve, 50));
      await transport.changeBaudrate(baud, loader.serialOptions);
      await transport.drainInput();
      if (!await loader.isResponsive()) throw new Error('Le stub ne répond plus.');
    } catch (cause) {
      // esptool-js changeBaud() can reset the board on failure. Leave recovery to the operator.
      throw new Error('Débit flash de ' + baud + ' bauds non confirmé. Redémarre manuellement en téléchargement et essaie un débit plus bas.', {cause});
    }
  }

  async readJedec() {
    const flashId = (await this.loader.readFlashId()) >>> 0;
    const capacityCode = (flashId >>> 16) & 255;
    return {
      flash_id: flashId,
      flash_size: capacityCode >= 12 && capacityCode <= 26 ? 2 ** capacityCode : null,
    };
  }

  async readFlash(address, size, checkSession, onProgress = () => {}) {
    const capacity = this.identity?.flash_size;
    if (!capacity || !this.loader.IS_STUB) throw new Error('operation_unsupported');
    if (!Number.isSafeInteger(address) || !Number.isSafeInteger(size) ||
        address < 0 || size <= 0 || size > MAX_FLASH_READ || address + size > capacity) {
      throw new Error('invalid_flash_range');
    }
    const data = new Uint8Array(size);
    for (let offset = 0; offset < size; offset += FLASH_BLOCK) {
      checkSession();
      // Keep the standard reader's cumulative copies bounded to one block.
      const length = Math.min(FLASH_BLOCK, size - offset);
      const block = await this.loader.readFlash(address + offset, length, (_packet, received) => {
        checkSession();
        onProgress(offset + received);
      });
      if (block.length !== length) throw new Error('incomplete_flash_read');
      data.set(block, offset);
    }
    checkSession();
    return data;
  }

  async programFlash(images, checkSession, onProgress) {
    if (!this.loader.IS_STUB || !this.identity?.flash_size) throw new Error('operation_unsupported');
    checkSession();
    await this.loader.writeFlash({
      fileArray: images, flashSize: 'keep', flashMode: 'keep', flashFreq: 'keep',
      eraseAll: false, compress: true,
      reportProgress: (index, written, total) => {
        checkSession();
        onProgress(index, written, total);
      },
    });
    checkSession();
  }

  async eraseFlash(checkSession, onProgress, region) {
    if (!this.identity?.erasable || !this.loader.IS_STUB) throw new Error('operation_unsupported');
    const capacity = this.identity.flash_size;
    const {address: start, size} = region ?? {address: 0, size: capacity};
    if (region && (!this.identity.erasable_region || !Number.isSafeInteger(start) || !Number.isSafeInteger(size) ||
        start < 0 || size < FLASH_SECTOR || start % FLASH_SECTOR || size % FLASH_SECTOR || start + size > capacity)) {
      throw new Error('invalid_flash_range');
    }
    checkSession();
    if (region) {
      const packet = new DataView(new ArrayBuffer(8));
      packet.setUint32(0, start, true);
      packet.setUint32(4, size, true);
      const timeout = this.loader.timeoutPerMb(this.loader.ERASE_REGION_TIMEOUT_PER_MB, size);
      await this.loader.checkCommand('erase flash region', this.loader.ESP_ERASE_REGION,
        new Uint8Array(packet.buffer), 0, 0, timeout);
    } else {
      await this.loader.eraseFlash();
    }
    checkSession();
    let first = null;
    for (let offset = 0; offset < size; offset += FLASH_BLOCK) {
      const length = Math.min(FLASH_BLOCK, size - offset);
      const address = start + offset;
      const block = await this.readFlash(address, length, checkSession, read => onProgress(offset + read));
      if (first === null) {
        const offset = block.findIndex(byte => byte !== 0xff);
        if (offset >= 0) first = address + offset;
      }
    }
    return {address: start, size, first_non_ff: first};
  }

  async close() {
    if (this.port.readable || this.port.writable) await this.transport.disconnect();
  }
}
