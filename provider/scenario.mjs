export const initialState = () => ({ name: '双面扫描网关', revision: 1 });

import { createHash } from 'node:crypto';
const images = {
  front1: Buffer.from('册A第一张正面'), back1: Buffer.from('册A第一张背面'),
  rescan1: Buffer.from('册A第一张重扫正面'), front2: Buffer.from('册B第一张正面'),
  front3: Buffer.from('册C第一张正面'), back3: Buffer.from('册C第一张背面'),
  stray: Buffer.from('迟到纸张正面'),
};
const hash = id => createHash('sha256').update(images[id]).digest('hex');

export async function handle({ url, state, json, bytes }) {
  if (url.pathname === '/scan/events') {
    const session = state.session ?? 'session-a';
    const side = (id, book, sheet, face, revision = 1, extra = {}) => ({
      type: 'side', scannerSession: session, book, sheetId: sheet, face,
      sideRevision: revision, image: `/scan/images/${id}`, sha256: hash(id), ...extra,
    });
    const events = [
      { type: 'beginBook', book: 'book-a', scannerSession: session },
      side('front1', 'book-a', 's1', 'front'),
      { type: 'beginBook', book: 'book-b', scannerSession: session },
      side('front2', 'book-b', 's2', 'front'),
      { type: 'sealBook', book: 'book-a', expectedSheets: ['s1'], manifestRevision: 1 },
      ...(state.missingBack ? [] : [side('back1', 'book-a', 's1', 'back')]),
      { type: 'blankSide', book: 'book-b', sheetId: 's2', face: 'back', decisionId: 'blank-1' },
      ...(state.rescan ? [{ type: 'rescan', sheetId: 's1', face: 'front', replaces: 1, ...side('rescan1', 'book-a', 's1', 'front', 2), type: 'rescan' }] : []),
      ...(state.reassign ? [{ type: 'reassign', sheetId: 's1', sourceBook: 'book-a', targetBook: 'book-b', decisionId: 'move-1' }] : []),
      ...(state.exclude ? [{ type: 'excludeSide', book: 'book-b', sheetId: 's2', face: 'front', decisionId: 'drop-1' }] : []),
      ...(state.lateSheet ? [side('stray', 'book-a', 's9', 'front')] : []),
      ...(state.thirdBook ? [
        { type: 'beginBook', book: 'book-c', scannerSession: state.thirdSession ?? session },
        side('front3', 'book-c', 's1', 'front', 1, { scannerSession: state.thirdSession ?? session }),
        side('back3', 'book-c', 's1', 'back', 1, { scannerSession: state.thirdSession ?? session }),
        { type: 'sealBook', book: 'book-c', expectedSheets: ['s1'], manifestRevision: 1, scannerSession: state.thirdSession ?? session },
      ] : []),
      ...(state.badDigest ? [side('front1', 'book-b', 's2', 'front', 3, { sha256: hash('stray') })] : []),
      ...(state.unknownEvent ? [{ type: 'jog', scannerSession: session, book: 'book-a', note: '整理纸路' }] : []),
      ...(state.collision ? [side('back3', 'book-b', 's2', 'back', 1, { scannerSession: 'session-b' })] : []),
    ];
    bytes(200, events.map(event => JSON.stringify(event)).join('\n') + '\n', 'application/x-ndjson'); return true;
  }
  if (url.pathname.startsWith('/scan/images/')) { const image = images[url.pathname.split('/').at(-1)]; if (!image) json(404, { error: '图像不存在' }); else bytes(200, image); return true; }
  return false;
}
