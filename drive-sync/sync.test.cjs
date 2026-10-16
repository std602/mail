const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const {webcrypto} = require('node:crypto');
function directory(initial={}) {
 const entries = new Map(Object.entries(initial));
 const missing=()=>Object.assign(Error('missing'),{name:'NotFoundError'});
 return {kind:'directory', entries:async function*(){yield* entries;},
 async getFileHandle(name,opts={}) { if(!entries.has(name)&&opts.create) entries.set(name,file('')); if(!entries.has(name))throw missing();return entries.get(name); },
 async getDirectoryHandle(name,opts={}) {if(!entries.has(name)&&opts.create)entries.set(name,directory());if(!entries.has(name))throw missing();return entries.get(name);}, map:entries};
}
function file(text) {let content=text; return {kind:'file',async getFile(){return new File([content],'test.txt',{lastModified:100});},async createWritable(){let next;return {async write(blob){next=await blob.text();},async close(){content=next;},async abort(){}};}};}
function setup(local,remotes=[]) {
 const nodes=new Map(), records=remotes.map(x=>({...x})), uploads=[];
 const context=vm.createContext({console,URLSearchParams,Blob,File,crypto:webcrypto,Date,Map,Set,Uint8Array,Error,Number,JSON,encodeURIComponent,setInterval:()=>{},window:{addEventListener(){}},document:{getElementById(id){if(!nodes.has(id))nodes.set(id,{textContent:'',value:'',disabled:false,checked:false});return nodes.get(id);}},fetch:async(url,opts={})=>{
  const u=new URL(url), id=u.pathname.split('/').pop();
  if(u.searchParams.get('alt')==='media'){const r=records.find(x=>x.id===id);return {ok:!!r,blob:async()=>new Blob([r.content])};}
  if(u.pathname.startsWith('/upload/')){uploads.push(opts); const saved={id:id==='files'?'new':id,size:'3',modifiedTime:'2026-01-02T00:00:00Z'};return {ok:true,json:async()=>saved};}
  if(u.searchParams.has('q')) return {ok:true,json:async()=>({files:records.filter(x=>(x.parent||'root')===u.searchParams.get('q').match(/^'([^']+)'/)[1])})};
  return {ok:true,json:async()=>records.find(x=>x.id===id)};
 }});
 vm.runInContext(fs.readFileSync(__dirname+'/app.js','utf8')+'\n globalThis.testing={buildPlan,sync,digest,baselines,setPlan:p=>plan=p,setRoots:(l)=>{localRoot=l;remoteRoot="root";token="test";expires=Infinity;}};',context);
 context.testing.setRoots(local);
 return {t:context.testing,records,uploads};
}
const remote=(content='old')=>({id:'r1',name:'a.txt',mimeType:'text/plain',size:String(Buffer.byteLength(content)),modifiedTime:'2026-01-01T00:00:00Z',content});
test('local-only file uploads',async()=>{const {t,uploads}=setup(directory({'a.txt':file('new')}));const p=await t.buildPlan();assert.equal(p[0].kind,'file');t.setPlan(p);await t.sync();assert.equal(uploads.length,1);assert.equal(uploads[0].method,'POST');});
test('remote-only file downloads',async()=>{const local=directory();const {t}=setup(local,[remote('new')]);const p=await t.buildPlan();assert.equal(p[0].kind,'download');t.setPlan(p);await t.sync();assert.equal(await(await local.map.get('a.txt').getFile()).text(),'new');});
test('same content establishes baseline and subsequent local edit uploads',async()=>{const local=directory({'a.txt':file('old')});const {t}=setup(local,[remote()]);assert.equal((await t.buildPlan()).length,0);local.map.set('a.txt',file('new'));assert.equal((await t.buildPlan())[0].kind,'file');});
test('remote edit after baseline downloads',async()=>{const local=directory({'a.txt':file('old')});const {t,records}=setup(local,[remote()]);await t.buildPlan();records[0].modifiedTime='2026-02-01T00:00:00Z';records[0].content='new';const p=await t.buildPlan();assert.equal(p[0].kind,'download');t.setPlan(p);await t.sync();assert.equal(await(await local.map.get('a.txt').getFile()).text(),'new');});
test('different initial versions conflict without writes',async()=>{const {t,uploads}=setup(directory({'a.txt':file('new')}),[remote()]);const p=await t.buildPlan();assert.equal(p[0].kind,'conflict');t.setPlan(p);assert.match(await t.sync(),/略過 1/);assert.equal(uploads.length,0);});
test('both sides modified after baseline conflict',async()=>{const local=directory({'a.txt':file('old')});const {t,records}=setup(local,[remote()]);await t.buildPlan();local.map.set('a.txt',file('local'));records[0].content='cloud';records[0].modifiedTime='2026-02-01T00:00:00Z';assert.equal((await t.buildPlan())[0].kind,'conflict');});
test('changes since preview block upload',async()=>{const local=directory({'a.txt':file('old')});const {t,uploads}=setup(local);const p=await t.buildPlan();local.map.set('a.txt',file('new'));t.setPlan(p);await assert.rejects(()=>t.sync(),/本機已變更/);assert.equal(uploads.length,0);});
test('duplicate names block preview',async()=>{const {t}=setup(directory(),[remote(),{...remote(),id:'r2'}]);await assert.rejects(()=>t.buildPlan(),/重複名稱/);});
test('cloud-only nested folder downloads',async()=>{const local=directory();const {t}=setup(local,[{id:'dir',name:'sub',mimeType:'application/vnd.google-apps.folder'}, {...remote('new'),parent:'dir'}]);const p=await t.buildPlan();assert.deepEqual(Array.from(p,x=>x.kind),['localFolder','download']);t.setPlan(p);await t.sync();assert.equal(await(await local.map.get('sub').map.get('a.txt').getFile()).text(),'new');});
test('Google native documents are explicitly skipped',async()=>{const {t}=setup(directory(),[{...remote(),mimeType:'application/vnd.google-apps.document'}]);assert.equal((await t.buildPlan())[0].kind,'skip');});
test('local deletion restores from cloud',async()=>{const local=directory({'a.txt':file('old')});const {t}=setup(local,[remote()]);await t.buildPlan();local.map.delete('a.txt');assert.equal((await t.buildPlan())[0].kind,'download');});
