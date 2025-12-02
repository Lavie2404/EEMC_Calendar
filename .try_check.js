const fs = require('fs');
const path = 'd:\\OneDrive - EEMC\\Calendar\\Calendar_coding\\asset\\js\\modal_register.js';
const s = fs.readFileSync(path,'utf8');
let idx = 0; const problems = [];
while (true) {
  const tryIdx = s.indexOf('try {', idx);
  if (tryIdx === -1) break;
  // find block end by scanning braces
  let pos = tryIdx + 4; let depth = 0; let inString = false; let strChar = null; let esc=false;
  for (; pos < s.length; pos++) {
    const ch = s[pos];
    if (!inString) {
      if (ch === '"' || ch === "'" || ch === '`') { inString=true; strChar=ch; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        if (depth === 0) { break; } else depth--; 
      }
    } else {
      if (esc) { esc=false; continue;} 
      if (ch === '\\') { esc=true; continue;} 
      if (ch === strChar) { inString=false; strChar=null; }
    }
  }
  const after = s.slice(pos+1).trimStart();
  const nextTok = after.split(/\s+/)[0] || '';
  if (!(nextTok.startsWith('catch') || nextTok.startsWith('finally'))) {
    // record position
    const pre = s.slice(Math.max(0,tryIdx-100), tryIdx+20);
    problems.push({tryPos: tryIdx, nextTok, context: pre.replace(/\n/g,'\\n')});
  }
  idx = tryIdx + 4;
}
console.log('problems', problems.length);
problems.slice(0,10).forEach(p => console.log(p));
