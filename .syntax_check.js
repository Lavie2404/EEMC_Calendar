const fs = require('fs');
const path = 'asset/js/modal_register.js';
const src = fs.readFileSync(path, 'utf8');
let i=0; const n=src.length;
let state='normal';
let stack=[];
let line=1,col=1;
let lastStateStart={};
function advance(ch){ if(ch==='\n'){line++;col=1;} else col++; }
for(i=0;i<n;i++){
  const ch = src[i];
  const nxt = src[i+1];
  if(state==='normal'){
    if(ch==='/'){
      if(nxt==='/' ){ state='linecomment'; lastStateStart={line,col}; i++; advance(ch); advance(nxt); continue; }
      if(nxt==='*'){ state='blockcomment'; lastStateStart={line,col}; i++; advance(ch); advance(nxt); continue; }
    }
    if(ch==='"'){ state='dquote'; lastStateStart={line,col}; }
    else if(ch==="'"){ state='squote'; lastStateStart={line,col}; }
    else if(ch==='`'){ state='bquote'; lastStateStart={line,col}; }
    else if(ch==='('){ stack.push({tok:'(',line,col}); }
    else if(ch===')'){ if(stack.length===0 || stack[stack.length-1].tok!=='('){ console.log('Unmatched ) at',line,col); } else stack.pop(); }
    else if(ch==='['){ stack.push({tok:'[',line,col}); }
    else if(ch===']'){ if(stack.length===0 || stack[stack.length-1].tok!=='['){ console.log('Unmatched ] at',line,col); } else stack.pop(); }
    else if(ch==='{'){ stack.push({tok:'{',line,col}); }
    else if(ch==='}'){ if(stack.length===0 || stack[stack.length-1].tok!=='{'){ console.log('Unmatched } at',line,col); } else stack.pop(); }
  } else if(state==='linecomment'){
    if(ch==='\n'){ state='normal'; }
  } else if(state==='blockcomment'){
    if(ch==='*' && nxt==='/' ){ state='normal'; i++; advance(ch); advance(nxt); continue; }
  } else if(state==='dquote'){
    if(ch==='\\'){ i++; advance(ch); if(i<n){ advance(src[i]); } continue; }
    if(ch==='"'){ state='normal'; }
  } else if(state==='squote'){
    if(ch==='\\'){ i++; advance(ch); if(i<n){ advance(src[i]); } continue; }
    if(ch==="'"){ state='normal'; }
  } else if(state==='bquote'){
    if(ch==='\\'){ i++; advance(ch); if(i<n){ advance(src[i]); } continue; }
    if(ch==='`'){ state='normal'; }
    if(ch==='$' && nxt==='{' ){ stack.push({tok:'${',line,col}); i++; advance(ch); advance(nxt); continue; }
    if(ch==='}' && stack.length && stack[stack.length-1].tok==='${'){ stack.pop(); }
  }
  advance(ch);
}
console.log('final state', state, 'line', line, 'col', col);
if(stack.length) console.log('unclosed stack', stack);
if(state!=='normal') console.log('unterminated', state, 'started at', JSON.stringify(lastStateStart));
else console.log('no unterminated strings/comments detected');
