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
const game = { idx: -1, open: false, subs: {}, roles: {}, roleList: [], msgs: {}, sent: [], notice: '', dead: {}, resolved: true, history: [], roster: [] };
const kindOf = i => (i === 0 ? 'role' : i % 2 ? 'night' : 'day');
const label = i => (i < 0 ? 'Lobby' : i === 0 ? 'Start Game' : i % 2 ? `Night ${(i + 1) / 2}` : `Day ${i / 2}`);
const onlinePlayers = () => [...new Set([...clients].map(c => c.name))].filter(n => n !== 'host').sort();
const people = () => (game.idx >= 0 ? [...game.roster].sort() : onlinePlayers());

const alive = () => onlinePlayers().filter(n => !game.dead[n]);
const roleOf = n => (game.roles[n] || '').trim().toLowerCase();

// What input (if any) does this player get in the current round?
function inputFor(name) {
  if (game.dead[name]) return { type: 'none', why: 'You are out of the game.' };
  if (game.idx >= 0 && !game.roster.includes(name)) return { type: 'none', why: 'You are not in this game.' };
  if (game.idx < 1) return { type: 'none' };
  if (kindOf(game.idx) === 'day') return { type: 'pick', count: 1, options: alive(), title: 'Vote out' };
  const role = roleOf(name);
  if (!role) return { type: 'none', why: 'You have no role, so no action tonight.' };
  if (['jester', 'executioner', 'villager'].includes(role)) return { type: 'none', why: 'Your role has no night action.' };
  if (role === 'mayor') return { type: 'choice', options: ['Reveal', 'Do not reveal'], title: 'Reveal yourself?' };
  if (role === 'pi') return { type: 'pick', count: 2, options: alive().filter(n => n !== name), title: 'Choose two players' };
  let options = alive();
  if (role === 'doctor') options = options.filter(n => n !== name);
  if (role === 'godfather') options = options.filter(n => roleOf(n) !== 'mafia');
  if (role === 'mafia') options = options.filter(n => roleOf(n) !== 'godfather');
  return { type: 'pick', count: 1, options, title: 'Choose a player' };
}

// Night 1: shuffle the host's role list and hand one to each online player
function assignRoles() {
  const players = game.roster, pool = [...game.roleList];
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
    open: game.open, online: onlinePlayers(), dead: Object.keys(game.dead),
  };
  if (isHost) {
    s.submissions = game.subs; s.roles = game.roles; s.roleList = game.roleList;
    s.notice = game.notice; s.sent = game.sent; s.people = people();
    s.alive = people().filter(n => !game.dead[n]);
    s.needsResolve = game.idx >= 1 && !game.open && !game.resolved;
    s.history = game.history;
    s.nextLabel = label(game.idx + 1);
  } else {
    s.mySub = game.subs[name] || null;
    s.myRole = game.roles[name] || null;
    s.msgs = game.msgs[name] || [];
    s.input = inputFor(name);
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
  game.resolved = false; // host must record deaths / vote-out before the next round
}

const body = req => new Promise(ok => {
  let d = ''; req.on('data', c => (d += c));
  req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch { ok({}); } });
});
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    const name = sessions[url.searchParams.get('token')];
    if (!name) { res.writeHead(401); return res.end(); }
    if (name !== 'host' && game.idx >= 0 && !game.roster.includes(name)) { res.writeHead(403); return res.end(); }
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
    if (name.toLowerCase() !== 'host' && game.idx >= 0 && !game.roster.includes(name))
      return send(res, 403, { error: 'A game is already running. Please wait for the next one.' });
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
    const spec = inputFor(name);
    if (spec.type === 'none') return send(res, 400, { error: spec.why || 'You have no input this round.' });
    const vals = (Array.isArray(b.values) ? b.values : []).map(String);
    const need = spec.type === 'choice' ? 1 : spec.count;
    if (vals.length !== need || new Set(vals).size !== need || !vals.every(v => spec.options.includes(v)))
      return send(res, 400, { error: need === 2 ? 'Choose two different players.' : 'Choose a valid option.' });
    game.subs[name] = vals.join(' + ');
    send(res, 200, { ok: true });
    return broadcast();
  }

  if (name !== 'host') return send(res, 403, { error: 'Host only.' });

  if (url.pathname === '/api/host/start') {
    if (game.open) return send(res, 400, { error: 'End the current round first.' });
    if (game.idx >= 1 && !game.resolved) return send(res, 400, { error: 'Record who died or was voted out first.' });
    const next = game.idx + 1;
    if (next === 0) {
      const p = onlinePlayers();
      if (!p.length) return send(res, 400, { error: 'No players are online yet.' });
      game.roster = p;
    }
    if (next === 1 && !game.roleList.length) return send(res, 400, { error: 'Enter the role list first (during Start Game).' });
    game.idx = next; game.subs = {}; game.open = true;
    if (next === 1) assignRoles();
  } else if (url.pathname === '/api/host/end') {
    if (!game.open) return send(res, 400, { error: 'No round is open.' });
    endRound();
  } else if (url.pathname === '/api/host/resolve') {
    if (game.open || game.idx < 1 || game.resolved) return send(res, 400, { error: 'Nothing to record right now.' });
    const names = (Array.isArray(b.names) ? b.names : []).map(String).filter(n => people().includes(n) && !game.dead[n]);
    const cause = kindOf(game.idx) === 'night' ? 'died' : 'voted out';
    names.forEach(n => (game.dead[n] = { label: label(game.idx), cause }));
    game.resolved = true;
  } else if (url.pathname === '/api/host/endgame') {
    Object.assign(game, { idx: -1, open: false, subs: {}, roles: {}, msgs: {}, sent: [], notice: '', dead: {}, resolved: true, history: [], roster: [] });
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
