import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digest } from './archive.mjs';
import {
  FACES, Ledger, buildBooks, decisionKey, deserializeLedger, eventIdentity,
  imageKey, normalizeSource, parseEvents, reviewItems, serializeLedger,
} from './scanner.mjs';
import { request } from './transport.mjs';

const MAX_EVENTS = 200000;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export class ScannerIntake {
  constructor(archive, configuration = {}) {
    this.archive = archive;
    this.decisions = new Map();
    this.warnings = [];
    this.timeout = configuration.timeout ?? 5000;
    this.maxImageBytes = configuration.maxImageBytes ?? MAX_IMAGE_BYTES;
    this.maxTotalBytes = configuration.maxTotalBytes ?? MAX_TOTAL_BYTES;
    // Collections share one journal, so they run one at a time.
    this.tail = Promise.resolve();
  }

  queued(operation) {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }

  // Human decisions outrank scanner claims. They are persisted as an
  // append-only log so they survive restarts, and every applied decision also
  // shows up as a transfer snapshot in the affected books.
  async load() {
    let lines = [];
    try { lines = (await readFile(join(this.archive.directory, 'state', 'decisions.ndjson'), 'utf8')).split(/\r?\n/); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.corruptDecisions = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      let decision;
      try { decision = JSON.parse(line); } catch { this.corruptDecisions += 1; continue; }
      if (!decision || typeof decision.sheetId !== 'string' || typeof decision.book !== 'string' || typeof decision.decisionId !== 'string') continue;
      if (typeof decision.scannerSession !== 'string' || !decision.scannerSession) continue;
      this.remember(decision);
    }
    if (this.corruptDecisions) this.warnings.push({ kind: 'decision-log-corrupt', message: `人工决定日志有 ${this.corruptDecisions} 行无法解析，已跳过` });
    return this;
  }

  remember(decision) {
    const key = decisionKey(decision.scannerSession, decision.sheetId);
    const list = this.decisions.get(key) ?? [];
    list.push({
      book: decision.book, decisionId: decision.decisionId,
      sequence: decision.sequence ?? null, recordedAt: decision.recordedAt ?? null,
    });
    this.decisions.set(key, list);
  }

  async resolve(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('人工决定应是对象');
    const sheetId = payload.sheetId;
    const session = payload.scannerSession ?? payload.session;
    const book = payload.book;
    const decisionId = payload.decisionId;
    for (const [field, value] of Object.entries({ sheetId, scannerSession: session, book, decisionId })) {
      if (typeof value !== 'string' || !value.length) throw new Error(`人工决定缺少 ${field}`);
    }
    const decision = { sheetId, scannerSession: session, book, decisionId, sequence: payload.sequence ?? null, recordedAt: new Date().toISOString() };
    return this.queued(async () => {
      await appendFile(join(this.archive.directory, 'state', 'decisions.ndjson'), JSON.stringify(decision) + '\n');
      this.remember(decision);
      return { key: decisionKey(session, sheetId), ...decision };
    });
  }

  decisionsOf() {
    return [...this.decisions.entries()].flatMap(([key, list]) => list.map(item => ({ key, ...item })));
  }

  async collect(source) {
    return this.queued(() => this.collectOnce(source));
  }

  async collectOnce(source) {
    const base = normalizeSource(source);
    const reply = await request(new URL('scan/events', base), { signal: AbortSignal.timeout(this.timeout) });
    if (reply.status !== 200) throw new Error(`来源返回 ${reply.status}`);
    const events = parseEvents(reply.bytes);
    if (events.length > MAX_EVENTS) throw new Error('扫描事件过多');
    const ledger = await this.ledger();
    let fresh = 0;
    let repeats = 0;
    for (const event of events) {
      const identity = eventIdentity(event, base);
      if (ledger.seen.has(identity)) { repeats += 1; continue; }
      ledger.apply(event, { sequence: ledger.trace.length + 1, source: base, base });
      ledger.seen.set(identity, { sequence: ledger.trace.length, firstSeenAt: new Date().toISOString(), source: base });
      fresh += 1;
    }
    ledger.applyDecisions(this.decisions);
    const facts = await this.images(ledger);
    const built = buildBooks(ledger, facts);
    const books = [];
    for (const record of built) {
      const receipt = await this.archive.accept('scan', record.identity, record.data, Buffer.from(JSON.stringify(record.data)));
      books.push({
        book: record.book,
        scannerSession: record.scannerSession,
        receipt: receipt.receipt,
        version: receipt.version,
        duplicate: receipt.duplicate,
        sha256: receipt.sha256,
        status: record.data.status,
        complete: record.data.completeness.complete,
        missingCount: record.data.completeness.missingCount,
        pendingCount: record.data.completeness.pendingCount,
        reviewCount: record.data.review.length,
      });
    }
    // Persist only after the records are written, so a failed collection can
    // be retried without losing events.
    await this.save(ledger);
    return {
      source: base,
      events: events.length,
      fresh,
      repeats,
      unrecognized: ledger.unrecognized.map(item => ({ ...item })),
      warnings: [...this.warnings, ...ledger.warnings],
      books,
      review: reviewItems(await this.archive.list()),
    };
  }

  async ledger() {
    try {
      return deserializeLedger(JSON.parse(await readFile(join(this.archive.directory, 'state', 'ledger.json'), 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return new Ledger();
      throw new Error(`扫描台账无法读取：${error.message}`);
    }
  }

  async save(ledger) {
    const target = join(this.archive.directory, 'state', 'ledger.json');
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(serializeLedger(ledger)));
    await rename(temporary, target);
  }

  async images(ledger) {
    const facts = new Map();
    const pages = new Map();
    for (const sheet of ledger.sheets.values()) {
      for (const face of FACES) {
        for (const page of sheet.pages[face]) {
          if (!page.imageUrl || !page.declaredSha256) continue;
          const key = imageKey(page.imageUrl, page.declaredSha256);
          if (!facts.has(key)) facts.set(key, { declared: page.declaredSha256, available: false, verified: false, sha256: null });
          if (!pages.has(key)) pages.set(key, page);
        }
      }
    }
    let total = 0;
    for (const [key, fact] of facts) {
      const page = pages.get(key);
      // Reuse content already held by the archive so repeated collection does
      // not even need the gateway to still serve the image.
      if (await this.archive.has(fact.declared)) {
        facts.set(key, { ...fact, available: true, verified: true, sha256: fact.declared });
        continue;
      }
      let bytes;
      try {
        const reply = await request(page.imageUrl, { signal: AbortSignal.timeout(this.timeout) });
        if (reply.status !== 200) { facts.set(key, { ...fact, available: false }); continue; }
        bytes = reply.bytes;
      } catch {
        facts.set(key, { ...fact, available: false });
        continue;
      }
      if (bytes.length > this.maxImageBytes) throw new Error(`图像 ${page.imageId ?? page.imageUrl} 过大`);
      total += bytes.length;
      if (total > this.maxTotalBytes) throw new Error('图像总量过大');
      const sha256 = digest(bytes);
      // Keep the bytes even when they do not match the declared digest, so a
      // human can inspect exactly what the scanner handed over.
      await this.archive.store(bytes);
      facts.set(key, { ...fact, available: true, sha256, verified: sha256 === fact.declared });
    }
    return facts;
  }
}
