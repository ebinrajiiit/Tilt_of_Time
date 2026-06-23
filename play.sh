#!/usr/bin/env bash
# Tilt of Time — native desktop launcher.
# Creates a local virtualenv on first run, installs deps, then plays.
cd "$(dirname "$0")" || exit 1

if [ ! -d .venv ]; then
  echo "First run: setting up Python environment (one time)…"
  python3 -m venv .venv || { echo "Could not create venv. Is python3 installed?"; exit 1; }
  .venv/bin/python -m pip install --quiet --upgrade pip
  .venv/bin/pip install --quiet -r requirements.txt || { echo "Dependency install failed."; exit 1; }
fi

exec .venv/bin/python game_neck.py
