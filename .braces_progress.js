const fs = require('fs');
const path = 'd:\\OneDrive - EEMC\\Calendar\\Calendar_coding\\asset\\js\\modal_register.js';
const start = 1480; const end = 1700;
try {
  const s = fs.readFileSync(path, 'utf8');
  const lines = s.split(/\r?\n/);
  let balance = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const opens = (line.match(/{/g) || []).length;
    const closes = (line.match(/}/g) || []).length;
    balance += opens - closes;
    if (i+1 >= start && i+1 <= end) {
      console.log(`${i+1}	${balance}	${line.trim()}`);
    }
  }
  console.log('Final balance overall:', balance);
} catch (err) { console.error(err && err.message); process.exit(2);}