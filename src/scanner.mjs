import { digest } from './archive.mjs';

export const FACES = ['front', 'back'];

// A face is settled once it is present with verified bytes, declared blank by
// the scanner, or explicitly removed by an operator. "pending" means no
// information has arrived; "missing" means the book was sealed without it.
export const SETTLED = new Set(['present', 'blank', 'excluded']);

// Ambiguities that a human ownership decision can settle.
const OWNERSHIP_KINDS = new Set([
  'book-mismatch', 'book-unknown', 'reassign-source-mismatch',
  'duplicate-decision-conflict', 'sealed-book-new-sheet', 'sealed-target',
  'sheet-id-collision', 'unexpected-sheet',
]);

const text = value => (typeof value === 'string' && value.length ? value : null);

function required(event, field) {
  const value = text(event[field]);
  if (!value) throw new Error(`扫描事件 ${event.type} 缺少 ${field}`);
  return value;
}

function faceOf(event) {
  const face = required(event, 'face');
  if (!FACES.includes(face)) throw new Error(`面别无效 ${face}`);
  return face;
}

export function normalizeSource(source) {
  let url;
  try { url = new URL(source); } catch { throw new Error('来源地址无效'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('来源地址只支持 http 或 https');
  if (url.username || url.password) throw new Error('来源地址不能包含凭据');
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

export function parseEvents(bytes) {
  const input = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  const events = [];
  const lines = input.replace(/^﻿/, '').split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { throw new Error(`第 ${index + 1} 行不是有效 JSON`); }
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') throw new Error(`第 ${index + 1} 行不是扫描事件`);
    events.push(event);
  }
  return events;
}

// Relative image links are resolved against the gateway that delivered the
// event; absolute links are kept as given. Only http(s) is ever fetched.
export function imageUrl(href, base) {
  if (typeof href !== 'string' || !href.length) return null;
  try {
    const url = new URL(href, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

export function imageId(url) {
  if (!url) return null;
  try { return new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? null; } catch { return null; }
}

export function imageKey(url, declared) { return `${url ?? ''}\u0000${declared ?? ''}`; }

// Gateways in the wild spell the same facts in a few shapes. Accept the
// documented one first, then the obvious variants, without inventing data.
export function imageRef(event) {
  const image = event.image;
  if (image && typeof image === 'object' && !Array.isArray(image)) {
    return { href: text(image.href) ?? text(image.url) ?? text(event.href), declared: text(image.sha256) ?? text(event.sha256) };
  }
  return { href: text(image) ?? text(event.href) ?? text(event.imageHref), declared: text(event.sha256) ?? text(event.hash) };
}

const revisionOfValue = value => (Number.isSafeInteger(value) && value >= 1 ? value : null);

export function revisionOf(event) {
  return revisionOfValue(event.sideRevision) ?? revisionOfValue(event.revision);
}

// Event identity is the basis for replay: the same event arriving twice, even
// in different downloads, must not count as new content. The gateway origin is
// part of the identity so two gateways are never conflated, while the same
// gateway reached through a slightly different URL still dedupes.
export function gatewayOrigin(source) {
  try { return new URL(source).origin; } catch { return String(source); }
}

export function eventIdentity(event, source) {
  const ref = imageRef(event);
  return JSON.stringify([
    gatewayOrigin(source),
    event.type ?? null,
    event.scannerSession ?? null,
    event.book ?? null,
    event.sheetId ?? null,
    event.face ?? null,
    revisionOf(event) ?? event.replaces ?? null,
    ref.href ?? null,
    ref.declared ?? null,
    event.sourceBook ?? null,
    event.targetBook ?? null,
    event.decisionId ?? null,
  ]);
}

const copy = value => structuredClone(value);

export class Ledger {
  constructor() {
    this.books = new Map();
    this.sheets = new Map();
    this.trace = [];
    this.unrecognized = [];
    this.warnings = [];
    this.currentSession = null;
    this.seen = new Map();
  }

  ensureBook(name) {
    let book = this.books.get(name);
    if (!book) {
      book = { name, begin: null, seal: null, disputes: [] };
      this.books.set(name, book);
    }
    return book;
  }

  ensureSheet(sheetId, session, book) {
    const key = `${session}\u0000${sheetId}`;
    let sheet = this.sheets.get(key);
    if (!sheet) {
      sheet = {
        key, sheetId, session, book, originBook: book,
        pages: { front: [], back: [] },
        blanks: { front: [], back: [] },
        exclusions: { front: [], back: [] },
        transfers: [], disputes: [], rescanTargets: [], events: [],
        rejected: false, rejectedBook: null, rejectedReason: null, resolution: null,
      };
      this.sheets.set(key, sheet);
    }
    this.ensureBook(book);
    return sheet;
  }

  traceEvent(sequence, source, event, books) {
    const names = [...new Set(books.filter(name => name && name !== 'unknown'))];
    this.trace.push({ sequence, source, event, books: names });
    // A book is a physical object from one intake; material from another
    // gateway with the same name must not merge silently.
    for (const name of names) {
      const book = this.ensureBook(name);
      book.sources ??= [];
      if (book.sources.includes(source)) continue;
      book.sources.push(source);
      if (book.sources.length > 1) {
        this.bookDispute(book, 'source-conflict', `册件 ${name} 同时来自多个扫描来源，不能合并`, sequence);
      }
    }
  }

  record(sheet, sequence, source, event) {
    sheet.events.push({ sequence, source, event });
  }

  dispute(sheet, kind, message, sequence, face = null) {
    if (sheet.disputes.some(item => item.kind === kind && item.sequence === sequence && (item.face ?? null) === face)) return;
    const entry = { kind, message, sequence, at: new Date().toISOString() };
    if (face) entry.face = face;
    sheet.disputes.push(entry);
  }

  bookDispute(book, kind, message, sequence) {
    if (book.disputes.some(item => item.kind === kind && item.sequence === sequence)) return;
    book.disputes.push({ kind, message, sequence, at: new Date().toISOString() });
  }

  warn(kind, message, sequence = null) {
    if (this.warnings.some(item => item.kind === kind && item.message === message)) return;
    this.warnings.push({ kind, message, sequence });
  }

  apply(event, context) {
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') throw new Error('扫描事件无效');
    const detail = { ...context, event };
    switch (event.type) {
      case 'beginBook': case 'begin': return this.begin(event, detail);
      case 'sealBook': case 'seal': return this.seal(event, detail);
      case 'sheet': return this.sheet(event, detail);
      case 'side': return this.side(event, detail);
      case 'blankSide': case 'blank': return this.blank(event, detail);
      case 'rescan': return this.rescan(event, detail);
      case 'reassign': return this.reassign(event, detail);
      case 'excludeSide': case 'removeSide': return this.exclude(event, detail, false);
      case 'excludeSheet': case 'removeSheet': case 'operatorExclude': return this.exclude(event, detail, true);
      default:
        // Unknown gateway additions are preserved, not dropped; if they name a
        // book they also appear in that book's event trace.
        this.unrecognized.push({ sequence: context.sequence, source: context.source, event });
        this.warn('unrecognized-event', `未识别的扫描事件 ${event.type}，已原样保留`, context.sequence);
        this.traceEvent(context.sequence, context.source, event, [text(event.book)]);
    }
  }

  begin(event, context) {
    const name = required(event, 'book');
    const book = this.ensureBook(name);
    const session = text(event.scannerSession);
    if (session) this.currentSession = session;
    const entry = { sequence: context.sequence, source: context.source, scannerSession: session };
    if (!book.begin) book.begin = entry;
    else if (book.begin.scannerSession !== entry.scannerSession) {
      this.bookDispute(book, 'duplicate-book-mark', '同一册件出现不一致的开册标记，需要人工确认', context.sequence);
    }
    this.traceEvent(context.sequence, context.source, event, [name]);
  }

  seal(event, context) {
    const name = required(event, 'book');
    const book = this.ensureBook(name);
    const expected = Array.isArray(event.expectedSheets) ? event.expectedSheets.filter(item => typeof item === 'string') : null;
    const seal = {
      sequence: context.sequence,
      expectedSheets: expected,
      manifestRevision: event.manifestRevision ?? null,
      scannerSession: text(event.scannerSession),
    };
    if (!book.seal) {
      book.seal = seal;
      // The seal arrives when the operator closes the book; the paper itself
      // may still be in the scanner, so later additions are legitimate only
      // for sheets the manifest already names.
      if (expected === null) this.bookDispute(book, 'seal-without-manifest', '封册未给出清单，无法判断后续到达是否属于该册', context.sequence);
    } else {
      const same = book.seal.manifestRevision === seal.manifestRevision
        && JSON.stringify(book.seal.expectedSheets) === JSON.stringify(seal.expectedSheets);
      if (!same) this.bookDispute(book, 'conflicting-seal', '同一册件出现不一致的封册清单，需要人工确认', context.sequence);
    }
    this.traceEvent(context.sequence, context.source, event, [name]);
  }

  locate(sheetId, declaredSession) {
    // A declared session is authoritative: sheetId is only unique inside it.
    if (declaredSession) {
      this.currentSession = declaredSession;
      return this.sheets.get(`${declaredSession}\u0000${sheetId}`) ?? null;
    }
    // Without a session, a face can come back after the next book has already
    // started, so the physical sheet id identifies the paper if it is unique.
    const matches = [...this.sheets.values()].filter(item => item.sheetId === sheetId);
    if (matches.length === 1) return matches[0];
    if (this.currentSession !== null) {
      const exact = this.sheets.get(`${this.currentSession}\u0000${sheetId}`);
      if (exact) return exact;
    }
    return null;
  }

  resolveSheet(event, sequence) {
    const sheetId = required(event, 'sheetId');
    const declaredSession = text(event.scannerSession);
    let sheet = this.locate(sheetId, declaredSession);
    const claimedBook = text(event.book);
    if (!sheet) {
      sheet = this.ensureSheet(sheetId, declaredSession ?? this.currentSession ?? 'unknown', claimedBook ?? 'unknown');
      if (!claimedBook) this.dispute(sheet, 'book-unknown', '事件没有标明册件，归属需要人工确认', sequence);
      if (!declaredSession) {
        const collisions = [...this.sheets.values()].filter(item => item.sheetId === sheetId && item !== sheet);
        if (collisions.length) this.dispute(sheet, 'session-ambiguous', `纸张 ${sheetId} 在多个扫描会话中出现且事件未标明会话，归属需要人工确认`, sequence);
      }
    } else if (claimedBook && claimedBook !== sheet.book && !this.everOwned(sheet, claimedBook)) {
      this.dispute(sheet, 'book-mismatch', `事件声明属于 ${claimedBook}，当前归属 ${sheet.book}，需要人工确认`, sequence);
    }
    return sheet;
  }

  everOwned(sheet, book) {
    return sheet.originBook === book || sheet.transfers.some(item => item.sourceBook === book || item.targetBook === book);
  }

  // Content that shows up only after a book was sealed, and that the sealed
  // manifest does not name, must never join silently.
  guardSealed(sheet, bookName, sequence) {
    const seal = this.books.get(bookName)?.seal;
    if (!seal) return;
    const firstContact = sheet.events.length === 0 && sheet.transfers.length === 0;
    if (!firstContact) return;
    if (seal.expectedSheets === null || seal.expectedSheets.includes(sheet.sheetId)) return;
    this.reject(sheet, bookName, 'sealed-book-new-sheet', `册件 ${bookName} 已封册，新到的 ${sheet.sheetId} 不能静默并入`, sequence);
  }

  reject(sheet, bookName, kind, message, sequence) {
    sheet.rejected = true;
    sheet.rejectedBook = bookName;
    sheet.rejectedReason = kind;
    this.dispute(sheet, kind, message, sequence);
  }

  addPage(sheet, face, event, context, { rescan = false } = {}) {
    const ref = imageRef(event);
    const declared = ref.declared;
    const url = imageUrl(ref.href, context.base);
    const existingRevisions = sheet.pages[face].map(page => page.sideRevision);
    let revision = revisionOf(event);
    if (revision === null && rescan) {
      revision = Math.max(revisionOfValue(event.replaces) ?? 0, ...existingRevisions, 0) + 1;
    }
    if (revision === null) revision = existingRevisions.length + 1;
    if (!url || !declared) this.dispute(sheet, 'image-reference-invalid', '图像位置或摘要缺失，无法核对原始图像', context.sequence, face);
    const same = sheet.pages[face].find(page => page.sideRevision === revision);
    if (same) {
      if (same.imageUrl === url && same.declaredSha256 === declared) return;
      // Two different images claim the same side revision. Keep both bytes and
      // let a human decide; the later arrival is shown as current.
      same.conflict = true;
      this.dispute(sheet, 'revision-conflict', `${face} 的版本 ${revision} 指向不同图像，需要人工确认`, context.sequence, face);
      sheet.pages[face].push({
        sideRevision: revision,
        imageId: imageId(url),
        imageUrl: url,
        declaredSha256: declared,
        rescanOf: null,
        sequence: context.sequence,
        conflict: true,
      });
      return;
    }
    const prior = existingRevisions.filter(value => value < revision).sort((a, b) => b - a)[0] ?? null;
    sheet.pages[face].push({
      sideRevision: revision,
      imageId: imageId(url),
      imageUrl: url,
      declaredSha256: declared,
      rescanOf: rescan ? (revisionOfValue(event.replaces) ?? prior) : null,
      sequence: context.sequence,
      conflict: false,
    });
  }

  addBlank(sheet, face, event, context) {
    const decisionId = text(event.decisionId);
    if (decisionId && sheet.blanks[face].some(item => item.decisionId === decisionId)) return;
    sheet.blanks[face].push({ decisionId, sequence: context.sequence });
  }

  // A bare sheet marker only establishes the physical paper and its book.
  sheet(event, context) {
    const sheet = this.resolveSheet(event, context.sequence);
    this.guardSealed(sheet, text(event.book) ?? sheet.book, context.sequence);
    this.record(sheet, context.sequence, context.source, event);
    this.traceEvent(context.sequence, context.source, event, [sheet.book, text(event.book)]);
  }

  side(event, context) {
    const sheet = this.resolveSheet(event, context.sequence);
    const face = faceOf(event);
    this.guardSealed(sheet, text(event.book) ?? sheet.book, context.sequence);
    this.addPage(sheet, face, event, context);
    if (event.blank === true) this.addBlank(sheet, face, event, context);
    this.record(sheet, context.sequence, context.source, event);
    this.traceEvent(context.sequence, context.source, event, [sheet.book, text(event.book)]);
  }

  blank(event, context) {
    const sheet = this.resolveSheet(event, context.sequence);
    const face = faceOf(event);
    this.guardSealed(sheet, sheet.book, context.sequence);
    this.addBlank(sheet, face, event, context);
    this.record(sheet, context.sequence, context.source, event);
    this.traceEvent(context.sequence, context.source, event, [sheet.book, text(event.book)]);
  }

  rescan(event, context) {
    const sheet = this.resolveSheet(event, context.sequence);
    const face = faceOf(event);
    this.guardSealed(sheet, sheet.book, context.sequence);
    sheet.rescanTargets.push({ face, replaces: revisionOfValue(event.replaces), sequence: context.sequence });
    this.addPage(sheet, face, event, context, { rescan: true });
    this.record(sheet, context.sequence, context.source, event);
    this.traceEvent(context.sequence, context.source, event, [sheet.book, text(event.book)]);
  }

  captureView(sheet) {
    return {
      originBook: sheet.originBook,
      session: sheet.session,
      pages: copy(sheet.pages),
      blanks: copy(sheet.blanks),
      exclusions: copy(sheet.exclusions),
    };
  }

  reassign(event, context) {
    const sheetId = required(event, 'sheetId');
    const sourceBook = required(event, 'sourceBook');
    const targetBook = required(event, 'targetBook');
    const decisionId = required(event, 'decisionId');
    let sheet = this.locate(sheetId, text(event.scannerSession));
    if (!sheet) sheet = this.ensureSheet(sheetId, text(event.scannerSession) ?? this.currentSession ?? 'unknown', sourceBook);
    this.ensureBook(sourceBook); this.ensureBook(targetBook);
    const existing = sheet.transfers.find(item => item.decisionId === decisionId);
    if (existing) {
      if (existing.sourceBook !== sourceBook || existing.targetBook !== targetBook) {
        this.dispute(sheet, 'duplicate-decision-conflict', `移册决定 ${decisionId} 指向不同归属，需要人工确认`, context.sequence);
      }
    } else if (sheet.book === sourceBook) {
      if (this.books.get(targetBook)?.seal) {
        // The receiving book has already been handed over.
        this.dispute(sheet, 'sealed-target', `目标册件 ${targetBook} 已封册，${sheetId} 不能经移册静默并入`, context.sequence);
      } else {
        sheet.transfers.push({
          sourceBook, targetBook, decisionId, sequence: context.sequence,
          snapshot: this.captureView(sheet),
          sourceSealed: Boolean(this.books.get(sourceBook)?.seal),
          manual: false,
        });
        sheet.book = targetBook;
        if (sheet.rejected) { sheet.rejected = false; sheet.rejectedBook = null; sheet.rejectedReason = null; }
      }
    } else if (sheet.book !== targetBook) {
      this.dispute(sheet, 'reassign-source-mismatch', `移册来源 ${sourceBook} 与当前归属 ${sheet.book} 不符，需要人工确认`, context.sequence);
    }
    this.record(sheet, context.sequence, context.source, event);
    this.traceEvent(context.sequence, context.source, event, [sourceBook, targetBook, sheet.book]);
  }

  exclude(event, context, wholeSheet) {
    const sheet = this.resolveSheet(event, context.sequence);
    const faces = wholeSheet ? FACES : [faceOf(event)];
    for (const face of faces) {
      const decisionId = text(event.decisionId);
      if (decisionId && sheet.exclusions[face].some(item => item.decisionId === decisionId)) continue;
      sheet.exclusions[face].push({ decisionId, sequence: context.sequence });
    }
    this.record(sheet, context.sequence, context.source, event);
    this.traceEvent(context.sequence, context.source, event, [sheet.book, text(event.book)]);
  }

  // A human decision that says the same thing twice is a repeat, not a new
  // change; a different book for the same decision id is a contradiction.
  applyDecisions(decisions) {
    const entries = [];
    for (const [key, value] of decisions) {
      const list = Array.isArray(value) ? value : [value];
      for (const [index, decision] of list.entries()) entries.push([key, decision, index]);
    }
    entries.sort(([a, , ai], [b, , bi]) => a.localeCompare(b) || ai - bi);
    for (const [key, decision] of entries) {
      const sheet = this.sheets.get(key);
      if (!sheet) {
        this.warn('decision-target-unknown', `人工决定 ${decision.decisionId} 指向未到达的纸张 ${key.replace('\u0000', '/')}`, decision.sequence ?? null);
        continue;
      }
      sheet.decisions ??= [];
      const same = sheet.decisions.find(item => item.decisionId === decision.decisionId);
      if (same) {
        if (same.book !== decision.book) this.dispute(sheet, 'duplicate-decision-conflict', `人工决定 ${decision.decisionId} 指向不同册件，需要人工确认`, decision.sequence ?? null);
        continue;
      }
      sheet.decisions.push({ ...decision });
      const priorBook = sheet.book;
      if (priorBook !== decision.book) {
        sheet.transfers.push({
          sourceBook: priorBook,
          targetBook: decision.book,
          decisionId: decision.decisionId,
          sequence: decision.sequence ?? null,
          snapshot: this.captureView(sheet),
          sourceSealed: Boolean(this.books.get(priorBook)?.seal),
          manual: true,
        });
        sheet.book = decision.book;
        this.ensureBook(decision.book);
      }
      // A human has taken responsibility for this sheet: it is no longer
      // treated as material that slipped into a sealed book.
      sheet.rejected = false; sheet.rejectedBook = null; sheet.rejectedReason = null;
      sheet.resolution = { book: decision.book, decisionId: decision.decisionId, sequence: decision.sequence ?? null };
      for (const dispute of sheet.disputes) {
        if (!OWNERSHIP_KINDS.has(dispute.kind)) continue;
        dispute.resolved = true;
        dispute.resolvedBy = decision.decisionId;
      }
    }
  }
}

function pickCurrent(pages) {
  let current = null;
  for (const page of pages) if (!current || page.sideRevision >= current.sideRevision) current = page;
  return current;
}

function renderFace(face, view, facts, sealed, issues) {
  const pages = view.pages[face];
  const blanks = view.blanks[face];
  const exclusions = view.exclusions[face];
  const current = pickCurrent(pages);
  const factOf = page => facts.get(imageKey(page.imageUrl, page.declaredSha256)) ?? null;
  const currentFact = current ? factOf(current) : null;
  if (current && !currentFact) issues.push({ kind: 'image-missing', message: `${face} 的原始图像未归档`, sequence: current.sequence, face });
  else if (current && !currentFact.verified) {
    issues.push({
      kind: currentFact.available === false ? 'image-unavailable' : 'image-digest-mismatch',
      message: `${face} 的图像 ${current.imageId ?? current.imageUrl} 内容与声明摘要不符`,
      sequence: current.sequence,
      face,
    });
  }
  if (pages.length && blanks.length && exclusions.length === 0 && !blanks.every(item => pages.some(page => page.sequence === item.sequence))) {
    // A blank decision attached to the same event that delivered the image is
    // the scanner's own preprocessing note; a separate blank decision on a
    // face that already has an image is a real conflict.
    issues.push({ kind: 'blank-and-image', message: `${face} 同时有图像与空白判定，需要人工确认`, sequence: blanks.at(-1).sequence, face });
  }
  if (pages.some(page => page.conflict)) {
    issues.push({ kind: 'revision-conflict', message: `${face} 的同一版本出现了多个不同图像，需要人工确认`, sequence: current?.sequence ?? null, face });
  }
  for (const target of view.rescanTargets ?? []) {
    if (target.face !== face || target.replaces === null) continue;
    if (!pages.some(page => page.sideRevision === target.replaces)) {
      issues.push({ kind: 'rescan-target-not-observed', message: `重扫声明的被替换版本 ${target.replaces} 未到达，原图无法对齐`, sequence: target.sequence, face });
    }
  }
  let state;
  if (exclusions.length) state = 'excluded';
  else if (current) {
    if (!currentFact) state = 'unverified';
    else if (currentFact.available === false) state = 'unavailable';
    else state = currentFact.verified ? 'present' : 'unverified';
  } else if (blanks.length) state = 'blank';
  else state = sealed ? 'missing' : 'pending';
  return {
    state,
    arrived: Boolean(current),
    blank: blanks.length > 0,
    excluded: exclusions.length > 0,
    currentRevision: current?.sideRevision ?? null,
    sha256: currentFact?.sha256 ?? null,
    verified: currentFact?.verified === true,
    blankDecisions: blanks.map(item => ({ ...item })),
    excludedDecisions: exclusions.map(item => ({ ...item })),
    pages: pages
      .slice()
      .sort((a, b) => a.sideRevision - b.sideRevision)
      .map(page => {
        const fact = factOf(page);
        return {
          sideRevision: page.sideRevision,
          imageId: page.imageId,
          imageUrl: page.imageUrl,
          declaredSha256: page.declaredSha256,
          sha256: fact?.sha256 ?? null,
          available: fact ? fact.available !== false : false,
          verified: fact?.verified === true,
          role: page === current ? 'current' : (page.conflict ? 'conflicting' : 'superseded'),
          rescanOf: page.rescanOf,
          sequence: page.sequence,
        };
      }),
  };
}

function renderAdvance(view, facts, sealed) {
  const issues = [];
  const faces = Object.fromEntries(FACES.map(face => [face, renderFace(face, view, facts, sealed, issues)]));
  return { ...faces, issues };
}

function transferView(transfer) {
  return {
    sourceBook: transfer.sourceBook,
    targetBook: transfer.targetBook,
    decisionId: transfer.decisionId,
    sequence: transfer.sequence,
    manual: transfer.manual === true,
    sourceSealed: transfer.sourceSealed === true,
  };
}

function sheetView(sheet, book, sealed, facts) {
  const issues = [];
  const faces = Object.fromEntries(FACES.map(face => [face, renderFace(face, sheet, facts, sealed, issues)]));
  const disputes = sheet.disputes.map(item => ({ ...item }));
  // Render-time findings are re-derived on every build, so they are merged
  // with the recorded disputes instead of piling up new copies.
  for (const issue of issues) {
    if (disputes.some(item => item.kind === issue.kind && (item.face ?? null) === (issue.face ?? null))) continue;
    disputes.push(issue);
  }
  disputes.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.kind.localeCompare(b.kind) || String(a.face ?? '').localeCompare(String(b.face ?? '')));
  return {
    sheetId: sheet.sheetId,
    scannerSession: sheet.session,
    book,
    originBook: sheet.originBook,
    ...faces,
    transfer: sheet.transfers.length ? transferView(sheet.transfers.at(-1)) : null,
    transfers: sheet.transfers.map(transferView),
    resolution: sheet.resolution ? { ...sheet.resolution } : null,
    decisions: (sheet.decisions ?? []).map(item => ({ ...item })),
    disputes,
    events: sheet.events.map(item => ({ ...item })),
  };
}

function reviewOf(book, sheets) {
  const items = [];
  for (const dispute of book.disputes) items.push({ scope: 'book', ...dispute });
  for (const sheet of sheets) {
    for (const dispute of sheet.disputes) {
      if (dispute.resolved) continue;
      items.push({ scope: 'sheet', sheetId: sheet.sheetId, scannerSession: sheet.scannerSession, ...dispute });
    }
  }
  return items.sort((a, b) => String(a.book ?? '').localeCompare(String(b.book ?? '')) || (a.sequence ?? 0) - (b.sequence ?? 0) || String(a.sheetId ?? '').localeCompare(String(b.sheetId ?? '')) || a.kind.localeCompare(b.kind));
}

function openCompleteness(sheets) {
  const pending = [];
  for (const sheet of sheets) {
    for (const face of FACES) if (sheet[face].state === 'pending') pending.push({ sheetId: sheet.sheetId, face, state: 'pending' });
  }
  return {
    expectedSheets: null,
    arrivedSheets: sheets.map(sheet => sheet.sheetId),
    missing: [],
    pending,
    missingCount: 0,
    pendingCount: pending.length,
    unexpectedSheets: [],
    transferredOutSheets: [],
    complete: false,
  };
}

function sealedCompleteness(book, sheets, transfersOut) {
  const expected = book.seal.expectedSheets;
  const byId = new Map();
  for (const sheet of sheets) {
    const list = byId.get(sheet.sheetId) ?? [];
    list.push(sheet);
    byId.set(sheet.sheetId, list);
  }
  const movedOut = new Set(transfersOut.map(item => item.sheetId));
  const missing = [];
  // Without a manifest there is nothing to compare against; the seal itself is
  // already flagged for review instead of pretending the book is complete.
  if (expected !== null) {
    for (const sheetId of expected) {
      const matches = byId.get(sheetId);
      if (!matches) {
        if (!movedOut.has(sheetId)) missing.push({ sheetId, face: 'front', state: 'missing' }, { sheetId, face: 'back', state: 'missing' });
        continue;
      }
      const arrived = new Set(matches.flatMap(sheet => FACES.filter(face => SETTLED.has(sheet[face].state))));
      for (const face of FACES) {
        if (arrived.has(face)) continue;
        const states = matches.map(sheet => sheet[face].state);
        missing.push({ sheetId, face, state: states.find(state => !SETTLED.has(state)) ?? 'missing' });
      }
    }
  }
  const expectedSet = new Set(expected ?? []);
  // A sheet an operator explicitly placed in this book is no longer a mismatch;
  // the manual transfer carries the responsibility and stays in the history.
  const unexpectedSheets = expected === null ? [] : sheets
    .filter(sheet => !expectedSet.has(sheet.sheetId) && !movedOut.has(sheet.sheetId) && sheet.resolution?.book !== book.name)
    .map(sheet => sheet.sheetId);
  return {
    expectedSheets: expected,
    arrivedSheets: sheets.map(sheet => sheet.sheetId),
    missing,
    pending: [],
    missingCount: missing.length,
    pendingCount: 0,
    unexpectedSheets,
    transferredOutSheets: [...movedOut],
    // Complete means every expected sheet and face is settled, every present
    // sheet is on the manifest, and nothing is waiting for a human.
    complete: expected !== null && missing.length === 0 && unexpectedSheets.length === 0,
  };
}

export function buildBooks(ledger, facts = new Map()) {
  for (const sheet of ledger.sheets.values()) {
    ledger.ensureBook(sheet.originBook);
    ledger.ensureBook(sheet.book);
    for (const transfer of sheet.transfers) {
      ledger.ensureBook(transfer.sourceBook);
      ledger.ensureBook(transfer.targetBook);
    }
  }
  const records = [];
  for (const name of [...ledger.books.keys()].sort((a, b) => a.localeCompare(b))) {
    const book = ledger.books.get(name);
    const owned = [...ledger.sheets.values()]
      .filter(sheet => sheet.book === name)
      .sort((a, b) => a.sheetId.localeCompare(b.sheetId) || a.session.localeCompare(b.session));
    if (owned.length === 0 && !book.begin && !book.seal && !book.disputes.length) continue;
    const sessions = new Set(owned.map(sheet => sheet.session));
    const scannerSession = sessions.size === 0 ? (book.seal?.scannerSession ?? null) : (sessions.size === 1 ? [...sessions][0] : 'mixed');
    const sealed = Boolean(book.seal);
    const bySheetId = new Map();
    for (const sheet of owned) {
      const list = bySheetId.get(sheet.sheetId) ?? [];
      list.push(sheet);
      bySheetId.set(sheet.sheetId, list);
    }
    for (const [sheetId, copies] of bySheetId) {
      if (copies.length < 2) continue;
      for (const sheet of copies) {
        // Moving one of the copies to another book is what ends this dispute,
        // so the collision is re-derived from the current grouping.
        ledger.dispute(sheet, 'sheet-id-collision', `同一册件内纸张编号 ${sheetId} 出现在多个扫描会话，归属需要人工确认`, null);
        const collision = sheet.disputes.find(item => item.kind === 'sheet-id-collision');
        collision.resolved = false;
        collision.resolvedBy = null;
      }
    }
    // Rejected material stays on the record but is never presented as content
    // the book received.
    const rejectedRaw = owned.filter(sheet => sheet.rejected && sheet.rejectedBook === name);
    const receivedRaw = owned.filter(sheet => !rejectedRaw.includes(sheet));
    const transferredOut = [];
    for (const sheet of [...ledger.sheets.values()].sort((a, b) => a.sheetId.localeCompare(b.sheetId) || a.session.localeCompare(b.session))) {
      for (const transfer of sheet.transfers) {
        if (transfer.sourceBook !== name) continue;
        transferredOut.push({
          sheetId: sheet.sheetId,
          scannerSession: sheet.session,
          ...transferView(transfer),
          finalBook: sheet.book,
          resolution: sheet.resolution ? { ...sheet.resolution } : null,
          snapshot: transfer.snapshot ? renderAdvance(transfer.snapshot, facts, transfer.sourceSealed) : null,
        });
      }
    }
    // Disputes are derived from the raw sheets before rendering, so a dispute
    // discovered here is visible in the same collection result. An explicit
    // human decision to place a sheet in this book settles both the dispute and
    // the manifest mismatch: the operator, not the gateway, takes that call.
    const sealedIds = book.seal?.expectedSheets;
    if (sealed && sealedIds) {
      const movedOut = new Set(transferredOut.map(item => item.sheetId));
      for (const sheet of receivedRaw) {
        if (sealedIds.includes(sheet.sheetId) || movedOut.has(sheet.sheetId)) continue;
        if (sheet.resolution?.book === name) continue;
        ledger.dispute(sheet, 'unexpected-sheet', `封册清单未列出 ${sheet.sheetId}，需要人工确认`, book.seal.sequence);
      }
    }
    const sheets = receivedRaw.map(sheet => sheetView(sheet, name, sealed, facts));
    const rejectedSheets = rejectedRaw.map(sheet => ({
      ...sheetView(sheet, name, sealed, facts),
      rejectedReason: sheet.rejectedReason,
    }));
    const completeness = sealed ? sealedCompleteness(book, sheets, transferredOut) : openCompleteness(sheets);
    const review = reviewOf(book, [...sheets, ...rejectedSheets]);
    if (sealed) completeness.complete = completeness.complete && review.length === 0;
    const status = review.length ? 'review' : (sealed ? 'sealed' : 'open');
    records.push({
      identity: { book: name },
      book: name,
      scannerSession,
      data: {
        book: name,
        scannerSession,
        status,
        sealed: book.seal ? {
          sequence: book.seal.sequence,
          expectedSheets: book.seal.expectedSheets,
          manifestRevision: book.seal.manifestRevision,
        } : null,
        completeness,
        sheets,
        transfersOut: transferredOut,
        rejected: rejectedSheets,
        review: review.map(item => ({ ...item, book: name })),
        events: ledger.trace.filter(item => item.books.includes(name)).map(item => ({ ...item })),
      },
    });
  }
  return records;
}

export function reviewItems(records) {
  const items = [];
  for (const record of records) {
    if (record.source !== 'scan') continue;
    const latest = record.versions?.at(-1);
    if (!latest?.data) continue;
    const receipt = digest(Buffer.from(JSON.stringify([record.source, record.identity])));
    for (const entry of latest.data.review ?? []) {
      items.push({ receipt, book: latest.data.book, version: latest.version, status: latest.data.status, ...entry });
    }
  }
  return items.sort((a, b) => String(a.book).localeCompare(String(b.book)) || (a.sequence ?? 0) - (b.sequence ?? 0) || a.kind.localeCompare(b.kind));
}

export function decisionKey(session, sheetId) { return `${session}\u0000${sheetId}`; }

// The gateway is append-oriented but may replay, truncate or interleave
// batches. The intake therefore keeps what it has already seen and only
// applies genuinely new events, so a sealed book cannot silently change
// because an old batch was fetched again.
export function serializeLedger(ledger) {
  return {
    seen: [...ledger.seen.entries()].map(([key, value]) => [key, value]),
    books: [...ledger.books.values()].map(book => ({ name: book.name, begin: book.begin, seal: book.seal, disputes: book.disputes, sources: book.sources ?? [] })),
    sheets: [...ledger.sheets.values()].map(sheet => ({
      key: sheet.key, sheetId: sheet.sheetId, session: sheet.session, book: sheet.book,
      originBook: sheet.originBook, pages: sheet.pages, blanks: sheet.blanks,
      exclusions: sheet.exclusions, transfers: sheet.transfers, disputes: sheet.disputes,
      rescanTargets: sheet.rescanTargets, events: sheet.events,
      rejected: sheet.rejected, rejectedBook: sheet.rejectedBook, rejectedReason: sheet.rejectedReason,
      resolution: sheet.resolution, decisions: sheet.decisions ?? [],
    })),
    trace: ledger.trace,
    unrecognized: ledger.unrecognized,
    warnings: ledger.warnings,
  };
}

export function deserializeLedger(state) {
  const ledger = new Ledger();
  for (const [key, value] of state.seen ?? []) ledger.seen.set(key, value);
  for (const book of state.books ?? []) ledger.books.set(book.name, { ...book });
  for (const sheet of state.sheets ?? []) {
    ledger.sheets.set(sheet.key, {
      ...sheet,
      pages: sheet.pages ?? { front: [], back: [] },
      blanks: sheet.blanks ?? { front: [], back: [] },
      exclusions: sheet.exclusions ?? { front: [], back: [] },
      transfers: sheet.transfers ?? [], disputes: sheet.disputes ?? [],
      rescanTargets: sheet.rescanTargets ?? [], events: sheet.events ?? [],
      decisions: sheet.decisions ?? [],
    });
  }
  ledger.trace = state.trace ?? [];
  ledger.unrecognized = state.unrecognized ?? [];
  ledger.warnings = state.warnings ?? [];
  return ledger;
}
