/**
 * Pinna - Upload guard.
 *
 * Three-layer defense against storage XSS / browser content-type mismatch:
 *
 *  1. Server-side MIME allowlist: only "safe" images + PDF. SVG is forbidden
 *     (inline script + foreignObject XSS).
 *  2. Magic-number check on the first bytes of the file: the client's
 *     Content-Type header is not enough, the real content must confirm it.
 *     PNG/JPEG/WebP/GIF/PDF have recognizable signatures.
 *  3. Serving: `Content-Disposition: attachment` by default, `inline` only for
 *     allowlisted images. PDF never inline (PDF.js JS runs in the domain context).
 *
 * Once the 3 layers pass, the file lands on R2 with the canonical
 * content_type (the one derived from the signature, not the client's).
 */

export type SafeMime =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif'
  | 'application/pdf';

const SAFE_MIMES: readonly SafeMime[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
] as const;

/** MIME types that can be served inline (viewable in the browser without a download). */
const INLINE_SAFE: readonly SafeMime[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** True if the MIME type is in the server-side allowlist. Strict, no fallback. */
export function isAllowedMime(mime: string): mime is SafeMime {
  return (SAFE_MIMES as readonly string[]).includes(mime);
}

/** True if the attachment can be shown inline in the browser. */
export function isInlineSafe(mime: string): boolean {
  return (INLINE_SAFE as readonly string[]).includes(mime);
}

/**
 * Checks the first bytes of the file and returns the recognized MIME type, or null.
 * Recognition based on the standard signatures (RFC + spec):
 *   PNG   89 50 4E 47 0D 0A 1A 0A
 *   JPEG  FF D8 FF
 *   GIF   47 49 46 38 (GIF8), covers GIF87a and GIF89a
 *   WebP  52 49 46 46 _ _ _ _ 57 45 42 50  ("RIFF" + 4-byte size + "WEBP")
 *   PDF   25 50 44 46 2D  ("%PDF-")
 */
export function detectMimeFromBytes(bytes: Uint8Array): SafeMime | null {
  // PNG
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  // JPEG
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  // GIF (GIF87a / GIF89a, both start with "GIF8")
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return 'image/gif';
  }
  // WebP: "RIFF" ... "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  // PDF: "%PDF-"
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return 'application/pdf';
  }
  return null;
}

/**
 * Full upload validation pipeline:
 *  1. is the client content-type in the allowlist? (cheap pre-check)
 *  2. reads the first 16 bytes of the file
 *  3. is the signature recognized?
 *  4. does the signature match the declared content-type? (anti-mismatch)
 *
 * Returns the canonical MIME type (derived from the signature) or a structured error.
 */
export interface UploadOk {
  ok: true;
  mime: SafeMime;
  /** First bytes already read for sniffing: the caller can reuse them and skip a second read. */
  headBytes: Uint8Array;
}
export interface UploadFail {
  ok: false;
  code: 'mime-not-allowed' | 'magic-mismatch' | 'unknown-format' | 'read-error';
  message: string;
}
export type UploadCheck = UploadOk | UploadFail;

export async function validateUpload(file: File): Promise<UploadCheck> {
  const declared = (file.type || '').toLowerCase();
  if (!isAllowedMime(declared)) {
    return {
      ok: false,
      code: 'mime-not-allowed',
      message:
        'file type not allowed (' +
        (declared || 'unknown') +
        '). accepted: PNG, JPEG, WebP, GIF, PDF',
    };
  }
  let headBytes: Uint8Array;
  try {
    const slice = file.slice(0, 16);
    headBytes = new Uint8Array(await slice.arrayBuffer());
  } catch (e) {
    return {
      ok: false,
      code: 'read-error',
      message: 'could not read the file: ' + (e as Error).message,
    };
  }
  const detected = detectMimeFromBytes(headBytes);
  if (!detected) {
    return {
      ok: false,
      code: 'unknown-format',
      message: 'file format not recognized from the signature of the first bytes',
    };
  }
  if (detected !== declared) {
    return {
      ok: false,
      code: 'magic-mismatch',
      message:
        'mismatch between declared type (' + declared + ') and real signature (' + detected + ')',
    };
  }
  return { ok: true, mime: detected, headBytes };
}

