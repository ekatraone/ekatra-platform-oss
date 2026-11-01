import { cpSync, mkdirSync } from 'node:fs';
mkdirSync(new URL('../dist/migrations/', import.meta.url), { recursive: true });
cpSync(new URL('../src/migrations/', import.meta.url), new URL('../dist/migrations/', import.meta.url), { recursive: true });
