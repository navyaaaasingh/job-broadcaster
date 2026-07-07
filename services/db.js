const path = require('path');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const file = path.join(__dirname, '..', 'data', 'db.json');
const adapter = new FileSync(file);
const db = low(adapter);

// recipients: [{ email, addedAt }] — the fixed broadcast list.
db.defaults({ recipients: [] }).write();

module.exports = db;
