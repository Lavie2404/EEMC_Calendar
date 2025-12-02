const fs = require('fs');
const src = fs.readFileSync('asset/js/modal_register.js','utf8');
function indexToLineCol(idx){ const before=src.slice(0, idx); const lines=before.split(/\r?\n/); const line=lines.length; const col=lines[lines.length-1].length+1; return {line,col}; }
const re = /\btry\s*\{/g;
let m; const problems = [];
while((m = re.exec(src)) !== null){ const start = m.index; // find matching brace for this try block
  let i = src.indexOf('{', start+m[0].length-1);
  if(i<0) continue;
  let depth=1; let j=i+1; for(; j<src.length; j++){ const ch = src[j]; if(ch==='"' || ch==="'" || ch==='`'){ // skip strings
      const quote = ch; j++; while(j<src.length){ if(src[j]==='\\') { j+=2; continue; } if(src[j]===quote) { j++; break; } j++; }
      continue;
    }
    if(ch==='/'){ const nxt = src[j+1]; if(nxt==='/' ){ j = src.indexOf('\n', j+2); if(j<0) { j=src.length; break; } continue; } if(nxt==='*'){ const endc = src.indexOf('*/', j+2); if(endc<0){ j=src.length; break; } j = endc+2; continue; } }
    if(ch==='{') depth++; else if(ch==='}') { depth--; if(depth===0) break; }
  }
  if(j>=src.length) { problems.push({start,issue:'unterminated try block',pos:indexToLineCol(start)}); continue; }
  // j points to closing '}' of try block
  // find next non-whitespace/comments
  let k = j+1; while(k<src.length){ const ch=src[k]; if(/\s/.test(ch)) { k++; continue; } if(ch==='/'){ const nxt=src[k+1]; if(nxt==='/' ){ k = src.indexOf('\n', k+2); if(k<0) k=src.length; continue; } if(nxt==='*'){ const endc = src.indexOf('*/', k+2); if(endc<0) { k=src.length; break; } k = endc+2; continue; } }
    break; }
  const nextTok = src.slice(k, k+10);
  const nextWord = nextTok.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*/);
  const next = nextWord ? nextWord[0] : (nextTok[0]||'');
  if(next !== 'catch' && next !== 'finally'){
    problems.push({start,tryEndPos:j+1, next, nextSnippet: src.slice(k, k+40), pos: indexToLineCol(start), endPos:indexToLineCol(j)});
  }
}
if(!problems.length){ console.log('No try-without-catch issues found'); process.exit(0);} console.log('problems', problems.length); problems.forEach(p=>{
  console.log('---'); console.log('try at', p.pos, 'ends at', p.endPos, 'next=', p.next); console.log('snippet:', JSON.stringify(p.nextSnippet));
});
process.exit(0);
