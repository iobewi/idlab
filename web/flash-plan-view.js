import { sha256 } from './board-connector.js';
import { $, element } from './dom.js';

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

export function renderFlashPlan(card, available) {
  const plan = planFor(card);
  const canProgram = Boolean(available && card?.identity?.capabilities.includes('flash.program'));
  const canOpenLoader = Boolean(available && card?.mode === 'console' && card.canEnterLoader);
  const working = Boolean(plan?.working);
  const confirming = Boolean(plan?.confirming);
  if (plan) plan.available = available;
  if (plan?.approval && (plan.generation !== card.identity?.generation ||
      !card.identity?.capabilities.includes('flash.program'))) invalidate(plan);
  $('binary').disabled = !plan || working;
  $('clear-plan').disabled = !plan?.files.length || working;
  $('validate-plan').disabled = !(canProgram || canOpenLoader) || !plan?.files.length || working;
  $('write').disabled = !canProgram || !plan?.approval || working || confirming;
  $('program-confirmation').hidden = !plan?.confirming;
  $('confirm-write').disabled = !canProgram || !plan?.confirming || plan.working;
  $('cancel-write').disabled = !plan?.confirming || plan.working;
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
        element('td', hex(image.address + Math.ceil(image.size / 4096) * 4096)));
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

export function wireFlashPlan({getSelected, render, observeCard}) {
  $('binary').onchange = () => {
    const card = getSelected();
    const input = $('binary');
    const entries = Array.from(input.files, file => ({file, address: ''}));
    input.value = '';
    const plan = planFor(card);
    if (!plan || plan.working || !entries.length) return;
    const files = [...plan.files, ...entries];
    if (files.length > 16 || files.reduce((sum, entry) => sum + entry.file.size, 0) > 64 * 1024 * 1024) {
      plan.message = 'Un plan peut contenir jusqu’à 16 fichiers et 64 Mio.';
    } else {
      plan.files = files;
      invalidate(plan);
    }
    render();
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
      const images = [];
      for (const entry of plan.files) {
        const address = entry.address.trim();
        if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(address)) throw new Error('Renseigne l’adresse de ' + entry.file.name + '.');
        entry.sha256 = await sha256(await entry.file.arrayBuffer());
        images.push({address: Number(address), size: entry.file.size, sha256: entry.sha256});
      }
      if (card.identity?.generation !== generation) throw new Error('La session de la carte a changé.');
      if (card.mode === 'console' && card.canEnterLoader) {
        plan.message = 'Ouverture du chargeur flash…';
        render();
        await card.enterLoader();
        if (card.identity?.generation !== generation) throw new Error('La session de la carte a changé.');
      }
      plan.approval = await card.prepareProgram(images);
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
      const binaries = [];
      for (const {file} of plan.files) binaries.push(encodeBase64(new Uint8Array(await file.arrayBuffer())));
      if (card.identity?.generation !== generation) throw new Error('La session de la carte a changé.');
      const result = await card.programFlash(planId, binaries);
      plan.message = result.detail;
    } catch (error) {
      plan.message = errors[error.message] ?? error.message;
    } finally {
      plan.working = false;
      render();
      void observeCard(card);
    }
  };
}
