import { EspDriver, connectionPlan } from './esp-driver.js';
import { openSerialConsole, resetConsole } from './serial-console.js';
import { ConsoleBuffer } from './console-buffer.js';
import { BootIdentity } from './boot-identity.js';

async function api(path, options) {
  const response = await fetch('/api/v1' + path, options);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error ?? ('HTTP ' + response.status));
  }
  return response;
}

export class BoardConnector {
  constructor(name, port, {baud, manual, use, onChange, onCapture, onJournal}, {
    request = api, loadTools = () => import('/esptool.js'),
    createSocket = url => new WebSocket(url), openConsole = openSerialConsole, reset = resetConsole,
    origin = location.href,
  } = {}) {
    Object.assign(this, {name, port, baud, manual, use, onChange, onCapture, onJournal,
      request, loadTools, createSocket, openConsole, reset, origin});
    const info = port.getInfo();
    this.transport = connectionPlan(info, {}).transport;
    this.resetWait = {usb_uart: 100, usb_serial_jtag: 200}[this.transport];
    this.portLabel = info.usbVendorId == null ? 'Port série' :
      [info.usbVendorId, info.usbProductId].filter(Number.isInteger)
        .map(value => value.toString(16).padStart(4, '0')).join(':');
    this.mode = 'disconnected';
    this.busy = false;
    this.requesting = false;
    this.lost = false;
    this.romJedec = null;
    this.capture = new ConsoleBuffer();
    this.boot = new BootIdentity();
  }

  get canEnterLoader() {
    return !this.manual && Boolean(this.resetWait);
  }

  get consoleUnavailable() {
    return this.manual || (this.mode === 'loader' && this.identity?.loader === 'rom' && !this.canEnterLoader);
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
      if (this.use !== 'console') {
        await this.#openLoader(this.use);
        if (this.identity) return;
      }
      if (this.manual) {
        throw new Error('Chargeur non détecté. Maintiens BOOT, appuie sur RESET, relâche BOOT, puis reconnecte la carte.');
      }
      await this.#openConsole();
    } catch (error) {
      await this.#clearSession();
      throw error;
    }
  }

  async #openConsole() {
    if (this.lost) throw new Error('Port USB déconnecté.');
    this.boot.tail = '';
    const session = await this.openConsole(this.port, this.baud, null, bytes => {
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
    this.onJournal('Console ouverte à ' + this.baud + ' bauds');
  }

  async #openLoader(use) {
    if (this.lost) throw new Error('Port USB déconnecté.');
    const driver = new EspDriver(this.port, await this.loadTools());
    if (this.lost) throw new Error('Port USB déconnecté.');
    this.session = driver;
    const identity = await driver.connect({auto: use === 'auto', romOnly: use === 'rom', manualEntry: this.manual, resetToRom: use === 'rom'});
    if (this.lost) throw new Error('Port USB déconnecté.');
    if (!identity) {
      await this.#closeSession();
      if (!this.manual) this.onJournal('Pas de réponse du chargeur sans reset · ouverture console');
      return;
    }
    this.identity = await this.#register(driver);
    this.romJedec = null;
    if (this.lost) throw new Error('Port USB déconnecté.');
    this.lastIdentity = this.identity;
    this.#setMode('loader');
    this.onJournal('Chargeur détecté · ' + (identity.model ?? identity.chip));
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
      socket.send(await driver.readFlash(command.address, command.size, check));
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
        throw new Error('Place la carte en mode téléchargement, puis reconnecte-la en mode Automatique.');
      }
      this.#setMode('connecting');
      this.onJournal('Passage au chargeur…');
      let result, failure;
      try {
        await this.#closeSession();
        await this.#openLoader('stub');
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
      if (!this.canEnterLoader) throw new Error('Place la carte en mode téléchargement, puis reconnecte-la en mode Automatique.');
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

  enterRom() {
    return this.#exclusive(async () => {
      if (this.identity?.loader === 'rom') return this.identity;
      const previousMode = this.mode;
      const wasRegistered = Boolean(this.identity);
      this.lost = false;
      this.#setMode('connecting');
      try {
        await this.#closeSession();
        if (wasRegistered) await this.#waitForUnregister();
        if (this.lost) throw new Error('Port USB déconnecté.');
        await this.#openLoader('rom');
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

  returnConsole() {
    return this.#exclusive(async () => {
      if (this.mode !== 'loader') return;
      if (this.consoleUnavailable) {
        if (this.manual) throw new Error('Pour utiliser la console, redémarre sans BOOT puis ajoute la carte en Console seule.');
        throw new Error('Déconnecte la carte, appuie sur RESET sans maintenir BOOT, puis reconnecte-la.');
      }
      try { await this.#resumeConsole(); }
      catch (error) { await this.#clearSession(); throw error; }
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
