import { sha256 } from './board-connector.js';
import { FLASH_SECTOR } from './esp-driver.js';
import { $, element, flashNumber, run, say } from './dom.js';
import { importManifest } from './flash-manifest.js';

const plans = new WeakMap();
const hex = address => '0x' + address.toString(16);
let renderedPlan;

function planFor(card) {
  if (!card) return null;
  if (!plans.has(card)) plans.set(card, {files: [], message: ''});
  return plans.get(card);
}

function invalidate(plan, message = '') {
  plan.approval = null;
  plan.confirming = false;
  plan.message = message;
}

const canOpenLoader = card => card?.mode === 'console' && card.canEnterLoader;
const eraseCapability = region => region ? 'flash.erase.region' : 'flash.erase';
const sectorEnd = (address, size) => address + Math.ceil(size / FLASH_SECTOR) * FLASH_SECTOR;

function canPrepareProgram(card, available) {
  return Boolean(available && card?.identity &&
    (card.identity.capabilities.includes('flash.program') || canOpenLoader(card)));
}

function canErase(card, available, region) {
  return Boolean(available && card?.identity &&
    (card.identity.capabilities.includes(eraseCapability(region)) || canOpenLoader(card)));
}

function validRegion(card, {address, size}) {
  const capacity = card.identity?.flash_size ?? card.lastIdentity?.flash_size ?? 64 * 1024 * 1024;
  return Number.isSafeInteger(address) && Number.isSafeInteger(size) && address >= 0 &&
    size >= FLASH_SECTOR && address % FLASH_SECTOR === 0 && size % FLASH_SECTOR === 0 && address + size <= capacity;
}

export function canErasePartition(card, part, available) {
  return canErase(card, available, part) && card.partitionsGeneration === card.identity.generation &&
    card.partitions?.includes(part) && validRegion(card, part);
}

export function renderFlashPlan(card, available) {
  const plan = planFor(card);
  const canProgram = Boolean(available && card?.identity?.capabilities.includes('flash.program'));
  const canLoad = available && canOpenLoader(card);
  const working = Boolean(plan?.working);
  const confirming = Boolean(plan?.confirming);
  if (plan) plan.available = available;
  if (plan?.approval && (plan.generation !== card.identity?.generation ||
      !card.identity?.capabilities.includes('flash.program'))) invalidate(plan);
  $('binary').disabled = !plan || working;
  for (const id of ['manifest', 'manifest-files', 'manifest-directory']) $(id).disabled = !plan || working;
  $('install').disabled = !plan || working || !$('manifest').files.length ||
    !($('manifest-files').files.length || $('manifest-directory').files.length);
  $('clear-plan').disabled = !plan?.files.length || working;
  $('validate-plan').disabled = !(canProgram || canLoad) || !plan?.files.length || working;
  $('restore-memory').disabled = !canPrepareProgram(card, available) || working;
  $('write').disabled = !canProgram || !plan?.approval || working || confirming;
  $('program-confirmation').hidden = !plan?.confirming;
  $('confirm-write').disabled = !canProgram || !plan?.confirming || plan.working;
  $('cancel-write').disabled = !plan?.confirming || plan.working;
  $('erase').disabled = !canErase(card, available) || working;
  $('erase-memory').disabled = !canErase(card, available, true) || working;
  $('erase-help').textContent = canLoad ? 'Après confirmation, IDLab ouvre le chargeur, efface la flash et vérifie la relecture.'
    : card?.identity?.capabilities.includes('flash.erase')
    ? 'Efface toute la flash, puis vérifie que chaque octet vaut 0xFF.'
    : 'Nécessite un stub actif, une capacité connue et un état de sécurité vérifié.';
  $('plan-target-help').textContent = canProgram ? '' : card?.mode === 'console' && card.canEnterLoader
    ? 'La validation ouvre le chargeur flash. La carte peut redémarrer.'
    : 'Ouvre le chargeur flash de la carte pour valider et programmer le plan.';
  $('plan-state').textContent = plan?.message || (plan?.files.length
    ? 'Renseigne les adresses de chaque binaire puis valide le plan.' : 'Plan vide. Les adresses doivent être renseignées explicitement.');

  const files = plan?.files;
  if (renderedPlan !== files) {
    renderedPlan = files;
    $('images-body').replaceChildren(...(files ?? []).map(entry => {
      const row = element('tr');
      const address = element('input');
      address.value = entry.address;
      address.placeholder = '0x…';
      address.setAttribute('aria-label', 'Adresse de ' + entry.file.name);
      address.oninput = () => {
        entry.address = address.value;
        invalidate(plan);
        renderFlashPlan(card, plan.available);
      };
      const cell = element('td');
      cell.append(address);
      const remove = element('button', 'Retirer');
      remove.type = 'button';
      remove.onclick = () => {
        plan.files = plan.files.filter(file => file !== entry);
        invalidate(plan);
        renderFlashPlan(card, plan.available);
      };
      const action = element('td');
      action.append(remove);
      const digest = element('td', entry.sha256 ?? '—');
      entry.fields = {address, remove, digest};
      row.append(element('td', entry.file.name), cell, element('td', entry.file.size), digest, action);
      return row;
    }));
  }
  for (const entry of files ?? []) {
    entry.fields.address.disabled = Boolean(plan.working);
    entry.fields.remove.disabled = Boolean(plan.working);
    entry.fields.digest.textContent = entry.sha256 ?? '—';
  }
  if (plan?.confirming) {
    $('confirmation-target').textContent = 'Carte ' + card.name;
    $('confirmation-regions').replaceChildren(...plan.approval.images.map((image, index) => {
      const row = element('tr');
      row.append(element('td', files[index].file.name), element('td', hex(image.address)),
        element('td', hex(sectorEnd(image.address, image.size))));
      return row;
    }));
  }
}

