#!/bin/sh
set -eu

if [ -e .env ]; then
  echo ".env already exists; leaving it unchanged."
  exit 0
fi

umask 077
postgres_password="$(openssl rand -hex 24)"
api_token="$(openssl rand -hex 32)"

sed \
  -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=${postgres_password}/" \
  -e "s/^ESTIMIT_API_TOKEN=.*/ESTIMIT_API_TOKEN=${api_token}/" \
  .env.example > .env

echo "Created .env with generated database and API credentials."
