import { $, download, element, FLASH_PREVIEW_BYTES, flashNumber, formatFlashPreview, run, say } from './dom.js';
import { decodePartitions, PARTITION_TABLE_BYTES } from './partitions.js';

const alternatePartitionAddress = new Map([[0x8000, 0x10000], [0x10000, 0x8000]]);
const hex = value => '0x' + value.toString(16);

function iconAction(icon, label, help) {
  const button = element('button', undefined, 'icon-action');
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.dataset.guideHelp = help;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  svg.setAttribute('class', 'status-icon');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', '#icon-' + icon);
  svg.append(use);
  button.append(svg);
  return button;
}

function operationDetails(entry) {
  const proof = JSON.stringify(entry, null, 2);
  const row = element('tr', undefined, 'operation-detail-row');
  row.id = 'operation-detail-' + entry.id;
  const cell = element('td');
  cell.colSpan = 5;
  const panel = element('div', undefined, 'operation-proof-panel');
  const toolbar = element('div', undefined, 'operation-proof-toolbar');
  const actions = element('div', undefined, 'operation-proof-actions');
  const copy = iconAction('copy', 'Copier le JSON', 'Copie le détail de cette opération au format JSON.');
  copy.onclick = () => run(async () => {
    await navigator.clipboard.writeText(proof);
    say('JSON de l’opération copié.', {temporary: true});
  });
  const save = iconAction('download', 'Télécharger le JSON', 'Télécharge le fichier JSON de cette opération.');
  save.onclick = () => download(new Blob([proof + '\n'], {type: 'application/json'}),
    'idlab-' + entry.device + '-operation-' + entry.id + '.json');
  actions.append(copy, save);
  toolbar.append(element('span', 'Détail de l’opération'), actions);
  panel.append(toolbar, element('pre', proof, 'operation-detail-json result'));
  cell.append(panel);
  row.append(cell);
  return row;
}

export function renderOperationHistory(card) {
  const entries = card?.observation?.operations ?? [];
  const body = $('operations-body');
  $('empty-operations').hidden = entries.length !== 0;
  body.replaceChildren();
  for (const entry of entries) {
    const row = element('tr', undefined, 'operation-row');
    const expanded = card.inspectedOperation === entry.id;
    row.id = 'operation-row-' + entry.id;
    row.tabIndex = 0;
    row.setAttribute('aria-expanded', expanded);
    if (expanded) row.setAttribute('aria-controls', 'operation-detail-' + entry.id);
    const toggleDetails = () => {
      card.inspectedOperation = expanded ? null : entry.id;
      renderOperationHistory(card);
      $(row.id).focus({preventScroll: true});
    };
    row.onclick = () => {
      if (window.getSelection()?.isCollapsed !== false) toggleDetails();
    };
    row.onkeydown = event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (!event.repeat) toggleDetails();
    };
    row.append(element('td', entry.id));
    const commands = {'flash.read': 'Lecture flash', 'flash.program': 'Programmation flash',
      'flash.erase': 'Effacement global', 'flash.erase.region': 'Effacement de zone'};
    for (const value of [entry.device, commands[entry.command] ?? entry.command, entry.state, entry.duration]) {
      row.append(element('td', value ?? '—'));
    }
    body.append(row);
    if (expanded) body.append(operationDetails(entry));
  }
}

export function renderOperations(card) {
  renderOperationHistory(card);
  $('dump-state').textContent = card?.dump?.summary ?? 'Aucun aperçu de la flash.';
  $('hex-dump').textContent = card?.dump?.preview ?? 'Aucune donnée à afficher.';
  $('download-dump').disabled = !card?.dump?.blob;
}

