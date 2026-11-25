export const PARTITION_TABLE_BYTES = 0xc00;

export function decodePartitions(bytes, capacity) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const rows = [];
  for (let offset = 0; offset + 32 <= bytes.length; offset += 32) {
    const magic = view.getUint16(offset, true);
    if (magic === 0xffff || magic === 0xebeb) break;
    if (magic !== 0x50aa) throw new Error('partition_table_invalid');
    const address = view.getUint32(offset + 4, true);
    const size = view.getUint32(offset + 8, true);
    if (!size || address + size > capacity) throw new Error('partition_table_invalid');
    rows.push({
      type: bytes[offset + 2], subtype: bytes[offset + 3], address, size,
      label: decoder.decode(bytes.subarray(offset + 12, offset + 28)).split('\0', 1)[0],
    });
  }
  if (!rows.length) throw new Error('partition_table_invalid');
  return rows;
}
