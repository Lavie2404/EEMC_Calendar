const fs = require('fs');
const path = 'd:\\OneDrive - EEMC\\Calendar\\Calendar_coding\\asset\\js\\modal_register.js';
try {
  const s = fs.readFileSync(path, 'utf8');
  let open = 0;
  const bad = [];
  const lines = s.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const opens = (line.match(/{/g) || []).length;
    const closes = (line.match(/}/g) || []).length;
    open += opens - closes;
    if (open < 0) {
      bad.push({ line: i + 1, text: line });
      open = 0;
    }
  }
  console.log('Final balance:', open);
  if (bad.length) {
    bad.forEach(b => console.log('Negative at line', b.line, b.text));
    process.exit(1);
  }
  process.exit(0);
} catch (err) {
  console.error('Failed to read/parse:', err && err.message);
  process.exit(2);
}
