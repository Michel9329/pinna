/**
 * Pinna - the stored and downloaded file name agrees with the type read from
 * the file's first bytes. The type check ignores the name, and the download
 * uses it: a file that starts with "%PDF-" and is called "invoice.cmd" would
 * pass as a PDF and be saved as a Windows batch file. When the extension is
 * not one of the detected type's, the canonical one is appended, at upload and
 * again in the Content-Disposition header (rows stored before are covered).
 */
import { test, expect } from 'bun:test';
import { signTyped } from '../worker/auth';
import * as db from '../worker/db';
import { nameForType, safeFilename, FILENAME_MAX } from '../worker/upload-guard';
import { appFetch, makeEnv, makeCtx, seedUser, seedProject, sized, TEST_SECRET } from './helpers/env';

const PDF = new TextEncoder().encode('%PDF-1.4\n%junk\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

test('nameForType: a wrong or missing extension gets the canonical one; a right one is left alone', () => {
  expect(nameForType('invoice.cmd', 'application/pdf')).toBe('invoice.cmd.pdf');
  expect(nameForType('photo.html', 'image/png')).toBe('photo.html.png');
  expect(nameForType('scan', 'application/pdf')).toBe('scan.pdf');
  expect(nameForType('report.pdf', 'application/pdf')).toBe('report.pdf');
  expect(nameForType('PHOTO.PNG', 'image/png')).toBe('PHOTO.PNG');
  expect(nameForType('holiday.JPEG', 'image/jpeg')).toBe('holiday.JPEG');
  expect(nameForType('pic.jpg', 'image/jpeg')).toBe('pic.jpg');
  expect(nameForType('anim.gif', 'image/webp')).toBe('anim.gif.webp');
  // A type the upload never stores: unchanged.
  expect(nameForType('notes.txt', 'text/plain')).toBe('notes.txt');
});

test('safeFilename with a type: aligned, then capped keeping the new extension', () => {
  expect(safeFilename('invoice.cmd', 'application/pdf')).toBe('invoice.cmd.pdf');
  expect(safeFilename('', 'application/pdf')).toBe('file.pdf');
  const long = safeFilename('a'.repeat(300) + '.cmd', 'application/pdf');
  expect(Array.from(long).length).toBe(FILENAME_MAX);
  expect(long.endsWith('.pdf')).toBe(true);
});

async function setup() {
  const env = makeEnv();
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  seedProject(env.raw, 'p1', 'site', 'https://staging.test/');
  await db.addMembership(env.DB, 'u_c', 'p1', 'client');
  const wt = await signTyped('widget', { uid: 'u_c', pid: 'p1', exp: Date.now() + 3600_000, iat: Date.now() }, TEST_SECRET);
  return { env, wt };
}

test('upload: a PDF named invoice.cmd is stored as invoice.cmd.pdf; a correct name is kept', async () => {
  const { env, wt } = await setup();
  // Bun's multipart parser takes a part's type from the file name (none for
  // "invoice.cmd"), while a browser and the Workers runtime use the part's
  // Content-Type. So the request hands the route the form a browser would
  // produce: a File named "invoice.cmd" of type application/pdf.
  const upload = async (name: string) => {
    const form = new FormData();
    form.append('file', new File([PDF], name, { type: 'application/pdf' }));
    const req = new Request('https://pinna.test/api/projects/site/attachments', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + wt,
        'Content-Type': 'multipart/form-data; boundary=unused',
        'Content-Length': String(PDF.byteLength + 200),
      },
      body: 'unused',
    });
    Object.defineProperty(req, 'formData', { value: async () => form });
    const ctx = makeCtx();
    const res = await appFetch(await sized(req), env, ctx);
    await ctx.settle();
    expect(res.status).toBe(201);
    return ((await res.json()) as { filename: string }).filename;
  };
  expect(await upload('invoice.cmd')).toBe('invoice.cmd.pdf');
  expect(await upload('Report.PDF')).toBe('Report.PDF');
  expect(await upload('scan')).toBe('scan.pdf');
});

test('download: a row stored before the fix is served with the aligned name', async () => {
  const { env, wt } = await setup();
  await env.ATTACHMENTS.put('att/old', PDF);
  env.raw
    .query("INSERT INTO attachments (id, comment_id, project_id, r2_key, filename, content_type, size, created_at, created_by) VALUES ('old', NULL, 'p1', 'att/old', 'invoice.cmd', 'application/pdf', ?, 0, 'u_c')")
    .run(PDF.byteLength);
  const res = await appFetch(new Request('https://pinna.test/api/attachments/old', { headers: { Authorization: 'Bearer ' + wt } }), env, makeCtx());
  expect(res.status).toBe(200);
  const cd = res.headers.get('Content-Disposition') || '';
  expect(cd).toContain('attachment;');
  expect(cd).toContain('filename="invoice.cmd.pdf"');
  expect(cd).toContain("filename*=UTF-8''invoice.cmd.pdf");
});

test('the right extension somewhere else in the name does not count: x.pdf.cmd becomes x.pdf.cmd.pdf', () => {
  expect(nameForType('x.pdf.cmd', 'application/pdf')).toBe('x.pdf.cmd.pdf');
  expect(nameForType('photo.png.html', 'image/png')).toBe('photo.png.html.png');
});

test('download: the plain filename fallback keeps the type extension after its 200-character cut', async () => {
  const { env, wt } = await setup();
  const name = '\u{1F600}'.repeat(98) + '.cmd.pdf';
  await env.ATTACHMENTS.put('att/emoji', PDF);
  env.raw
    .query("INSERT INTO attachments (id, comment_id, project_id, r2_key, filename, content_type, size, created_at, created_by) VALUES ('emoji', NULL, 'p1', 'att/emoji', ?, 'application/pdf', ?, 0, 'u_c')")
    .run(name, PDF.byteLength);
  const res = await appFetch(new Request('https://pinna.test/api/attachments/emoji', { headers: { Authorization: 'Bearer ' + wt } }), env, makeCtx());
  expect(res.status).toBe(200);
  const cd = res.headers.get('Content-Disposition') || '';
  // 98 emoji = 196 UTF-16 units -> 196 "_", then ".cmd" fits the 200 and ".pdf" is cut: added back.
  expect(cd).toContain('filename="' + '_'.repeat(196) + '.cmd.pdf"');
  expect(cd).toContain("filename*=UTF-8''" + encodeURIComponent(name));
});
