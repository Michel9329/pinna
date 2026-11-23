/**
 * Pinna - JSON input validation.
 *
 * Without these schemas the handlers would call `c.req.json<T>()`, a type cast
 * WITHOUT runtime validation: a malformed or abusive body would get through
 * (e.g. multi-MB body, NaN coords, non-array attachment_ids). These Zod
 * schemas are FAITHFUL to the existing behavior: they accept everything the
 * widget sends, and ONLY add anti-abuse bounds + type safety + array validation.
 *
 * Deliberate defensive choices:
 * - No `.strict()`: extra keys are ignored (stripped), as with a plain type
 *   cast. Adding strict could break the widget if it sent a new field.
 * - GENEROUS bounds: the goal is to block abuse, not to limit real use.
 *   `body` up to 5,000 characters (the widget textarea has the same
 *   maxlength). The daily caps and the comment storage quota are below, and
 *   index.ts enforces them.
 * - `viewport` stays a free string (the DB does not constrain the enum; the
 *   widget only sends desktop|tablet|mobile but it is not tightened, to avoid
 *   breaking edge cases).
 * - `status` in the patch stays a free string: updateComment already ignores
 *   values != open|done (what is a no-op must not become a 400).
 */
import { z } from 'zod';

/** Maximum length of a comment's text. */
export const COMMENT_BODY_MAX = 5_000;
const BODY_MAX = COMMENT_BODY_MAX;
/** Comments per day per user (all projects) and per project (all users). */
export const COMMENTS_PER_USER_DAY = 200;
export const COMMENTS_PER_PROJECT_DAY = 1_000;
/**
 * Comment storage quota of a project: sum of the characters of text, page
 * path and selector (path and selector, up to 4,000 characters each, count
 * too, not only the text).
 * 2 million = about 150 comments with every field at the maximum, or tens of
 * thousands of normal comments (real reviews have dozens).
 */
export const PROJECT_COMMENT_CHARS = 2_000_000;
const STR_MAX = 4_000; // page path: generous
/**
 * CSS selector of a pin's anchor. The widget builds at most six segments
 * (about 700 characters in the worst realistic case) and sends none when the
 * result is longer than this; every viewer's widget runs querySelector on the
 * stored value at each refresh.
 */
export const SELECTOR_MAX = 1_000;
// Attachments per comment: the widget sends only a few.
export const COMMENT_ATT_MAX = 10;
const ATT_MAX = COMMENT_ATT_MAX;

// number that rejects NaN/Infinity (defense; they never arrive via JSON anyway).
const finiteNum = z.number().refine((n) => Number.isFinite(n), 'invalid number');

/**
 * Control characters. U+0000 also breaks the quota: SQLite's LENGTH() stops at
 * the first NUL, so a text starting with one would count as zero characters.
 * - text: honest input carries some (U+000B and U+000C from a text pasted from
 *   Word), so they are removed, not refused: everything below U+0020 except
 *   tab, line feed and carriage return, plus U+007F. The cleaned text is the
 *   one validated, stored and counted; empty after cleaning = empty.
 * - selector: the widget may build one from a data-* value holding a tab or a
 *   line feed; such a selector is dropped (null) and the pin keeps its
 *   coordinates.
 * - page path: never holds one, refused.
 */
const NO_C0 = /^[^\u0000-\u001f]*$/;
const TEXT_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const SELECTOR_CONTROLS = /[\u0000-\u001f\u007f]/;

const cleanText = (v: unknown) => (typeof v === 'string' ? v.replace(TEXT_CONTROLS, '') : v);
const dropControlSelector = (v: unknown) => (typeof v === 'string' && SELECTOR_CONTROLS.test(v) ? null : v);

export const newCommentSchema = z.object({
  body: z.preprocess(
    cleanText,
    z
      .string()
      .min(1, 'body is required')
      .max(BODY_MAX, 'comment too long')
      .refine((s) => s.trim().length > 0, 'body is required'),
  ),
  parent_id: z.string().max(200).nullish(),
  // page_path: the widget always sends a string ('' for replies, the path for
  // pins), never null. .optional() to match NewCommentInput (?: string).
  page_path: z.string().max(STR_MAX).regex(NO_C0, 'invalid characters in page_path').optional(),
  anchor_selector: z.preprocess(dropControlSelector, z.string().max(SELECTOR_MAX).nullish()),
  anchor_x: finiteNum.nullish(),
  anchor_y: finiteNum.nullish(),
  page_x: finiteNum.nullish(),
  page_y: finiteNum.nullish(),
  viewport_w: finiteNum.nullish(),
  viewport: z.string().max(20).nullish(),
  attachment_ids: z.array(z.string().max(200)).max(ATT_MAX).optional(),
});

export const inviteSchema = z.object({
  email: z.string().min(3, 'invalid email').max(320),
  name: z.string().max(200).nullish(),
  role: z.string().max(20).optional(),
});

export const projectSchema = z.object({
  name: z.string().min(1, 'name is required').max(200),
  staging_url: z.string().max(STR_MAX).optional(),
});

export const commentPatchSchema = z.object({
  status: z.string().max(20).optional(),
  body: z.preprocess(cleanText, z.string().max(BODY_MAX).optional()),
});

// Payload of POST /api/auth/verify-code. Email + a code of exactly 6 digits
// (the regex also blocks abusive payloads before the DB).
export const verifyCodeSchema = z.object({
  email: z.string().min(3, 'invalid email').max(320),
  code: z.string().regex(/^\d{6}$/, 'invalid code'),
});

/** First readable message from a ZodError, for the 400 response. */
export function firstError(err: z.ZodError): string {
  return err.issues[0]?.message || 'invalid data';
}
