function saveToDisk(key: string): string {
  return `disk:${key}`;
}

function saveToCloud(key: string): string {
  return `cloud:${key}`;
}

export { saveToCloud as save, saveToDisk, saveToCloud };
