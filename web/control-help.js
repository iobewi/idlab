import { $ } from './dom.js';

let hoveredControl;
let focusedControl;
let explainedControl;
export function updateHelp() {
  const control = [hoveredControl, focusedControl]
    .find(candidate => candidate?.isConnected && !candidate.closest('[hidden]'));
  if (explainedControl !== control) {
    explainedControl?.classList.remove('control-help-target');
    control?.classList.add('control-help-target');
    explainedControl = control;
  }
  const text = control?.dataset.guideHelp ?? tooltip(control)?.textContent.trim() ?? '';
  const hint = $('control-help');
  if (hint.textContent !== text) hint.textContent = text;
}

function controlWithHelp(element) {
  const control = element?.closest?.('[data-guide-help], [aria-describedby]');
  if (control?.dataset.guideHelp || tooltip(control)) return control;
}

function tooltip(control) {
  return control?.getAttribute('aria-describedby')?.split(/\s+/)
    .map($).find(description => description?.getAttribute('role') === 'tooltip');
}

export function wireControlHelp() {
  document.addEventListener('pointerover', event => {
    if (event.pointerType === 'touch') return;
    const control = controlWithHelp(event.target);
    if (hoveredControl === control) return;
    hoveredControl = control;
    updateHelp();
  });
  document.addEventListener('pointerout', event => {
    if (event.pointerType === 'touch' || !hoveredControl ||
        hoveredControl === controlWithHelp(event.relatedTarget)) return;
    hoveredControl = undefined;
    updateHelp();
  });
  document.addEventListener('focusin', event => {
    focusedControl = event.target.matches(':focus-visible') ? controlWithHelp(event.target) : undefined;
    updateHelp();
  });
  document.addEventListener('focusout', () => {
    focusedControl = undefined;
    updateHelp();
  });
}
