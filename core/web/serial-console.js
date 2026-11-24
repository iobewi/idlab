// A console owns this Web Serial port until close() completes.
export async function openSerialConsole(port, baudRate, onText) {
  await port.open({ baudRate });
  let reader;
  try {
    reader = port.readable.getReader();
  } catch (error) {
    await port.close();
    throw error;
  }
  let closing;
  let ended = false;
  let writing = Promise.resolve();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const done = (async () => {
    try {
      for (;;) {
        const {value, done: eof} = await reader.read();
        if (eof) break;
        onText(decoder.decode(value, {stream: true}));
      }
      const remainder = decoder.decode();
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
          await writer.write(encoder.encode(text));
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
