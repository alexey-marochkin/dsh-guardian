// Сворачивает журнал сессии: хранит только замечания Guardian и якоря текущего шага.
export function foldHistory(state, {type, data, seq, time}) {
  if (type === 'turn/start' || type === 'turn/end' || (type === 'user/message' && data.source?.kind === 'user')) {
    return state.assistant || state.calls.length ? {...state, assistant:null, calls:[]} : state;
  }
  if (type === 'assistant/message') return {...state, assistant:{seq, turn:data.turn, step:data.step}, calls:[]};
  if (type === 'tool/call') return {...state, calls:[...state.calls, {seq, turn:data.turn, step:data.step, callId:data.callId}]};
  if (type === 'tool/result') {
    const calls = state.calls.filter(call => call.callId !== data.message.callId);
    return calls.length === state.calls.length ? state : {...state, calls};
  }
  if (type !== 'user/message' || data.source?.kind !== 'dsh-guardian' || data.source.form !== 'notice') return state;
  const reason = data.content.filter(block => block.type === 'text').map(block => block.text).join('\n').replace(/^Guardian: /, '');
  if (!reason) return state;
  const notice = {kind:'notice', reason, timestamp:time, noticeSeq:seq, ...(state.assistant ?? {seq})};
  return {...state, notices:[...state.notices, notice]};
}

// Привязывает решение к фактическому корневому вызову; автономный вызов не получает ложную ссылку.
export function toolTrigger(calls, exec, decision, timestamp) {
  const anchor = calls.find(call => call.callId === (exec.rootCallId ?? exec.callId));
  return {kind:decision.kind, reason:decision.reason, tool:exec.name, timestamp, ...(anchor ?? {seq:null})};
}

// Читает историю активного или архивного чата, не открывая его для записи.
export function registerHistory(ctx, history, toolsFor) {
  // HTTP-мост DSH создаёт GET без тела только в режиме buffered.
  ctx.connection.fetch.register({path:'/api/dsh-guardian/history', methods:['GET'], requestBody:'buffered', fetch:async request => {
    const id = new URL(request.url).searchParams.get('session');
    if (!id || id.length > 256) return new Response(null, {status:400});
    try {
      const live = ctx.sessions.get(id);
      let notices;
      if (live) notices = history.stateOf(live).notices;
      else {
        // Для выгруженной сессии нужна подготовка журнала; не выдаём частичную историю за полную.
        const query = ctx.get('sessionQuery');
        if (!query) return new Response(null, {status:503});
        notices = await query.inspectSession(id, session => history.stateOf(session).notices, request.signal);
      }
      return Response.json(historyRows(notices, toolsFor(id)), {headers:{'Cache-Control':'no-store'}});
    } catch (error) {
      if (error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return new Response(null, {status:404});
      throw error;
    }
  }});
}

// Объединяет замечания журнала и решения инструментов в обратном хронологическом порядке.
export function historyRows(notices, tools) {
  return [...tools, ...notices].reverse().sort((a,b) => b.timestamp - a.timestamp || (b.seq ?? -1) - (a.seq ?? -1));
}
