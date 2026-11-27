# AGENTS.md — IDLab

## Mission and scope

IDLab (IOBEWI Device Lab) is a generic embedded-device laboratory, not a
firmware-specific test application. Preserve the separation between the
browser-owned Web Serial connection, the server broker and the API clients.
Use the supported API and Python SDK; do not create a second serial owner,
a bypass around the broker, or a workaround specific to a consumer such as
StreamBeWI. Consolidation IDL-01–07 is complete; further functional work
requires a demonstrated need and an explicitly scoped task.

## Read first

- [README.md](README.md): installation, operator workflow, supported features.
- [docs/api.md](docs/api.md): authoritative documented API contracts, modes,
  control, campaigns, diagnostics, recovery, timeouts and SDK usage.
- [docs/service.md](docs/service.md): service lifecycle, network and credentials.
- [docs/ux-historique.md](docs/ux-historique.md): UI history and rationale.
- Implementation and tests at the actual checked-out SHA take precedence
  over stale examples. Report discrepancies; do not silently invent an API.

| Area | Entry points |
|---|---|
| Server and control | `core/server.py`, `core/api_activity.py` |
| Persistence and campaigns | `core/campaigns.py` |
| Manager | `core/manager.py` |
| Web Serial / ESP transport | `core/board-connector.js`, `core/esp-driver.js`, `core/serial-transport.js`, `core/flash-read.js` |
| Flash planning | `core/flash_plan.py` |
| Operator UI | `web/index.html`, `web/app.js`, feature modules in `web/` |
| SDK | `clients/python/src/idlab_client/` |
| Tests | `core/tests/`, `clients/python/tests/` |
| CI | `.github/workflows/python-client.yml` |

## Non-negotiable operator boundaries

- Repository work, a green CI, an open connection, a board token or a
  previous permission are not hardware authorization.
- Obtain explicit operator authorization for the specific board, scenario,
  candidate SHA and actions before any hardware access, including flash
  reads, live identification, JEDEC, UART access, writes, erase, reset,
  loader/mode changes, reconnect or RAM stub execution. A passive server
  metadata inspection is distinct from a hardware action; do not use it
  to trigger identification or recovery.
- Do not deploy, start/stop/restart a live service, change its configuration,
  publish a release or rotate credentials without separate authorization.
  An updated checkout does not prove the live server serves that SHA.
- Require explicit destructive consent covering the exact flash ranges
  and image hashes. Do not extend an approved read into a write or erase.
- Physical intervention and visible indicators (LED colours, cabling,
  physical reset, physical identity) are the operator's responsibility.
  Do not claim observation without evidence.
- Never expose secrets in logs, command lines, issues, PRs or test artifacts.
  Keep board token, session credential, IDLAB_TOKEN and IDLAB_MANAGER_TOKEN
  distinct. Use secure input and follow the documented revocation procedure.

## Using IDLab from a consumer or test agent

Acquiring exclusive control changes laboratory state even when no command
is sent to the device. It requires explicit operator authorization and must
not be treated as passive metadata inspection. This also applies to the
generated pytest connectivity fixture.

1. Identify the intended scenario, expected results, board name, expected
   chip/transport and exact candidate firmware hash. Establish the
   authorization boundary and record it.
2. Inspect the configured service and SDK version and, when available,
   deployed provenance. Check health and passive metadata only within the
   approved scope. Do not start or restart the service to make a test pass.
3. Use the supported SDK (`IDLabClient`); use the card token to acquire
   exclusive control via its context manager. The global token alone
   does not authorize hardware commands. Use the same Board generation
   throughout an operation; refresh immutable snapshots after transitions.
4. Inspect capabilities and recovery status before acting. Do not infer a
   chip, MAC or flash size from the logical name; null in console can be
   legitimate. A passive identity is not a live measurement.
5. Execute only the authorized scenario. Let supported SDK operations
   manage automatic mode transitions; do not force loader/console changes
   or add resets for convenience. ROM-only is not a flash stub.
6. Save evidence and release exclusive control. Report any uncertainty,
   unexpected state change or recovery requirement before further actions.

## Operational pitfalls

