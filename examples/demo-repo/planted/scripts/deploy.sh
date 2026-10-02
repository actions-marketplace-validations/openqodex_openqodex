#!/usr/bin/env bash
# Copies the app to the deploy folder and lists what was deployed.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/srv/demo}"

rm -rf $DEPLOY_DIR/
mkdir -p "$DEPLOY_DIR"
cp -R app requirements.txt "$DEPLOY_DIR/"

for file in $(ls $DEPLOY_DIR); do
  echo "deployed: $file"
done
