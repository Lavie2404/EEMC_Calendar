const fs = require('fs');
const acorn = require('acorn');
const src = fs.readFileSync('asset/js/modal_register.js','utf8');
try{
  acorn.parse(src, {ecmaVersion:2020, sourceType:'module'});
  console.log('Parsed OK');
}catch(e){
  console.log('Acorn error:', e.message);
  console.log('Loc:', e.loc);
}
