import { md5 } from './md5.js';

// READ_FLASH wire protocol, based on esptool-js PR #274 and esptool Python.
// Preserve the 0.7.0 command parameters for this targeted backport.
const PACKET_SIZE = 4096;
export async function readFlashVerified(loader, address, size, check, progress) {
  const {transport} = loader;
  const payload = new DataView(new ArrayBuffer(16));
  [address, size, PACKET_SIZE, 1024].forEach((value, index) => payload.setUint32(index * 4, value, true));
  check();
  const result = await loader.checkCommand('read flash', loader.ESP_READ_FLASH, new Uint8Array(payload.buffer));
  check();
  if (result !== 0) throw new Error('device_command_failed');
  const data = new Uint8Array(size);
  let received = 0;
  while (received < size) {
    const packet = await transport.read(loader.FLASH_READ_TIMEOUT);
    check();
    if (!(packet instanceof Uint8Array) || packet.length !== Math.min(PACKET_SIZE, size - received)) {
      throw new Error('incomplete_flash_read');
    }
    data.set(packet, received);
    received += packet.length;
    const ack = new DataView(new ArrayBuffer(4));
    ack.setUint32(0, received, true);
    await transport.write(new Uint8Array(ack.buffer));
    check();
    progress(received);
  }
  const digest = await transport.read(loader.FLASH_READ_TIMEOUT);
  check();
  if (!(digest instanceof Uint8Array) || digest.length !== 16) throw new Error('flash_read_invalid_digest');
  if (!md5(data).every((byte, index) => byte === digest[index])) throw new Error('flash_read_digest_mismatch');
  check();
  return data;
}
