import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createProvider } from '../provider/server.mjs';
async function withSource(context) {
  const service = createProvider(); service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });
  const base = `http://127.0.0.1:${service.address().port}`;
  const control = value => fetch(base + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const post = (path, value) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { base, control, post };
}

test('封册消息可先于背面且下一册已开始', async context => {
  const { base } = await withSource(context); const events = (await (await fetch(base + '/scan/events')).text()).trim().split('\n').map(JSON.parse);
  assert.ok(events.findIndex(event => event.type === 'sealBook') < events.findIndex(event => event.face === 'back' && event.book === 'book-a'));
  assert.ok(events.some(event => event.type === 'blankSide' && event.book === 'book-b'));
});
test('重扫与人工移册有明确引用而非覆盖原图', async context => {
  const { base, control } = await withSource(context); await control({ rescan: true, reassign: true });
  const events = (await (await fetch(base + '/scan/events')).text()).trim().split('\n').map(JSON.parse);
  assert.equal(events.find(event => event.type === 'rescan').replaces, 1); assert.equal(events.at(-1).decisionId, 'move-1');
  assert.notEqual(await (await fetch(base + '/scan/images/front1')).text(), await (await fetch(base + '/scan/images/rescan1')).text());
});
