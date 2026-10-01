import fs from "node:fs";
import path from "node:path";

function stripComments(sql){
  return sql
    .replace(/\/\*[\s\S]*?\*\//g," ")
    .replace(/--.*$/gm," ")
    .replace(/\s+/g," ")
    .trim();
}

function scan(file,mode){
  const raw=fs.readFileSync(file,"utf8");
  const sql=stripComments(raw);
  const approved=/MS007-SAFETY-APPROVED:/i.test(raw);

  const alwaysBlocked=[
    ["DROP TABLE",/\bDROP\s+TABLE\b/i],
    ["DROP VIEW",/\bDROP\s+VIEW\b/i],
    ["TRUNCATE",/\bTRUNCATE\b/i],
    ["Disable foreign keys",/\bPRAGMA\s+foreign_keys\s*=\s*(?:OFF|0)\b/i]
  ];

  const guarded=[
    ["DROP COLUMN",/\bALTER\s+TABLE\b[\s\S]*?\bDROP\s+(?:COLUMN\s+)?[A-Za-z_]/i],
    ["ALTER TABLE RENAME",/\bALTER\s+TABLE\b[\s\S]*?\bRENAME\b/i],
    ["DELETE FROM",/\bDELETE\s+FROM\b/i],
    ["UPDATE existing data",/\bUPDATE\s+[A-Za-z_][A-Za-z0-9_]*\s+SET\b/i],
    ["INSERT OR REPLACE",/\bINSERT\s+OR\s+REPLACE\b/i],
    ["REPLACE INTO",/\bREPLACE\s+INTO\b/i]
  ];

  const hits=[];
  for(const [name,re] of alwaysBlocked) if(re.test(sql)) hits.push(name);
  for(const [name,re] of guarded){
    if(!re.test(sql)) continue;
    if(mode==="migration" && approved) continue;
    hits.push(name);
  }
  return hits;
}

const files=[];
if(fs.existsSync("schema.sql")) files.push(["schema.sql","bootstrap"]);
if(fs.existsSync("migrations")){
  for(const name of fs.readdirSync("migrations").filter(x=>x.endsWith(".sql")).sort()){
    files.push([path.join("migrations",name),"migration"]);
  }
}

let failed=false;
for(const [file,mode] of files){
  const hits=scan(file,mode);
  if(hits.length){
    failed=true;
    console.error("\nBLOCKED:",file);
    for(const hit of hits) console.error(" -",hit);
    if(mode==="migration"){
      console.error("If a reviewed migration genuinely needs a guarded operation, add:");
      console.error("-- MS007-SAFETY-APPROVED: <why this is safe and how data is protected>");
    }
  }
}

if(failed){
  console.error("\nDatabase safety gate failed before any remote database is touched.");
  process.exit(1);
}

console.log("Database safety gate passed.");
console.log("Checked",files.length,"SQL file(s).");
