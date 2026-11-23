/**
 * Pinna - validation schema tests.
 * Run: `bun test` from the repository root.
 *
 * Goal #1: make sure the schemas do NOT reject what the widget really sends
 * (regression guard on the comment flow). Payloads taken 1:1 from the comment
 * POST in widget/pinna.js. Goal #2: confirm that malformed/abusive input is
 * rejected.
 */
import { test, expect } from 'bun:test';
import {
  newCommentSchema,
  inviteSchema,
  projectSchema,
  commentPatchSchema,
} from '../worker/schemas';

// Top-level pin, exact widget payload.
const widgetPin = {
  parent_id: null,
  page_path: '/contact',
  page_x: 600,
  page_y: 340,
  anchor_selector: '.hero h1',
  anchor_x: 0.5,
  anchor_y: 0.2,
  viewport_w: 1440,
  viewport: 'desktop',
  attachment_ids: [],
  body: 'This heading should move higher up',
};
// Reply: parent_id set, page_path '', coords/viewport null.
const widgetReply = {
  parent_id: 'c_123e4567',
  page_path: '',
  page_x: null,
  page_y: null,
  anchor_selector: null,
  anchor_x: null,
  anchor_y: null,
  viewport_w: 1440,
  viewport: null,
  attachment_ids: [],
  body: 'Agreed, fixing it',
};

// --- newCommentSchema: must ACCEPT the real widget ---
test('accepts the widget pin', () => {
  expect(newCommentSchema.safeParse(widgetPin).success).toBe(true);
});
test('accepts the widget reply', () => {
  expect(newCommentSchema.safeParse(widgetReply).success).toBe(true);
});
test('accepts a body at the maximum length (5,000) + 3 attachments', () => {
  const r = newCommentSchema.safeParse({
    ...widgetPin,
    body: 'x'.repeat(5000),
    attachment_ids: ['a1', 'b2', 'c3'],
  });
  expect(r.success).toBe(true);
});
test('accepts mobile/tablet viewport', () => {
  expect(newCommentSchema.safeParse({ ...widgetPin, viewport: 'mobile' }).success).toBe(true);
  expect(newCommentSchema.safeParse({ ...widgetPin, viewport: 'tablet' }).success).toBe(true);
});
test('ignores extra keys (not strict)', () => {
  expect(newCommentSchema.safeParse({ ...widgetPin, futureField: 1, x: 'y' }).success).toBe(true);
});

// --- newCommentSchema: must REJECT malformed/abusive input ---
test('rejects a missing body', () => {
  const { body, ...noBody } = widgetPin;
  expect(newCommentSchema.safeParse(noBody).success).toBe(false);
});
test('rejects a whitespace-only body', () => {
  expect(newCommentSchema.safeParse({ ...widgetPin, body: '    ' }).success).toBe(false);
});
test('rejects a non-string body', () => {
  expect(newCommentSchema.safeParse({ ...widgetPin, body: 123 }).success).toBe(false);
});
test('rejects an abusive body (60k chars)', () => {
  expect(newCommentSchema.safeParse({ ...widgetPin, body: 'x'.repeat(60000) }).success).toBe(false);
});
test('rejects non-array attachment_ids (string)', () => {
  expect(newCommentSchema.safeParse({ ...widgetPin, attachment_ids: 'abc' }).success).toBe(false);
});
test('rejects >50 attachments', () => {
  expect(
    newCommentSchema.safeParse({ ...widgetPin, attachment_ids: Array(51).fill('a') }).success,
  ).toBe(false);
});
test('rejects NaN/Infinity coords', () => {
  expect(newCommentSchema.safeParse({ ...widgetPin, page_x: NaN }).success).toBe(false);
  expect(newCommentSchema.safeParse({ ...widgetPin, anchor_x: Infinity }).success).toBe(false);
});

// --- inviteSchema ---
test('inviteSchema: valid email+role', () => {
  expect(inviteSchema.safeParse({ email: 'collab@example.com', role: 'collab' }).success).toBe(true);
  expect(inviteSchema.safeParse({ email: 'a@example.org' }).success).toBe(true);
});
test('inviteSchema: rejects a missing email', () => {
  expect(inviteSchema.safeParse({}).success).toBe(false);
});

// --- projectSchema ---
test('projectSchema: name is required', () => {
  expect(projectSchema.safeParse({ name: 'Acme Studio site', staging_url: 'https://x.pages.dev' }).success).toBe(true);
  expect(projectSchema.safeParse({}).success).toBe(false);
});

// --- commentPatchSchema ---
test('commentPatchSchema: status/body optional', () => {
  expect(commentPatchSchema.safeParse({ status: 'done' }).success).toBe(true);
  expect(commentPatchSchema.safeParse({ status: 'open' }).success).toBe(true);
  expect(commentPatchSchema.safeParse({ body: 'edited text' }).success).toBe(true);
  expect(commentPatchSchema.safeParse({}).success).toBe(true);
});
test('commentPatchSchema: rejects a non-string body', () => {
  expect(commentPatchSchema.safeParse({ body: { x: 1 } }).success).toBe(false);
});

test('anchor_selector: at most 1,000 characters (the widget sends none when longer); page_path keeps 4,000', () => {
  expect(newCommentSchema.safeParse({ ...widgetPin, anchor_selector: 'a'.repeat(1000) }).success).toBe(true);
  expect(newCommentSchema.safeParse({ ...widgetPin, anchor_selector: 'a'.repeat(1001) }).success).toBe(false);
  expect(newCommentSchema.safeParse({ ...widgetPin, anchor_selector: null }).success).toBe(true);
  expect(newCommentSchema.safeParse({ ...widgetPin, page_path: '/' + 'p'.repeat(3999) }).success).toBe(true);
});
