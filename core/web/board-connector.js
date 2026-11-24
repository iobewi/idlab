import { ESP_SYNC_BAUD, EspDriver, connectionPlan } from './esp-driver.js';
import { openSerialConsole, resetConsole } from './serial-console.js';
import { ConsoleBuffer } from './console-buffer.js';
import { BootIdentity } from './boot-identity.js';

const CONSOLE_BAUD = 115200;

async function api(path, options) {
  const response = await fetch('/api/v1' + path, options);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error ?? ('HTTP ' + response.status));
  }
  return response;
}

export class BoardConnector {
  constructor(name, port, {flashBaud = ESP_SYNC_BAUD, onChange, onCapture, onJournal}, {
    request = api, loadTools = () => import('/esptool.js'),
    createSocket = url => new WebSocket(url), openConsole = openSerialConsole, reset = resetConsole,
    origin = location.href,
  } = {}) {
    Object.assign(this, {name, port, flashBaud, onChange, onCapture, onJournal,
      request, loadTools, createSocket, openConsole, reset, origin});
    const info = port.getInfo();
    this.transport = connectionPlan(info, {}).transport;
    this.resetWait = {usb_uart: 100, usb_serial_jtag: 200}[this.transport];
    this.portLabel = info.usbVendorId == null ? 'Port série' :
      [info.usbVendorId, info.usbProductId].filter(Number.isInteger)
        .map(value => value.toString(16).padStart(4, '0')).join(':');
    this.mode = 'disconnected';
    this.lastLoaderBaud = ESP_SYNC_BAUD;
    this.temporaryLoader = false;
    this.busy = false;
    this.requesting = false;
    this.lost = false;
    this.romJedec = null;
    this.capture = new ConsoleBuffer();
    this.boot = new BootIdentity();
  }

  get canEnterLoader() {
    return Boolean(this.resetWait);
  }

  get canResetIntoRom() {
    return this.mode === 'console' && this.canEnterLoader;
  }

  get consoleUnavailable() {
    return this.mode === 'loader' && !this.temporaryLoader;
  }

  get activeBaud() {
    if (this.mode === 'console') return CONSOLE_BAUD;
    if (this.mode === 'loader') return this.session?.transport.baudrate;
    return null;
  }

