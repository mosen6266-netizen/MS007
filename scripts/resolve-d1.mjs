const dbName=process.argv[2];
if(!dbName)throw new Error("Database name is required");
const token=process.env.CLOUDFLARE_API_TOKEN;
const account=process.env.CLOUDFLARE_ACCOUNT_ID;
if(!token||!account)throw new Error("Cloudflare credentials are missing");

const headers={Authorization:"Bearer "+token,"Content-Type":"application/json"};
const base="https://api.cloudflare.com/client/v4/accounts/"+account+"/d1/database";

async function jsonFetch(url,options={}){
  const res=await fetch(url,{...options,headers:{...headers,...(options.headers||{})}});
  const data=await res.json();
  if(!res.ok||!data.success)throw new Error(JSON.stringify(data.errors||data));
  return data;
}

const listed=await jsonFetch(base);
let db=(listed.result||[]).find(x=>x.name===dbName);
let created=false;
if(!db){
  const out=await jsonFetch(base,{method:"POST",body:JSON.stringify({name:dbName})});
  db=out.result;
  created=true;
}
if(!db?.uuid)throw new Error("Could not resolve D1 database UUID");
process.stdout.write(JSON.stringify({id:db.uuid,name:dbName,created}));
