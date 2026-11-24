// Adapted from rust_dev/bench/web/bench-transport.js. Wait for incoming bytes
// instead of polling with timers that browsers throttle in background tabs.
export function serialTransport(Transport, ESPError) {
  const empty = new Uint8Array();
  return class extends Transport {
    get buffer() { return this.bytes ?? empty; }
    set buffer(bytes) {
      this.bytes = bytes;
      if (bytes.length) this.wake?.();
    }

    async connect(...args) {
      this.generation = (this.generation ?? 0) + 1;
      this.closed = false;
      this.buffer = empty;
      return super.connect(...args);
    }

    async readLoop() {
      const generation = this.generation;
      try {
        await super.readLoop();
      } finally {
        if (this.generation === generation) {
          this.closed = true;
          this.wake?.();
        }
      }
    }

    async disconnect() {
      this.closed = true;
      this.wake?.();
      await super.disconnect();
    }

    async write(bytes) {
      if (this.closed || !this.device.writable) throw new ESPError('serial_closed');
      const writer = this.device.writable.getWriter();
      try {
        await writer.write(this.slipWriter(bytes));
      } finally {
        writer.releaseLock();
      }
    }

    async read(timeout) {
      let deadline = performance.now() + timeout;
      let packet = null;
      let length = 0;
      let escaped = false;
      for (;;) {
        if (this.closed) throw new ESPError('serial_closed');
        const chunk = this.buffer;
        this.buffer = empty;
        if (!chunk.length) {
          const remaining = deadline - performance.now();
          if (remaining <= 0) throw new ESPError(packet ? 'serial_partial_packet' : 'serial_timeout');
          await new Promise(resolve => {
            const timer = setTimeout(() => this.wake(), remaining);
            this.wake = () => {
              clearTimeout(timer);
              this.wake = null;
              resolve();
            };
          });
          continue;
        }

        deadline = performance.now() + timeout;
        for (const [index, byte] of chunk.entries()) {
          if (!packet) {
            if (byte !== this.SLIP_END) {
              this.buffer = chunk.subarray(index + 1);
              this.detectPanicHandler(chunk);
              throw new ESPError('serial_invalid_frame');
            }
            packet = new Uint8Array(256);
            continue;
          }
          let decoded = byte;
          if (escaped) {
            escaped = false;
            if (byte === this.SLIP_ESC_END) decoded = this.SLIP_END;
            else if (byte === this.SLIP_ESC_ESC) decoded = this.SLIP_ESC;
            else throw new ESPError('serial_invalid_escape');
          } else if (byte === this.SLIP_END) {
            this.buffer = chunk.subarray(index + 1);
            return packet.slice(0, length);
          } else if (byte === this.SLIP_ESC) {
            escaped = true;
            continue;
          }
          if (length === packet.length) {
            if (length >= 65536) throw new ESPError('serial_frame_too_large');
            const grown = new Uint8Array(length * 2);
            grown.set(packet);
            packet = grown;
          }
          packet[length++] = decoded;
        }
      }
    }
  };
}
