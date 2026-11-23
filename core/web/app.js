import { EspDriver } from './esp-driver.js';

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

function addBoard(name, identity, socket) {
  const card = document.querySelector('#board').content.firstElementChild.cloneNode(true);
  card.querySelector('h2').textContent = name;
  card.querySelector('p').textContent =
    [identity.chip, identity.mac, identity.transport, identity.loader,
      identity.flash_size ? identity.flash_size + ' octets' : 'capacité inconnue'].join(' · ');
  card.querySelector('button').onclick = () => socket.close();
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
  document.querySelector('#boards').append(card);
  return card;
}

function register(name, driver, identity) {
  const socket = new WebSocket('ws://' + location.host + '/agent?device=' + encodeURIComponent(name));
  let card;
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
        card = addBoard(name, info, socket);
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
    card?.remove();
    if (!card) status.value = name + ' : connexion au serveur refusée ou interrompue';
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
  for (const { port, socket } of sessions.values()) {
    if (event.target === port || event.port === port) socket.close();
  }
});

form.onsubmit = async event => {
  event.preventDefault();
  const fields = new FormData(form);
  const name = fields.get('device');
  const submit = form.querySelector('button');
  submit.disabled = true;
  let driver;
  try {
    if (sessions.has(name)) throw new Error('Ce nom est déjà connecté.');
    if (!navigator.serial) throw new Error('Web Serial est indisponible dans ce navigateur.');
    const port = await navigator.serial.requestPort();
    if (usedPorts.has(port)) throw new Error('Ce port est déjà utilisé.');
    const deps = await import('/esptool.js');
    driver = new EspDriver(port, deps);
    usedPorts.add(port);
    status.value = 'Identification de la carte…';
    const identity = await driver.connect({
      romOnly: fields.get('loader') === 'rom',
      manualEntry: fields.has('manual'),
    });
    sessions.set(name, { port, socket: register(name, driver, identity) });
  } catch (error) {
    status.value = error.message;
    if (driver) {
      try { await driver.close(); }
      finally { usedPorts.delete(driver.port); }
    }
  } finally {
    submit.disabled = false;
  }
};
