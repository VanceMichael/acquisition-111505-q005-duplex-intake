import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Archive } from './archive.mjs';
import { ScannerIntake } from './collector.mjs';
import { receiveManual } from './intake.mjs';
import { reviewItems } from './scanner.mjs';

const defaultSource = () => process.env.SOURCE_URL || 'http://127.0.0.1:4200/';
const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' };

export async function createIntake(directory, options = {}) {
  const archive = await new Archive(directory).initialize();
  const scanner = await new ScannerIntake(archive, options).load();
  return createServer(async (incoming, outgoing) => {
    const reply = (status, body) => { outgoing.writeHead(status, JSON_TYPE); outgoing.end(JSON.stringify(body)); };
    const read = async limit => {
      const chunks = []; let length = 0;
      for await (const chunk of incoming) {
        length += chunk.length;
        if (length > limit) return null;
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    };
    const json = async limit => {
      const raw = await read(limit);
      if (raw === null) return { tooLarge: true };
      try { return { value: raw.length ? JSON.parse(raw.toString('utf8')) : {} }; }
      catch { return { invalid: true }; }
    };
    try {
      if (incoming.method === 'GET' && incoming.url === '/health') return reply(200, { status: 'ok', acquisition: 'manual+scan' });
      if (incoming.method === 'GET' && incoming.url === '/api/records') return reply(200, await archive.list());
      if (incoming.method === 'GET' && incoming.url === '/api/review') return reply(200, reviewItems(await archive.list()));
      if (incoming.method === 'GET' && incoming.url === '/api/decisions') return reply(200, scanner.decisionsOf());
      if (incoming.method === 'POST' && incoming.url === '/api/collect') {
        const parsed = await json(65536);
        if (parsed.tooLarge) return reply(413, { error: '自动收件请求过大' });
        if (parsed.invalid) return reply(400, { error: 'JSON 无效' });
        if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return reply(400, { error: '请求应是对象' });
        const source = parsed.value.source ?? options.source ?? defaultSource();
        try { return reply(201, await scanner.collect(source)); }
        catch (error) { return reply(502, { error: `自动收件失败：${error.message}` }); }
      }
      if (incoming.method === 'POST' && incoming.url === '/api/review') {
        const parsed = await json(65536);
        if (parsed.tooLarge) return reply(413, { error: '人工决定过大' });
        if (parsed.invalid) return reply(400, { error: 'JSON 无效' });
        let decision;
        try { decision = await scanner.resolve(parsed.value); }
        catch (error) { return reply(422, { error: error.message }); }
        if (parsed.value.collect === false) return reply(201, { decision });
        const source = parsed.value.source ?? options.source ?? defaultSource();
        try { return reply(201, { decision, collection: await scanner.collect(source) }); }
        catch (error) { return reply(502, { decision, error: `人工决定已记录，但重新采集失败：${error.message}` }); }
      }
      if (incoming.method === 'GET' && incoming.url?.startsWith('/api/blobs/')) {
        const sha256 = incoming.url.split('?')[0].split('/').at(-1);
        try {
          const bytes = await archive.bytes(sha256);
          outgoing.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
          return outgoing.end(bytes);
        } catch (error) {
          return reply(error.code === 'ENOENT' ? 404 : 400, { error: '图像不存在' });
        }
      }
      if (incoming.method === 'POST' && incoming.url === '/api/manual') {
        const parsed = await json(1048576);
        if (parsed.tooLarge) return reply(413, { error: '单份人工收件过大' });
        if (parsed.invalid) return reply(400, { error: 'JSON 无效' });
        try { return reply(201, await receiveManual(archive, parsed.value)); }
        catch (error) { return reply(422, { error: error.message }); }
      }
      return reply(404, { error: '路径不存在' });
    } catch (error) { return reply(500, { error: error.message }); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = await createIntake(process.env.ARCHIVE_DIR || '.local/archive');
  service.listen(Number(process.env.PORT || 3200), '0.0.0.0', () => console.log('收件服务已就绪'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => service.close(() => process.exit(0)));
}
