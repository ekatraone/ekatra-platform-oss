#!/bin/bash

# Ekatra Platform - Development Setup Script
# Run this once to set up the development environment

set -e

echo "🚀 Setting up Ekatra Platform..."
echo ""

# Check for required tools
command -v docker >/dev/null 2>&1 || { echo "❌ Docker is required. Please install it first."; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "Installing pnpm..."; npm install -g pnpm; }

# Copy env file if not exists
if [ ! -f .env ]; then
  cp .env.example .env
  echo "✅ Created .env file from template"
  echo "⚠️  Please update .env with your API keys"
else
  echo "✅ .env file exists"
fi

# Start database and redis
echo ""
echo "🐳 Starting PostgreSQL and Redis..."
docker-compose -f docker-compose.dev.yml up -d

# Wait for postgres to be ready
echo "⏳ Waiting for PostgreSQL to be ready..."
sleep 5

# Check if postgres is ready
until docker exec ekatra-postgres-dev pg_isready -U ekatra > /dev/null 2>&1; do
  echo "Waiting for PostgreSQL..."
  sleep 2
done
echo "✅ PostgreSQL is ready"

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
pnpm install

# Build packages
echo ""
echo "🔨 Building packages..."
pnpm --filter @ekatra/database build
pnpm --filter @ekatra/messaging build
pnpm --filter @ekatra/backend build

# Seed database
echo ""
echo "🌱 Seeding database..."
cd packages/database
pnpm seed || echo "Seed may have already run"
cd ../..

echo ""
echo "✅ Setup complete!"
echo ""
echo "To start development:"
echo "  pnpm dev           # Start backend in dev mode"
echo "  pnpm dev:frontend  # Start frontend in dev mode"
echo ""
echo "Useful commands:"
echo "  docker-compose -f docker-compose.dev.yml logs -f postgres  # View DB logs"
echo "  docker-compose -f docker-compose.dev.yml down              # Stop services"
echo ""
echo "Database: postgresql://ekatra:ekatra_dev_password@localhost:5432/ekatra"
echo "Redis: redis://localhost:6379"
echo ""
