import { ESP_SYNC_BAUD, MAX_FLASH_READ, EspDriver, connectionPlan } from './esp-driver.js';
import { openSerialConsole, resetConsole } from './serial-console.js';

const CONSOLE_BAUD = 115200;
const toHex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

async function api(path, options) {
  const response = await fetch('/api/v1' + path, options);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail ?? error.error ?? ('HTTP ' + response.status));
  }
  return response;
}

export class BoardConnector {
  constructor(name, port, {flashBaud = ESP_SYNC_BAUD, onChange, onLinkLost = () => {}, campaignId = () => null}, {
    request = api, loadTools = () => import('/esptool.js'),
    createSocket = url => new WebSocket(url), openConsole = openSerialConsole, reset = resetConsole,
    origin = location.href,
  } = {}) {
    Object.assign(this, {name, port, flashBaud, onChange, onLinkLost, campaignId,
      request, loadTools, createSocket, openConsole, reset, origin});
    const info = port.getInfo();
    this.transport = connectionPlan(info, {}).transport;
    this.resetWait = {usb_uart: 100, usb_serial_jtag: 200}[this.transport];
    this.portLabel = info.usbVendorId == null ? 'Port série' :
      [info.usbVendorId, info.usbProductId].filter(Number.isInteger)
        .map(value => value.toString(16).padStart(4, '0')).join(':');
    this.mode = 'disconnected';
    this.portKey = crypto.randomUUID();
    this.lastLoaderBaud = ESP_SYNC_BAUD;
    this.temporaryLoader = false;
    this.loaderFromConsole = false;
    this.busy = false;
    this.requesting = false;
    this.lost = false;
    this.startupJournal = [];
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

  get canReturnToConsole() {
    return this.mode === 'loader' && this.loaderFromConsole && this.canEnterLoader;
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

  async connect({romOnly = false} = {}) {
    if (this.mode !== 'disconnected') return;
    this.lost = false;
    this.#setMode('connecting');
    try {
      if (this.session) await this.#closeSession();
      if (romOnly) { await this.#openLoader('rom'); return; }
      await this.#openLoader('auto');
      if (!this.identity && this.lastLoaderBaud !== ESP_SYNC_BAUD) {
        await this.#openLoader('auto', {initialBaud: this.lastLoaderBaud});
      }
      if (!this.identity) {
        this.lastLoaderBaud = ESP_SYNC_BAUD;
        this.#log('Pas de réponse du chargeur sans reset · ouverture console');
        await this.#openConsole();
      }
    } catch (error) {
      await this.#clearSession();
      throw error;
    }
  }

  async #openConsole(restart = false) {
    if (this.lost) throw new Error('Port USB déconnecté.');
    const startupBytes = [];
    let ready = false;
    const sendUart = bytes => {
      if (this.socket?.readyState === 1) {
        for (let offset = 0; offset < bytes.length; offset += 65536) {
          this.socket.send(JSON.stringify({uart: toHex(bytes.subarray(offset, offset + 65536))}));
        }
      }
    };
    const session = await this.openConsole(this.port, CONSOLE_BAUD, null, bytes => {
      if (ready) sendUart(bytes);
      else startupBytes.push(new Uint8Array(bytes));
    });
    this.session = session;
    const ended = error => {
      if (this.session !== session) return;
      if (error) this.#log(error.message);
      this.disconnect(true).catch(failure => this.#log(failure.message));
    };
    session.done.then(() => ended(), ended);
    if (restart) await this.reset(this.port, this.resetWait);
    this.identity = await this.#publishIdentity({mode: 'console', transport: this.transport});
    if (this.lost) throw new Error('Port USB déconnecté.');
    ready = true;
    for (const bytes of startupBytes.splice(0)) sendUart(bytes);
    this.#setMode('console');
    this.#log('Console ouverte à ' + CONSOLE_BAUD + ' bauds');
  }

  async #openLoader(use, {temporary = false, fromConsole = false, resetToRom = false, initialBaud = ESP_SYNC_BAUD} = {}) {
    if (this.lost) throw new Error('Port USB déconnecté.');
    const driver = new EspDriver(this.port, await this.loadTools(), initialBaud);
    if (this.lost) throw new Error('Port USB déconnecté.');
    this.session = driver;
    const identity = await driver.connect({
      auto: use === 'auto', romOnly: use === 'rom', resetToRom, flashBaud: this.flashBaud,
    }).catch(error => {
      if (error.message === 'serial_timeout' || error.message === 'serial_partial_packet') {
        throw new Error(driver.connectionStage + ' · délai série dépassé (' + error.message + ')', {cause: error});
      }
      throw error;
    });
    if (this.lost) throw new Error('Port USB déconnecté.');
    if (!identity) {
      await this.#closeSession();
      return;
    }
    this.identity = await this.#publishIdentity({
      ...identity, mode: 'loader', return_to_console: fromConsole && this.canEnterLoader,
    });
    if (this.lost) throw new Error('Port USB déconnecté.');
    this.lastIdentity = this.identity;
    this.lastLoaderBaud = driver.transport.baudrate || ESP_SYNC_BAUD;
    this.temporaryLoader = temporary;
    this.loaderFromConsole = fromConsole;
    this.#setMode('loader');
    this.#log('Chargeur détecté · ' + (identity.model ?? identity.chip));
    if (identity.transport === 'usb_uart') this.#log('Débit chargeur · ' + this.lastLoaderBaud + ' bauds');
  }

