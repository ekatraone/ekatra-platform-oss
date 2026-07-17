#!/bin/bash

# Ekatra Platform - Start Development Servers

set -e

# Start database if not running
if ! docker ps | grep -q ekatra-postgres-dev; then
  echo "🐳 Starting database..."
  docker-compose -f docker-compose.dev.yml up -d
  sleep 3
fi

echo "🚀 Starting Ekatra Platform in development mode..."
echo ""

# Run backend in watch mode
pnpm --filter @ekatra/backend dev
