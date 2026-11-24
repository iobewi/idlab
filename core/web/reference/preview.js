// Presentation-only fixture for reviewing the historical interface.
const byId = id => document.getElementById(id);

function text(id, value) {
  byId(id).textContent = value;
}

function wireTabs(attribute) {
  const tabs = Array.from(document.querySelectorAll('[' + attribute + ']'));
  function select(tab) {
    for (const candidate of tabs) {
      const selected = candidate === tab;
      candidate.setAttribute('aria-selected', selected);
      candidate.tabIndex = selected ? 0 : -1;
      byId(candidate.getAttribute('aria-controls')).hidden = !selected;
    }
  }
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', event => {
      const last = tabs.length - 1;
      const target = { ArrowLeft: (index + last) % tabs.length, ArrowRight: (index + 1) % tabs.length,
        Home: 0, End: last }[event.key];
      if (target === undefined) return;
      event.preventDefault();
      select(tabs[target]);
      tabs[target].focus();
    });
  }
  select(tabs.find(tab => tab.getAttribute('aria-selected') === 'true'));
}

const bands = Array.from(document.querySelectorAll('[data-status]'));
function selectBand(active) {
  for (const button of bands) {
    button.setAttribute('aria-expanded', button === active);
    byId(button.getAttribute('aria-controls')).hidden = button !== active;
  }
}
for (const button of bands) {
  button.onclick = () => selectBand(button.getAttribute('aria-expanded') === 'true' ? null : button);
}
for (const button of document.querySelectorAll('[data-close-status]')) {
  button.onclick = () => { selectBand(null); byId('status-' + button.dataset.closeStatus).focus(); };
}
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') selectBand(null);
});
byId('access-toggle').onclick = event => {
  const panel = byId('access-panel');
  panel.hidden = !panel.hidden;
  event.currentTarget.setAttribute('aria-expanded', !panel.hidden);
};
wireTabs('data-workspace-tab');
wireTabs('data-tab');

const fixtures = [
  { name: 'esp32-local', chip: 'ESP32-S3', flash: '16 Mio', rdid: '0x184068', transport: 'Pont USB–UART' },
  { name: 'esp32-zero', chip: 'ESP32-S3', flash: '4 Mio', rdid: '0x164068', transport: 'USB Serial/JTAG' },
];
const lines = [
  'I (104) boot: Démarrage du firmware',
  'I (268) app: Initialisation terminée',
  'I (512) app: READY',
];
const entries = [];
let selected = 0;
let showHex = false;
let paused = false;
const visibleLines = fixtures.map(() => [...lines]);
const encoder = new TextEncoder();

function renderConsole() {
  if (paused) return;
  const search = byId('console-search').value.toLocaleLowerCase();
  const rows = visibleLines[selected].flatMap((line, index) => {
    const content = showHex
      ? Array.from(encoder.encode(line), byte => byte.toString(16).padStart(2, '0')).join(' ')
      : line;
    if (!content.toLocaleLowerCase().includes(search)) return [];
    const row = document.createElement('div');
    row.className = 'console-row' + (byId('timestamps').checked ? '' : ' no-time');
    for (const [tag, cls, value] of [
      ['span', 'seq', index + 1], ['time', '', '10:00:0' + index],
      ['span', 'kind', 'RX'], ['span', 'payload', content],
    ]) {
      if (tag === 'time' && !byId('timestamps').checked) continue;
      const field = document.createElement(tag);
      field.className = cls;
      field.textContent = value;
      row.append(field);
    }
    return [row];
  });
  byId('uart-log').replaceChildren(...rows);
}

function selectCard(index) {
  selected = index;
  entries.forEach((entry, i) => entry.setAttribute('aria-pressed', i === index));
  const card = fixtures[index];
  for (const [id, value] of Object.entries({
    'status-label-card': card.name, 'chip-info': card.chip, 'flash-info': card.flash,
    'rdid-info': card.rdid, 'interface-info': card.transport, 'loader-speed-info': '115 200',
    'console-speed-info': '115 200', 'footer-target': 'Carte sélectionnée : ' + card.name,
  })) text(id, value);
  text('reset-device', index === 0 ? 'Reset EN' : 'Reset USB');
  byId('card-boot-actions').hidden = index !== 0;
  byId('p4-diagnostic').hidden = byId('p4-bringup').hidden = false;
  // Keep the visual inventory visible even though this fixture has no P4 session.
  byId('card-reset-actions').hidden = byId('reset-device').hidden = false;
  renderConsole();
}

byId('active-cards').replaceChildren();
for (const [index, card] of fixtures.entries()) {
  const item = document.createElement('div');
  item.className = 'active-board';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'board-name';
  button.textContent = card.name + ' · ' + card.chip;
  button.onclick = () => selectCard(index);
  const badge = document.createElement('span');
  badge.className = 'board-status';
  badge.dataset.state = 'connected';
  badge.textContent = 'Connectée';
  item.append(button, badge);
  entries.push(button);
  byId('active-cards').append(item);
}

byId('card-details').hidden = false;
for (const button of document.querySelectorAll('[data-hardware]')) button.disabled = true;
for (const id of ['agent-connect', 'release-control', 'grant', 'revoke', 'confirm-write']) byId(id).disabled = true;
text('status-label-agent', 'Agent connecté (simulé)');
text('server-state', 'Session locale simulée');
text('client-state', 'Référence historique. Les commandes matérielles sont désactivées.');
byId('console-search').oninput = byId('timestamps').onchange = renderConsole;
byId('format-text').onclick = () => { showHex = false; renderConsole(); };
byId('format-hex').onclick = () => { showHex = true; renderConsole(); };
byId('clear-display').onclick = () => { visibleLines[selected] = []; renderConsole(); };
byId('pause').onclick = () => {
  paused = !paused;
  byId('pause').setAttribute('aria-pressed', paused);
  if (!paused) renderConsole();
};
byId('console-auto-size').onclick = () => byId('uart-log').style.height = '';
byId('agent-log-toggle').onclick = event => {
  const log = byId('agent-log');
  log.hidden = !log.hidden;
  event.currentTarget.setAttribute('aria-expanded', !log.hidden);
  event.currentTarget.textContent = log.hidden ? 'Développer' : 'Réduire';
};
byId('agent-log-clear').onclick = () => byId('agent-log').replaceChildren();
const agentEntry = document.createElement('p');
agentEntry.className = 'padded';
agentEntry.textContent = '10:00:00 · Agent connecté · Port série simulé · Console ouverte';
byId('agent-log').replaceChildren(agentEntry);
selectCard(0);