  #publishIdentity(identity) {
    if (!this.socket) return this.#register(identity);
    return new Promise((resolve, reject) => {
      const settle = (error, value) => {
        clearTimeout(deadline);
        this.identityReply = null;
        if (error) reject(error);
        else resolve(value);
      };
      const deadline = setTimeout(() => settle(new Error('Mode non confirmé par le serveur.')), 3000);
      this.identityReply = settle;
      try { this.socket.send(JSON.stringify({identity})); }
      catch (error) { settle(error); }
    });
  }

  #register(identity) {
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
      socket.onopen = () => socket.send(JSON.stringify({...identity, port_key: this.portKey}));
      socket.onclose = () => {
        failed(interrupted);
        if (this.socket !== socket) return;
        if (this.identity && !this.lost && this.mode !== 'closing') this.onLinkLost();
        this.identityReply?.(interrupted);
        if (!this.lost && !this.requesting && !this.busy) {
          this.disconnect().catch(error => this.#log(error.message));
        }
      };
      socket.onmessage = async event => {
        if (this.socket !== socket) return;
        try {
          const command = JSON.parse(event.data);
          if (command.control) {
            this.control = command.control;
            this.hasControlToken = command.has_token;
            this.onChange();
          } else if (command.cancel) {
            if (command.cancel === this.activeCommand) this.commandCancelled = true;
          } else if (command.identity) {
            this.identityReply?.(null, command.identity);
          } else if (command.generation) {
            const identity = await this.request('/devices/' + this.name).then(reply => reply.json());
            if (socket.readyState !== 1) throw interrupted;
            this.control = identity.control;
            this.hasControlToken = command.has_token;
            for (const message of this.startupJournal.splice(0)) socket.send(JSON.stringify({journal: message}));
            registered(identity);
          } else {
            await this.#serveCommand(socket, command);
          }
        } catch (error) {
          failed(error);
          this.#log(error.message);
        }
      };
    });
  }

  async #serveCommand(socket, command) {
    if (this.busy || this.socket !== socket) return;
    this.busy = true;
    this.activeCommand = command.id;
    this.onChange();
    const check = () => {
      if (this.commandCancelled) throw new Error('Opération interrompue par l’opérateur.');
      if (socket.readyState !== 1 || this.socket !== socket || this.lost) throw new Error('device_session_changed');
    };
    try {
      check();
      if (command.command === 'flash.read') {
        const capacity = await this.#withLoader(() => this.#readFlashBlocks(socket, command, check));
        check();
        if (command.stream) socket.send(JSON.stringify({result: command.id, value: capacity}));
      } else {
        const value = await this.#runCommand(command);
        check();
        socket.send(JSON.stringify({result: command.id, value}));
      }
    } catch (error) {
      if (socket.readyState === 1) {
        socket.send(command.command === 'flash.read' && !command.stream ? command.id
          : JSON.stringify({result: command.id, error: error.message === 'invalid_flash_range'
            ? 'invalid_flash_range' : 'device_command_failed', console_restored: this.mode === 'console',
            detail: command.command === 'mode.loader' ? error.message : undefined}));
      }
      this.#log(error.message);
    } finally {
      this.activeCommand = null;
      this.commandCancelled = false;
      this.busy = false;
      if (this.mode === 'connecting') await this.#clearSession();
      else if (!this.requesting && (this.lost || socket.readyState !== 1)) await this.disconnect();
      this.onChange();
    }
  }

  #log(message) {
    if (this.identity && this.socket?.readyState === 1) {
      this.socket.send(JSON.stringify({journal: message}));
    } else {
      this.startupJournal.push(message);
      if (this.startupJournal.length > 20) this.startupJournal.shift();
    }
  }

  async #readFlashBlocks(socket, {id, address, size}, check) {
    const capacity = this.identity.flash_size;
    if (!this.identity.capabilities.includes('flash.read') || !Number.isSafeInteger(address) ||
        !Number.isSafeInteger(size) || address < 0 || size < 1 || address + size > capacity) {
      throw new Error('invalid_flash_range');
    }
    let lastUpdate = -Infinity;
    const progress = received => {
      const now = performance.now();
      if (received < size && now - lastUpdate < 250) return;
      lastUpdate = now;
      socket.send(JSON.stringify({id, progress: {address, received, total: size}}));
    };
    progress(0);
    for (let offset = 0; offset < size; offset += MAX_FLASH_READ) {
      check();
      const length = Math.min(MAX_FLASH_READ, size - offset);
      const data = await this.session.readFlash(address + offset, length, check, received => progress(offset + received));
      check();
      socket.send(data);
    }
    this.#log('Lecture flash terminée · ' + size + ' octets');
    return capacity;
  }

  async #runCommand({command, hex, reset}) {
    if (command === 'mode.loader' && this.mode === 'console' && this.canEnterLoader) {
      await this.#enterLoaderFromConsole();
    } else if (command === 'mode.console' && this.canReturnToConsole) {
      await this.#resumeConsole();
    } else if (command === 'console.reset' && this.mode === 'console' && this.resetWait) {
      await this.reset(this.port, this.resetWait);
      this.#log('Redémarrage du firmware demandé');
    } else if (command === 'uart.write' && this.mode === 'console') {
      const bytes = Uint8Array.from(hex.match(/../g), byte => parseInt(byte, 16));
      await this.session.write(bytes);
      this.socket.send(JSON.stringify({journal: 'UART TX · ' + hex}));
    } else if (command === 'mode.rom') {
      await this.#enterRom(reset);
    } else if (command === 'rom.jedec' && this.mode === 'loader' && this.identity?.loader === 'rom') {
      return this.session.readJedec();
    } else if (command === 'identify') {
      return this.#withLoader(() => this.identity);
    } else {
      throw new Error('Commande indisponible dans ce mode.');
    }
  }

  async #closeSession(keepAgent = false) {
    const session = this.session;
    const socket = this.socket;
    this.session = null;
    this.loaderFromConsole = false;
    if (!keepAgent || socket?.readyState !== 1) {
      this.socket = this.identity = this.control = null;
      socket?.close();
    }
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
      this.lastIdentity = null;
      this.#setMode('disconnected');
    }
  }

  async disconnect(lost = false) {
    if (lost) {
      if (this.identity && !this.lost && this.mode !== 'closing') this.onLinkLost();
      this.lost = true;
      this.socket?.close();
    }
    if (this.mode === 'connecting' || this.mode === 'closing' || this.requesting || this.busy) return;
    if (this.mode === 'disconnected' && !this.session) return;
    this.#setMode('closing');
    await this.#clearSession();
    this.#log('Port fermé');
  }

  async #exclusive(action) {
    const available = ['console', 'loader'].includes(this.mode);
    if (this.control === 'external' || this.control === 'stopping' || this.requesting || this.busy || !available) {
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
        if (this.lost || (['console', 'loader'].includes(this.mode) && this.socket?.readyState !== 1)) {
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
    await this.#closeSession(true);
    await this.#openConsole(true);
  }

  async #enterLoaderFromConsole() {
    this.#setMode('connecting');
    this.#log('Passage au chargeur…');
    try {
      await this.#closeSession(true);
      await this.#openLoader('stub', {fromConsole: true});
    } catch (error) {
      if (this.lost || this.socket?.readyState !== 1 || this.commandCancelled) throw error;
      try {
        await this.#resumeConsole();
      } catch (recoveryError) {
        throw new Error(error.message + ' · Console indisponible : ' + recoveryError.message);
      }
      throw error;
    }
  }

  async #withLoader(operation) {
    if (this.mode === 'loader') return operation();
    if (this.mode !== 'console' || !this.canEnterLoader) {
      throw new Error('Place la carte en mode téléchargement, puis reconnecte-la dans IDLab.');
    }
    this.#setMode('connecting');
    this.#log('Passage au chargeur…');
    try {
      await this.#closeSession(true);
      await this.#openLoader('stub', {temporary: true});
      return await operation();
    } finally {
      if (!this.lost && this.socket?.readyState === 1) {
        this.#log('Retour en console…');
        await this.#resumeConsole();
      }
    }
  }

  async identify() {
    return (await this.#command('identify')).result;
  }

  readFlash(address, size) {
    return this.#exclusive(async () => {
      const response = await this.request('/devices/' + this.name + '/flash/read', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: this.#operationBody({address, size}),
      });
      return {blob: await response.blob(), capacity: Number(response.headers.get('X-IDLab-Flash-Size'))};
    });
  }

  enterLoader() { return this.#command('mode.loader'); }

  returnConsole() {
    if (!this.canReturnToConsole) return Promise.reject(new Error('Un RESET manuel sans BOOT est nécessaire.'));
    return this.#command('mode.console');
  }

  async enterRom({reset = this.canResetIntoRom} = {}) {
    if (this.mode !== 'disconnected') return this.#command('mode.rom', {reset});
    await this.connect({romOnly: true});
    return this.identity;
  }

  async #enterRom(reset) {
    if (this.identity?.loader === 'rom') return this.identity;
    const resetToRom = reset && this.canResetIntoRom;
    const previousMode = this.mode;
    const fromConsole = this.canEnterLoader && (previousMode === 'console' || this.loaderFromConsole);
    this.lost = false;
    this.#setMode('connecting');
    try {
      await this.#closeSession(true);
      if (this.lost) throw new Error('Port USB déconnecté.');
      await this.#openLoader('rom', {resetToRom, fromConsole});
      return this.identity;
    } catch (error) {
      if (previousMode === 'console' && !this.lost) {
        try {
          await this.#closeSession(true);
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
  }

  readRomJedec() { return this.#command('rom.jedec'); }

  restart() {
    if (this.mode !== 'console' || !this.resetWait) return Promise.reject(new Error('Reset indisponible.'));
    return this.#command('console.reset');
  }

  write(bytes) {
    const payload = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
    return this.#command('uart.write', {hex: toHex(payload)});
  }

  #command(command, args = {}) {
    return this.#exclusive(async () => (await this.request('/devices/' + this.name + '/command', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: this.#operationBody({command, ...args}),
    })).json());
  }

  #operationBody(fields) {
    const campaignId = this.campaignId();
    const body = {generation: this.identity.generation, ...fields};
    if (campaignId) body.campaign_id = campaignId;
    return JSON.stringify(body);
  }
}
