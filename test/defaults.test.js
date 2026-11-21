import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {registerHooks} from 'node:module';

// Подменяет только неиспользуемую в этом сценарии сборку сообщений и описание схемы проекции.
// Сами обработчики Guardian, проверка ревизии и запись на диск остаются реальными.
async function loadHost() {
  const stub = {
    '@deepseek-ai/dsh-llm':'export function createUserMessage(){throw Error("unexpected review")}',
    zod:'const chain=new Proxy(()=>chain,{get:()=>chain});export const z=chain'
  };
  const hook = registerHooks({resolve(name,ctx,next){
    return Object.hasOwn(stub,name) ? {url:'data:text/javascript,'+encodeURIComponent(stub[name]),shortCircuit:true} : next(name,ctx);
  }});
  try {return (await import('../index.js')).apply;} finally {hook.deregister();}
}

// Подключает реальные HTTP-обработчики Guardian к тестовому контексту без активного чата.
async function mount() {
  const routes = new Map(), events = new Map();
  const apply = await loadHost();
  await apply({
    llm:{listProviders:()=>[{id:'p',name:'Provider'}], listModels:async id=>id==='p' ? [{id:'m',name:'Reviewer'}] : []},
    sessionProjections:{register: async()=>({})}, inject:()=>{},
    connection:{fetch:{register:r=>routes.set(r.path,r.fetch)}}, on:(event,fn)=>events.set(event,fn)
  });
  assert.ok(routes.has('/api/dsh-guardian/history'),'Маршрут истории должен регистрироваться и без sessionQuery');
  // Делает запрос с теми же заголовками и полями, что отправляет форма.
  async function request(path, value) {
    const url = new URL('/api/dsh-guardian/'+path,'http://localhost');
    return routes.get(url.pathname)(new Request(url,value===undefined ? {} : {
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)
    }));
  }
  return {request, create:id=>events.get('session/created')({id,header:{createdAt:Date.now()}})};
}

// Проверяет выбор модели, оба режима и сохранение настроек независимо от уже созданных чатов.
test('Настройки плагина задают модель и надзор только новым сессиям', async t => {
  const home = await mkdtemp(join(tmpdir(),'guardian-defaults-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async()=>{
    if(previous===undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    assert.equal(dirname(home),tmpdir());
    await rm(home,{recursive:true,force:true});
  });
  const app = await mount();
  const initial = await (await app.request('defaults')).json();
  assert.deepEqual([initial.model,initial.enabled,initial.revision],['',false,0]);
  const groups = await (await app.request('models')).json();
  const selected = await app.request('defaults',{...initial,provider:groups[0].id,model:groups[0].models[0].id});
  assert.equal(selected.status,200);
  const enabled = await app.request('defaults',{...await selected.json(),enabled:true});
  assert.equal(enabled.status,200);
  app.create('before');
  const disabled = await app.request('defaults',{...await enabled.json(),enabled:false});
  assert.equal(disabled.status,200);
  assert.equal((await app.request('defaults',{...initial,provider:'p',model:'m',enabled:false})).status,409);
  const reopened = await mount();
  const saved = await (await reopened.request('defaults')).json();
  assert.deepEqual([saved.provider,saved.model,saved.enabled],['p','m',false]);
  reopened.create('after');
  for(const [id,expected] of [['before',true],['after',false]]) {
    const chat = await (await reopened.request('settings?session='+id)).json();
    assert.deepEqual([chat.provider,chat.model,chat.enabled],['p','m',expected]);
  }
});
