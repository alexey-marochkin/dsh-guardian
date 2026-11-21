import test from 'node:test';
import assert from 'node:assert/strict';
import {foldHistory, toolTrigger, historyRows, registerHistory} from '../history.js';

const empty = {assistant:null, calls:[], notices:[]};
const assistant = {seq:12, time:1100, type:'assistant/message', data:{turn:2,step:3}};
const call = {seq:13, time:1200, type:'tool/call', data:{turn:2,step:3,callId:'root',name:'run_code',arguments:'private'}};
const notice = {seq:18, time:1800, type:'user/message', data:{source:{kind:'dsh-guardian',form:'notice'},content:[{type:'text',text:'Guardian: Stay in scope'}]}};

// Проверяет воспроизведение реального замечания и его переход к вызвавшему его сообщению.
test('Проекция восстанавливает замечания по источнику, но не по совпадению текста', () => {
  const state = [assistant, call, notice].reduce(foldHistory, empty);
  assert.deepEqual(state.notices,[{kind:'notice',reason:'Stay in scope',timestamp:1800,noticeSeq:18,seq:12,turn:2,step:3}]);
  for (const source of [{kind:'user'}, {kind:'other',form:'notice'}, {kind:'dsh-guardian',form:'prompt'}]) {
    assert.deepEqual(foldHistory(state, {...notice,data:{...notice.data,source}}).notices,state.notices);
  }
  const ended = foldHistory(state,{type:'turn/end',data:{turn:2}});
  assert.equal(foldHistory(ended,notice).notices.at(-1).seq,18);
});

// Сверяет независимые вызовы и вложенные инструменты с карточкой корневого вызова.
test('Каждое решение ссылается только на соответствующий открытый вызов', () => {
  const {calls} = [assistant,call,{...call,seq:14,data:{...call.data,callId:'second'}}].reduce(foldHistory,empty);
  const review = {kind:'deny',reason:'No authorization'};
  const nested = toolTrigger(calls,{callId:'inner',rootCallId:'root',name:'write'},review,1500);
  assert.deepEqual(nested,{...review,tool:'write',timestamp:1500,seq:13,turn:2,step:3,callId:'root'});
  assert.equal(toolTrigger(calls,{callId:'second',name:'read'},review,1500).seq,14);
  const closed = foldHistory({...empty,calls},{type:'tool/result',data:{message:{callId:'root'}}});
  assert.equal(toolTrigger(closed.calls,{callId:'root',name:'write'},review,1501).seq,null);
  assert.equal(JSON.stringify(nested).includes('private'),false);
});

// Проверяет сортировку после восстановления конфигурации и независимость пустого чата.
test('Замечания и сохранённые решения объединяются от новых к старым', () => {
  const notes = [assistant, notice].reduce(foldHistory,empty).notices;
  const previous = [{kind:'ask', reason:'Confirm', timestamp:1200, seq:13}, {kind:'deny', reason:'Denied', timestamp:2000, seq:32}];
  assert.deepEqual(historyRows(notes, JSON.parse(JSON.stringify(previous))).map(r=>r.kind),['deny','notice','ask']);
  assert.deepEqual(historyRows([],[]),[]);
});

// Мост DSH выбирает обработчик по pathname, но передаёт ему полный URL и не создаёт потоковое тело для buffered GET.
test('Регистрация истории совместима с GET через HTTP-мост DSH и сохраняет session в query', async () => {
  let route;
  const id = 'чат +/&=?';
  const ctx = {connection:{fetch:{register:r=>{route=r;}}},sessions:{get:key=>{assert.equal(key,id);return {id};}}};
  registerHistory(ctx,{stateOf:()=>empty},()=>[]);
  const url = new URL('api/dsh-guardian/history?'+new URLSearchParams({session:id}), 'http://dsh.internal/');
  assert.equal(route.path,url.pathname);
  assert.deepEqual(route.methods,['GET']);
  assert.equal(route.requestBody,'buffered','Потоковое тело несовместимо с GET');
  const response = await route.fetch(new Request(url,{method:'GET'}));
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),[]);
});

// Проверяет контракт маршрута, изоляцию чатов и восстановление истории без запуска агента.
test('GET истории возвращает только запрошенный чат и не маскирует ошибки пустым списком', async () => {
  let route;
  const records = {first:[assistant,notice],second:[]};
  const ctx = {connection:{fetch:{register:r => { route = r; }}},
    sessions:{get:id => Object.hasOwn(records,id) ? {id} : undefined},get:()=>undefined};
  registerHistory(ctx, {stateOf:session => records[session.id].reduce(foldHistory,empty)}, id => id === 'first' ? [{kind:'ask',reason:'Confirm',tool:'edit',timestamp:2200,seq:13}] : []);
  assert.deepEqual(route.methods,['GET']);
  const request = query => route.fetch(new Request('http://localhost'+route.path+query));
  const first = await request('?session=first');
  assert.equal(first.headers.get('cache-control'),'no-store');
  assert.deepEqual((await first.json()).map(({kind}) => kind),['ask','notice']);
  assert.deepEqual(await (await request('?session=second')).json(),[]);
  assert.equal((await request('?session=archived')).status,503);
  ctx.get = name => {
    assert.equal(name,'sessionQuery');
    return {inspectSession:async (id,read,signal) => {
      assert.ok(signal instanceof AbortSignal);
      if (id === 'archived') return read({id});
      throw Object.assign(new Error(),{code:'SESSION_QUERY_SESSION_NOT_FOUND'});
    }};
  };
  records.archived = [assistant,notice];
  ctx.sessions.get = () => undefined;
  assert.deepEqual((await (await request('?session=archived')).json()).map(row=>row.kind),['notice']);
  assert.equal((await request('?session=missing')).status,404);
  assert.equal((await request('')).status,400);
  assert.equal((await request('?session='+ 'x'.repeat(257))).status,400);
});
