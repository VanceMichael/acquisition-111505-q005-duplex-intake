import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const intake = await createIntake(directory);
const provider = createProvider();
try {
  intake.listen(0, '127.0.0.1'); provider.listen(0, '127.0.0.1');
  await Promise.all([once(intake, 'listening'), once(provider, 'listening')]);
  const base = `http://127.0.0.1:${intake.address().port}`;
  const source = `http://127.0.0.1:${provider.address().port}`;
  const sample = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url), 'utf8'));
  const project = JSON.parse(await readFile(new URL('../fixtures/project.json', import.meta.url), 'utf8'));
  const observed = await fetch(source + project.probe, project.probeBody ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(project.probeBody) } : {});
  const raw = Buffer.from(await observed.arrayBuffer());
  console.log(JSON.stringify({ 来源状态: observed.status, 原始字节: raw.length, 来源类型: observed.headers.get('content-type'), 事件行数: raw.toString('utf8').trim().split('\n').length }));

  const accepted = await fetch(base + '/api/manual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sample) });
  console.log(JSON.stringify({ 人工收件: await accepted.json() }));

  const collected = await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: source + '/' }) });
  const collection = await collected.json();
  console.log(JSON.stringify({ 自动收件状态: collected.status, 事件: collection.events, 新事件: collection.fresh, 册件: collection.books.map(book => ({ 册: book.book, 状态: book.status, 版本: book.version, 缺失: book.missingCount, 待复核: book.reviewCount })) }));

  const repeated = await (await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: source + '/' }) })).json();
  console.log(JSON.stringify({ 重复采集: { 新事件: repeated.fresh, 重复: repeated.repeats, 新版本: repeated.books.filter(book => !book.duplicate).length } }));

  const records = await (await fetch(base + '/api/records')).json();
  const scan = records.filter(record => record.source === 'scan');
  console.log(JSON.stringify({ 已存记录: records.length, 扫描册件: scan.map(record => ({ 册: record.identity.book, 版本: record.versions.length, 面: record.versions.at(-1).data.sheets.map(sheet => ({ 纸: sheet.sheetId, 正: sheet.front.state, 反: sheet.back.state })) })) }));
  console.log(JSON.stringify({ 待人工处理: await (await fetch(base + '/api/review')).json() }));
} finally {
  intake.closeAllConnections(); provider.closeAllConnections();
  await Promise.all([new Promise(resolve => intake.close(resolve)), new Promise(resolve => provider.close(resolve))]);
  await rm(directory, { recursive: true, force: true });
}
