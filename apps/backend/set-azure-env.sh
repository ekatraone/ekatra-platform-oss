#!/bin/bash
# Pushes backend env vars to the Azure Web App.
# Reads values from environment / a local .env — never hardcode secrets here.
#
# Usage: set -a && source ../../.env && set +a && ./set-azure-env.sh

set -euo pipefail

required=(DATABASE_URL META_ACCESS_TOKEN META_PHONE_NUMBER_ID META_WEBHOOK_VERIFY_TOKEN AZURE_OPENAI_ENDPOINT AZURE_OPENAI_API_KEY)
for var in "${required[@]}"; do
  if [ -z "${!var:-}" ]; then
    echo "❌ $var is not set. Source your .env first — see usage above." >&2
    exit 1
  fi
done

az webapp config appsettings set \
  --resource-group ekatra-platform-rg \
  --name ekatra-backend \
  --settings \
    "DATABASE_URL=$DATABASE_URL" \
    "META_ACCESS_TOKEN=$META_ACCESS_TOKEN" \
    "META_PHONE_NUMBER_ID=$META_PHONE_NUMBER_ID" \
    "META_WEBHOOK_VERIFY_TOKEN=$META_WEBHOOK_VERIFY_TOKEN" \
    "WHATSAPP_API_VERSION=${WHATSAPP_API_VERSION:-v23.0}" \
    "AZURE_OPENAI_ENDPOINT=$AZURE_OPENAI_ENDPOINT" \
    "AZURE_OPENAI_API_KEY=$AZURE_OPENAI_API_KEY" \
    "AZURE_OPENAI_API_VERSION=${AZURE_OPENAI_API_VERSION:-2025-01-01-preview}" \
    "AZURE_OPENAI_DEPLOYMENT=${AZURE_OPENAI_DEPLOYMENT:-gpt-4o}" \
    "AZURE_OPENAI_LLM_MODEL=${AZURE_OPENAI_LLM_MODEL:-gpt-4o}" \
    "PORT=8080" \
    "NODE_ENV=production" \
    "FRONTEND_URL=${FRONTEND_URL:-https://ekatra-backend.azurewebsites.net}" \
  --output table

echo "✅ Environment variables configured"
