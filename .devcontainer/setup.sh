#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
venv="$HOME/.venv/idlab"

python -m venv "$venv"
"$venv/bin/python" -m pip install -r core/requirements.txt -e ./client
npm ci --ignore-scripts --prefix core
