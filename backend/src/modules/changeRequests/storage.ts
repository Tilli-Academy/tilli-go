import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Attachments never go into the database - only a pointer does.
 * "local" writes to UPLOAD_DIR (a Docker volume). A "sharepoint" provider can
 * implement the same two functions with Microsoft Graph, like the Quality System.
 */
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads'));

export const providerName = 'local';

export async function saveFile(crNumber: number, fileName: string, data: Buffer): Promise<string> {
  const dir = path.join(UPLOAD_DIR, `CR-${crNumber}`);
  await mkdir(dir, { recursive: true });
  const safe = fileName.replace(/[^\w.\-]+/g, '_').slice(-120);
  const key = path.join(`CR-${crNumber}`, `${randomUUID()}-${safe}`);
  await writeFile(path.join(UPLOAD_DIR, key), data);
  return key;
}

export async function readStoredFile(key: string): Promise<Buffer> {
  const full = path.resolve(UPLOAD_DIR, key);
  if (!full.startsWith(UPLOAD_DIR + path.sep)) throw new Error('Invalid storage key');
  return readFile(full);
}
