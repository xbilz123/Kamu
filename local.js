// Untuk tes di komputer: npm start  (memakai file local.db bila TURSO_* tidak diisi)
require('./api/index.js').use(require('express').static('public')).listen(process.env.PORT || 3000, () => console.log('http://localhost:' + (process.env.PORT || 3000)));
