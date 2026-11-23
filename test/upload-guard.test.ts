/**
 * Pinna - upload-guard tests.
 * Run: `bun test` from the repository root.
 *
 * Locks in, against regressions, the 3-layer defense against storage XSS:
 * MIME allowlist (SVG forbidden), magic-byte sniffing, declared==detected. The
 * critical case ("an SVG renamed .png must be REJECTED") is a permanent test
 * here. Pure functions -> no Miniflare/auth.
 */
import { test, expect } from 'bun:test';
import {
  detectMimeFromBytes,
  isAllowedMime,
  isInlineSafe,
  validateUpload,
} from '../worker/upload-guard';

// Real signatures (first bytes) per format.
const SIG: Record<string, number[]> = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpeg: [0xff, 0xd8, 0xff, 0xe0],
  gif: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  webp: [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
  pdf: [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31],
  svg: [0x3c, 0x73, 0x76, 0x67, 0x20], // "<svg "
  txt: [0x68, 0x65, 0x6c, 0x6c, 0x6f], // "hello"
};
const bytes = (k: string) => new Uint8Array(SIG[k] ?? []);
const file = (k: string, declaredType: string, name = 'f') =>
  new File([bytes(k)], name, { type: declaredType });

// --- detectMimeFromBytes: recognizes the safe formats, null for the rest ---
test('detect recognizes PNG/JPEG/GIF/WebP/PDF', () => {
  expect(detectMimeFromBytes(bytes('png'))).toBe('image/png');
  expect(detectMimeFromBytes(bytes('jpeg'))).toBe('image/jpeg');
  expect(detectMimeFromBytes(bytes('gif'))).toBe('image/gif');
  expect(detectMimeFromBytes(bytes('webp'))).toBe('image/webp');
  expect(detectMimeFromBytes(bytes('pdf'))).toBe('application/pdf');
});
test('detect returns null for SVG and text', () => {
  expect(detectMimeFromBytes(bytes('svg'))).toBeNull();
  expect(detectMimeFromBytes(bytes('txt'))).toBeNull();
  expect(detectMimeFromBytes(new Uint8Array([]))).toBeNull();
});

// --- MIME allowlist ---
test('isAllowedMime: only safe images + PDF, SVG forbidden', () => {
  for (const m of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']) {
    expect(isAllowedMime(m)).toBe(true);
  }
  expect(isAllowedMime('image/svg+xml')).toBe(false);
  expect(isAllowedMime('text/plain')).toBe(false);
  expect(isAllowedMime('text/html')).toBe(false);
});
test('isInlineSafe: PDF NOT inline (PDF.js XSS), images yes', () => {
  expect(isInlineSafe('image/png')).toBe(true);
  expect(isInlineSafe('application/pdf')).toBe(false);
});

// --- validateUpload: the full pipeline ---
test('validateUpload accepts a real PNG', async () => {
  const r = await validateUpload(file('png', 'image/png', 'photo.png'));
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.mime).toBe('image/png');
});
test('validateUpload accepts a real PDF', async () => {
  const r = await validateUpload(file('pdf', 'application/pdf', 'doc.pdf'));
  expect(r.ok).toBe(true);
});
test('CRITICAL: SVG renamed .png/PNG-declared -> REJECTED', async () => {
  const r = await validateUpload(file('svg', 'image/png', 'evil.png'));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.code).toBe('unknown-format');
});
test('SVG declared svg+xml -> REJECTED (mime-not-allowed)', async () => {
  const r = await validateUpload(file('svg', 'image/svg+xml', 'x.svg'));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.code).toBe('mime-not-allowed');
});
test('txt renamed .png (text/plain) -> REJECTED', async () => {
  const r = await validateUpload(file('txt', 'text/plain', 'x.png'));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.code).toBe('mime-not-allowed');
});
test('mismatch: PNG bytes declared as JPEG -> REJECTED (magic-mismatch)', async () => {
  const r = await validateUpload(file('png', 'image/jpeg', 'x.jpg'));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.code).toBe('magic-mismatch');
});
