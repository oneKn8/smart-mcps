import { join } from "node:path";

export function homeDir(home = process.env.HOME): string {
  return home ?? process.cwd();
}

export function stateDir(home?: string): string {
  return join(homeDir(home), ".santo-agent", "drive-smart");
}

export function configPath(home?: string): string {
  return join(stateDir(home), "config.json");
}

export function indexPath(home?: string): string {
  return join(stateDir(home), "index.json");
}
