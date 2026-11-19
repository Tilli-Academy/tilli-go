import { AppError } from './errors';

/**
 * Which files a change request may have attached, and how to recognise each one.
 * The stored type comes from this table, never from what the browser claims, and
 * the first bytes of the file must match it (a renamed .exe is refused).
 */
type Kind = { mime: string; magic: (b: Buffer) => boolean };

const starts = (sig: number[]) => (b: Buffer) => sig.every((v, i) => b[i] === v);
const ascii = (s: string, at = 0) => (b: Buffer) => b.subarray(at, at + s.length).toString('latin1') === s;
const ZIP = (b: Buffer) => starts([0x50, 0x4b, 0x03, 0x04])(b) || starts([0x50, 0x4b, 0x05, 0x06])(b);
const OLE = starts([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]); // old .doc/.xls/.ppt
/** Plain text: no NUL bytes in the first 8 KB (binaries almost always have some). */
const TEXT = (b: Buffer) => !b.subarray(0, 8192).includes(0);

const KINDS: Record<string, Kind> = {
  pdf: { mime: 'application/pdf', magic: ascii('%PDF-') },
  png: { mime: 'image/png', magic: starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  jpg: { mime: 'image/jpeg', magic: starts([0xff, 0xd8, 0xff]) },
  jpeg: { mime: 'image/jpeg', magic: starts([0xff, 0xd8, 0xff]) },
  gif: { mime: 'image/gif', magic: (b) => ascii('GIF87a')(b) || ascii('GIF89a')(b) },
  webp: { mime: 'image/webp', magic: (b) => ascii('RIFF')(b) && ascii('WEBP', 8)(b) },
  txt: { mime: 'text/plain', magic: TEXT },
  csv: { mime: 'text/csv', magic: TEXT },
  doc: { mime: 'application/msword', magic: OLE },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: ZIP },
  xls: { mime: 'application/vnd.ms-excel', magic: OLE },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: ZIP },
  ppt: { mime: 'application/vnd.ms-powerpoint', magic: OLE },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', magic: ZIP },
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
