import fs from "node:fs";

const files=["src/worker.js","public/app.js"];
let failed=false;

for(const file of files){
  const source=fs.readFileSync(file,"utf8");
  const names=[...source.matchAll(/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(x=>x[1]);
  const counts=new Map();
  for(const name of names)counts.set(name,(counts.get(name)||0)+1);
  const duplicates=[...counts.entries()].filter(([,count])=>count>1);
  if(duplicates.length){
    failed=true;
    console.error("Duplicate function declarations in "+file+":");
    for(const [name,count] of duplicates)console.error(" - "+name+" x"+count);
  }
}
if(failed)process.exit(1);
console.log("No duplicate function declarations.");
