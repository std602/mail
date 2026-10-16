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
  if(u.pathname.endsWith('/export')){const r=records.find(x=>x.id===u.pathname.split('/').at(-2));return {ok:!r.exportError,status:r.exportError?403:200,json:async()=>({error:{message:'exportSizeLimitExceeded'}}),blob:async()=>new Blob([r.content])};}
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
test('unsupported Google Forms are explicitly skipped',async()=>{const {t}=setup(directory(),[{...remote(),mimeType:'application/vnd.google-apps.form'}]);assert.equal((await t.buildPlan())[0].kind,'skip');});
test('local deletion restores from cloud',async()=>{const local=directory({'a.txt':file('old')});const {t}=setup(local,[remote()]);await t.buildPlan();local.map.delete('a.txt');assert.equal((await t.buildPlan())[0].kind,'download');});

for (const [type,extension] of [['document','.docx'],['spreadsheet','.xlsx'],['presentation','.pptx']]) {
 test(`Google ${type} exports and does not upload its local representation`,async()=>{
  const local=directory();const {t,uploads}=setup(local,[{...remote('exported'),name:'Report',mimeType:'application/vnd.google-apps.'+type}]);
  const p=await t.buildPlan();assert.equal(p[0].name,'Report'+extension);assert.equal(p[0].kind,'download');t.setPlan(p);await t.sync();
  assert.equal(await(await local.map.get('Report'+extension).getFile()).text(),'exported');
  assert.equal((await t.buildPlan()).length,0);
  local.map.set('Report'+extension,file('local edits'));
  const changes=await t.buildPlan();assert.equal(changes.length,1);assert.equal(changes[0].kind,'conflict');
  t.setPlan(changes);await t.sync();assert.equal(uploads.length,0);
 });
}
test('cloud native edit refreshes unchanged export',async()=>{
 const local=directory();const {t,records}=setup(local,[{...remote('first'),name:'Report',mimeType:'application/vnd.google-apps.document'}]);
 t.setPlan(await t.buildPlan());await t.sync();records[0].modifiedTime='2026-03-01T00:00:00Z';records[0].content='second';
 const p=await t.buildPlan();assert.equal(p[0].kind,'download');t.setPlan(p);await t.sync();assert.equal(await(await local.map.get('Report.docx').getFile()).text(),'second');
});
test('shortcut creates safe URL with resource key without following target',async()=>{
 const local=directory();const {t,uploads}=setup(local,[{...remote(),name:'Shared',mimeType:'application/vnd.google-apps.shortcut',shortcutDetails:{targetId:'target_123',targetResourceKey:'key123',targetMimeType:'application/vnd.google-apps.folder'}}]);
 t.setPlan(await t.buildPlan());await t.sync();assert.equal(await(await local.map.get('Shared.url').getFile()).text(),'[InternetShortcut]\r\nURL=https://drive.google.com/open?id=target_123&resourcekey=key123\r\n');assert.equal(uploads.length,0);assert.equal((await t.buildPlan()).length,0);
});
test('native export filename collision blocks preview',async()=>{
 const {t}=setup(directory(),[{...remote(),name:'Report',mimeType:'application/vnd.google-apps.document'},{...remote(),id:'r2',name:'Report.docx'}]);await assert.rejects(()=>t.buildPlan(),/重複名稱/);
});
test('preexisting modified native export conflicts instead of uploading',async()=>{
 const local=directory({'Report.docx':file('local')});const {t}=setup(local,[{...remote('cloud'),name:'Report',mimeType:'application/vnd.google-apps.document'}]);assert.equal((await t.buildPlan())[0].kind,'conflict');
});
test('export failure preserves existing local file',async()=>{
 const local=directory();const {t,records}=setup(local,[{...remote('original'),name:'Report',mimeType:'application/vnd.google-apps.document'}]);t.setPlan(await t.buildPlan());await t.sync();records[0].exportError=true;records[0].modifiedTime='2026-03-01T00:00:00Z';t.setPlan(await t.buildPlan());await assert.rejects(()=>t.sync(),/10 MB/);assert.equal(await(await local.map.get('Report.docx').getFile()).text(),'original');
});
