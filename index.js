const express = require('express'), { createClient } = require('@libsql/client'), bcrypt = require('bcryptjs'),
  jwt = require('jsonwebtoken'), QRCode = require('qrcode'), crypto = require('crypto');
const { JWT_SECRET, PAKASIR_PROJECT, PAKASIR_API_KEY, ADMIN_EMAIL, ADMIN_PASSWORD, TURSO_DATABASE_URL, TURSO_AUTH_TOKEN } = process.env;

const db = createClient({ url: TURSO_DATABASE_URL || 'file:local.db', authToken: TURSO_AUTH_TOKEN });
const run = async (sql, args = []) => { const r = await db.execute({ sql, args });
  return { rows: r.rows.map(x => Object.fromEntries(r.columns.map((c, i) => [c, x[i]]))), changes: r.rowsAffected, id: Number(r.lastInsertRowid || 0) }; };
const one = async (s, a) => (await run(s, a)).rows[0];
const all = async (s, a) => (await run(s, a)).rows;

// Inisialisasi tabel + data awal (sekali per cold start)
let ready;
const init = () => ready || (ready = (async () => {
  await db.batch([
    'create table if not exists users(id integer primary key, email text unique, pass text, role text default \'user\', created integer)',
    'create table if not exists plans(id integer primary key, name text, cpu int, ram int, disk int, price int, active int default 1)',
    'create table if not exists stock(id integer primary key, plan_id int, region text, os text, version text, cred text, status text default \'available\', order_id text, reserved_at integer)',
    'create table if not exists orders(id text primary key, user_id int, stock_id int, plan_id int, amount int, total int, qr text, status text default \'pending\', created integer, paid_at integer)',
  ], 'write');
  if (!(await one('select count(*) c from plans')).c)
    await db.batch([['Starter', 1, 2, 50, 75000], ['Business', 2, 8, 160, 250000], ['Pro', 4, 16, 320, 480000], ['Ultra', 8, 16, 400, 650000]]
      .map(p => ({ sql: 'insert into plans(name,cpu,ram,disk,price) values(?,?,?,?,?)', args: p })), 'write');
  if (ADMIN_EMAIL && ADMIN_PASSWORD && !(await one('select 1 x from users where email=?', [ADMIN_EMAIL.toLowerCase()])))
    await run("insert into users(email,pass,role,created) values(?,?,'admin',?)", [ADMIN_EMAIL.toLowerCase(), bcrypt.hashSync(ADMIN_PASSWORD, 10), Date.now()]);
})().catch(e => { ready = null; throw e; }));

const app = express(); app.use(express.json());
const w = f => (req, res, next) => Promise.resolve(f(req, res, next)).catch(next);
app.use(w(async (req, res, next) => { if (!JWT_SECRET) throw new Error('JWT_SECRET belum diisi'); await init(); next(); }));
const auth = w(async (req, res, next) => {
  try { const u = jwt.verify((req.headers.authorization || '').slice(7), JWT_SECRET);
    req.user = await one('select id,email,role from users where id=?', [u.id]); if (!req.user) throw 0;
  } catch { return res.status(401).json({ error: 'Silakan login dulu' }); }
  next();
});
const admin = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Khusus admin' });
const sign = u => jwt.sign({ id: u.id }, JWT_SECRET, { expiresIn: '14d' });

// Lepas stok yang dibooking tapi tidak dibayar (35 menit) — dijalankan saat ada request
async function cleanup() {
  const t = Date.now() - 35 * 60e3;
  await db.batch([{ sql: "update orders set status='expired' where status='pending' and created<?", args: [t] },
    { sql: "update stock set status='available',order_id=null,reserved_at=null where status='reserved' and reserved_at<?", args: [t] }], 'write');
}

// ---------- Auth ----------
app.post('/api/register', w(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), pw = String(req.body.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email) || pw.length < 6) return res.status(400).json({ error: 'Email tidak valid / password minimal 6 karakter' });
  if (await one('select 1 x from users where email=?', [email])) return res.status(400).json({ error: 'Email sudah terdaftar' });
  const r = await run('insert into users(email,pass,created) values(?,?,?)', [email, bcrypt.hashSync(pw, 10), Date.now()]);
  res.json({ token: sign({ id: r.id }), user: { email, role: 'user' } });
}));
app.post('/api/login', w(async (req, res) => {
  const u = await one('select * from users where email=?', [String(req.body.email || '').trim().toLowerCase()]);
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.pass)) return res.status(400).json({ error: 'Email atau password salah' });
  res.json({ token: sign(u), user: { email: u.email, role: u.role } });
}));
app.get('/api/me', auth, (req, res) => res.json(req.user));

// ---------- Katalog ----------
app.get('/api/plans', w(async (req, res) => {
  await cleanup();
  const plans = await all('select * from plans where active=1 order by price');
  const combos = await all("select plan_id,region,os,version,count(*) n from stock where status='available' group by 1,2,3,4");
  res.json(plans.map(p => ({ ...p, combos: combos.filter(c => c.plan_id === p.id) })));
}));

// ---------- Order & Pakasir ----------
const full = id => one('select o.*,p.name plan,s.region,s.os,s.version,s.cred from orders o join plans p on p.id=o.plan_id join stock s on s.id=o.stock_id where o.id=?', [id]);
const pub = o => ({ id: o.id, plan: o.plan, region: o.region, os: o.os, version: o.version, amount: o.amount, total: o.total, status: o.status, created: o.created,
  qr: o.status === 'pending' ? o.qr : null, cred: o.status === 'paid' ? o.cred : null });
