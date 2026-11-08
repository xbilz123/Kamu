# Nebula VPS (Vercel + Turso)
1. Buat database di https://turso.tech → ambil URL (libsql://...) dan Auth Token.
2. Push folder ini ke GitHub (private).
3. Vercel → Add New Project → pilih repo → isi Environment Variables (lihat .env.example) → Deploy.
4. Dashboard Pakasir → Webhook URL: https://DOMAINMU.vercel.app/api/pakasir/webhook
5. Buka situs, login pakai ADMIN_EMAIL/ADMIN_PASSWORD → menu Admin → isi stok.
Tes lokal: npm install, isi .env, npm start.
