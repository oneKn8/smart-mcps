export function bytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = value;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return `${n.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function compactFile<T extends { size: number }>(file: T): T & { size_human: string } {
  return { ...file, size_human: bytes(file.size) };
}