  #setMode(mode) {
    this.mode = mode;
    this.onChange();
  }

  async connect() {
    if (this.mode !== 'disconnected') return;
    this.lost = false;
    this.#setMode('connecting');
    try {
      if (this.session) await this.#closeSession();
      await this.#openLoader('auto');
      if (!this.identity && this.lastLoaderBaud !== ESP_SYNC_BAUD) {
        await this.#openLoader('auto', {initialBaud: this.lastLoaderBaud});
      }
      if (!this.identity) {
        this.lastLoaderBaud = ESP_SYNC_BAUD;
        this.onJournal('Pas de réponse du chargeur sans reset · ouverture console');
        await this.#openConsole();
      }
    } catch (error) {
      await this.#clearSession();
      throw error;
    }
  }

  async #openConsole() {
    if (this.lost) throw new Error('Port USB déconnecté.');
    this.boot.tail = '';
    const session = await this.openConsole(this.port, CONSOLE_BAUD, null, bytes => {
      const event = this.capture.append(bytes);
      this.boot.append(event.text);
      this.onCapture();
    });
    this.session = session;
    const ended = error => {
      if (this.session !== session) return;
      if (error) this.onJournal(error.message);
      this.disconnect(true).catch(failure => this.onJournal(failure.message));
    };
    session.done.then(() => ended(), ended);
    if (this.lost) throw new Error('Port USB déconnecté.');
    this.#setMode('console');
    this.onJournal('Console ouverte à ' + CONSOLE_BAUD + ' bauds');
  }

  async #openLoader(use, {temporary = false, resetToRom = false, initialBaud = ESP_SYNC_BAUD} = {}) {
    if (this.lost) throw new Error('Port USB déconnecté.');
    const driver = new EspDriver(this.port, await this.loadTools(), initialBaud);
    if (this.lost) throw new Error('Port USB déconnecté.');
    this.session = driver;
    const identity = await driver.connect({
      auto: use === 'auto', romOnly: use === 'rom', resetToRom, flashBaud: this.flashBaud,
    });
    if (this.lost) throw new Error('Port USB déconnecté.');
    if (!identity) {
      await this.#closeSession();
      return;
    }
    this.identity = await this.#register(driver);
    this.romJedec = null;
    if (this.lost) throw new Error('Port USB déconnecté.');
    this.lastIdentity = this.identity;
    this.lastLoaderBaud = driver.transport.baudrate || ESP_SYNC_BAUD;
    this.temporaryLoader = temporary;
    this.#setMode('loader');
    this.onJournal('Chargeur détecté · ' + (identity.model ?? identity.chip));
    if (identity.transport === 'usb_uart') this.onJournal('Débit chargeur · ' + this.lastLoaderBaud + ' bauds');
  }

  #register(driver) {
    const url = new URL('/agent', this.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('device', this.name);
    const socket = this.createSocket(url);
    this.socket = socket;
    return new Promise((resolve, reject) => {
      const interrupted = new Error('Liaison au serveur interrompue.');
      const deadline = setTimeout(() => reject(new Error('Le serveur n’a pas enregistré la carte à temps.')), 10000);
      const registered = identity => { clearTimeout(deadline); resolve(identity); };
      const failed = error => { clearTimeout(deadline); reject(error); };
      socket.onopen = () => socket.send(JSON.stringify(driver.identity));
      socket.onclose = () => {
        failed(interrupted);
        if (this.socket === socket && this.mode === 'loader' && !this.requesting) {
          this.disconnect().catch(error => this.onJournal(error.message));
        }
      };
      socket.onmessage = async event => {
        try {
          const command = JSON.parse(event.data);
          if (command.generation) {
            const identity = await this.request('/devices/' + this.name).then(reply => reply.json());
            if (socket.readyState !== 1) throw interrupted;
            registered(identity);
          } else {
            await this.#serveRead(socket, driver, command);
          }
        } catch (error) {
          failed(error);
          this.onJournal(error.message);
        }
      };
    });
  }

  async #serveRead(socket, driver, command) {
    if (this.busy || this.socket !== socket) return;
    this.busy = true;
    this.onChange();
    const check = () => {
      if (socket.readyState !== 1 || this.socket !== socket || this.lost) throw new Error('device_session_changed');
    };
    try {
      check();
      if (command.command !== 'flash.read') throw new Error('operation_unsupported');
      this.onJournal('Lecture flash en cours');
      const started = performance.now();
      const data = await driver.readFlash(command.address, command.size, check);
      const elapsed = Math.max(1, performance.now() - started);
      check();
      socket.send(data);
      if (data.length === command.size) this.flashReadRate = data.length * 1000 / elapsed;
      this.onJournal('Lecture flash terminée');
    } catch (error) {
      if (socket.readyState === 1) socket.send(command.id);
      this.onJournal(error.message);
    } finally {
      this.busy = false;
      if (!this.requesting && (this.lost || socket.readyState !== 1)) await this.disconnect();
      this.onChange();
    }
  }

  async #closeSession() {
    const session = this.session;
    const socket = this.socket;
    this.session = this.socket = this.identity = null;
    socket?.close();
    try {
      await session?.close();
    } catch (error) {
      // Retain ownership if close fails so cleanup can retry the same handle.
      this.session = session;
      throw error;
    }
  }

  async #clearSession() {
    try {
      await this.#closeSession();
    } finally {
      this.lastIdentity = this.romJedec = null;
      this.boot = new BootIdentity();
      this.#setMode('disconnected');
    }
  }

  async disconnect(lost = false) {
    if (lost) {
      this.lost = true;
      this.socket?.close();
    }
    if (this.mode === 'connecting' || this.mode === 'closing' || this.requesting || this.busy) return;
    if (this.mode === 'disconnected' && !this.session) return;
    this.#setMode('closing');
    await this.#clearSession();
    this.onJournal('Port fermé');
  }

  async #exclusive(action, allowDisconnected = false) {
    const available = ['console', 'loader'].includes(this.mode) || (allowDisconnected && this.mode === 'disconnected');
    if (this.requesting || this.busy || !available) {
      throw new Error('Carte indisponible.');
    }
    this.requesting = true;
    this.onChange();
    try {
      const result = await action();
      if (this.lost) throw new Error('Port USB déconnecté.');
      return result;
    } finally {
      try {
        if (this.lost || (this.mode === 'loader' && this.socket?.readyState !== 1)) {
          await this.#clearSession();
        }
      } finally {
        this.requesting = false;
        this.onChange();
      }
    }
  }

  async #resumeConsole() {
    this.#setMode('connecting');
    await this.#closeSession();
    await this.#openConsole();
    if (this.resetWait) {
      await this.reset(this.port, this.resetWait);
    } else {
      this.onJournal('Console ouverte · redémarre la carte si elle est encore en téléchargement.');
    }
  }

  async #withLoader(operation) {
    return this.#exclusive(async () => {
      if (this.mode === 'loader') return operation();
      if (!this.canEnterLoader) {
        throw new Error('Place la carte en mode téléchargement, puis reconnecte-la dans IDLab.');
      }
      this.#setMode('connecting');
      this.onJournal('Passage au chargeur…');
      let result, failure;
      try {
        await this.#closeSession();
        await this.#openLoader('stub', {temporary: true});
        result = await operation();
      } catch (error) {
        failure = error;
      }
      if (!this.lost) {
        try {
          this.onJournal('Retour en console…');
          await this.#resumeConsole();
        } catch (error) {
          await this.#clearSession();
          throw new Error((failure ? failure.message + ' · ' : '') + 'Retour console impossible : ' + error.message);
        }
      }
      if (failure) throw failure;
      return result;
    });
  }

  identify() {
    return this.#withLoader(() => this.identity);
  }

  readFlash(address, size) {
    return this.#withLoader(async () => {
      const identity = this.identity;
      if (!identity.capabilities.includes('flash.read')) throw new Error('Lecture flash indisponible pour ce chargeur.');
      const response = await this.request('/devices/' + this.name + '/flash/read', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({generation: identity.generation, address, size}),
      });
      return {blob: await response.blob(), capacity: identity.flash_size};
    });
  }

  enterLoader() {
    return this.#exclusive(async () => {
      if (this.mode !== 'console') return;
      if (!this.canEnterLoader) throw new Error('Place la carte en mode téléchargement, puis reconnecte-la dans IDLab.');
      this.#setMode('connecting');
      try {
        await this.#closeSession();
        await this.#openLoader('stub');
      } catch (error) {
        await this.#clearSession();
        throw error;
      }
    });
  }

  enterRom({reset = this.canResetIntoRom} = {}) {
    return this.#exclusive(async () => {
      if (this.identity?.loader === 'rom') return this.identity;
      const resetToRom = reset && this.canResetIntoRom;
      const previousMode = this.mode;
      const wasRegistered = Boolean(this.identity);
      this.lost = false;
      this.#setMode('connecting');
      try {
        await this.#closeSession();
        if (wasRegistered) await this.#waitForUnregister();
        if (this.lost) throw new Error('Port USB déconnecté.');
        await this.#openLoader('rom', {resetToRom});
        return this.identity;
      } catch (error) {
        if (previousMode === 'console' && !this.lost) {
          try {
            await this.#closeSession();
            await this.#openConsole();
          } catch (recoveryError) {
            await this.#clearSession();
            throw new Error(error.message + ' · Console indisponible : ' + recoveryError.message);
          }
        } else {
          await this.#clearSession();
        }
        throw error;
      }
    }, true);
  }

  async #waitForUnregister() {
    // The gateway can finish closing the old agent after the local port closes.
    // Wait for its registration to disappear before using the same card name.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await this.request('/devices/' + this.name);
      } catch (error) {
        if (error.message === 'device_disconnected') return;
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('L’ancienne session du chargeur est encore enregistrée.');
  }

  readRomJedec() {
    return this.#exclusive(async () => {
      if (this.mode !== 'loader' || this.identity?.loader !== 'rom') {
        throw new Error('Ouvre une session ROM seule.');
      }
      this.romJedec = await this.session.readJedec();
      return this.romJedec;
    });
  }

  restart() {
    return this.#exclusive(async () => {
      if (this.mode !== 'console' || !this.resetWait) throw new Error('Reset indisponible.');
      await this.reset(this.port, this.resetWait);
      this.onJournal('Redémarrage du firmware demandé');
    });
  }

  write(bytes) {
    return this.#exclusive(() => {
      if (this.mode !== 'console') throw new Error('Console indisponible.');
      return this.session.write(bytes);
    });
  }
}