- `read_uart(cursor=None)` returns retained history, not a cleared capture
  or a new-test boundary. Carry the returned cursor forward on the same
  generation; inspect dropped bytes. Zero dropped on the initial page
  does not prove no previous loss. Empty capture is not proof of firmware
  health. Never reuse a cursor across generations.
- Flash reads return the exact requested data or fail; do not accept partial
  data as success. Preserve the original error, requested range, received
  bytes, lastOffset, transfer count, baudrate and console recovery status.
- Distinguish serial timeout, server operation timeout and client HTTP
  timeout. A successful shorter read or a larger timeout does not resolve
  the original failure. Retest the original scenario only when authorized.
- On interruption, do not automatically retry, reset, restart, reconnect,
  replay a destructive command, rename a board to bypass recovery or
  release a reservation prematurely. Follow docs/api.md; use the operator
  recovery procedure when termination or identity is uncertain.
- A returned console or successful reset does not prove flash integrity.
  Unknown termination and indeterminate flash state are not unchanged.
- Merged binaries with 0xFF padding can erase configuration partitions.
  Validate the full sector-rounded ranges, partition layout, flash capacity,
  plan and image hashes. Preserve configuration using non-overlapping
  images when required by the scenario.
- Campaigns group evidence; the verdict is decided by the test, not by the
  mere completion of a campaign. An abort is not proof of physical stop.
- The generated pytest connectivity example is passive in terms of commands
  sent to the device: it acquires control and reads retained UART data.
  It does not qualify firmware or flash integrity. Its 10-second SDK
  timeout is not a default for lengthy hardware tests.

## Development and qualification

- Preserve the global objective and acceptance criteria. Do not recursively
  decompose a problem beyond the granularity needed to make a decision.
  Analyse existing source code and evidence before introducing additional
  instrumentation or experiments. Each investigation must answer a concrete
  unresolved question. Stop investigating once the evidence is sufficient
  to resolve the stated problem; report remaining uncertainties without
  expanding the scope.

- Read the issue, current main/target SHA, existing implementation and
  relevant tests before changing code. Prefer a targeted correction over
  new layers, protocols, dependencies or speculative refactors.
- Keep one focused PR per issue or requested change. Maintain existing
  contracts and add regression tests for demonstrated defects.
- Separate server/SDK/UI defects from target firmware, wiring, transport
  and test-harness defects. Do not change consumers to mask a lab defect
  or change IDLab to mask a firmware defect.
- Test locally against isolated software fixtures where available.
  These commands exercise software, not live hardware; do not point
  tests at a production lab or attached devices:

```sh
python -m pip wheel --no-deps --wheel-dir dist clients/python
python -m pip install -r core/requirements.txt dist/*.whl
python -m pip install -r clients/python/src/idlab_client/templates/hardware/requirements.txt
python -m unittest discover -s clients/python/tests -v
npm ci --prefix core
(cd core && python -m unittest discover -s tests -v && node --test tests/*.test.js)
```

  Use a clean virtual environment and the supported Python/Node versions
  from CI. Do not run generated hardware pytest recipes as software CI.
- Use the existing CI; do not rerun the entire pipeline unnecessarily
  or weaken assertions to obtain a green result. Check the exact candidate
  SHA, actual job conclusions and skipped steps. A green software CI
  is not hardware qualification or proof that a documentation example ran.
- Request independent review when required. Treat findings on the same
  branch, verify the final SHA and merge only after operator authorization.
  Do not bump SDK versions or publish releases implicitly.

## Evidence and final report

Record candidate SHA, deployed SHA if verified, SDK version, board identity
and generation where known, transport, scenario, authorization scope,
parameters, expected/observed results, error codes and relevant evidence
paths. Redact credentials and protect flash/UART data. Report executed and
not-executed steps separately, including deviations and recovery state.

Use these verdicts consistently:

| Verdict | Meaning |
|---|---|
| PASS | All applicable criteria verified and satisfied |
| FAIL | A nonconformity is demonstrated |
| BLOCKED | A required precondition prevents execution |
| INDETERMINATE | Evidence is insufficient to establish the result |

Do not convert skipped, blocked or indeterminate steps into PASS. Stop at
the authorized boundary; state precisely what is needed to continue.
