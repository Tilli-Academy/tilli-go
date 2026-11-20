import { AppError } from './errors';

/**
 * Which files a change request may have attached, and how to recognise each one.
 * The stored type comes from this table, never from what the browser claims, and
 * the first bytes of the file must match it (a renamed .exe is refused).
 */
type Kind = { mime: string; magic: (b: Buffer) => boolean };

const starts = (sig: number[]) => (b: Buffer) => sig.every((v, i) => b[i] === v);
const ascii = (s: string, at = 0) => (b: Buffer) => b.subarray(at, at + s.length).toString('latin1') === s;
const OLE = starts([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]); // old .doc/.xls/.ppt
/** Plain text: no NUL bytes in the first 8 KB (binaries almost always have some). */
const TEXT = (b: Buffer) => !b.subarray(0, 8192).includes(0);
/** PDF: header at the start and the end-of-file marker near the end (rejects truncated / fake files). */
const PDF = (b: Buffer) => ascii('%PDF-')(b) && b.subarray(Math.max(0, b.length - 2048)).toString('latin1').includes('%%EOF');

/**
 * Names of the files inside a ZIP, read from its central directory (nothing is
 * extracted). Returns null when the archive is malformed.
 */
export function zipEntries(b: Buffer): string[] | null {
  if (!starts([0x50, 0x4b])(b) || b.length < 22) return null;
  // End-of-central-directory record: within the last 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== 0x02014b50) return null;
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    if (p + 46 + nameLen > b.length) return null;
    names.push(b.subarray(p + 46, p + 46 + nameLen).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}
const ZIP = (b: Buffer) => zipEntries(b) !== null;
/**
 * Office Open XML (docx/xlsx/pptx): a valid ZIP with the package manifest and the
 * main part for that type, and no VBA macros (macro files must be .docm etc.).
 */
const OOXML = (mainPart: string) => (b: Buffer) => {
  const names = zipEntries(b);
  return !!names && names.includes('[Content_Types].xml') && names.includes(mainPart) && !names.some((n) => /vbaProject\.bin$/i.test(n));
};

const KINDS: Record<string, Kind> = {
  pdf: { mime: 'application/pdf', magic: PDF },
  png: { mime: 'image/png', magic: starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  jpg: { mime: 'image/jpeg', magic: starts([0xff, 0xd8, 0xff]) },
  jpeg: { mime: 'image/jpeg', magic: starts([0xff, 0xd8, 0xff]) },
  gif: { mime: 'image/gif', magic: (b) => ascii('GIF87a')(b) || ascii('GIF89a')(b) },
  webp: { mime: 'image/webp', magic: (b) => ascii('RIFF')(b) && ascii('WEBP', 8)(b) },
  txt: { mime: 'text/plain', magic: TEXT },
  csv: { mime: 'text/csv', magic: TEXT },
  doc: { mime: 'application/msword', magic: OLE },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: OOXML('word/document.xml') },
  xls: { mime: 'application/vnd.ms-excel', magic: OLE },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: OOXML('xl/workbook.xml') },
  ppt: { mime: 'application/vnd.ms-powerpoint', magic: OLE },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', magic: OOXML('ppt/presentation.xml') },
  zip: { mime: 'application/zip', magic: ZIP },
};

export const ALLOWED_EXTENSIONS = Object.keys(KINDS);

/** Returns the MIME type to store, or throws 415 with a message the user can act on. */
export function checkUpload(fileName: string, data: Buffer): string {
  const ext = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  const kind = KINDS[ext];
  if (!kind) {
    throw new AppError(`This file type isn't allowed. Allowed: ${ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(', ')}`, 415);
  }
  if (!kind.magic(data)) {
    throw new AppError(`The file doesn't look like a real .${ext} file`, 415);
  }
  return kind.mime;
}
