import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
export class Vault {
  constructor(path, crypto) {
    this.path = path; this.crypto = crypto; this.data = {};
    if (!crypto.isEncryptionAvailable()) throw new Error('SECURE_STORAGE_UNAVAILABLE');
    if (existsSync(path)) {
      try { this.data = JSON.parse(crypto.decryptString(readFileSync(path))); }
      catch { throw new Error('SECURE_STORAGE_UNREADABLE'); }
    }
  }
  get(key) { return this.data[key] == null ? null : structuredClone(this.data[key]); }
  set(key, value) {
    const next = { ...this.data, [key]: structuredClone(value) };
    const encrypted = this.crypto.encryptString(JSON.stringify(next));
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = this.path + '.' + randomUUID() + '.tmp';
    writeFileSync(temporary, encrypted, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, this.path); this.data = next;
  }
  hostId() {
    let id = this.get('hostId');
    if (!id) { id = 'urn:uuid:' + randomUUID(); this.set('hostId', id); }
    return id;
  }
}
