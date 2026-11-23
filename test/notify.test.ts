/**
 * Pinna - notification email: the recipient's name (written by whoever sends
 * the invite) must not be able to inject markup.
 */
import { test, expect } from 'bun:test';
import { notifyHtml } from '../worker/notify';

test('notifyHtml: recipient name escaped', () => {
  const html = notifyHtml('<img src=x onerror=alert(1)>"', 'Site', 'Line', 'Text', 'https://pinna.test/p/x');
  expect(html).not.toContain('<img src=x');
  expect(html).toContain('Hi &lt;img src=x onerror=alert(1)&gt;&quot;,');
});

test('notifyHtml: project and comment text stay escaped', () => {
  const html = notifyHtml(null, '<b>Site</b>', 'Line', "<a href='x'>y</a>", 'https://pinna.test/p/x');
  expect(html).not.toContain('<b>Site</b>');
  expect(html).not.toContain("<a href='x'>");
});
