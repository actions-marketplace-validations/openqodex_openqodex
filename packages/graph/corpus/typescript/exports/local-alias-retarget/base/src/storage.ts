function saveToDisk(key: string): string {
  return `disk:${key}`;
}

function saveToCloud(key: string): string {
  return `cloud:${key}`;
}

export { saveToDisk as save, saveToDisk, saveToCloud };
