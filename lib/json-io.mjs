// File access for the scripts. Tests inject their own object with the same two
// methods, which keeps the flow logic free of fs and of the real repository.
import { readFile, writeFile } from 'node:fs/promises';

export const fileIo = {
  async readJson(path, fallback) {
    let raw;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if (fallback !== undefined && err.code === 'ENOENT') return fallback;
      throw err;
    }
    const text = raw.trim();
    if (!text) {
      if (fallback !== undefined) return fallback;
      throw new Error(`${path} is empty`);
    }
    return JSON.parse(text);
  },
  async writeJson(path, value) {
    await writeFile(path, JSON.stringify(value, null, 2) + '\n');
  },
};