function encodeBase64(bytes) {
  // Multiples of three keep padding at the end of the complete string.
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += 24576) {
    parts.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 24576))));
  }
  return parts.join('');
}

const errors = {
  invalid_flash_plan: 'Plan invalide. Choisis des adresses alignées sur 4 Kio et des fichiers non vides.',
  invalid_flash_range: 'Les secteurs se chevauchent ou dépassent la capacité de la flash.',
  flash_plan_confirmation_required: 'Le plan doit être validé à nouveau.',
  flash_verification_failed: 'La relecture ne correspond pas au plan. Consulte le détail dans l’historique.',
  flash_program_failed: 'Programmation interrompue. Consulte le journal avant de réessayer.',
};

function appendFiles(plan, entries) {
  const files = [...plan.files, ...entries];
  if (files.length > 16 || files.reduce((sum, entry) => sum + entry.file.size, 0) > 64 * 1024 * 1024) {
    throw new Error('Un plan peut contenir jusqu’à 16 fichiers et 64 Mio.');
  }
  plan.files = files;
  invalidate(plan);
}

async function prepareImages(card, generation, files, beforeLoader = () => {}) {
  const images = [];
  for (const entry of files) {
    const address = entry.address.trim();
    if (!address) throw new Error('Renseigne l’adresse de ' + entry.file.name + '.');
    const offset = flashNumber(address);
    entry.sha256 = await sha256(await entry.file.arrayBuffer());
    images.push({address: offset, size: entry.file.size, sha256: entry.sha256});
  }
  if (card.identity?.generation !== generation) throw new Error('La session de la carte a changé.');
  if (canOpenLoader(card)) {
    beforeLoader();
    await card.enterLoader();
    if (card.identity?.generation !== generation) throw new Error('La session de la carte a changé.');
  }
  return card.prepareProgram(images);
}

async function writeImages(card, generation, planId, files, isSelected) {
  const binaries = [];
  for (const {file} of files) binaries.push(encodeBase64(new Uint8Array(await file.arrayBuffer())));
  if (card.identity?.generation !== generation || !isSelected()) throw new Error('La carte ou sa session a changé.');
  card.partitionsGeneration = null;
  return card.programFlash(planId, binaries);
}

