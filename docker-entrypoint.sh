#!/bin/sh
# Runs pending migrations, then starts the API.
# Compose only starts this container once Postgres reports healthy, so no polling is needed.
set -eu

echo "[crossrail] running migrations"
node node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js

echo "[crossrail] starting api"
exec node dist/main.js
