import { EspDriver } from './esp-driver.js';
import { openSerialConsole } from './serial-console.js';

const form = document.querySelector('#connect');
const status = document.querySelector('#status');
const usedPorts = new Set();
const sessions = new Map();

async function api(path, options) {
  const result = await fetch('/api/v1' + path, options);
  if (!result.ok) throw new Error((await result.json()).error);
  return result;
}

function flashNumber(value) {
  if (!/^(0x[0-9a-f]+|[0-9]+)$/i.test(value)) throw new Error('Adresse ou taille invalide.');
  return Number(value);
}

function showCard(name, card, label) {
  card.id = 'card-' + name;
  document.querySelector('#boards').append(card);
  const link = document.createElement('a');
  link.href = '#' + card.id;
  link.textContent = name + ' · ' + label;
  const list = document.querySelector('#card-list');
  const empty = document.querySelector('#empty-cards');
  list.append(link);
  empty.hidden = true;
  return () => {
    card.remove();
    link.remove();
    empty.hidden = list.children.length > 0;
  };
}

async function connectConsole(name, port, baudRate) {
  const card = document.querySelector('#serial-console').content.firstElementChild.cloneNode(true);
  card.querySelector('h2').textContent = 'Console série · ' + name;
  card.querySelector('[data-baud]').textContent = baudRate.toLocaleString('fr') + ' bauds';
  const screen = card.querySelector('.console');
  const controls = card.querySelector('form');
  const output = card.querySelector('output');
  const session = await openSerialConsole(port, baudRate, text => {
    screen.textContent = (screen.textContent + text).slice(-128000);
    if (controls.elements.follow.checked) screen.scrollTop = screen.scrollHeight;
  });

  const remove = showCard(name, card, 'Console');
  const endings = { lf: '\n', crlf: '\r\n', cr: '\r', none: '' };
  let closing;
  function close() {
    closing ??= (async () => {
      try {
        await session.close();
      } catch (error) {
        status.value = error.message;
      } finally {
        remove();
        usedPorts.delete(port);
        sessions.delete(name);
      }
    })();
    return closing;
  }

  sessions.set(name, { port, close });
  session.done.then(close, error => {
    status.value = error.message;
    return close();
  });
  card.querySelector('[data-disconnect]').onclick = close;
  card.querySelector('[data-clear]').onclick = () => { screen.textContent = ''; };
  controls.onsubmit = async event => {
    event.preventDefault();
    const line = controls.elements.line;
    const button = controls.querySelector('button[type=submit], button.primary');
    if (button.disabled) return;
    button.disabled = true;
    try {
      await session.write(line.value + endings[controls.elements.ending.value]);
      line.value = '';
      output.value = '';
    } catch (error) {
      output.value = error.message;
    } finally {
      button.disabled = false;
    }
  };
  status.value = name + ' connectée en console.';
}

function addBoard(name, identity, socket) {
  const card = document.querySelector('#board').content.firstElementChild.cloneNode(true);
  card.querySelector('h2').textContent = name;
  card.querySelector('p').textContent =
    [identity.chip, identity.mac, identity.transport, identity.loader,
      identity.flash_size ? identity.flash_size + ' octets' : 'capacité inconnue'].join(' · ');
  card.querySelector('[data-disconnect]').onclick = () => socket.close();
  const read = card.querySelector('form');
  const output = card.querySelector('output');
  read.hidden = !identity.capabilities.includes('flash.read');
  read.onsubmit = async event => {
    event.preventDefault();
    const submit = read.querySelector('button');
    submit.disabled = true;
    try {
      const fields = new FormData(read);
      const address = flashNumber(fields.get('address'));
      const size = flashNumber(fields.get('size'));
      output.value = 'Lecture en cours…';
      const result = await api('/devices/' + name + '/flash/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ generation: identity.generation, address, size }),
      });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(await result.blob());
      link.download = name + '-0x' + address.toString(16) + '.bin';
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      output.value = size + ' octets lus';
    } catch (error) {
      output.value = error.message;
      status.value = error.message;
    } finally {
      submit.disabled = false;
    }
  };
  return showCard(name, card, 'Chargeur');
}

function register(name, driver, identity) {
  const socket = new WebSocket('ws://' + location.host + '/agent?device=' + encodeURIComponent(name));
  let remove;
  const checkSession = () => {
    if (socket.readyState !== WebSocket.OPEN) throw new Error('device_session_changed');
  };
  socket.onopen = () => socket.send(JSON.stringify(identity));
  socket.onmessage = async event => {
    const command = JSON.parse(event.data);
    if (command.generation) {
      try {
        const info = await (await api('/devices/' + name)).json();
        checkSession();
        remove = addBoard(name, info, socket);
        status.value = name + ' connectée';
      } catch {
        socket.close();
      }
      return;
    }
    try {
      if (command.command !== 'flash.read') throw new Error('operation_unsupported');
      socket.send(await driver.readFlash(command.address, command.size, checkSession));
    } catch {
      if (socket.readyState === WebSocket.OPEN) socket.send(command.id);
    }
  };
  socket.onclose = async () => {
    remove?.();
    if (!remove) status.value = name + ' : connexion au serveur refusée ou interrompue';
    try {
      await driver.close();
    } catch (error) {
      status.value = error.message;
    } finally {
      sessions.delete(name);
      usedPorts.delete(driver.port);
    }
  };
  return socket;
}

navigator.serial?.addEventListener('disconnect', event => {
  for (const { port, close } of sessions.values()) {
    if (event.target === port || event.port === port) close();
  }
});

function updateMode() {
  const consoleMode = form.elements.mode.value === 'console';
  document.querySelector('#console-baud').hidden = !consoleMode;
  form.elements.baud.disabled = !consoleMode;
  document.querySelector('#flash-entry').hidden = consoleMode;
}
form.elements.mode.onchange = updateMode;
updateMode();

form.onsubmit = async event => {
  event.preventDefault();
  const fields = new FormData(form);
  const name = fields.get('device');
  const submit = form.querySelector('button');
  submit.disabled = true;
  let port;
  let driver;
  let claimed = false;
  try {
    if (sessions.has(name)) throw new Error('Ce nom est déjà connecté.');
    if (!navigator.serial) throw new Error('Web Serial est indisponible dans ce navigateur.');
    port = await navigator.serial.requestPort();
    if (usedPorts.has(port)) throw new Error('Ce port est déjà utilisé.');
    usedPorts.add(port);
    claimed = true;
    if (fields.get('mode') === 'console') {
      await connectConsole(name, port, Number(fields.get('baud')));
      return;
    }
    const deps = await import('/esptool.js');
    driver = new EspDriver(port, deps);
    status.value = 'Identification de la carte…';
    const identity = await driver.connect({
      romOnly: fields.get('mode') === 'rom',
      manualEntry: fields.has('manual'),
    });
    const socket = register(name, driver, identity);
    sessions.set(name, { port, close: () => socket.close() });
  } catch (error) {
    status.value = error.message;
    if (claimed) {
      try { await driver?.close(); }
      catch (closeError) { status.value = closeError.message; }
      finally { usedPorts.delete(port); }
    }
  } finally {
    submit.disabled = false;
  }
};
