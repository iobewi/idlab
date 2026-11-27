export function destructiveFlashMessage(error, messages) {
  if (['indeterminate', 'unverified'].includes(error.operation?.flashState)) {
    return 'État flash non vérifié. Consulte le diagnostic et privilégie une relecture autorisée avant toute opération destructive.';
  }
  return messages[error.code ?? error.message] ?? error.message;
}

export function operationDiagnosticDetail(entry) {
  return entry.command.startsWith('flash.') && entry.error && entry.detail ? entry.detail : null;
}

export function campaignOperationLabel(entry) {
  return entry.device + ' · ' + entry.command + ' · ' + entry.state
    + (entry.duration ? ' · ' + entry.duration : '')
    + (entry.error ? ' · ' + entry.error : '')
    + (entry.flashState ? ' · ' + entry.flashState : '');
}
