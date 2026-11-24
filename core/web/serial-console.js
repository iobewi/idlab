const idleSignals = {dataTerminalReady: false, requestToSend: false};

// An explicit firmware restart for the known USB reset circuits.
export async function resetConsole(port, holdMs) {
  try {
    await port.setSignals({dataTerminalReady: false, requestToSend: true});
    await new Promise(resolve => setTimeout(resolve, holdMs));
  } finally {
    await port.setSignals(idleSignals);
  }
}

// A console owns this Web Serial port until close() completes.
export async function openSerialConsole(port, baudRate, onText, onBytes = () => {}) {
  await port.open({ baudRate });
  let reader;
  try {
    await port.setSignals?.(idleSignals);
    reader = port.readable.getReader();
  } catch (error) {
    await port.close();
    throw error;
  }
  let closing;
  let ended = false;
  let writing = Promise.resolve();
  const decoder = onText ? new TextDecoder() : null;
  const encoder = new TextEncoder();

  const done = (async () => {
    try {
      for (;;) {
        const {value, done: eof} = await reader.read();
        if (eof) break;
        onBytes(value);
        if (decoder) onText(decoder.decode(value, {stream: true}));
      }
      const remainder = decoder?.decode();
      if (remainder) onText(remainder);
    } finally {
      ended = true;
      reader.releaseLock();
    }
  })();

  return {
    done,
    write(text) {
      if (closing || ended) return Promise.reject(new Error('Console déconnectée.'));
      writing = writing.catch(() => {}).then(async () => {
        if (ended) throw new Error('Console déconnectée.');
        const writer = port.writable.getWriter();
        try {
          await writer.write(typeof text === 'string' ? encoder.encode(text) : text);
        } finally {
          writer.releaseLock();
        }
      });
      return writing;
    },
    close() {
      closing ??= (async () => {
        await reader.cancel().catch(() => {});
        await Promise.allSettled([done, writing]);
        await port.close();
      })();
      return closing;
    },
  };
}