/**
 * Storage quotas: with only a 10 MB per-file cap and 10 uploads per minute, a
 * single user could put up to ~14 GB a day on R2.
 */
/** Maximum attachment storage of a project (uploads + screenshots). */
export const PROJECT_QUOTA_BYTES = 200 * 1024 * 1024;
/** Bytes a user can upload in one day (all projects). */
export const USER_DAILY_UPLOAD_BYTES = 100 * 1024 * 1024;
/**
 * Number of attachments: if only bytes counted, tiny GIFs at 10 per minute
 * would fill the project with rows (each one a signed URL in the list). Cap
 * per project (uploads + screenshots, drafts included) and per user per day.
 */
export const PROJECT_MAX_ATTACHMENTS = 1_000;
export const USER_DAILY_UPLOADS = 200;

/** Maximum size of an attached file. */
export const MAX_UPLOAD_FILE = 10 * 1024 * 1024;
/** Maximum body of an upload: the file plus the multipart envelope (name, boundaries). */
export const MAX_UPLOAD_BODY = MAX_UPLOAD_FILE + 64 * 1024;

/**
 * Declared Content-Length: upload and /shot require it and reject BEFORE
 * reading the body (otherwise the Worker would read everything and only then
 * look at the size). Null if missing or not a valid integer. The runtime does
 * not deliver more bytes than declared, so the cap really holds.
 */
export function declaredLength(header: string | undefined): number | null {
  if (!header || !/^\d{1,12}$/.test(header.trim())) return null;
  return Number(header.trim());
}

/** Longest stored file name, in characters (code points). */
export const FILENAME_MAX = 200;
/** A longer "extension" is not one: the name is simply cut. */
const EXT_MAX = 20;

/**
 * Extensions of each type validateUpload accepts; the first is the one added
 * when a name does not end with any of them.
 */
const TYPE_EXTENSIONS: Record<string, string[]> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg', '.jpe', '.jfif'],
  'image/webp': ['.webp'],
  'image/gif': ['.gif'],
  'application/pdf': ['.pdf'],
};

/**
 * The name made to agree with the type read from the file's first bytes: if
 * its extension is not one of that type's, the canonical one is appended
 * ("invoice.cmd" stored as a PDF -> "invoice.cmd.pdf"). The type check ignores
 * the name, and the download uses it: a PDF named "invoice.cmd" would be
 * saved, and could be run, as a Windows batch file. Unknown type: unchanged.
 */
export function nameForType(name: string, mime: string): string {
  const exts = TYPE_EXTENSIONS[mime.toLowerCase()];
  if (!exts) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
  return exts.includes(ext) ? name : name + exts[0];
}

/**
 * File name as stored and shown: control characters (C0, DEL, C1) removed,
 * the extension made to agree with `mime` when given (nameForType), and at
 * most FILENAME_MAX characters, keeping the extension. The name comes from
 * the client unchecked; without the cap a single upload could store kilobytes
 * of name in D1 and in every comment list. Empty -> 'file'.
 */
export function safeFilename(name: string, mime?: string): string {
  let clean = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  if (mime) clean = nameForType(clean || 'file', mime);
  const chars = Array.from(clean);
  if (chars.length <= FILENAME_MAX) return clean || 'file';
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 ? Array.from(clean.slice(dot)) : [];
  const keep = ext.length > 1 && ext.length <= EXT_MAX ? ext : [];
  const stem = keep.length ? Array.from(clean.slice(0, dot)) : chars;
  return stem.slice(0, FILENAME_MAX - keep.length).join('') + keep.join('');
}