export function wireFlashPlan({getSelected, render, observeCard}) {
  const dialog = $('erase-dialog');
  const confirmation = $('erase-confirmation');
  const confirmErase = $('erase-confirm');
  const restoreInput = $('restore-file');
  const restoreDialog = $('restore-dialog');
  let restoreTarget;
  let eraseTarget;
  $('restore-memory').onclick = () => {
    const card = getSelected();
    if ($('restore-memory').disabled || !card?.identity) return;
    return run(() => {
      const address = flashNumber($('address').value.trim());
      if (!Number.isSafeInteger(address) || address % FLASH_SECTOR) {
        throw new Error('L’adresse d’écriture doit être alignée sur 4 Kio.');
      }
      restoreTarget = {card, generation: card.identity.generation, address};
      restoreInput.value = '';
      restoreInput.click();
    });
  };
  restoreInput.onchange = () => run(() => {
    const file = restoreInput.files[0];
    restoreInput.value = '';
    if (!file || !restoreTarget) return;
    const {card, generation, address} = restoreTarget;
    if (card !== getSelected() || card.identity?.generation !== generation || $('restore-memory').disabled) {
      throw new Error('La carte ou sa session a changé. Sélectionne à nouveau le binaire.');
    }
    const end = sectorEnd(address, file.size);
    const capacity = card.identity.flash_size ?? card.lastIdentity?.flash_size ?? 64 * 1024 * 1024;
    if (!file.size || end > capacity) {
      throw new Error('Binaire vide ou secteurs hors de la capacité de la flash.');
    }
    restoreTarget.file = file;
    $('restore-target').textContent = `${card.name} · ${file.name} · ${file.size} octets à ${hex(address)}`;
    $('restore-sectors').textContent = `${hex(address)} à ${hex(end)} (fin exclue)`;
    $('restore-loader-help').hidden = !canOpenLoader(card);
    restoreDialog.showModal();
  });
  restoreDialog.onclose = () => { restoreTarget = null; };
  $('restore-cancel').onclick = () => restoreDialog.close();
  restoreDialog.querySelector('form').onsubmit = event => {
    event.preventDefault();
    if (!restoreTarget?.file) return;
    const {card, generation, address, file} = restoreTarget;
    restoreTarget = null;
    restoreDialog.close();
    return run(async () => {
      const plan = planFor(card);
      if (card !== getSelected() || card.identity?.generation !== generation || $('restore-memory').disabled) {
        throw new Error('La carte ou sa session a changé. Confirme à nouveau l’écriture.');
      }
      const entries = [{file, address: hex(address)}];
      invalidate(plan);
      plan.working = true;
      render();
      try {
        say('Validation du binaire…');
        const approval = await prepareImages(card, generation, entries, () => say('Ouverture du chargeur flash…'));
        say('Écriture et relecture en cours…');
        await writeImages(card, generation, approval.plan_id, entries, () => card === getSelected());
        if (card === getSelected()) say('Écriture vérifiée par relecture SHA-256.');
      } catch (error) {
        if (card === getSelected()) say(errors[error.message] ?? error.message);
      } finally {
        plan.working = false;
        render();
        void observeCard(card);
      }
    });
  };
  function allowedToErase(card, region, partition) {
    const plan = planFor(card);
    const available = plan?.available && !plan.working;
    return partition ? canErasePartition(card, region, available) : canErase(card, available, region);
  }
  function openErase(region, partition = false) {
    const card = getSelected();
    if (!allowedToErase(card, region, partition)) return;
    if (region && !validRegion(card, region)) throw new Error('Adresse et taille doivent être alignées sur 4 Kio et tenir dans la flash.');
    eraseTarget = {card, generation: card.identity.generation, region, partition};
    $('erase-title').textContent = partition ? 'Confirmer l’effacement de la partition'
      : region ? 'Confirmer l’effacement de la plage' : 'Confirmer l’effacement intégral';
    const capacity = card.identity.flash_size ?? card.lastIdentity?.flash_size;
    const target = [card.name, region?.label];
    if (region) target.push(`${hex(region.address)} à ${hex(region.address + region.size)} (fin exclue)`, `${region.size} octets`);
    else if (capacity) target.push(`${capacity / (1024 * 1024)} Mio`);
    $('erase-target').textContent = target.filter(Boolean).join(' · ');
    const warning = region ? 'Toutes les données de cette plage seront supprimées.'
      : 'Le firmware, les partitions, les réglages et toutes les données de la flash seront supprimés.';
    $('erase-warning').textContent = canOpenLoader(card) ? warning + ' IDLab ouvrira le chargeur et la carte peut redémarrer.' : warning;
    confirmation.value = '';
    confirmErase.disabled = true;
    dialog.showModal();
    confirmation.focus();
  }
  $('erase').onclick = () => openErase();
  $('erase-memory').onclick = () => run(() => openErase({
    address: flashNumber($('address').value.trim()), size: flashNumber($('size').value.trim()),
  }));
  confirmation.oninput = () => { confirmErase.disabled = confirmation.value !== eraseTarget?.card.name; };
  $('erase-cancel').onclick = () => dialog.close();
  dialog.querySelector('form').onsubmit = event => {
    event.preventDefault();
    if (!eraseTarget || confirmErase.disabled) return;
    const {card, generation, region, partition} = eraseTarget;
    const typed = confirmation.value;
    dialog.close();
    return run(async () => {
      const plan = planFor(card);
      if (card !== getSelected() || card.identity?.generation !== generation || !allowedToErase(card, region, partition)) {
        throw new Error('La carte ou sa session a changé. Confirme à nouveau l’effacement.');
      }
      invalidate(plan);
      plan.working = true;
      render();
      try {
        if (canOpenLoader(card)) await card.enterLoader();
        if (card.identity?.generation !== generation || card !== getSelected()) throw new Error('La carte ou sa session a changé.');
        if (!card.identity.capabilities.includes(eraseCapability(region))) throw new Error('Effacement indisponible pour cette carte.');
        if (region) {
          if (!validRegion(card, region)) throw new Error('La plage dépasse la capacité mesurée.');
          await card.eraseFlashRegion(typed, region.address, region.size);
        } else {
          card.partitions = null;
          card.partitionStatus = null;
          await card.eraseFlash(typed);
        }
        if (card === getSelected()) say(region ? 'Plage effacée et vérifiée à 0xFF.'
          : 'Effacement intégral vérifié. Tous les octets valent 0xFF.');
      } finally {
        plan.working = false;
        render();
        void observeCard(card);
      }
    });
  };
  $('binary').onchange = () => {
    const card = getSelected();
    const input = $('binary');
    const entries = Array.from(input.files, file => ({file, address: ''}));
    input.value = '';
    const plan = planFor(card);
    if (!plan || plan.working || !entries.length) return;
    try { appendFiles(plan, entries); }
    catch (error) { plan.message = error.message; }
    render();
  };
  for (const id of ['manifest', 'manifest-files', 'manifest-directory']) $(id).onchange = render;
  $('install').onclick = async () => {
    const card = getSelected();
    const plan = planFor(card);
    const manifest = $('manifest').files[0];
    if (!plan || plan.working || !manifest) return;
    const files = [...$('manifest-files').files, ...$('manifest-directory').files];
    plan.working = true;
    render();
    try {
      const chip = card.identity?.chip ?? card.lastIdentity?.chip;
      const entries = importManifest(JSON.parse(await manifest.text()), files, chip);
      appendFiles(plan, entries);
      for (const id of ['manifest', 'manifest-files', 'manifest-directory']) $(id).value = '';
      plan.message = 'Manifeste ajouté au plan. Vérifie les adresses avant validation.';
    } catch (error) {
      plan.message = error.message;
    } finally {
      plan.working = false;
      render();
    }
  };
  $('clear-plan').onclick = () => {
    const plan = planFor(getSelected());
    plan.files = [];
    invalidate(plan);
    render();
  };
  $('validate-plan').onclick = async () => {
    const card = getSelected();
    const plan = planFor(card);
    const generation = card.identity.generation;
    invalidate(plan, 'Validation en cours…');
    plan.working = true;
    render();
    try {
      plan.approval = await prepareImages(card, generation, plan.files, () => {
        plan.message = 'Ouverture du chargeur flash…';
        render();
      });
      plan.generation = generation;
      plan.message = 'Plan validé. Sélectionne Programmer pour confirmer.';
    } catch (error) {
      plan.message = errors[error.message] ?? error.message;
    } finally {
      plan.working = false;
      render();
    }
  };
  $('write').onclick = () => {
    planFor(getSelected()).confirming = true;
    render();
    $('cancel-write').focus();
  };
  $('cancel-write').onclick = () => {
    planFor(getSelected()).confirming = false;
    render();
  };
  $('confirm-write').onclick = async () => {
    const card = getSelected();
    const plan = planFor(card);
    const {plan_id: planId} = plan.approval;
    const generation = plan.generation;
    invalidate(plan, 'Programmation et relecture en cours…');
    plan.working = true;
    render();
    try {
      const result = await writeImages(card, generation, planId, plan.files, () => card === getSelected());
      plan.message = result.detail;
    } catch (error) {
      plan.message = errors[error.message] ?? error.message;
    } finally {
      plan.working = false;
      render();
      void observeCard(card);
    }
  };
  return openErase;
}
