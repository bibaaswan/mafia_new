// Run with:  node server.js   (no npm install needed)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const HOST_PASSWORD = process.env.HOST_PASSWORD || 'hostpass'; // change this!
const DB = path.join(__dirname, 'players.json');

let users = {};
try { users = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch {}
const saveUsers = () => fs.writeFileSync(DB, JSON.stringify(users));
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');

const sessions = {};      // token -> name
const clients = new Set(); // { res, name }  (an open connection = "online")

// Rounds go: Day 0 (roles), Night 1, Day 1, Night 2, Day 2, ...
const game = { idx: -1, open: false, subs: {}, roles: {}, roleList: [], msgs: {}, sent: [], notice: '', history: [] };
const kindOf = i => (i === 0 ? 'role' : i % 2 ? 'night' : 'day');
const label = i => (i < 0 ? 'Lobby' : i === 0 ? 'Day 0' : i % 2 ? `Night ${(i + 1) / 2}` : `Day ${i / 2}`);
const onlinePlayers = () => [...new Set([...clients].map(c => c.name))].filter(n => n !== 'host').sort();
const people = () => [...new Set([...onlinePlayers(), ...Object.keys(game.roles)])].sort();

// Night 1: shuffle the host's role list and hand one to each online player
function assignRoles() {
  const players = onlinePlayers(), pool = [...game.roleList];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  game.roles = {};
  players.forEach((p, i) => (game.roles[p] = pool[i] || 'Villager'));
  const extra = pool.length - players.length;
  game.notice = extra > 0 ? `${extra} role(s) were not used (more roles than players).`
    : extra < 0 ? `${-extra} player(s) got "Villager" (fewer roles than players).` : '';
}

function stateFor(name) {
  const isHost = name === 'host';
  const s = {
    me: name, isHost, idx: game.idx, label: label(game.idx),
    kind: game.idx < 0 ? 'lobby' : kindOf(game.idx),
    open: game.open, online: onlinePlayers(),
  };
  if (isHost) {
    s.submissions = game.subs; s.roles = game.roles; s.roleList = game.roleList;
    s.notice = game.notice; s.sent = game.sent; s.people = people();
    s.history = game.history;
    s.nextLabel = label(game.idx + 1);
  } else {
    s.mySub = game.subs[name] || null;
    s.myRole = game.roles[name] || null;
    s.msgs = game.msgs[name] || [];
  }
  return s;
}
function broadcast() {
  for (const c of clients) c.res.write(`data: ${JSON.stringify(stateFor(c.name))}\n\n`);
}
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 25000);

function endRound() {
  if (kindOf(game.idx) === 'role') { game.open = false; return; }
  const names = new Set([...onlinePlayers(), ...Object.keys(game.subs)]);
  game.history.push({
    label: label(game.idx), kind: kindOf(game.idx),
    entries: [...names].sort().map(p => ({
      player: p,
      role: game.roles[p] || '—',
      choice: kindOf(game.idx) === 'role' ? '—' : game.subs[p] || '—',
    })),
  });
  game.open = false;
}

const body = req => new Promise(ok => {
  let d = ''; req.on('data', c => (d += c));
  req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch { ok({}); } });
});
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    const name = sessions[url.searchParams.get('token')];
    if (!name) { res.writeHead(401); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const client = { res, name };
    clients.add(client);
    req.on('close', () => { clients.delete(client); broadcast(); });
    return broadcast();
  }

  if (req.method !== 'POST') { res.writeHead(404); return res.end(); }
  const b = await body(req);

  if (url.pathname === '/api/login') {
    const name = String(b.name || '').trim().slice(0, 20), pw = String(b.password || '');
    if (!name || pw.length < 3) return send(res, 400, { error: 'Enter a name and a password of at least 3 characters.' });
    if (name.toLowerCase() === 'host') {
      if (pw !== HOST_PASSWORD) return send(res, 401, { error: 'Wrong host password.' });
    } else if (users[name]) {
      if (hash(pw, users[name].salt) !== users[name].hash) return send(res, 401, { error: 'Wrong password.' });
    } else {
      const salt = crypto.randomBytes(8).toString('hex');
      users[name] = { salt, hash: hash(pw, salt) };
      saveUsers();
    }
    const token = crypto.randomBytes(16).toString('hex');
    const me = name.toLowerCase() === 'host' ? 'host' : name;
    sessions[token] = me;
    return send(res, 200, { token, name: me });
  }

  const name = sessions[b.token];
  if (!name) return send(res, 401, { error: 'Please log in again.' });

  if (url.pathname === '/api/submit') {
    if (name === 'host') return send(res, 403, { error: 'The host does not play.' });
    if (!game.open) return send(res, 400, { error: 'No round is open right now.' });
    if (kindOf(game.idx) === 'role') return send(res, 400, { error: 'Roles are handed out at the start of Night 1.' });
    const value = String(b.value || '').trim().slice(0, 30);
    if (!onlinePlayers().includes(value)) return send(res, 400, { error: 'That player is not online.' });
    game.subs[name] = value;
    send(res, 200, { ok: true });
    return broadcast();
  }

  if (name !== 'host') return send(res, 403, { error: 'Host only.' });

  if (url.pathname === '/api/host/start') {
    if (game.open) return send(res, 400, { error: 'End the current round first.' });
    const next = game.idx + 1;
    if (next === 1 && !game.roleList.length) return send(res, 400, { error: 'Enter the role list first (on Day 0).' });
    game.idx = next; game.subs = {}; game.open = true;
    if (next === 1) assignRoles();
  } else if (url.pathname === '/api/host/end') {
    if (!game.open) return send(res, 400, { error: 'No round is open.' });
    endRound();
  } else if (url.pathname === '/api/host/roles') {
    if (game.idx > 0) return send(res, 400, { error: 'Roles are locked once Night 1 has started.' });
    game.roleList = String(b.roles || '').split('\n').map(x => x.trim().slice(0, 30)).filter(Boolean).slice(0, 50);
  } else if (url.pathname === '/api/host/message') {
    const to = String(b.to || ''), text = String(b.text || '').trim().slice(0, 300);
    if (!game.open || kindOf(game.idx) !== 'night') return send(res, 400, { error: 'You can message players only while a night round is open.' });
    if (!people().includes(to) || !text) return send(res, 400, { error: 'Pick a player and write a message.' });
    const m = { label: label(game.idx), text };
    (game.msgs[to] = game.msgs[to] || []).push(m);
    game.sent.push({ ...m, to });
  } else return send(res, 404, { error: 'Unknown action.' });
  send(res, 200, { ok: true });
  broadcast();
}).listen(PORT, () => console.log(`Mafia server on http://localhost:${PORT}  (host password: ${HOST_PASSWORD})`));
