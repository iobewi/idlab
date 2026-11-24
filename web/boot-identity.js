// Boot banners are hints from UART. They never grant loader capabilities.
export class BootIdentity {
  constructor() {
    this.chip = null;
    this.revision = null;
    this.flashMiB = null;
    this.tail = '';
  }

  append(text) {
    const lines = (this.tail + text).split(/[\r\n]/);
    this.tail = lines.pop().slice(-512);
    let changed = false;
    for (const line of lines) {
      const rom = /\bESP-ROM:(esp32[a-z0-9]*)(?:-[^\s]*)?/i.exec(line);
      const flash = /^I\s+\(\s*\d+\)\s+boot\.(esp32[a-z0-9]*):\s*SPI Flash Size\s*:\s*(\d+)\s*MB\s*$/i.exec(line);
      const revision = /^I\s+\(\s*\d+\)\s+boot:\s*chip revision:\s*(v\d+\.\d+)\s*$/i.exec(line);

      const chip = (rom?.[1] ?? flash?.[1])?.toLowerCase();
      if (chip && this.chip !== chip) {
        this.chip = chip;
        changed = true;
      }
      if (revision && this.revision !== revision[1]) {
        this.revision = revision[1];
        changed = true;
      }
      if (flash) {
        const size = Number(flash[2]);
        if (Number.isSafeInteger(size) && size > 0 && this.flashMiB !== size) {
          this.flashMiB = size;
          changed = true;
        }
      }
    }
    return changed;
  }
}
