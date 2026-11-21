import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Вызывает регистрацию реального клиентского модуля. Время и интерфейс строки подставные:
// это тест выбора якоря и порядка действий, а не проверка внешнего вида в браузере.
function navigation(nodes, {delay=0, folded=false}={}) {
  const log=[], hidden=new Set(folded ? ['outer','inner'] : []);
  let now=0, frame=0, inject;
  const scope={sessions:{binding:()=>({session:{loadThrough:async seq=>log.push(`load:${seq}`)}})},
    modelDirectories:{directoryFor:()=>({})},uiConversation:{binding:()=>({target:()=>({getSnapshot:()=>({order:[...nodes.keys()],nodes})})})},
    slots:{inject:(_name,cb)=>cb(),register:options=>{inject=options.inject;}}};
  const sandbox={Event,CSS:{escape:value=>value},performance:{now:()=>now},requestAnimationFrame:cb=>{now+=16;frame++;cb(now);},
    window:{__ModuleLoader__:{load:module=>module.factory(()=>({})).apply({effect(){},inject:(deps,cb)=>{if(deps.includes('uiConversation')) cb(scope);}})}}};
  vm.runInNewContext(readFileSync(new URL('../client.js',import.meta.url),'utf8'),sandbox);
  const wrappers={};
  // В DSH раскрытие принадлежит владельцу beforematch, а не соседнему заголовку.
  for(const [name,parent] of [['outer',null],['inner','outer']]) {
    wrappers[name]={parentElement:wrappers[parent]??null, matches:selector=>selector.includes('hidden') && hidden.has(name),
      getAttribute:key=>key==='hidden' && hidden.has(name) ? 'until-found' : null,
      dispatchEvent:event=>{assert.equal(event.type,'beforematch');hidden.delete(name);log.push(name);}};
  }
  const viewport={closest:()=>null,querySelectorAll:selector=>{
    const key=[...nodes.keys()].find(key=>selector.includes('"'+key+'"'));
    if(!key || frame<delay)return [];
    return [{parentElement:wrappers.inner,closest:selector=>selector.includes('hidden') ? [...hidden].reverse().map(n=>wrappers[n])[0]??null : null,
      getAttribute:()=>null,matches:()=>false,getBoundingClientRect:()=>({height: hidden.size?0:22}),
      focus:()=>log.push('focus:'+key),scrollIntoView:()=>log.push('scroll:'+key)}];
  }};
  const locate=inject('test-session').locate;
  return {log,go:(entry,active=()=>true)=>locate({closest:()=>viewport,isConnected:true},entry,active)};
}

// При совпадающем seq чужой источник не заменяет собственное замечание Guardian.
test('Навигация предпочитает точное замечание Guardian сопутствующему ответу',async()=>{
  const nodes=new Map([['answer',{kind:'assistant-step',data:{finalNode:{seq:5}}}],
    ['other',{kind:'context',data:{seq:12,source:{kind:'other'}}}],['notice',{kind:'context',data:{seq:12,source:{kind:'dsh-guardian',form:'notice'}}}]]);
  const {go,log}=navigation(nodes);
  await go({kind:'notice',seq:5,noticeSeq:12});
  assert.deepEqual(log.slice(-2),['focus:notice','scroll:notice']);
});

// При отсутствии собственного узла замечания используется связанное видимое сообщение агента.
test('Навигация не выбирает чужой контекст с тем же номером события',async()=>{
  const nodes=new Map([['other',{kind:'context',data:{seq:12,source:{kind:'other'}}}],
    ['answer',{kind:'assistant-step',data:{finalNode:{seq:5}}}]]);
  const {go,log}=navigation(nodes);
  await go({kind:'notice',seq:5,noticeSeq:12});
  assert.deepEqual(log.slice(-2),['focus:answer','scroll:answer']);
});

// Проверяет позднее монтирование, две вложенные свёртки и точное совпадение callId.
test('Навигация дожидается карточки инструмента и раскрывает блоки снаружи внутрь',async()=>{
  const nodes=new Map([['other',{kind:'tool-call',data:{root:{callId:'wrong'}}}],['tool',{kind:'tool-call',data:{root:{callId:'exact'}}}]]);
  const {go,log}=navigation(nodes,{delay:30,folded:true});
  const target=await go({kind:'ask',seq:1030,callId:'exact'});
  assert.equal(target?.tabIndex,-1,'Найденная карточка передаётся для показа причины Guardian');
  assert.deepEqual(log,['load:1030','outer','inner','focus:tool','scroll:tool']);
});