const finalize = o => db.batch([{ sql: "update orders set status='paid',paid_at=? where id=? and status in ('pending','expired')", args: [Date.now(), o.id] },
  { sql: "update stock set status='sold' where id=?", args: [o.stock_id] }], 'write');
async function checkPakasir(o) {
  const u = new URL('https://app.pakasir.com/api/transactiondetail');
  Object.entries({ project: PAKASIR_PROJECT, amount: o.amount, order_id: o.id, api_key: PAKASIR_API_KEY }).forEach(([k, v]) => u.searchParams.set(k, v));
  const d = await fetch(u).then(r => r.json());
  if (d.transaction && d.transaction.status === 'completed') await finalize(o);
}

app.post('/api/order', auth, w(async (req, res) => {
  await cleanup();
  const { plan_id, region, os, version } = req.body;
  const plan = await one('select * from plans where id=? and active=1', [plan_id]);
  if (!plan) return res.status(400).json({ error: 'Paket tidak ditemukan' });
  const oid = 'VPS' + Date.now() + crypto.randomInt(100, 999);
  const r = await run("update stock set status='reserved',order_id=?,reserved_at=? where id=(select id from stock where plan_id=? and region=? and os=? and version=? and status='available' limit 1)",
    [oid, Date.now(), plan_id, region, os, version]);
  if (!r.changes) return res.status(409).json({ error: 'Maaf, stok kombinasi ini baru saja habis' });
  try {
    const pr = await fetch('https://app.pakasir.com/api/transactioncreate/qris', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: PAKASIR_PROJECT, order_id: oid, amount: plan.price, api_key: PAKASIR_API_KEY }) }).then(r => r.json());
    if (!pr.payment) throw new Error(JSON.stringify(pr));
    const qr = await QRCode.toDataURL(pr.payment.payment_number, { width: 520, margin: 1 });
    const st = await one('select id from stock where order_id=?', [oid]);
    await run('insert into orders(id,user_id,stock_id,plan_id,amount,total,qr,created) values(?,?,?,?,?,?,?,?)',
      [oid, req.user.id, st.id, plan.id, plan.price, pr.payment.total_payment || plan.price, qr, Date.now()]);
    res.json({ id: oid });
  } catch (e) {
    console.error('Pakasir error', e.message);
    await run("update stock set status='available',order_id=null,reserved_at=null where order_id=?", [oid]);
    res.status(502).json({ error: 'Gagal membuat QRIS, coba lagi' });
  }
}));
app.get('/api/order/:id', auth, w(async (req, res) => {
  let o = await full(req.params.id);
  if (!o || (o.user_id !== req.user.id && req.user.role !== 'admin')) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
  if (o.status === 'pending') { await checkPakasir(o).catch(e => console.error(e.message)); o = await full(o.id); }
  res.json(pub(o));
}));
app.get('/api/my-orders', auth, w(async (req, res) =>
  res.json((await all('select o.*,p.name plan,s.region,s.os,s.version,s.cred from orders o join plans p on p.id=o.plan_id join stock s on s.id=o.stock_id where o.user_id=? order by o.created desc', [req.user.id])).map(pub))));
// Webhook Pakasir: https://DOMAINMU.vercel.app/api/pakasir/webhook (diverifikasi ulang ke Pakasir)
app.post('/api/pakasir/webhook', w(async (req, res) => {
  const o = await one('select * from orders where id=?', [req.body.order_id]);
  if (o && o.status !== 'paid') await checkPakasir(o);
  res.json({ ok: true });
}));

// ---------- Admin ----------
app.get('/api/admin/data', auth, admin, w(async (req, res) => {
  const [plans, stock, orders, users, avail, rev] = await Promise.all([
    all('select * from plans order by price'),
    all('select s.*,p.name plan from stock s join plans p on p.id=s.plan_id order by s.id desc limit 500'),
    all('select o.id,o.amount,o.status,o.created,u.email,p.name plan from orders o join users u on u.id=o.user_id join plans p on p.id=o.plan_id order by o.created desc limit 200'),
    one('select count(*) c from users'), one("select count(*) c from stock where status='available'"),
    one("select coalesce(sum(amount),0) c from orders where status='paid'")]);
  res.json({ plans, stock, orders, stats: { users: users.c, available: avail.c, revenue: rev.c } });
}));
app.post('/api/admin/stock', auth, admin, w(async (req, res) => {
  const { plan_id, region, os, version, items } = req.body;
  const lines = String(items || '').split('\n').map(s => s.trim()).filter(Boolean);
  if (!plan_id || !region || !os || !version || !lines.length) return res.status(400).json({ error: 'Lengkapi semua kolom' });
  await db.batch(lines.map(l => ({ sql: 'insert into stock(plan_id,region,os,version,cred) values(?,?,?,?,?)', args: [plan_id, region, os.trim(), version.trim(), l] })), 'write');
  res.json({ added: lines.length });
}));
app.delete('/api/admin/stock/:id', auth, admin, w(async (req, res) => {
  await run("delete from stock where id=? and status='available'", [req.params.id]); res.json({ ok: true });
}));
app.post('/api/admin/plan', auth, admin, w(async (req, res) => {
  const { id, name, cpu, ram, disk, price, active } = req.body, a = active ? 1 : 0;
  if (id) await run('update plans set name=?,cpu=?,ram=?,disk=?,price=?,active=? where id=?', [name, cpu, ram, disk, price, a, id]);
  else await run('insert into plans(name,cpu,ram,disk,price,active) values(?,?,?,?,?,?)', [name, cpu, ram, disk, price, a]);
  res.json({ ok: true });
}));

app.use((e, req, res, next) => { console.error(e); res.status(500).json({ error: 'Server error: ' + e.message }); });
module.exports = app;
