import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Archive, digest } from '../src/archive.mjs';
import { ScannerIntake } from '../src/collector.mjs';
import { Ledger, buildBooks, normalizeSource, parseEvents } from '../src/scanner.mjs';
import { createProvider } from '../provider/server.mjs';

async function harness(context) {
  const directory = await mkdtemp(join(tmpdir(), 'scanner-')); context.after(() => rm(directory, { recursive: true, force: true }));
  const provider = createProvider(); provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  context.after(async () => { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });
  const source = `http://127.0.0.1:${provider.address().port}/`;
  const archive = await new Archive(directory).initialize();
  const control = body => fetch(source + '__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const intake = await new ScannerIntake(archive).load();
  return { directory, provider, source, archive, intake, control };
}

function recordOf(records, book) {
  return records.find(record => record.source === 'scan' && record.identity.book === book);
}

test('乱序到达的册件按册标记归位，不按到达顺序', async context => {
  const { archive, intake, source } = await harness(context);
  await intake.collect(source);
  const records = await archive.list();
  const a = recordOf(records, 'book-a');
  const b = recordOf(records, 'book-b');
  assert.ok(a && b);
  // 封册在背面之前到达，背面仍归 book-a
  assert.equal(a.versions.at(-1).data.sheets[0].back.state, 'present');
  assert.equal(b.versions.at(-1).data.sheets[0].sheetId, 's2');
  assert.equal(a.versions.at(-1).data.scannerSession, 'session-a');
});

test('空白背面被记录为判定而不是遗漏', async context => {
  const { archive, intake, source } = await harness(context);
  await intake.collect(source);
  const data = recordOf(await archive.list(), 'book-b').versions.at(-1).data;
  const back = data.sheets[0].back;
  assert.equal(back.state, 'blank');
  assert.equal(back.blank, true);
  assert.deepEqual(back.blankDecisions.map(item => item.decisionId), ['blank-1']);
  assert.equal(data.completeness.complete, false);
});

test('封册后未到的面标记为缺失而不是空白', async context => {
  const { archive, intake, source, control } = await harness(context);
  await control({ missingBack: true });
  await intake.collect(source);
  const data = recordOf(await archive.list(), 'book-a').versions.at(-1).data;
  assert.equal(data.sheets[0].back.state, 'missing');
  assert.equal(data.sheets[0].back.blank, false);
  assert.deepEqual(data.completeness.missing.map(item => [item.sheetId, item.face]), [['s1', 'back']]);
  assert.equal(data.completeness.complete, false);
});

test('重扫保留旧图并把新版本标为当前', async context => {
  const { archive, intake, source, control } = await harness(context);
  await control({ rescan: true });
  await intake.collect(source);
  const front = recordOf(await archive.list(), 'book-a').versions.at(-1).data.sheets[0].front;
  assert.equal(front.pages.length, 2);
  assert.deepEqual(front.pages.map(page => page.role), ['superseded', 'current']);
  assert.equal(front.pages[1].rescanOf, 1);
  assert.equal(front.currentRevision, 2);
  for (const page of front.pages) assert.equal(await archive.has(page.sha256), true);
});

test('移册保留原始图像与来源册的移出快照', async context => {
  const { archive, intake, source, control } = await harness(context);
  await intake.collect(source);
  await control({ reassign: true });
  await intake.collect(source);
  const records = await archive.list();
  const a = recordOf(records, 'book-a').versions.at(-1).data;
  const b = recordOf(records, 'book-b').versions.at(-1).data;
  assert.equal(a.sheets.length, 0);
  assert.equal(a.transfersOut.length, 1);
  const transfer = a.transfersOut[0];
  assert.equal(transfer.sheetId, 's1');
  assert.equal(transfer.targetBook, 'book-b');
  assert.equal(transfer.snapshot.front.state, 'present');
  assert.equal(transfer.sourceSealed, true);
  assert.equal(b.sheets.find(sheet => sheet.sheetId === 's1').originBook, 'book-a');
});

test('已交出的册件不会因再次采集悄悄混入新内容', async context => {
  const { archive, intake, source, control } = await harness(context);
  await intake.collect(source);
  await control({ lateSheet: true });
  await intake.collect(source);
  const data = recordOf(await archive.list(), 'book-a').versions.at(-1).data;
  assert.deepEqual(data.rejected.map(sheet => sheet.sheetId), ['s9']);
  assert.equal(data.rejected[0].rejectedReason, 'sealed-book-new-sheet');
  assert.equal(data.sheets.some(sheet => sheet.sheetId === 's9'), false);
  assert.equal(data.status, 'review');
  assert.ok(data.review.some(item => item.kind === 'sealed-book-new-sheet'));
  // 拒收仍保管原始字节，便于人工核对
  const page = data.rejected[0].front.pages[0];
  assert.equal(await archive.has(page.sha256), true);
});

test('人工决定可消除归属歧义并记为人工移册', async context => {
  const { archive, intake, source, control } = await harness(context);
  await intake.collect(source);
  await control({ lateSheet: true });
  const first = await intake.collect(source);
  assert.ok(first.review.some(item => item.kind === 'sealed-book-new-sheet'));
  await intake.resolve({ sheetId: 's9', scannerSession: 'session-a', book: 'book-b', decisionId: 'human-1' });
  const second = await intake.collect(source);
  assert.equal(second.review.length, 0);
  const records = await archive.list();
  const b = recordOf(records, 'book-b').versions.at(-1).data;
  const sheet = b.sheets.find(item => item.sheetId === 's9');
  assert.equal(sheet.book, 'book-b');
  assert.equal(sheet.resolution.decisionId, 'human-1');
  assert.equal(sheet.transfers.at(-1).manual, true);
  const a = recordOf(records, 'book-a').versions.at(-1).data;
  assert.equal(a.rejected.length, 0);
  assert.equal(a.status, 'sealed');
  assert.ok(a.transfersOut.some(item => item.sheetId === 's9'));
});

test('重复抓取不产生新版本，人工决定跨重启保留', async context => {
  const { directory, intake, source, archive } = await harness(context);
  await intake.collect(source);
  const again = await intake.collect(source);
  assert.equal(again.repeats > 0, true);
  assert.equal(again.books.every(book => book.duplicate), true);
  await intake.resolve({ sheetId: 's2', scannerSession: 'session-a', book: 'book-b', decisionId: 'keep-1' });
  await intake.collect(source);
  const reopened = await new ScannerIntake(archive).load();
  assert.equal(reopened.decisionsOf().length, 1);
  assert.equal(reopened.decisionsOf()[0].decisionId, 'keep-1');
  assert.ok(directory);
});

test('台账跨重启保留封册与已到图像，补页仍能并入', async context => {
  const { directory, intake, source, archive, control } = await harness(context);
  await control({ missingBack: true });
  await intake.collect(source);
  // 重新打开归档，模拟进程重启
  const reopenedArchive = await new Archive(directory).initialize();
  const reopened = await new ScannerIntake(reopenedArchive).load();
  await control({ missingBack: false });
  await reopened.collect(source);
  const data = recordOf(await archive.list(), 'book-a').versions.at(-1).data;
  assert.equal(data.sheets[0].back.state, 'present');
  assert.equal(data.completeness.complete, true);
  assert.equal(data.sealed.manifestRevision, 1);
  const versions = recordOf(await archive.list(), 'book-a').versions;
  assert.equal(versions[0].data.sheets[0].back.state, 'missing');
  assert.equal(versions.at(-1).data.sheets[0].back.state, 'present');
});

test('封册争议在人工决定后不再反复出现', async context => {
  const { archive, intake, source, control } = await harness(context);
  await intake.collect(source);
  await control({ lateSheet: true });
  await intake.collect(source);
  await intake.resolve({ sheetId: 's9', scannerSession: 'session-a', book: 'book-b', decisionId: 'human-2' });
  const collected = await intake.collect(source);
  assert.equal(collected.review.length, 0);
  const b = recordOf(await archive.list(), 'book-b').versions.at(-1).data;
  assert.equal(b.review.length, 0);
  assert.equal(b.status, 'open');
  assert.ok(b.sheets.find(sheet => sheet.sheetId === 's9'));
});

test('摘要不符的图像仍被保管但标记为待核对', async context => {
  const { archive, intake, source, control } = await harness(context);
  await control({ badDigest: true });
  const result = await intake.collect(source);
  const data = recordOf(await archive.list(), 'book-b').versions.at(-1).data;
  const sheet = data.sheets.find(item => item.sheetId === 's2');
  assert.equal(sheet.front.state, 'unverified');
  assert.equal(sheet.front.pages.some(page => page.verified === false), true);
  assert.ok(data.review.some(item => item.kind === 'image-digest-mismatch'));
  assert.equal(result.books.find(book => book.book === 'book-b').status, 'review');
});

test('未知事件被保留并提示，不静默丢弃', async context => {
  const { archive, intake, source, control } = await harness(context);
  await control({ unknownEvent: true });
  const result = await intake.collect(source);
  assert.ok(result.warnings.some(item => item.kind === 'unrecognized-event'));
  const data = recordOf(await archive.list(), 'book-a').versions.at(-1).data;
  assert.ok(data.events.some(item => item.event.type === 'jog'));
});

test('操作员剔除的面不计为缺失也不冒充内容', async context => {
  const { archive, intake, source, control } = await harness(context);
  await control({ exclude: true });
  await intake.collect(source);
  const data = recordOf(await archive.list(), 'book-b').versions.at(-1).data;
  const sheet = data.sheets.find(item => item.sheetId === 's2');
  assert.equal(sheet.front.state, 'excluded');
  assert.equal(sheet.front.excluded, true);
  assert.equal(sheet.front.pages[0].role, 'current');
});

test('同一册件内跨会话的同名纸张要求人工确认', async context => {
  const { archive, intake, source, control } = await harness(context);
  await control({ collision: true });
  await intake.collect(source);
  const data = recordOf(await archive.list(), 'book-b').versions.at(-1).data;
  const collisions = data.sheets.filter(sheet => sheet.disputes.some(item => item.kind === 'sheet-id-collision'));
  assert.equal(collisions.length, 2);
  assert.equal(data.status, 'review');
  assert.ok((await (await fetch(source + '__state')).json()));
});

test('来源地址与事件解析拒绝异常输入', () => {
  assert.throws(() => normalizeSource('ftp://example'), /http/);
  assert.throws(() => normalizeSource('not a url'), /无效/);
  assert.equal(normalizeSource('http://example.test/scan'), 'http://example.test/scan/');
  assert.throws(() => parseEvents('{"type":"side"}\nnot json\n'), /第 2 行/);
  assert.equal(parseEvents(Buffer.from('')).length, 0);
  assert.throws(() => new Ledger().apply({ type: 'side' }, { sequence: 1, source: 'x', base: 'x' }), /缺少 sheetId/);
});

test('构建不依赖事件到达顺序', () => {
  const facts = new Map();
  const events = [
    { type: 'side', scannerSession: 's', book: 'b', sheetId: 'p1', face: 'back', sideRevision: 1, image: 'http://h/scan/images/x', sha256: 'a'.repeat(64) },
    { type: 'side', scannerSession: 's', book: 'b', sheetId: 'p1', face: 'front', sideRevision: 1, image: 'http://h/scan/images/y', sha256: 'b'.repeat(64) },
    { type: 'sealBook', book: 'b', expectedSheets: ['p1'], manifestRevision: 1 },
  ];
  const base = 'http://h/';
  const build = order => {
    const ledger = new Ledger();
    for (const [index, event] of order.entries()) ledger.apply(event, { sequence: index + 1, source: base, base });
    return buildBooks(ledger, facts)[0].data;
  };
  const forward = build(events);
  const reverse = build([...events].reverse());
  const summarize = data => data.sheets.map(sheet => [sheet.sheetId, sheet.front.state, sheet.back.state]);
  assert.deepEqual(summarize(forward), summarize(reverse));
  assert.equal(digest(Buffer.from('x')).length, 64);
});
