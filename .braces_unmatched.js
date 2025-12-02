const fs = require('fs');
const path = 'd:\\OneDrive - EEMC\\Calendar\\Calendar_coding\\asset\\js\\modal_register.js';
try {
  const s = fs.readFileSync(path, 'utf8');
  const lines = s.split(/\r?\n/);
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === '{') stack.push({ line: i + 1, col: j + 1, context: line.trim() });
      else if (ch === '}') stack.pop();
    }
  }
  if (stack.length === 0) {
    console.log('No unmatched opens');
    process.exit(0);
  }
  console.log('Unmatched opens count:', stack.length);
  stack.forEach(item => console.log('Unmatched { at line', item.line, 'col', item.col, '-', item.context));
  process.exit(0);
} catch (err) {
  console.error('Failed to read file:', err && err.message);
  process.exit(2);
}
