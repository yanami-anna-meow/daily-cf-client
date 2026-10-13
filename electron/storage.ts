import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, readdirSync, openSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Settings } from '../shared/types';
import { settingsInput, storedSettingsInput } from './guards';
import { isLegacyRemoteDataFile } from '../shared/legacy-remote-data';
import { t } from '../shared/i18n';

export interface Encryption { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string; getSelectedStorageBackend?(): string; }
export const DEFAULT_SETTINGS: Settings = settingsInput({ clientId: '', language: 'cpp', uiLanguage: 'system', theme: 'light' });
interface Data { settings: Settings; }
export class LocalStore {
  readonly directory: string;
  data: Data;
  private warningKeys: string[] = [];
  get warning(): string | undefined { return this.warningKeys.length ? this.warningKeys.map(key => t(key)).join(' ') : undefined; }
  set warning(key: string | undefined) { this.warningKeys = key ? [key] : []; }
  private legacyData?: string;
  constructor(directory: string, private encryption: Encryption, clientId = '') {
    this.directory = resolve(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.data = { settings: settingsInput({ ...DEFAULT_SETTINGS, palettes: undefined, paletteId: undefined, clientId }) };
    const path = join(directory, 'data.json');
    if (existsSync(path)) {
      let removeLegacyAuthor = false;
      try {
        const original = readFileSync(path, 'utf8');
        const parsed = JSON.parse(original);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.settings || typeof parsed.settings !== 'object' || Array.isArray(parsed.settings)) throw new Error('shape');
        const settings = storedSettingsInput({ ...this.data.settings, ...parsed.settings, palettes: parsed.settings.palettes, paletteId: parsed.settings.paletteId });
        this.data = { settings };
        removeLegacyAuthor = Object.prototype.hasOwnProperty.call(parsed.settings, 'author');
        // Removed features are never restored into application state. Preserve
        // an existing user's old file once before a later settings save replaces
        // it, so migration cannot silently destroy previously authored code.
        if (['drafts', 'history'].some(key => parsed[key] != null && (!Array.isArray(parsed[key]) || parsed[key].length > 0))) {
          this.legacyData = original;
        }
        if (clientId && !this.data.settings.clientId) this.data.settings.clientId = clientId;
      } catch {
        this.warning = '本地数据文件无法读取，已保留备份。';
        renameSync(path, join(directory, `data-corrupt-${Date.now()}.json`));
      }
      if (removeLegacyAuthor) {
        // Remove the obsolete default identity from active settings immediately.
        // persist() first preserves any old authored code in the legacy backup.
        try { this.persist(); }
        catch { this.warning = '旧版默认署名已停用，但本地设置迁移暂时无法保存；原文件已保留。'; }
      }
    }
    this.removeLegacyRemoteData();
  }
  private removeLegacyRemoteData(): void {
    let failed = false;
    try {
      for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
        if (!entry.isFile() || !isLegacyRemoteDataFile(entry.name)) continue;
        const path = resolve(this.directory, entry.name);
        if (dirname(path) !== this.directory) continue;
        try { unlinkSync(path); } catch { failed = true; }
      }
    } catch { failed = true; }
    if (failed) this.warningKeys.push('旧版远端数据文件未能全部清理；程序不会再读取或保存这些数据。');
  }
  get secure(): boolean { return this.encryption.isEncryptionAvailable() && this.encryption.getSelectedStorageBackend?.() !== 'basic_text'; }
  private atomic(name: string, value: string | Buffer) {
    const path = join(this.directory, name);
    const temporary = `${path}.${randomUUID()}.tmp`;
    // Never truncate an existing temporary path: it may be a hard link or a
    // symbolic link. Keep the exclusive file descriptor through the write.
    const descriptor = openSync(temporary, 'wx', 0o600);
    try {
      try { writeFileSync(descriptor, value); }
      finally { closeSync(descriptor); }
      renameSync(temporary, path);
    } finally {
      try { unlinkSync(temporary); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  persist() {
    const settings = settingsInput(this.data.settings);
    if (this.legacyData !== undefined) {
      const digest = createHash('sha256').update(this.legacyData).digest('hex').slice(0, 16);
      const name = `data-legacy-${digest}.json`;
      const path = join(this.directory, name);
      if (!existsSync(path)) this.atomic(name, this.legacyData);
      else if (readFileSync(path, 'utf8') !== this.legacyData) throw new Error(t('旧版数据备份冲突，已保留原文件并停止保存。'));
      this.legacyData = undefined;
    }
    // Explicitly whitelist settings. New code, local drafts and submission
    // ledgers must never become durable data, even through extra runtime fields.
    this.atomic('data.json', JSON.stringify({ settings }, null, 2));
    this.data = { settings };
  }
  saveToken(token: string) { if (this.secure) this.atomic('session.enc', this.encryption.encryptString(token)); else this.clearToken(); }
  loadToken(): string | undefined {
    const path = join(this.directory, 'session.enc');
    if (!this.secure || !existsSync(path)) return undefined;
    try { return this.encryption.decryptString(readFileSync(path)); } catch { this.warning = '保存的登录状态无法解密，请重新登录。'; return undefined; }
  }
  clearToken() { const path = join(this.directory, 'session.enc'); if (existsSync(path)) unlinkSync(path); }
}
