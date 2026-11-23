import { serialTransport } from './serial-transport.js';

const UART_BRIDGES = new Set([0x0403, 0x067b, 0x10c4, 0x1a86]);
const FLASH_BLOCK = 1024 * 1024;

export function connectionPlan(portInfo, { romOnly, manualEntry }) {
  const { usbVendorId: vid, usbProductId: pid } = portInfo;
  let transport = 'unknown';
  if (vid === 0x303a && pid === 0x1001) transport = 'usb_serial_jtag';
  else if (UART_BRIDGES.has(vid)) transport = 'usb_uart';

  const autoReset = !manualEntry && !romOnly && transport !== 'unknown';
  return { transport, entry: autoReset ? 'default_reset' : 'no_reset', useStub: !romOnly };
}

export class EspDriver {
  constructor(port, { ESPLoader, Transport, ESPError }) {
    const SerialTransport = serialTransport(Transport, ESPError);
    this.port = port;
    this.transport = new SerialTransport(port);
    this.loader = new ESPLoader({
      transport: this.transport,
      baudrate: 115200,
      terminal: { clean() {}, write() {}, writeLine() {} },
    });
  }

  async connect(options) {
    const plan = connectionPlan(this.port.getInfo(), options);
    const loader = this.loader;
    await loader.detectChip(plan.entry);
    if (loader.syncStubDetected) throw new Error('Un stub tourne déjà. Remets la carte en mode ROM.');
    if (loader.secureDownloadMode) throw new Error('Identité indisponible en mode téléchargement sécurisé.');

    let transport = plan.transport;
    if (transport === 'unknown' && await loader.usesUsbOtg()) transport = 'usb_otg';

    const mac = await loader.chip.readMac(loader);
    if (plan.useStub) {
      await loader.chip.postConnect?.(loader);
      await loader.runStub();
    }
    // ROM identification can work even when its target has no usable flash.
    let flashSize = null;
    if (loader.IS_STUB) {
      const flashId = await loader.readFlashId();
      const capacityCode = (flashId >>> 16) & 255;
      if (capacityCode >= 12 && capacityCode <= 26) flashSize = 2 ** capacityCode;
    }
    const chip = loader.chip.CHIP_NAME.toLowerCase().replace(/[^a-z0-9]/g, '');
    this.identity = { chip, mac, flash_size: flashSize, transport, loader: loader.IS_STUB ? 'stub' : 'rom' };
    return this.identity;
  }

  async readFlash(address, size, checkSession) {
    const capacity = this.identity?.flash_size;
    if (!capacity || !this.loader.IS_STUB) throw new Error('operation_unsupported');
    if (!Number.isSafeInteger(address) || !Number.isSafeInteger(size) ||
        address < 0 || size <= 0 || size > 4 * FLASH_BLOCK || address + size > capacity) {
      throw new Error('invalid_flash_range');
    }
    const data = new Uint8Array(size);
    for (let offset = 0; offset < size; offset += FLASH_BLOCK) {
      checkSession();
      // Keep the standard reader's cumulative copies bounded to one block.
      const length = Math.min(FLASH_BLOCK, size - offset);
      const block = await this.loader.readFlash(address + offset, length, checkSession);
      if (block.length !== length) throw new Error('incomplete_flash_read');
      data.set(block, offset);
    }
    checkSession();
    return data;
  }

  async close() {
    if (this.port.readable || this.port.writable) await this.transport.disconnect();
  }
}
