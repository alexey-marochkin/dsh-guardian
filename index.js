import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { z } from 'zod';
import { inspectAction, inspectCourse } from './review.js';
import { foldHistory, toolTrigger, registerHistory } from './history.js';

export const inject = ['llm', 'connection', 'sessions', 'sessionProjections'];

// Хранит настройки чатов отдельно от истории и атомарно сохраняет каждую редакцию.
export async function apply(ctx) {
  const seq = z.number().int().nonnegative();
  const anchor = z.object({seq, turn:seq, step:seq});
  const history = await ctx.sessionProjections.register({key:'dsh-guardian-history', stateVersion:1,
    stateSchema:z.object({assistant:anchor.nullable(), calls:z.array(anchor.extend({callId:z.string()})),
      notices:z.array(z.object({seq, noticeSeq:seq, turn:seq.optional(), step:seq.optional(), kind:z.literal('notice'), reason:z.string(), timestamp:seq}))}),
    init:() => ({assistant:null, calls:[], notices:[]}), apply:foldHistory});
  const directory = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-guardian');
  const states = new Map();
  const courses = new Map();
  const empty = Object.freeze({enabled: false, provider: '', model: '', revision: 0});

  // Имя файла не содержит пользовательского ввода.
  function filename(id) {
    return join(directory, createHash('sha256').update(id).digest('hex') + '.json');
  }

  // Только отсутствующая запись означает, что надзор изначально выключен.
  function state(id) {
    if (!states.has(id)) {
      try {
        const saved = JSON.parse(readFileSync(filename(id), 'utf8'));
        if (typeof saved.enabled !== 'boolean' || !Number.isSafeInteger(saved.revision) ||
            typeof saved.provider !== 'string' || typeof saved.model !== 'string') throw Error('Invalid Guardian configuration');
        states.set(id, saved);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        states.set(id, empty);
      }
    }
    return states.get(id);
  }

  // Атомарно сохраняет настройки и счётчики одной сессии.
  function persist(id, updated) {
    mkdirSync(directory, {recursive: true, mode: 0o700});
    const temporary = filename(id) + '.' + randomUUID();
    writeFileSync(temporary, JSON.stringify(updated), {mode: 0o600});
    renameSync(temporary, filename(id));
    states.set(id, updated);
  }

  // Возвращает интерфейсу статистику только выбранной пары провайдера и модели.
  function view(record) {
    const {byModel, toolHistory, ...config} = record;
    return {...config, usage: byModel?.[JSON.stringify([config.provider, config.model])] ?? null};
  }

  // Относит последний отчёт каждого запроса к модели, которая выполняла проверку.
  function recorder(id, route) {
    const key = JSON.stringify([route.provider, route.model]);
    return usage => {
      const {inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0} = usage;
      const total = usage.totalTokens ?? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
      if (![inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, total].every(n => Number.isSafeInteger(n) && n >= 0)) return;
      const current = state(id);
      const old = current.byModel?.[key];
      const entry = {input: (old?.input ?? 0) + inputTokens, output: (old?.output ?? 0) + outputTokens,
        cache: (old?.cache ?? 0) + cacheReadTokens + cacheWriteTokens, total: (old?.total ?? 0) + total};
      try { persist(id, {...current, byModel: {...current.byModel, [key]: entry}}); }
      catch { console.warn('[dsh-guardian] Не удалось сохранить статистику токенов'); }
    };
  }

  // Отменяет фоновую оценку, если изменились задача, модель или состояние чата.
  function cancelCourse(id) {
    courses.get(id)?.controller.abort();
    courses.delete(id);
  }

  // Ограничивает изменение настроек авторизованным интерфейсом DSH и проверяет версию записи.
  async function settings(request, defaults = false) {
    const id = defaults ? '' : new URL(request.url).searchParams.get('session');
    if ((!defaults && !id) || id.length > 256) return new Response(null, {status: 400});
    const previous = state(id);
    if (request.method === 'GET') return Response.json(view(previous), {headers: {'Cache-Control':'no-store'}});
    if (!request.headers.get('content-type')?.startsWith('application/json')) return new Response(null, {status: 415});
    const body = await request.json();
    if (typeof body.enabled !== 'boolean' || typeof body.provider !== 'string' || typeof body.model !== 'string' ||
        body.model.length > 512 || body.provider.length > 512) return new Response(null, {status: 400});
    if (body.enabled || body.provider !== previous.provider || body.model !== previous.model) {
      const models = await ctx.llm.listModels(body.provider);
      if (!models.some(m => m.id === body.model)) return new Response(null, {status: 422});
    }
    if (state(id).revision !== body.revision) return new Response(null, {status: 409});
    const updated = {...state(id), enabled: body.enabled, provider: body.provider, model: body.model, revision: body.revision + 1, ...(defaults ? {since: Date.now()} : {})};
    persist(id, updated);
    cancelCourse(id);
    return Response.json(view(updated));
  }

  registerHistory(ctx, history, id => state(id).toolHistory ?? []);
  ctx.connection.fetch.register({path: '/api/dsh-guardian/settings', methods: ['GET','POST'], requestBody: 'buffered', fetch: request => settings(request)});
  ctx.connection.fetch.register({path: '/api/dsh-guardian/defaults', methods: ['GET','POST'], requestBody: 'buffered',
    fetch: request => settings(request, true)});
  ctx.connection.fetch.register({path: '/api/dsh-guardian/models', methods: ['GET'], requestBody:'buffered', fetch: async () => {
    const groups = await Promise.all(ctx.llm.listProviders().map(async provider => {
      try {
        const models = await ctx.llm.listModels(provider.id);
        return {...provider, models: models.map(({id, name}) => ({id, name}))};
      } catch { return {...provider, models: []}; }
    }));
    return Response.json(groups, {headers: {'Cache-Control':'no-store'}});
  }});
  // Фиксируем настройки при создании чата, сохраняя выбор ранее открытых сессий.
  ctx.on('session/created', session => {
    const defaults = state('');
    if (!defaults.model || session.header?.createdAt < defaults.since || state(session.id) !== empty) return;
    persist(session.id, {enabled: defaults.enabled, provider: defaults.provider, model: defaults.model, revision: 0});
  });
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end' || event.type === 'turn/start' ||
        (event.type === 'user/message' && event.data.source?.kind === 'user')) cancelCourse(session.id);
    if (event.type !== 'assistant/message') return;
    const route = state(session.id);
    if (!route.enabled) return;
    cancelCourse(session.id);
    const controller = new AbortController();
    const result = inspectCourse(ctx.llm, route, session, controller.signal, recorder(session.id, route)).catch(() => '');
    courses.set(session.id, {controller, result});
  });
  ctx.on('agent/pre-step', async ({agent, signal}, next) => {
    const decision = await next();
    const id = agent.session.id;
    const pending = courses.get(id);
    if (!pending || decision.kind !== 'enter') return decision;
    const reason = await pending.result;
    if (signal.aborted || courses.get(id) !== pending) return decision;
    courses.delete(id);
    if (!reason) return decision;
    const notice = createUserMessage({source: {kind:'dsh-guardian', form:'notice', summary:'Guardian'},
      content: [{type:'text', text:'Guardian: ' + reason}]});
    return {...decision, messages: [...decision.messages, notice]};
  }, {prepend: true});
  ctx.on('tools/pre-execute', async (exec, next) => {
    const prior = await next();
    const id = exec.agent?.session?.id;
    if (!id || prior.kind === 'deny') return prior;
    const route = state(id);
    if (!route.enabled) return prior;
    const review = await inspectAction(ctx.llm, route, exec, recorder(id, route));
    const decision = exec.signal?.aborted || route.revision !== state(id).revision
      ? {kind:'deny', reason:'Проверка Guardian прервана.'} : review;
    if (decision.kind !== 'deny' && (prior.kind === 'ask' || decision.kind === 'allow')) return prior;
    try {
      const current = state(id);
      const entry = toolTrigger(history.stateOf(exec.agent.session).calls, exec, decision, Date.now());
      persist(id, {...current, toolHistory:[...(current.toolHistory ?? []), entry]});
    } catch { console.warn('[dsh-guardian] Не удалось сохранить срабатывание'); }
    return decision;
  }, {prepend: true});
  ctx.on('session/disposed', session => { cancelCourse(session.id); states.delete(session.id); });
  ctx.on('dispose', () => { for (const id of courses.keys()) cancelCourse(id); });
}