export function renderPartitions(card, canRead) {
  const table = card?.partitions;
  const currentTable = card?.partitionsGeneration === card?.identity?.generation;
  $('read-partitions').disabled = !canRead;
  const suggestion = card?.suggestPartition;
  const tryAddress = $('try-partition-address');
  tryAddress.disabled = !canRead || !suggestion;
  $('partition-suggestion').hidden = !suggestion;
  if (suggestion) {
    $('partition-suggestion-text').textContent = `Aucune table valide à ${hex(suggestion.failed)}. Essaie l’autre adresse courante.`;
    tryAddress.textContent = `Essayer ${hex(suggestion.address)}`;
  }
  $('partition-state').textContent = card?.partitionStatus ?? 'Aucune table lue.';
  $('partitions-body').replaceChildren(...(table ?? []).map(part => {
    const row = element('tr', undefined, 'partition-row');
    for (const value of [part.label, hex(part.type) + ' / ' + hex(part.subtype),
      hex(part.address), hex(part.size), hex(part.address + part.size)]) row.append(element('td', value));
    const enabled = Boolean(canRead && currentTable);
    row.setAttribute('aria-disabled', String(!enabled));
    row.dataset.guideHelp = enabled ? 'Renseigne la plage et lit la partition « ' + part.label + ' ».'
      : currentTable ? 'La lecture est indisponible dans l’état actuel de la carte.' : 'Relis la table des partitions.';
    if (!enabled) return row;
    row.tabIndex = 0;
    const read = () => {
      $('address').value = hex(part.address);
      $('size').value = hex(part.size);
      $('address').focus();
      $('read').click();
    };
    row.onclick = () => {
      if (window.getSelection()?.isCollapsed !== false) read();
    };
    row.onkeydown = event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (!event.repeat) read();
    };
    return row;
  }));
}

export function wireOperations({getSelected, render, observeCard}) {
  $('download-dump').onclick = () => {
    const dump = getSelected()?.dump;
    if (dump?.blob) download(dump.blob, dump.filename);
  };

  async function readPartitions() {
    const card = getSelected();
    if (!card || card.busy || card.requesting || $('read').disabled) return;
    say('');
    card.partitions = [];
    card.suggestPartition = null;
    card.partitionStatus = 'Lecture de la table…';
    render();
    let address;
    try {
      address = flashNumber($('partition-address').value.trim());
      const generation = card.identity.generation;
      const {blob, capacity} = await card.readFlash(address, PARTITION_TABLE_BYTES);
      card.partitions = decodePartitions(new Uint8Array(await blob.arrayBuffer()), capacity);
      card.partitionsGeneration = generation;
      card.partitionStatus = card.partitions.length + ' partition(s) lue(s).';
    } catch (error) {
      const alternate = alternatePartitionAddress.get(address);
      if (alternate !== undefined && error.message === 'partition_table_invalid') {
        card.suggestPartition = {failed: address, address: alternate};
      }
      card.partitionStatus = error.message === 'partition_table_invalid' ? 'Aucune table valide à cette adresse.' : error.message;
    } finally {
      if (card === getSelected()) render();
    }
  }
  $('read-partitions').onclick = readPartitions;
  $('try-partition-address').onclick = () => {
    const suggestion = getSelected()?.suggestPartition;
    if (!suggestion) return;
    $('partition-address').value = hex(suggestion.address);
    return readPartitions();
  };

  $('read').onclick = async () => {
    const card = getSelected();
    if (!card || card.busy || card.requesting || $('read').disabled) return;
    say('');
    card.dump = null;
    $('read').disabled = true;
    renderOperations(card);
    try {
      const address = flashNumber($('address').value.trim());
      const size = flashNumber($('size').value.trim());
      const {blob} = await card.readFlash(address, size);
      const preview = new Uint8Array(await blob.slice(0, FLASH_PREVIEW_BYTES).arrayBuffer());
      card.dump = {blob, filename: card.name + '-0x' + address.toString(16) + '.bin',
        summary: blob.size + ' octets lus • aperçu des ' + preview.length + ' premiers octets',
        preview: formatFlashPreview(preview)};
      if (card === getSelected()) say('Lecture flash terminée. Le fichier est prêt à télécharger.', {temporary: true});
    } catch (error) {
      say(error.message);
    } finally {
      if (card === getSelected()) render();
      void observeCard(card);
    }
  };
}
