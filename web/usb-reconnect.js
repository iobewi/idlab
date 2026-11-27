// Only a physical return of the exact authorized SerialPort can trigger reconnect.
export function usbReconnect(card, {connect, report, isRegistered}) {
  let desired = false;
  let missing = false;
  let returned = false;
  let scheduled = false;
  let running = false;

  function changed() {
    if (!desired || !missing || !returned || scheduled || running ||
        card.mode !== 'disconnected' || card.busy || card.requesting) return;
    scheduled = true;
    queueMicrotask(async () => {
      scheduled = false;
      if (!desired || !missing || !returned || !isRegistered() ||
          card.mode !== 'disconnected' || card.busy || card.requesting) return;
      missing = returned = false;
      running = true;
      try {
        await connect();
      } catch (error) {
        report(error);
      } finally {
        running = false;
        changed();
      }
    });
  }

  return {
    enable() { desired = true; missing = returned = false; },
    disable() { desired = missing = returned = false; },
    changed,
    async removed() {
      if (desired) {
        missing = true;
        returned = false;
      }
      try { await card.disconnect(true); }
      finally { changed(); }
    },
    added() {
      if (!desired || !missing) return;
      returned = true;
      changed();
    },
  };
}
