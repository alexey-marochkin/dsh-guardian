window.__ModuleLoader__.load({id: 'dsh-guardian', factory: require => {
  const React = require('react');
  const h = React.createElement;
  const {createPortal} = require('react-dom');
  const {Tooltip} = require('@deepseek-ai/dsh-client-ui-primitives');

  // Оставляет управление списком браузеру и показывает стрелку в обеих темах DSH.
  function ModelSelect({children, ...props}) {
    return h('span', {className:'guardian-model-field'},
      h('select', props, children),
      h('svg', {viewBox:'0 0 16 16', width:16, height:16, 'aria-hidden':true},
        h('path', {d:'m4 6 4 4 4-4', fill:'none', stroke:'currentColor', strokeWidth:1.6,
          strokeLinecap:'round', strokeLinejoin:'round'})));
  }

  // Раскрывает пояснение о передаче данных по кнопке рядом с названием модели.
  function ModelHeader({title, label, close}) {
    const [expanded, setExpanded] = React.useState(false);
    const noteId = React.useId();
    const trigger = React.useRef(null);
    const dismiss = React.useRef(null);
    React.useLayoutEffect(()=>{if(expanded) dismiss.current?.focus({preventScroll:true});},[expanded]);
    // При закрытии подсказки возвращает фокус на кнопку, не закрывая окно Guardian.
    function hideNote() { setExpanded(false); trigger.current?.focus({preventScroll:true}); }
    const info = label('Какие данные получает провайдер?', 'What data does the provider receive?');
    return h('header',null,h('strong',null,title),
      h('button',{type:'button',ref:trigger,className:'guardian-info','aria-haspopup':'dialog','aria-label':info,'aria-expanded':expanded,
        'aria-controls':noteId,onClick:()=>setExpanded(value=>!value)},
        h('svg',{viewBox:'0 0 20 20',width:17,height:17,fill:'none','aria-hidden':true},
          h('circle',{cx:10,cy:10,r:8,stroke:'currentColor',strokeWidth:1.4}),
          h('circle',{cx:10,cy:6.5,r:1,fill:'currentColor'}),
          h('path',{d:'M10 9.5v4',stroke:'currentColor',strokeWidth:1.6,strokeLinecap:'round'}))),
      h('button',{type:'button','aria-label':label('Закрыть','Close'),onClick:close},'×'),
      expanded && h('div',{id:noteId,role:'dialog',className:'guardian-info-popup',
        onBlur:e=>{if(e.relatedTarget!==trigger.current && !e.currentTarget.contains(e.relatedTarget)) setExpanded(false);},'aria-label':info,'aria-describedby':noteId+'-text'},
        h('button',{type:'button',ref:dismiss,'aria-label':label('Закрыть подсказку','Close information'),onClick:hideNote},'×'),
        h('span',{id:noteId+'-text'},label('Провайдер выбранной модели получит путь к рабочей папке, недавние сообщения, результаты инструментов и аргументы действий этого чата.', 'The selected provider will receive the working directory path, recent messages, tool results, and action arguments from this chat.'))));
  }

  // Догружает историю через Session Controller и ищет точный узел в ленте этого экземпляра чата.
  async function locateEntry(scope, sessionId, anchor, entry, active) {
    const viewport = anchor?.closest('[data-conversation-scroll]');
    const binding = scope.sessions.binding(sessionId);
    if (!viewport || !binding || !Number.isSafeInteger(entry.seq)) throw Error();
    // В основном окне Chat — первая закреплённая вкладка; у встроенного чата своей шапки нет.
    const content = viewport.closest('[data-conversation-content]');
    const tab = content?.parentElement?.matches('[data-phase]') && content.parentElement.querySelector('[data-conversation-tabs] [role="tab"]');
    if (tab && tab.getAttribute('aria-selected') === 'false') tab.click();
    const noticeSeq = entry.kind === 'notice' && Number.isSafeInteger(entry.noticeSeq) ? entry.noticeSeq : entry.seq;
    await binding.session.loadThrough(Math.min(entry.seq,noticeSeq));
    const source = scope.uiConversation.binding(binding).target('chat');
    const deadline = performance.now() + 5000;
    const clicked = new WeakSet();
    let key;
    // Chat держит живой индекс nodes; публикация группы и появление её DOM могут запоздать независимо.
    while (active() && anchor.isConnected && performance.now() < deadline) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      if (!active() || !anchor.isConnected) break;
      if (!key) {
        const chat = source.getSnapshot();
        if (!chat) continue;
        let answer;
        for (const id of chat.order) {
          const node = chat.nodes.get(id);
          if (!node || node.visibility === 'hidden') continue;
          if (entry.callId ? node.data.root?.callId === entry.callId : node.data.source?.kind === 'dsh-guardian' && node.data.seq === noticeSeq) { key=id; break; }
          if (!entry.callId && node.data.finalNode?.seq === entry.seq) answer=id;
        }
        // В старых сессиях замечание может не иметь собственной визуальной строки.
        key ??= answer;
      }
      if (!key) continue;
      const rows = [...viewport.querySelectorAll('[data-chat-node-key="'+CSS.escape(key)+'"]')];
      // Один ответ бывает разделён на reasoning и response с одним ключом. Сначала показываем сам ответ.
      rows.sort((a,b)=>Number(a.getAttribute('data-chat-group-part') === 'reasoning')-Number(b.getAttribute('data-chat-group-part') === 'reasoning'));
      for (const row of rows) {
        let outer;
        for (let el=row; el && el!==viewport; el=el.parentElement) {
          if (el.getAttribute('hidden') === 'until-found') outer=el;
        }
        // beforematch обрабатывает владелец каждого уровня. Не переключаем DOM-атрибуты в обход состояния React.
        if (outer) { outer.dispatchEvent(new Event('beforematch')); break; }
        if (row.closest('[data-chat-motion="collapse"],[data-chat-motion="reveal"]') || row.getBoundingClientRect().height <= 1) continue;
        // Открываем только штатное раскрытие точной карточки, никогда не команды, ссылки или подтверждения.
        const kind = row.getAttribute('data-chat-flow-kind');
        const selector = kind === 'tool-call' ? '[data-tool] [aria-expanded]' : kind === 'context' ? '[aria-expanded]' : null;
        const disclosure = selector && row.querySelector(selector);
        if (disclosure && disclosure.getAttribute('aria-expanded') === 'false' && !disclosure.disabled) {
          if (!clicked.has(disclosure)) {clicked.add(disclosure);disclosure.click();}
          break;
        }
        row.tabIndex = -1;
        row.focus({preventScroll:true});
        row.scrollIntoView({block:'center',behavior:'instant'});
        return row;
      }
    }
    throw Error();
  }

  // Загружает только вмешательства текущего чата, пока открыта панель Guardian.
  function History({sessionId, label, ru, jump, close}) {
    const [entries, setEntries] = React.useState(null);
    const [failure, setFailure] = React.useState('');
    const dialog = React.useRef(null);
    const [pending, setPending] = React.useState(false);
    const [jumpError, setJumpError] = React.useState(false);
    const alive = React.useRef(false);
    const listId = React.useId();
    React.useEffect(() => {
      alive.current = true;
      const abort = new AbortController();
      let timer;
      // Обновляет число и список одним снимком; запросы не обгоняют друг друга.
      async function refresh() {
        try {
          const fetcher = globalThis.__DSH_TRANSPORT__?.fetch ?? globalThis.fetch.bind(globalThis);
          const query = new URLSearchParams({session:sessionId});
          const response = await fetcher('api/dsh-guardian/history?'+query, {method:'GET'});
          if (!response.ok) throw Error('HTTP '+response.status);
          const rows = await response.json();
          if (!Array.isArray(rows)) throw Error(label('Ожидался список событий','Expected a list of events'));
          if (!abort.signal.aborted) { setEntries(rows); setFailure(''); }
        } catch (err) { if (!abort.signal.aborted) setFailure(err.message || String(err)); }
        if (!abort.signal.aborted) timer = setTimeout(refresh, 5000);
      }
      refresh();
      return () => { alive.current = false; abort.abort(); clearTimeout(timer); };
    }, [sessionId]);
    // Закрывает панель только после перехода к строке текущего чата.
    async function navigate(entry) {
      setPending(true); setJumpError(false);
      dialog.current.close(); // Снимает модальность до передачи фокуса сообщению чата.
      try { await jump(entry, () => alive.current); if (alive.current) close(); }
      catch { if (alive.current) {setJumpError(true); if (!dialog.current.open) dialog.current.showModal();} }
      finally { if (alive.current) setPending(false); }
    }
    const count = entries?.length ?? (failure ? '—' : '…');
    const kinds = {ask:label('Запрос подтверждения','Approval requested'), deny:label('Блокировка','Blocked'), notice:label('Предупреждение','Warning')};
    return h('div',{className:'guardian-history'},
      h('div',{className:'guardian-count-row'},label('Срабатывания в этом чате','Interventions in this chat'),
        h('button',{type:'button',className:'guardian-history-count',disabled:entries===null || pending,'aria-haspopup':'dialog','aria-controls':listId,
          'aria-label':label('Открыть историю срабатываний: ','Open intervention history: ')+count,
          onClick:()=>{setJumpError(false);dialog.current.showModal();}},count)),
      failure && h('small',{role:'status'},label('Не удалось обновить историю: ','Could not refresh history: ')+failure),
      pending && h('small',{role:'status'},label('Переход к сообщению…','Opening message…')),
      h('dialog',{id:listId,ref:dialog,className:'guardian-history-window','aria-labelledby':listId+'-title'},
        h('header',null,h('strong',{id:listId+'-title'},label('История срабатываний','Intervention history')),
          h('button',{type:'button','aria-label':label('Закрыть историю','Close history'),onClick:()=>dialog.current.close()},'×')),
        (entries?.length ? h('ol',null,entries.map((row,i)=>h('li',{key:row.seq+':'+(row.callId ?? i)},
        h('button',{type:'button','aria-disabled':pending || !Number.isSafeInteger(row.seq),onClick:()=>!pending && Number.isSafeInteger(row.seq) && navigate(row)},h('strong',null,kinds[row.kind],row.tool && ' · '+row.tool),
          h('small',null,new Date(row.timestamp).toLocaleString(ru?'ru-RU':'en-US')),h('span',null,row.reason),
          h('small',null,Number.isSafeInteger(row.seq) ? label('К сообщению →','Go to message →') : label('Нет сообщения в чате','No chat message')))))) :
        h('p',null,label('Срабатываний пока нет.','No interventions yet.'))),
        jumpError && h('small',{role:'alert'},label('Не удалось показать событие. Откройте вкладку чата и повторите.','Could not show the event. Open the Chat tab and try again.'))));
  }

  // Рисует один и тот же контурный щит с буквой G для панели и маркера.
  function guardianShield(props) {
    return h('svg',{viewBox:'0 0 24 24',width:22,height:22,fill:'none',...props},
      h('path',{d:'M12 2.5 20 6v6c0 4-3.2 7.7-8 10-4.8-2.3-8-6-8-10V6z',stroke:'currentColor',strokeWidth:1.7}),
      h('path',{d:'M15 9a4 4 0 1 0 .3 5.4V12H12',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round'}));
  }

  // Ставит щит у начала выбранного события; причину не дублирует в чате.
  function InterventionMarker({entry,label}) {
    const target = React.useRef(null);
    React.useLayoutEffect(()=>{
      target.current.focus({preventScroll:true});
      target.current.scrollIntoView({block:'center',behavior:'instant'});
    },[entry]);
    const kind = entry.kind==='ask' ? label('Запрос подтверждения','Approval requested') : entry.kind==='deny' ? label('Блокировка','Blocked') : label('Замечание','Notice');
    return guardianShield({ref:target,tabIndex:-1,className:'guardian-event-marker',role:'img','aria-label':'Guardian · '+kind});
  }

  // Показывает выбор модели и состояние надзора только для открытого чата.
  function Controls({sessionId, directory, locate}) {
    const ru = (document.documentElement.lang || navigator.language).startsWith('ru');
    const label = (r, e) => ru ? r : e;
    const [state, setState] = React.useState(null);
    const [open, setOpen] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const [highlight,setHighlight] = React.useState(null);
    const shield = React.useRef(null);
    const panel = React.useRef(null);
    const catalog = React.useSyncExternalStore(cb => directory.store.subscribe(cb), () => directory.store.getSnapshot());
    const url = 'api/dsh-guardian/settings?session=' + encodeURIComponent(sessionId);
    const transport = globalThis.__DSH_TRANSPORT__?.fetch ?? globalThis.fetch.bind(globalThis);
    const failed = label('Не удалось обновить Guardian', 'Could not update Guardian');

    React.useEffect(() => {
      if (busy) return;
      const abort = new AbortController();
      const refresh = () => transport(url).then(async response => {
        if (!response.ok) throw Error();
        const value = await response.json();
        if (!abort.signal.aborted) setState(value);
      }).catch(() => { if (!abort.signal.aborted) setError(failed); });
      refresh();
      const timer = open ? setInterval(refresh, 5000) : null;
      return () => { abort.abort(); clearInterval(timer); };
    }, [url, open, busy]);
    React.useLayoutEffect(() => {
      if (!open) return;
      const node = panel.current;
      const place = () => {
        const anchor = shield.current.getBoundingClientRect();
        const above = anchor.top - 20, below = innerHeight - anchor.bottom - 20;
        const up = above >= 300 || above >= below;
        Object.assign(node.style, {left: Math.max(12, Math.min(anchor.left, innerWidth - node.offsetWidth - 12)) + 'px',
          top: up ? 'auto' : anchor.bottom + 8 + 'px', bottom: up ? innerHeight - anchor.top + 8 + 'px' : 'auto',
          maxHeight: Math.min(innerHeight * .7, Math.max(80, up ? above : below)) + 'px'});
      };
      const dismiss = event => {
        if (!node.contains(event.target) && !shield.current.closest('.devos-guardian').contains(event.target)) setOpen(null);
      };
      const escape = event => {
        if (event.key !== 'Escape' || node.querySelector('.guardian-history-window[open]')) return;
        const noteClose = node.querySelector('.guardian-info-popup button');
        if (noteClose) { event.preventDefault(); event.stopPropagation(); noteClose.click(); return; }
        setOpen(null); shield.current?.focus();
      };
      document.addEventListener('pointerdown', dismiss, true);
      document.addEventListener('keydown', escape, true);
      place();
      node.querySelector('select')?.focus();
      window.addEventListener('resize', place);
      document.addEventListener('scroll', place, true);
      directory.load().catch(() => setError(label('Каталог моделей недоступен', 'Model catalog unavailable')));
      return () => { document.removeEventListener('pointerdown', dismiss, true); document.removeEventListener('keydown', escape, true); window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true); };
    }, [open, directory]);

    // Синхронизирует индикатор с подтверждённой конфигурацией хоста.
    async function save(change) {
      setBusy(true);
      setError('');
      try {
        const response = await transport(url, {method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({enabled:state.enabled, provider:state.provider, model:state.model, revision:state.revision, ...change})});
        if (!response.ok) {
          const fresh = await transport(url);
          if (fresh.ok) setState(await fresh.json());
          throw Error();
        }
        setState(await response.json());
        if (open === 'enable') setOpen(null);
      } catch { setError(failed); }
      finally { setBusy(false); }
    }
    const enabled = state?.enabled === true;
    const title = label('Модель надзора Guardian', 'Guardian reviewer model');
    const status = state ? (enabled ? label('Включён','On') : label('Выключен','Off')) : '…';
    const selected = state?.model ? JSON.stringify([state.provider,state.model]) : '';
    return h('span', {className:'devos-guardian'},
      h(Tooltip,{label:title,side:'top',delayMs:200,portal:true,disabled:!!open},
        h('button', {type:'button', ref:shield, className:'guardian-shield', 'aria-label':title, 'aria-haspopup':'dialog', 'aria-expanded':!!open, onClick:()=>setOpen(open ? null : 'model')},
          guardianShield({'aria-hidden':true}))),
      h(Tooltip,{label:'Guardian · '+status,side:'top',delayMs:200,portal:true,disabled:!!open},
        h('button',{type:'button',role:'switch','aria-checked':enabled,'aria-label':label('Надзор Guardian','Guardian supervision'),
          className:'guardian-switch', disabled:busy || !state,
          onClick:()=>state.model ? save({enabled:!enabled}) : setOpen('enable')},
          h('svg',{'aria-hidden':true,width:30,height:18,viewBox:'0 0 30 18'},
            h('rect',{width:30,height:18,rx:9,fill:enabled?'#19794e':'#b54047'}),
            h('circle',{cx:enabled?21:9,cy:9,r:6,fill:'white'})))),
      highlight && createPortal(h(InterventionMarker,{entry:highlight.entry,label}),highlight.row),
      error && !open && h('small',{role:'alert'},error),
      open && createPortal(h('section',{ref:panel,role:'dialog',className:'guardian-panel','aria-label':title},
        h(ModelHeader,{title,label,close:()=>{setOpen(null);shield.current?.focus();}}),
        h(ModelSelect,{'aria-label':title,value:selected,disabled:busy || !state,onChange:e=>{
          const [provider,model]=JSON.parse(e.target.value);
          save(open === 'enable' ? {provider,model,enabled:true} : {provider,model});
        }},h('option',{value:'',disabled:true},label('Выберите модель','Select a model')),
          ...catalog.groups.map(group=>h('optgroup',{key:group.id,label:group.name ?? group.id},
            group.models.map(model=>h('option',{key:model.id,value:JSON.stringify([group.id,model.id])},model.name ?? model.id))))),
        h('div',{className:'guardian-stat'},h('strong',null,label('Токены надзора','Supervision tokens')),
          h('small',null,label('Выбранная модель · текущий чат','Selected model · this chat')),
          state?.usage ? h('dl',null,...[
            [label('Входные','Input'),state.usage.input,'#4d91f7'], [label('Выходные','Output'),state.usage.output,'#a98afa'],
            ...(state.usage.cache ? [[label('Кэш','Cache'),state.usage.cache,'#52bfa6']] : []),
            [label('Всего','Total'),state.usage.total,'#acb2ba']
          ].map(([key,value,color])=>h('div',{key},h('dt',{style:{'--guardian-marker':color}},key),h('dd',null,value.toLocaleString(ru?'ru-RU':'en-US'))))) :
            h('p',null,label('Данных об использовании пока нет.','No usage reported yet.'))),
        h(History,{sessionId,label,ru,jump:async(entry,active)=>{const row=await locate(shield.current,entry,active);if(active()) setHighlight({row,entry});},close:()=>setOpen(null)}),
        error && h('small',{role:'alert'},error)), document.body));
  }

  // Меняет начальную модель и режим надзора только для новых чатов.
  function Defaults({remote}) {
    const ru = (document.documentElement.lang || navigator.language).startsWith('ru');
    const label = (r,e) => ru ? r : e;
    const [saved,setSaved] = React.useState(null);
    const [draft,setDraft] = React.useState(null);
    const [groups,setGroups] = React.useState(null);
    const [catalogError,setCatalogError] = React.useState('');
    const [attempt,retry] = React.useReducer(n=>n+1,0);
    const [busy,setBusy] = React.useState(false);
    const [error,setError] = React.useState('');
    const fetcher = globalThis.__DSH_TRANSPORT__?.fetch ?? globalThis.fetch.bind(globalThis);
    const url = 'api/dsh-guardian/defaults';
    React.useEffect(() => {
      let active = true;
      // Сбой каталога не мешает прочитать настройки или выключить ранее включённый надзор.
      async function load(path, accept, failed) {
        try {
          const response = await fetcher(path,{method:'GET'});
          if (!response.ok) throw Error();
          const value = await response.json();
          if (active) accept(value);
        } catch { if (active) failed(); }
      }
      if (!saved) load(url,value=>{setSaved(value);setDraft(value);},()=>setError(label('Не удалось загрузить настройки.','Could not load settings.')));
      // Читаем тот же каталог DSH, что и выбор модели в чате, без привязки к сессии.
      async function loadCatalog() {
        try {
          const response = await remote.session.modelCatalog();
          if (!response.ok) throw Error(response.error.code + ': ' + response.error.message);
          if (!active) return;
          setGroups(response.value.groups.filter(group=>group.models.length));
          setCatalogError(response.value.failures.map(f=>(f.name || f.id)+': '+f.message).join('; '));
        } catch (err) {
          if (active) {setGroups([]);setCatalogError(err.message || String(err));}
        }
      }
      loadCatalog();
      return () => {active=false;};
    },[attempt]);
    // Сохраняет оба поля одной редакцией; при конфликте показывает актуальный выбор.
    async function save() {
      setBusy(true);setError('');
      try {
        const {enabled,provider,model} = draft;
        const res = await fetcher(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled,provider,model,revision:saved.revision})});
        if(res.status===409){
          const fresh=await fetcher(url,{method:'GET'});if(!fresh.ok) throw Error();
          const value=await fresh.json();setSaved(value);setDraft(value);
          setError(label('Настройки изменились. Проверьте текущий выбор.','Settings changed. Review the current selection.'));return;
        }
        if(!res.ok) throw Error();
        const value=await res.json();setSaved(value);setDraft(value);
      } catch {setError(label('Не удалось сохранить настройки. Повторите попытку.','Could not save settings. Please try again.'));}
      finally {setBusy(false);}
    }
    const selected = draft?.model ? JSON.stringify([draft.provider,draft.model]) : '';
    const dirty = draft && (draft.model!==saved.model || draft.provider!==saved.provider || draft.enabled!==saved.enabled);
    return h('section',{className:'guardian-defaults'},h('h3',null,'Guardian'),
      h('label',null,label('Модель надзора по умолчанию','Default reviewer model'),
        h(ModelSelect,{value:selected,disabled:busy || !draft || !groups?.length,onChange:e=>{
          const [provider,model]=JSON.parse(e.target.value);setDraft({...draft,provider,model});
        }},h('option',{value:'',disabled:true},label('Выберите модель','Select a model')),
        selected && !groups?.some(g=>g.id===draft.provider && g.models.some(m=>m.id===draft.model)) && h('option',{value:selected,disabled:true},draft.model),
        ...(groups ?? []).map(g=>h('optgroup',{key:g.id,label:g.name ?? g.id},g.models.map(m=>
          h('option',{key:m.id,value:JSON.stringify([g.id,m.id])},m.name ?? m.id)))))),
      h('label',null,h('input',{type:'checkbox',role:'switch',checked:draft?.enabled ?? false,disabled:busy || !draft,
        onChange:e=>setDraft({...draft,enabled:e.target.checked})}), ' ',label('Включать надзор в новых чатах','Enable supervision in new chats')),
      draft?.enabled && !selected && h('small',null,label('Для включения надзора выберите модель.','Choose a model to enable supervision.')),
      groups?.length===0 && h('small',{role:'status'},catalogError ? label('Ошибка каталога DSH: ','DSH catalog error: ')+catalogError : label('Каталог DSH не содержит доступных моделей.','The DSH catalog has no available models.')),
      error && h('small',{role:'alert'},error),
      ((!saved && error) || groups?.length===0) && h('button',{type:'button',disabled:busy,onClick:()=>{setError('');setGroups(null);retry();}},label('Обновить','Reload')),
      h('button',{type:'button',disabled:busy || !dirty || (draft.enabled && !selected),onClick:save},busy ? label('Сохранение…','Saving…') : label('Сохранить','Save')));
  }

  // Встраивает щит и переключатель в штатную панель под редактором сообщения.
  function apply(ctx) {
    ctx.effect(() => {
      const style = document.createElement('style');
      style.textContent = `.devos-guardian{display:inline-flex;align-items:center;gap:4px;color:inherit}.devos-guardian button{font:inherit;color:inherit;cursor:pointer}.devos-guardian .guardian-shield,.guardian-panel header button{background:none;border:0;padding:2px;display:grid;place-items:center}.devos-guardian{flex-shrink:0}.devos-guardian .guardian-switch{appearance:none;box-sizing:border-box;flex:none;min-width:30px;height:24px;border:0;background:transparent;padding:0;display:grid;place-items:center}.devos-guardian .guardian-switch svg{display:block;width:30px;height:18px;max-width:none;pointer-events:none}@media(pointer:coarse){.devos-guardian .guardian-switch{min-width:36px;min-height:36px}}.devos-guardian button:disabled{opacity:.55}.guardian-panel header button{color:inherit;cursor:pointer}.guardian-panel{position:fixed;z-index:10000;inset:auto;margin:0;box-sizing:border-box;width:340px;max-width:calc(100vw - 24px);overflow:auto;padding:18px;border:1px solid var(--dsw-alias-border-l3,#555);border-radius:14px;background:var(--dsw-specific-menu,#29292c);color:var(--dsw-alias-label-primary,#eee);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-prominent);font:13px/1.5 system-ui}.guardian-panel header,.guardian-stat dl div{display:flex;align-items:center;justify-content:space-between;gap:12px}.guardian-panel header strong{font-size:16px}.guardian-panel p{margin:10px 0}.guardian-model-field{display:block;position:relative}.guardian-defaults .guardian-model-field{margin-top:6px}.guardian-model-field select{display:block;appearance:none;width:100%;min-height:36px;box-sizing:border-box;padding:6px 36px 6px 10px;border:1px solid var(--dsw-alias-border-l3,#666);border-radius:6px;background:var(--dsw-specific-menu,Canvas);color:inherit;font:inherit;text-align:start;text-overflow:ellipsis;cursor:pointer}.guardian-model-field select:disabled{opacity:.55;cursor:default}.guardian-model-field svg{position:absolute;right:10px;top:50%;transform:translateY(-50%);pointer-events:none;color:inherit}.guardian-model-field select:focus-visible{outline:2px solid var(--dsw-alias-label-link,#a99aff);outline-offset:2px}.guardian-panel :focus-visible{outline:2px solid var(--dsw-alias-label-link,#a99aff);outline-offset:2px}.guardian-stat{border-top:1px solid var(--dsw-alias-border-l3,#555);margin-top:14px;padding-top:12px}.guardian-stat small{display:block;opacity:.75}.guardian-stat dl{margin:8px 0 0}.guardian-stat dt{display:flex;align-items:center;gap:8px}.guardian-stat dt::before{content:'';width:10px;height:10px;flex:none;border-radius:2px;background:var(--guardian-marker)}.guardian-stat dd{margin:0;font-variant-numeric:tabular-nums}.guardian-stat dl div:last-child{font-weight:600}.guardian-defaults{max-width:480px;display:grid;gap:14px}.guardian-defaults label{display:block}`;
      style.textContent += `.guardian-panel header{gap:6px;margin-bottom:10px}.guardian-panel header .guardian-info{width:26px;height:26px;border-radius:50%;margin-inline-end:auto;color:var(--dsw-alias-label-secondary,inherit)}.guardian-panel header .guardian-info:hover,.guardian-panel header .guardian-info[aria-expanded=true]{color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-interactive-hovered,transparent)}`;
      style.textContent += `.guardian-history{border-top:1px solid var(--dsw-alias-border-l3);margin-top:12px;padding-top:10px}.guardian-history button{font:inherit;color:inherit;cursor:pointer}.guardian-history-count{border:0;background:transparent;text-decoration:underline;padding:3px 8px}.guardian-history ol{list-style:none;padding:0;margin:6px 0 0}.guardian-history li button{width:100%;text-align:start;background:transparent;border:0;border-bottom:1px solid var(--dsw-alias-border-l3);padding:8px 0;overflow-wrap:anywhere}.guardian-history li button:hover,.guardian-history li button:focus-visible{text-decoration:underline}.guardian-history small,.guardian-history li span{display:block}.guardian-history button:disabled{cursor:default}`;
      style.textContent += `.guardian-panel header{position:relative}.guardian-info-popup{position:absolute;z-index:2;top:calc(100% + 4px);inset-inline:0;box-sizing:border-box;padding:12px 36px 12px 12px;border:1px solid var(--dsw-alias-border-l3);border-radius:9px;background:Canvas;background:rgb(from var(--dsw-specific-menu,Canvas) r g b / 1);box-shadow:var(--dsw-elevation-prominent)}.guardian-panel header .guardian-info-popup button{position:absolute;right:4px;top:4px;width:26px;height:26px;font-size:18px}`;
      style.textContent += `.guardian-count-row{display:flex;align-items:center;justify-content:space-between}.guardian-history-count{font-weight:700!important}.guardian-history-window{position:fixed;inset:0;margin:auto;width: min(440px,calc(100vw - 32px));max-height:75vh;overflow:auto;box-sizing:border-box;padding:16px;border:1px solid var(--dsw-alias-border-l3);border-radius:12px;background:Canvas;background:rgb(from var(--dsw-specific-menu,Canvas) r g b / 1);color:inherit;font:inherit;box-shadow:var(--dsw-elevation-prominent)}.guardian-history-window::backdrop{background:rgb(0 0 0 / .4)}`;
      style.textContent += `[data-chat-node-key]:has(> .guardian-event-marker){position:relative;box-sizing:border-box;border-inline-start:4px solid var(--dsw-alias-label-link,Highlight);padding-inline-start:30px;min-height:26px}.guardian-event-marker{position:absolute;inset-inline-start:4px;top:2px;color:var(--dsw-alias-label-primary,CanvasText);scroll-margin-block:32px;outline:none}`;
      document.head.appendChild(style);
      return () => style.remove();
    });
    ctx.inject(['remote','remote.session'], scope=>scope.slots.inject('plugins.bundle.config',()=>scope.slots.register({name:'plugins.bundle.config',id:'dsh-guardian',key:'dsh-guardian'},()=>h(Defaults,{remote:scope.remote}))));
    ctx.inject(['modelDirectories','sessions','uiConversation'], scope => scope.slots.inject('conversation.composer.dock', () => scope.slots.register({
      name:'conversation.composer.dock', id:'dsh-guardian', order:3,
      inject:sessionId=>({sessionId,directory:scope.modelDirectories.directoryFor(sessionId),
        locate:(anchor,entry,active)=>locateEntry(scope,sessionId,anchor,entry,active)})
    }, props=>h(Controls,{...props,key:props.sessionId}))));
  }
  return {apply, inject:['slots','connection']};
}});
