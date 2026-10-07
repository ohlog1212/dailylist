/* 아마레 작업일지 — 구글 시트 저장소 연결 (GitHub Pages 버전)
 * 페이지가 쓰는 저장 기능(doc/collection/onSnapshot/set/update/delete)을
 * 구글 Apps Script 웹 앱으로 대신 처리합니다.
 * - 처음 열 때 현장 PIN을 한 번 입력하면 그 기기에 기억됩니다.
 * - 입력은 0.3초 모아서 한 번에 보내고, 실패하면 3번까지 다시 보냅니다.
 * - 다른 기기의 입력은 12초마다(화면을 다시 켤 때는 바로) 가져옵니다.
 */
(function(){
  const CFG = window.AMARE_CONFIG || {};
  const PIN_KEY = 'amare_pin';
  const POLL_MS = 12000;
  const lsGet = k => { try { return localStorage.getItem(k) } catch { return null } };
  const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v) } catch {} };
  const clone = o => o == null ? o : JSON.parse(JSON.stringify(o));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  let pin = null;

  /* 구글 쪽 전달(리다이렉트)이 가끔 실제 응답 대신 상태 페이지({ok,app})를 돌려줄 때가 있다.
   * 저장은 now, 읽기는 rows 가 있어야 진짜 응답으로 보고, 아니면 3번까지 다시 보낸다 (같은 내용 재전송이라 안전). */
  const looksDone = (action, j) => action === 'batch' ? typeof j.now === 'number' : Array.isArray(j.rows);
  async function call(body) {
    let last = { code: 'network', message: '응답을 받지 못했습니다.' };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, 600 * attempt));
      let r;
      try {
        r = await fetch(CFG.apiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ ...body, pin }), redirect: 'follow' });
      } catch (e) { last = { code: 'network', message: '인터넷 연결을 확인해 주세요.' }; continue }
      if (!r.ok) { last = { code: 'network', message: 'HTTP ' + r.status }; continue }
      let j; try { j = await r.json() } catch { last = { code: 'network', message: '응답을 읽지 못했습니다.' }; continue }
      if (!j.ok) throw { code: j.error === 'pin' ? 'pin' : 'server', message: j.error || '오류' };
      if (looksDone(body.action, j)) return j;
      last = { code: 'network', message: '구글 응답이 올바르지 않습니다.' };
    }
    throw last;
  }

  /* ---------- PIN 입력 화면 ---------- */
  function gate(msg) {
    return new Promise(resolve => {
      const box = document.createElement('div');
      box.setAttribute('role', 'dialog');
      box.style.cssText = 'position:fixed;inset:0;z-index:100;background:var(--bg,#eef1ef);display:flex;align-items:center;justify-content:center;padding:16px';
      box.innerHTML = `<form style="background:var(--surface,#fff);border:1px solid var(--line,#d6dcd8);border-radius:12px;padding:22px;width:100%;max-width:340px;display:flex;flex-direction:column;gap:12px">
        <div style="font-size:18px;font-weight:700"><b style="font-family:var(--f-mono);color:var(--accent,#1d5a86);letter-spacing:.08em">AMARE</b> 작업일지</div>
        <label style="display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:600;color:var(--muted,#5b676b)">현장 PIN 번호
          <input id="amarePin" class="in num" type="password" inputmode="numeric" autocomplete="off" style="font-size:22px;letter-spacing:.3em;text-align:center"></label>
        <div id="amarePinMsg" style="font-size:13px;color:var(--bad,#b0362b);min-height:1.2em">${msg || ''}</div>
        <button class="btn primary" type="submit" style="height:46px;font-size:16px">들어가기</button>
        <div style="font-size:12px;color:var(--muted,#5b676b);line-height:1.5">한 번 입력하면 이 기기에서는 다시 묻지 않습니다. PIN은 사무실에 문의하세요.</div>
      </form>`;
      document.body.appendChild(box);
      const inp = box.querySelector('#amarePin');
      setTimeout(() => inp.focus(), 50);
      box.querySelector('form').addEventListener('submit', e => {
        e.preventDefault();
        const v = inp.value.trim();
        if (!v) { box.querySelector('#amarePinMsg').textContent = 'PIN 번호를 입력하세요.'; return }
        box.remove(); resolve(v);
      });
    });
  }
  function fatal(msg) {
    const b = document.getElementById('banner');
    if (b) { b.hidden = false; b.textContent = msg }
  }
  function pinFail() { lsSet(PIN_KEY, null); location.reload() }

  /* ---------- 로컬 캐시 + 구독 ---------- */
  const cache = {};
  const mapOf = c => cache[c] || (cache[c] = new Map());
  const listeners = new Set();
  const pending = new Map();     // "coll/id" -> 보내는 중인 쓰기 수
  const lastWrite = new Map();   // "coll/id" -> 서버가 저장한 시각
  const META = { fromCache: false, hasPendingWrites: false };
  const snapDoc = (id, d) => ({ id, exists: d != null, data: () => d == null ? undefined : d, metadata: META });
  const cmp = (a, op, v) => {
    switch (op) {
      case '==': return a === v; case '!=': return a !== v;
      case 'in': return Array.isArray(v) && v.includes(a); case 'not-in': return Array.isArray(v) && !v.includes(a);
      case '<': return a < v; case '<=': return a <= v; case '>': return a > v; case '>=': return a >= v;
      case 'array-contains': return Array.isArray(a) && a.includes(v);
      default: return false;
    }
  };
  function runQuery(q) {
    let arr = [...mapOf(q.coll).entries()].map(([id, d]) => ({ id, d }));
    q.wh.forEach(([f, op, v]) => { arr = arr.filter(x => cmp(x.d[f], op, v)) });
    if (q.ob) { const [f, dir] = q.ob; arr.sort((a, b) => { const x = a.d[f], y = b.d[f]; if (x === y) return 0; if (x == null) return 1; if (y == null) return -1; return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1) }) }
    else arr.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (q.lim) arr = arr.slice(0, q.lim);
    const docs = arr.map(x => snapDoc(x.id, x.d));
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: META };
  }
  function notify(coll) {
    listeners.forEach(l => {
      if (l.coll !== coll) return;
      try { l.id != null ? l.next(snapDoc(l.id, mapOf(coll).get(l.id) ?? null)) : l.next(runQuery(l.q)) } catch (e) { console.error(e) }
    });
  }

  /* ---------- 쓰기 대기열 ---------- */
  let queue = [], flushT = null, inflight = false;
  function enqueue(op) {
    return new Promise((res, rej) => {
      const k = op.coll + '/' + op.id;
      pending.set(k, (pending.get(k) || 0) + 1);
      queue.push({ op, res, rej, tries: 0 });
      clearTimeout(flushT); flushT = setTimeout(flush, 300);
    });
  }
  function done(item) {
    const k = item.op.coll + '/' + item.op.id, n = (pending.get(k) || 1) - 1;
    n ? pending.set(k, n) : pending.delete(k);
  }
  async function flush() {
    if (inflight) { clearTimeout(flushT); flushT = setTimeout(flush, 300); return }
    const items = queue; queue = [];
    if (!items.length) return;
    inflight = true;
    try {
      const j = await call({ action: 'batch', ops: items.map(i => i.op) });
      items.forEach(i => { lastWrite.set(i.op.coll + '/' + i.op.id, j.now); done(i); i.res() });
    } catch (e) {
      if (e.code === 'pin') { items.forEach(i => { done(i); i.rej({ code: 'invalid_argument', message: 'PIN' }) }); pinFail() }
      else {
        const retry = items.filter(i => ++i.tries < 3), give = items.filter(i => i.tries >= 3);
        give.forEach(i => { done(i); i.rej({ code: 'unavailable', message: e.message }) });
        if (retry.length) { queue = retry.concat(queue); clearTimeout(flushT); flushT = setTimeout(flush, 3000) }
      }
    } finally {
      inflight = false;
      if (queue.length && !flushT) flushT = setTimeout(flush, 300);
    }
  }

  /* ---------- 다른 기기 변경 가져오기 ---------- */
  let since = 0, pollT = null, polling = false;
  function apply(rows) {
    const touched = new Set();
    rows.forEach(r => {
      const k = r.coll + '/' + r.id;
      if (pending.has(k)) return;                          // 이 기기에서 보내는 중
      if ((lastWrite.get(k) || 0) > r.updatedAt) return;   // 이 기기가 더 최근에 저장
      const m = mapOf(r.coll);
      if (r.data == null) { if (m.delete(r.id)) touched.add(r.coll) }
      else if (!same(m.get(r.id), r.data)) { m.set(r.id, r.data); touched.add(r.coll) }
    });
    touched.forEach(notify);
  }
  async function poll() {
    if (polling || document.hidden) return;
    polling = true;
    try { const j = await call({ action: 'changes', since: Math.max(0, since - 5000) }); apply(j.rows); since = j.now }
    catch (e) { if (e.code === 'pin') pinFail() }
    finally { polling = false }
  }
  function startPolling() {
    clearInterval(pollT); pollT = setInterval(poll, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll() });
    window.addEventListener('focus', poll);
  }

  /* ---------- 페이지가 쓰는 저장 API ---------- */
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  function docRef(coll, id) {
    return {
      id, path: coll + '/' + id,
      get: async () => snapDoc(id, mapOf(coll).get(id) ?? null),
      set(data) { const d = clone(data); mapOf(coll).set(id, d); notify(coll); return enqueue({ op: 'set', coll, id, data: d }) },
      update(data) {
        const cur = mapOf(coll).get(id);
        if (!cur) return Promise.reject({ code: 'invalid_argument', message: 'no document' });
        const d = { ...clone(cur), ...clone(data) };
        mapOf(coll).set(id, d); notify(coll);
        return enqueue({ op: 'set', coll, id, data: d });
      },
      delete() { mapOf(coll).delete(id); notify(coll); return enqueue({ op: 'delete', coll, id }) },
      onSnapshot(next) { const l = { coll, id, next }; listeners.add(l); setTimeout(() => listeners.has(l) && next(snapDoc(id, mapOf(coll).get(id) ?? null)), 0); return () => listeners.delete(l) },
    };
  }
  function query(q) {
    return {
      path: q.coll,
      where: (f, op, v) => query({ ...q, wh: [...q.wh, [f, op, v]] }),
      orderBy: (f, dir = 'asc') => query({ ...q, ob: [f, dir] }),
      limit: n => query({ ...q, lim: n }),
      get: async () => runQuery(q),
      onSnapshot(next) { const l = { coll: q.coll, q, next }; listeners.add(l); setTimeout(() => listeners.has(l) && next(runQuery(q)), 0); return () => listeners.delete(l) },
      doc: id => docRef(q.coll, id || newId()),
      add: async d => { const r = docRef(q.coll, newId()); await r.set(d); return r },
    };
  }
  const db = {
    doc(path) { const p = String(path).split('/'); return docRef(p.slice(0, -1).join('/'), p[p.length - 1]) },
    collection(path) { return query({ coll: String(path), wh: [], ob: null, lim: 0 }) },
  };

  /* 파일 저장: 일반 다운로드 */
  const dl = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      return { status: 'saved' };
    },
  };

  window.AMARE_BACKEND = {
    async connect() {
      if (!CFG.apiUrl || !/^https:\/\/script\.google\.com\//.test(CFG.apiUrl)) {
        fatal('config.js에 구글 Apps Script 웹 앱 주소가 없습니다. 설치 안내의 3단계를 확인해 주세요.');
        return null;
      }
      pin = lsGet(PIN_KEY);
      let msg = '';
      for (;;) {
        if (!pin) pin = await gate(msg);
        try {
          const j = await call({ action: 'load' });
          lsSet(PIN_KEY, pin);
          j.rows.forEach(r => { if (r.data != null) mapOf(r.coll).set(r.id, r.data) });
          since = j.now;
          startPolling();
          return { db, dl };
        } catch (e) {
          if (e.code === 'pin') { lsSet(PIN_KEY, null); pin = null; msg = 'PIN 번호가 맞지 않습니다.'; continue }
          fatal('구글 시트에 연결하지 못했습니다. 인터넷 연결을 확인하고 새로고침해 주세요. (' + (e.message || '') + ')');
          return null;
        }
      }
    },
  };
})();
