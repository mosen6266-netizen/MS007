import fs from "node:fs";

const args=Object.fromEntries(process.argv.slice(2).map(x=>{
  const i=x.indexOf("=");
  return i<0?[x,"true"]:[x.slice(0,i),x.slice(i+1)];
}));
const input=args.input||"wrangler.toml";
const output=args.output;
if(!output)throw new Error("output= is required");
const worker=args.worker||"ms007-crm";
const dbName=args.db||"ms007-crm";
const dbId=args.id;
const version=args.version||"dev";
const channel=args.channel||"development";
if(!dbId)throw new Error("id= is required");

let text=fs.readFileSync(input,"utf8");
text=text.replace(/^name\s*=\s*"[^"]+"/m,'name = "'+worker+'"');
text=text.replace(/^database_name\s*=\s*"[^"]+"/m,'database_name = "'+dbName+'"');
text=text.replace(/^database_id\s*=\s*"[^"]+"/m,'database_id = "'+dbId+'"');
text=text.replace(/^APP_VERSION\s*=\s*"[^"]+"/m,'APP_VERSION = "'+version+'"');
text=text.replace(/^DEPLOY_CHANNEL\s*=\s*"[^"]+"/m,'DEPLOY_CHANNEL = "'+channel+'"');

if(args["disable-cron"]==="true"){
  text=text.replace(/\n\[triggers\]\ncrons\s*=\s*\[[^\n]*\]\n?/m,"\n");
}
fs.writeFileSync(output,text);
