import { ESP_SYNC_BAUD, MAX_FLASH_READ, EspDriver, connectionPlan } from './esp-driver.js';
import { openSerialConsole, resetConsole } from './serial-console.js';

const CONSOLE_BAUD = 115200;
const toHex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
export const sha256 = async bytes => toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));

function diagnosticCode(error, fallback = 'device_command_failed') {
  for (const cause of [error, error?.cause]) {
    const code = cause?.code ?? cause?.message;
    if (typeof code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(code)) return code;
  }
  return fallback;
}

async function api(path, options) {
  const response = await fetch('/api/v1' + path, options);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error === 'operation_cancelled' ? 'Opération interrompue.'
      : error.detail ?? error.error ?? ('HTTP ' + response.status));
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

  async connect({romOnly = false, identifyOnConnect = false} = {}) {
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
    if (!identifyOnConnect) return;
    if (this.mode === 'console' && !this.lastIdentity?.flash_size && this.canEnterLoader) {
      try {
        await this.identify();
      } catch (error) {
        if (this.mode !== 'console' || this.lost || this.socket?.readyState !== 1) throw error;
        return error.message === 'Failed to connect with the device'
          ? 'La carte ne répond pas en mode téléchargement.' : error.message;
      }
    }
    if (!this.lastIdentity?.flash_size) {
      return this.mode === 'console' && !this.canEnterLoader
        ? 'Ce port exige une entrée manuelle en téléchargement avec BOOT et RESET.'
        : 'La capacité de la flash n’a pas pu être mesurée.';
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
        const detail = driver.connectionStage + ' · délai série dépassé (' + error.message + ')';
        const recovery = fromConsole && this.transport === 'usb_serial_jtag' && driver.identificationAfterSync
          ? ' Appuie sur RESET sans maintenir BOOT, recharge la page et reconnecte la carte avant de rouvrir le chargeur.' : '';
        throw new Error(detail + recovery, {cause: error});
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
    identity = {...identity, programmable: true};
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
    const readDiagnostic = command.command === 'flash.read' ? {} : null;
    this.onChange();
    const check = () => {
      if (this.commandCancelled) throw new Error('Opération interrompue par l’opérateur.');
      if (socket.readyState !== 1 || this.socket !== socket || this.lost) throw new Error('device_session_changed');
    };
    try {
      check();
      if (command.command === 'flash.read') {
        const capacity = await this.#withLoader(() => this.#readFlashBlocks(socket, command, check), readDiagnostic);
        check();
        if (command.stream) socket.send(JSON.stringify({result: command.id, value: capacity}));
      } else if (command.command === 'flash.program') {
        const {digests, previews} = await this.#programFlash(socket, command, check);
        check();
        socket.send(JSON.stringify({result: command.id, value: digests, previews}));
      } else if (command.command === 'flash.erase' || command.command === 'flash.erase.region') {
        const value = await this.#eraseFlash(socket, command, check);
        check();
        socket.send(JSON.stringify({result: command.id, value}));
      } else {
        const value = await this.#runCommand(command);
        check();
        socket.send(JSON.stringify({result: command.id, value}));
      }
    } catch (error) {
      if (socket.readyState === 1) {
        const code = this.commandCancelled ? 'operation_cancelled'
          : error.message === 'invalid_flash_range' ? 'invalid_flash_range' : 'device_command_failed';
        socket.send(command.command === 'flash.read' && !command.stream && !this.commandCancelled ? command.id
          : JSON.stringify({result: command.id, error: code, console_restored: this.mode === 'console',
            read_diagnostic: readDiagnostic ? {
              ...readDiagnostic, error: readDiagnostic.error ?? diagnosticCode(error, code),
            } : undefined,
            detail: ['mode.loader', 'identify', 'flash.program', 'flash.erase', 'flash.erase.region'].includes(command.command)
              ? error.message : undefined}));
      }
      this.#log(error.message);
    } finally {
      if (this.flashTransferInterrupted) {
        this.flashTransferInterrupted = false;
        socket.close();
      }
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
      this.socket.send(JSON.stringify({journal: message, operation: this.activeCommand ?? undefined}));
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
    let received = 0;
    let reported;
    const baudrate = this.identity.transport === 'usb_uart' ? this.session.transport.baudrate : undefined;
    const progress = (count, force = false) => {
      received = count;
      const now = performance.now();
      if (!force && received < size && now - lastUpdate < 250) return;
      lastUpdate = now;
      socket.send(JSON.stringify({id, progress: {address, received, total: size, baudrate}}));
      reported = received;
    };
    progress(0);
    try {
      for (let offset = 0; offset < size; offset += MAX_FLASH_READ) {
        check();
        const length = Math.min(MAX_FLASH_READ, size - offset);
        const data = await this.session.readFlash(address + offset, length, check, count => progress(offset + count));
        if (received < offset + data.length) progress(offset + data.length);
        check();
        socket.send(data);
      }
    } catch (error) {
      // Preserve the latest count even when the last packet fell inside the UI throttle window.
      if (socket.readyState === 1 && received !== reported) progress(received, true);
      throw error;
    }
    this.#log('Lecture flash terminée · ' + size + ' octets');
    return capacity;
  }

  async #programFlash(socket, {id, images}, check) {
    const capacity = this.identity.flash_size;
    if (this.mode !== 'loader' || this.identity.loader !== 'stub' || !capacity) {
      throw new Error('Le chargeur flash doit être ouvert pour programmer.');
    }
    const files = [];
    let end = 0;
    const regions = [...images].sort((a, b) => a.address - b.address);
    for (const {address, size} of regions) {
      if (!Number.isSafeInteger(address) || !Number.isSafeInteger(size) ||
          address % 4096 || address < end || size < 1 || address + Math.ceil(size / 4096) * 4096 > capacity) {
        throw new Error('invalid_flash_range');
      }
      end = address + Math.ceil(size / 4096) * 4096;
    }
    const total = images.reduce((sum, image) => sum + image.size, 0);
    let lastUpdate = -Infinity;
    const progress = (phase, address, received, force = false) => {
      const now = performance.now();
      if (!force && received < total && now - lastUpdate < 250) return;
      lastUpdate = now;
      socket.send(JSON.stringify({id, progress: {phase, address, received, total}}));
    };
    for (const [index, image] of images.entries()) {
      check();
      const response = await this.request(`/devices/${this.name}/flash/program/${id}/${index}`);
      const data = new Uint8Array(await response.arrayBuffer());
      if (data.length !== image.size || await sha256(data) !== image.sha256) {
        throw new Error('Le binaire reçu diffère du plan validé.');
      }
      files.push({address: image.address, data});
    }
    const offsets = [0];
    for (const {size} of images) offsets.push(offsets.at(-1) + size);
    check();
    // An interrupted write or readback can leave the stub in a transfer.
    this.flashTransferInterrupted = true;
    progress('write', images[0].address, 0, true);
    await this.session.programFlash(files, check, (index, sent, compressed) => {
      const {address, size} = images[index];
      progress('write', address, offsets[index] + Math.floor(size * sent / compressed));
    });
    this.#log('Programmation terminée · relecture SHA-256');
    const digests = [];
    const previews = [];
    progress('verify', images[0].address, 0, true);
    for (const [index, {address, size}] of images.entries()) {
      const readback = new Uint8Array(size);
      for (let offset = 0; offset < size; offset += MAX_FLASH_READ) {
        check();
        const length = Math.min(size - offset, MAX_FLASH_READ);
        const block = await this.session.readFlash(address + offset, length, check,
          received => progress('verify', address, offsets[index] + offset + received));
        readback.set(block, offset);
      }
      digests.push(await sha256(readback));
      previews.push(toHex(readback.subarray(0, 256)));
    }
    this.flashTransferInterrupted = false;
    return {digests, previews};
  }

  async #eraseFlash(socket, command, check) {
    const {id, command: type} = command;
    if (!this.identity?.capabilities.includes(type) || !this.session?.identity?.erasable) {
      throw new Error('Effacement indisponible sur cette carte.');
    }
    const region = type === 'flash.erase.region' ? {address: command.address, size: command.size} : undefined;
    const {address, size: total} = region ?? {address: 0, size: this.identity.flash_size};
    let lastUpdate = -Infinity;
    const progress = (phase, received) => {
      const now = performance.now();
      if (received && received < total && now - lastUpdate < 250) return;
      lastUpdate = now;
      socket.send(JSON.stringify({id, progress: {phase, address, received, total}}));
    };
    this.flashTransferInterrupted = true;
    progress('erase', 0);
    this.#log(region ? 'Effacement de la zone flash · vérification par relecture'
      : 'Effacement intégral · vérification de tous les octets après effacement');
    const result = await this.session.eraseFlash(check, received => progress('erase-verify', received), region);
    this.flashTransferInterrupted = false;
    return result;
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
      this.#log('UART TX · ' + hex);
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

  async #clearSession({keepIdentity = false} = {}) {
    try {
      await this.#closeSession();
    } finally {
      if (!keepIdentity || this.lost) this.lastIdentity = null;
      this.#setMode('disconnected');
    }
  }

  async disconnect(lost = false) {
    if (lost) {
      if (this.identity && !this.lost && this.mode !== 'closing') this.onLinkLost();
      this.lost = true;
      this.lastIdentity = null;
      this.socket?.close();
    }
    if (this.mode === 'connecting' || this.mode === 'closing' || this.requesting || this.busy) return;
    if (this.mode === 'disconnected' && !this.session) return;
    this.#setMode('closing');
    await this.#clearSession({keepIdentity: !lost});
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

  async #withLoader(operation, diagnostic = null) {
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
    } catch (error) {
      if (diagnostic) diagnostic.error = diagnosticCode(error, this.commandCancelled ? 'operation_cancelled' : undefined);
      throw error;
    } finally {
      if (!this.lost && this.socket?.readyState === 1) {
        this.#log('Retour en console…');
        try {
          await this.#resumeConsole();
          if (diagnostic) diagnostic.console_restored = true;
        } catch (error) {
          if (diagnostic) {
            diagnostic.console_restored = false;
            diagnostic.console_error = diagnosticCode(error);
          }
          throw error;
        }
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

  eraseFlash(confirmation) { return this.#command('flash.erase', {confirmation}); }

  eraseFlashRegion(confirmation, address, size) {
    return this.#command('flash.erase.region', {confirmation, address, size});
  }

  prepareProgram(images) {
    return this.#programRequest('plan', {images});
  }

  programFlash(planId, binaries) {
    return this.#programRequest('program', {plan_id: planId, binaries}, true);
  }

  #programRequest(path, fields, campaign = false) {
    const body = campaign ? this.#operationBody(fields) : JSON.stringify({generation: this.identity.generation, ...fields});
    return this.#exclusive(async () => (await this.request(`/devices/${this.name}/flash/${path}`, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body,
    })).json());
  }

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
