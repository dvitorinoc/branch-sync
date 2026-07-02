import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Permite sobrescrever o diretório de configuração (útil para testes).
const CONFIG_DIR =
  process.env.BRANCH_SYNC_DIR || join(homedir(), '.config', 'branch-sync');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const STATE_FILE = join(CONFIG_DIR, 'state.json');

function ensureDir() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
}

export function configPath() {
  return CONFIG_FILE;
}

export function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return { repositories: [] };
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    if (!Array.isArray(cfg.repositories)) cfg.repositories = [];
    return cfg;
  } catch (e) {
    throw new Error(
      `Arquivo de configuração inválido em ${CONFIG_FILE}: ${e.message}`,
    );
  }
}

export function saveConfig(cfg) {
  ensureDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
}

export function getRepo(cfg, name) {
  return cfg.repositories.find((r) => r.name === name);
}

// ---- Estado de uma sincronização em andamento ----

export function loadState() {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function saveState(state) {
  ensureDir();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

export function clearState() {
  if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
}
