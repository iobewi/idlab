import { $, download, element, run, say } from './dom.js';
import { decodePartitions, PARTITION_TABLE_BYTES } from './partitions.js';

function operationDetails(entry) {
  const proof = JSON.stringify(entry, null, 2);
  const row = element('tr', undefined, 'operation-detail-row');
  row.id = 'operation-detail-' + entry.id;
  const cell = element('td');
  cell.colSpan = 6;
  const panel = element('div', undefined, 'operation-proof-panel');
  const toolbar = element('div', undefined, 'operation-proof-toolbar');
  const actions = element('div', undefined, 'operation-proof-actions');
  const copy = element('button', 'Copier le JSON');
  copy.onclick = () => run(async () => {
    await navigator.clipboard.writeText(proof);
    say('JSON de l’opération copié.');
  });
  const save = element('button', 'Télécharger le JSON');
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
    const row = element('tr');
    for (const value of [entry.id, entry.device, entry.command === 'flash.read' ? 'Lecture flash' : entry.command, entry.state, entry.duration]) {
      row.append(element('td', value ?? '—'));
    }
    const expanded = card.inspectedOperation === entry.id;
    const cell = element('td');
    const inspect = element('button', expanded ? 'Masquer' : 'Inspecter');
    inspect.id = 'inspect-operation-' + entry.id;
    inspect.setAttribute('aria-expanded', expanded);
    inspect.setAttribute('aria-label', inspect.textContent + ' l’opération ' + entry.id);
    if (expanded) inspect.setAttribute('aria-controls', 'operation-detail-' + entry.id);
    inspect.onclick = () => {
      card.inspectedOperation = expanded ? null : entry.id;
      renderOperationHistory(card);
      $(inspect.id).focus({preventScroll: true});
    };
    cell.append(inspect);
    row.append(cell);
    body.append(row);
    if (expanded) body.append(operationDetails(entry));
  }
}

export function renderOperations(card) {
  renderOperationHistory(card);
  $('dump-state').textContent = card?.dump?.summary ?? 'Aucune relecture.';
  $('hex-dump').textContent = card?.dump?.preview ?? 'Aucune donnée lue.';
  const link = $('download');
  link.replaceChildren();
  if (card?.dump) {
    const button = element('button', 'Télécharger le dump');
    button.onclick = () => download(card.dump.blob, card.dump.filename);
    link.append(button);
  }
}

export function renderPartitions(card, loader) {
  const table = card?.partitions;
  $('read-partitions').disabled = !loader;
  $('try-partition-address').disabled = !loader;
  $('partition-suggestion').hidden = !card?.suggestPartition;
  $('partition-state').textContent = card?.partitionStatus ?? 'Aucune table lue.';
  $('partitions-body').replaceChildren(...(table ?? []).map(part => {
    const row = element('tr');
    const hex = value => '0x' + value.toString(16);
    for (const value of [part.label, hex(part.type) + ' / ' + hex(part.subtype),
      hex(part.address), hex(part.size), hex(part.address + part.size)]) row.append(element('td', value));
    const action = element('td');
    const read = element('button', 'Sélectionner la plage');
    read.onclick = () => {
      $('address').value = hex(part.address);
      $('size').value = hex(part.size);
      $('tab-memory').click();
    };
    action.append(read);
    row.append(action);
    return row;
  }));
}

function flashNumber(value) {
  if (!/^(0x[0-9a-f]+|[0-9]+)$/i.test(value)) throw new Error('Adresse ou taille invalide.');
  return Number(value);
}

export function wireOperations({getSelected, render, observeCard}) {
  async function readPartitions() {
    const card = getSelected();
    if (!card || card.busy || card.requesting || $('read').disabled) return;
    card.partitions = [];
    card.suggestPartition = false;
    card.partitionStatus = 'Lecture de la table…';
    render();
    let address;
    try {
      address = flashNumber($('partition-address').value.trim());
      const {blob, capacity} = await card.readFlash(address, PARTITION_TABLE_BYTES);
      card.partitions = decodePartitions(new Uint8Array(await blob.arrayBuffer()), capacity);
      card.partitionStatus = card.partitions.length + ' partition(s) lue(s).';
    } catch (error) {
      card.suggestPartition = address === 0x8000 && error.message === 'partition_table_invalid';
      card.partitionStatus = error.message === 'partition_table_invalid' ? 'Aucune table valide à cette adresse.' : error.message;
    } finally {
      if (card === getSelected()) render();
    }
  }
  $('read-partitions').onclick = readPartitions;
  $('try-partition-address').onclick = () => { $('partition-address').value = '0x10000'; readPartitions(); };

  $('read').onclick = async () => {
    const card = getSelected();
    if (!card || card.busy || card.requesting || $('read').disabled) return;
    card.dump = null;
    $('read').disabled = true;
    renderOperations(card);
    try {
      const address = flashNumber($('address').value.trim());
      const size = flashNumber($('size').value.trim());
      const {blob} = await card.readFlash(address, size);
      const preview = new Uint8Array(await blob.slice(0, 256).arrayBuffer());
      card.dump = {blob, filename: card.name + '-0x' + address.toString(16) + '.bin',
        summary: blob.size + ' octets lus • aperçu des ' + preview.length + ' premiers octets',
        preview: Array.from(preview, byte => byte.toString(16).padStart(2, '0')).join(' ')};
      say(card.dump.summary);
    } catch (error) {
      say(error.message);
    } finally {
      if (card === getSelected()) render();
      void observeCard(card);
    }
  };
}
