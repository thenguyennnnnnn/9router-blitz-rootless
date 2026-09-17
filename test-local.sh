#!/usr/bin/env sh
set -eu

if [ ! -f .env.local ]; then
  cp .env.example .env.local
  echo "Created .env.local. Edit JWT_SECRET and INITIAL_PASSWORD, then rerun."
  exit 1
fi

docker build --platform linux/amd64 -t 9router-blitz-rootless:test .
docker rm -f 9router-blitz-test >/dev/null 2>&1 || true
exec docker run --name 9router-blitz-test \
  --platform linux/amd64 \
  --user 1000:1000 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  -p 20128:20128 \
  --env-file .env.local \
  -v 9router-blitz-data:/app/data \
  9router-blitz-rootless:test
