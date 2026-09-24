(function () {
  'use strict';

  const root = document.getElementById('worklog');
  if (!root) return;

  const get = (id) => document.getElementById('wl-' + id);
  const ui = {
    month: get('month'), prev: get('prev'), next: get('next'), today: get('today'),
    all: get('all'), search: get('search'), status: get('status'), kind: get('kind'),
    category: get('category'), calendar: get('calendar'),
    summary: get('summary'), range: get('range'), count: get('count'), rows: get('rows'),
    empty: get('empty'), notice: get('notice'), add: get('add'), export: get('export'),
    import: get('import'), storageNote: get('storage-note'), reconnect: get('reconnect'),
    dialog: get('dialog'), form: get('form'), formTitle: get('form-title'),
    formError: get('form-error'), cancel: get('cancel'), save: get('save'),
    taskSection: get('task-section'), diarySection: get('diary-section'),
    diaryList: get('diary-list'), diaryRange: get('diary-range'), diaryCount: get('diary-count'),
    diaryEmpty: get('diary-empty'), writeDiary: get('write-diary'), diaryDialog: get('diary-dialog'),
    diaryForm: get('diary-form'), diaryFormTitle: get('diary-form-title'),
    diaryFormError: get('diary-form-error'), diaryCancel: get('diary-cancel'), diarySave: get('diary-save')
  };
  const fields = {
    date: get('date'), project: get('project'), title: get('title'), status: get('entry-status'),
    hours: get('hours'), outcome: get('outcome'), category: get('entry-category')
  };
  const diaryFields = {
    date: get('diary-date'), title: get('diary-title'), mood: get('diary-mood'), body: get('diary-body')
  };
  const editor = root.dataset.editor === 'true' &&
    ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const api = root.dataset.api || '/__worklog/api';
  const labels = { todo: '待开始', doing: '进行中', done: '已完成' };
  const categories = { work: '工作', study: '学习', life: '生活' };
  const moods = { '': '', happy: '开心', calm: '平静', tired: '疲惫', low: '低落' };
  let entries = [];
  let month = localDate(new Date()).slice(0, 7);
  let selectedDate = null;
  let readonlyReason = editor ? '正在连接本地编辑服务…' : '已发布的记录仅供查看。';
  let connected = false;
  let busy = false;
  let pendingWrite = false;
  let revision = '';
  let token = '';
  let editing = null;
  let formEntryId = '';
  let formSnapshot = '';
  let diaryEditing = null;
  let diaryEntryId = '';
  let diaryFormSnapshot = '';

  function localDate(date) {
    return String(date.getFullYear()).padStart(4, '0') + '-' +
      String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }

  function dateObject(value) {
    const [year, mon, day] = value.split('-').map(Number);
    const date = new Date(0);
    date.setHours(12, 0, 0, 0);
    date.setFullYear(year, mon - 1, day);
    return date;
  }

  function validDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number(value.slice(0, 4)) >= 1900 && localDate(dateObject(value)) === value;
  }

  function displayDate(value) {
    const [year, mon, day] = value.split('-').map(Number);
    return year + '年' + mon + '月' + (day ? day + '日' : '');
  }

  function notice(message, error) {
    ui.notice.textContent = message;
    ui.notice.classList.toggle('is-error', Boolean(error));
  }

  function node(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = value;
    return element;
  }

  function normalizedEntry(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.id !== 'string' || !value.id.trim() || value.id.length > 200 ||
      !validDate(value.date) || typeof value.title !== 'string' || value.title.length > 160) {
      throw new Error('记录格式无效，请检查编号、日期和标题。');
    }
    if (value.type === 'diary') {
      if (typeof value.body !== 'string' || !value.body.trim() || value.body.length > 20000 ||
        typeof value.mood !== 'string' || !Object.prototype.hasOwnProperty.call(moods, value.mood)) {
        throw new Error('日记格式无效，正文不能为空且不能超过 20000 字符，心情须使用支持的选项。');
      }
      return {
        id: value.id, date: value.date, type: 'diary', title: value.title,
        body: value.body, mood: value.mood
      };
    }
    if (value.type !== 'task' || !value.title.trim() ||
      typeof value.category !== 'string' || !Object.prototype.hasOwnProperty.call(categories, value.category) ||
      typeof value.project !== 'string' || value.project.length > 80 ||
      typeof value.outcome !== 'string' || value.outcome.length > 4000 ||
      typeof value.status !== 'string' || !Object.prototype.hasOwnProperty.call(labels, value.status) ||
      !(value.hours === null || (typeof value.hours === 'number' &&
        Number.isFinite(value.hours) && value.hours >= 0 && value.hours <= 24 &&
        Number.isInteger(value.hours * 4)))) {
      throw new Error('事项格式无效，请检查分类、内容、状态和耗时。');
    }
    return {
      id: value.id, date: value.date, type: 'task', category: value.category,
      project: value.project, title: value.title,
      status: value.status, hours: value.hours, outcome: value.outcome
    };
  }

  function parseBackup(raw, requireUnique) {
    const data = JSON.parse(raw);
    if (!data || data.version !== 2 || !Array.isArray(data.entries)) {
      throw new Error('备份格式不正确，需要 version 为 2 的每日记录 JSON。');
    }
    const result = data.entries.map(normalizedEntry);
    if (requireUnique && new Set(result.map((entry) => entry.id)).size !== result.length) {
      throw new Error('本地记录中存在重复编号。');
    }
    return result;
  }

  function syncControls() {
    const disabled = !editor || !connected || busy;
    [ui.add, ui.writeDiary, ui.import, ui.export].forEach((control) => {
      if (control) control.disabled = disabled;
    });
    [ui.save, ui.diarySave].forEach((control) => {
      if (control) control.disabled = !editor || busy;
    });
    if (ui.save) ui.save.textContent = connected ? '保存记录' : '重试保存';
    if (ui.diarySave) ui.diarySave.textContent = connected ? '保存日记' : '重试保存';
    [ui.cancel, ui.diaryCancel, ...Object.values(fields), ...Object.values(diaryFields)].forEach((control) => {
      if (control) control.disabled = busy;
    });
    root.querySelectorAll('button[data-action]').forEach((control) => { control.disabled = disabled; });
    if (ui.storageNote && editor) {
      ui.storageNote.textContent = connected ? '本地编辑 · 保存到仓库文件，发布后可查看。' : readonlyReason;
    }
    if (ui.reconnect) {
      ui.reconnect.hidden = !editor || connected;
      ui.reconnect.disabled = busy;
    }
  }

  function disconnected() {
    connected = false;
    readonlyReason = '未连接本地编辑服务，当前显示已加载的记录。';
    syncControls();
  }

  async function requestFile(method, data) {
    let response;
    try {
      response = await window.fetch(api, {
        method, cache: 'no-store', credentials: 'same-origin',
        headers: method === 'PUT' ? { 'Content-Type': 'application/json', 'X-Worklog-Token': token } : {},
        ...(method === 'PUT' ? { body: JSON.stringify(data) } : {})
      });
    } catch (_) {
      disconnected();
      throw new Error('无法连接本地编辑服务，修改尚未确认保存。请运行 python3 scripts/worklog-server.py，然后点击“重新连接”或“重试保存”；当前输入已保留。');
    }
    let payload;
    try {
      payload = await response.json();
    } catch (_) {
      disconnected();
      throw new Error('本地编辑服务没有返回有效数据。请使用 python3 scripts/worklog-server.py 启动预览，然后点击“重新连接”或“重试保存”；当前输入已保留。');
    }
    if (!response.ok) {
      const error = new Error(response.status === 409 ?
        '仓库文件已发生变化，本次修改尚未保存。请检查最新记录，重新打开编辑框后再保存；当前输入已保留。' :
        '本地文件操作失败，当前输入已保留。' + (payload && typeof payload.error === 'string' ? payload.error : '') +
        '请检查由 python3 scripts/worklog-server.py 启动的服务，然后点击“重新连接”或“重试保存”。');
      error.status = response.status;
      if (response.status !== 409) disconnected();
      throw error;
    }
    try {
      if (!payload.data || payload.data.version !== 2 ||
        typeof payload.revision !== 'string' || !/^[a-f0-9]{64}$/.test(payload.revision) ||
        typeof payload.token !== 'string' || !payload.token) throw new Error('服务响应不完整。');
      const current = parseBackup(JSON.stringify(payload.data), true);
      return { entries: current, revision: payload.revision, token: payload.token };
    } catch (error) {
      disconnected();
      throw new Error('本地数据无法读取，已停止写入。' + error.message);
    }
  }

  function useFile(data) {
    entries = data.entries;
    revision = data.revision;
    token = data.token;
    connected = true;
    readonlyReason = '';
  }

  async function exclusive(operation, writing = false) {
    if (busy) throw new Error('上一次操作尚未完成，请稍候。');
    busy = true;
    pendingWrite = writing;
    syncControls();
    try {
      return await operation();
    } finally {
      busy = false;
      pendingWrite = false;
      syncControls();
    }
  }

  async function refreshFile() {
    if (!editor || busy) return;
    await exclusive(async () => {
      const wasConnected = connected;
      try {
        useFile(await requestFile('GET'));
        render();
        if (!wasConnected) notice('已连接本地编辑服务。记录将保存到 static/data/worklog.json。');
      } catch (error) {
        notice(error.message, true);
      }
    });
  }

  // Re-read the repository before each write. Revision checks also catch writes
  // made after that read; the original dialog snapshot guards same-entry edits.
  async function persist(change) {
    if (!editor) throw new Error(readonlyReason);
    return exclusive(async () => {
      try {
        useFile(await requestFile('GET'));
        const next = await change(entries.slice());
        useFile(await requestFile('PUT', { data: { version: 2, entries: next }, revision }));
      } catch (error) {
        if (error.status === 409) {
          try { useFile(await requestFile('GET')); } catch (_) { /* Keep the last readable records. */ }
        }
        throw error;
      } finally {
        render();
      }
    }, true);
  }

  function newId(existing) {
    let id;
    do {
      id = window.crypto && typeof window.crypto.randomUUID === 'function' ?
        window.crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    } while (existing.has(id));
    return id;
  }

  function filteredEntries() {
    const query = ui.search.value.trim().toLocaleLowerCase();
    return entries.filter((entry) => {
      if (ui.kind.value !== 'all' && entry.type !== ui.kind.value) return false;
      if (entry.type === 'task' &&
        ((ui.status.value !== 'all' && entry.status !== ui.status.value) ||
        (ui.category.value !== 'all' && entry.category !== ui.category.value))) return false;
      const searchable = entry.type === 'diary' ?
        [entry.title, entry.body, entry.mood, moods[entry.mood]] :
        [entry.title, entry.project, entry.outcome, categories[entry.category]];
      return !query || searchable.join(' ').toLocaleLowerCase().includes(query);
    });
  }

  function hasFilters() {
    return ui.search.value.trim() || ui.kind.value !== 'all' ||
      ui.category.value !== 'all' || ui.status.value !== 'all';
  }

  function entrySummary(entry) {
    if (entry.title.trim()) return entry.title;
    return entry.body.trim().split(/[\r\n。！？.!?]/, 1)[0].slice(0, 120) || '无题日记';
  }

  function entryActions(entry) {
    const actions = node('div', 'wl-row-actions');
    ['edit', 'delete'].forEach((action) => {
      const button = node('button', action === 'delete' ? 'wl-danger' : '', action === 'edit' ? '编辑' : '删除');
      button.type = 'button';
      button.dataset.action = action;
      button.dataset.id = entry.id;
      button.disabled = !connected || busy;
      button.setAttribute('aria-label', (action === 'edit' ? '编辑' : '删除') + '：' + entrySummary(entry));
      actions.append(button);
    });
    return actions;
  }

  function render() {
    const today = localDate(new Date());
    const filtered = filteredEntries();
    const monthEntries = filtered.filter((entry) => entry.date.slice(0, 7) === month);
    const byDate = new Map();
    filtered.forEach((entry) => {
      if (!byDate.has(entry.date)) byDate.set(entry.date, []);
      byDate.get(entry.date).push(entry);
    });
    ui.month.value = month;
    ui.prev.disabled = month === '1900-01';
    ui.next.disabled = month === '9999-12';
    ui.all.setAttribute('aria-pressed', String(selectedDate === null));
    ui.today.setAttribute('aria-pressed', String(selectedDate === today));
    ui.taskSection.hidden = ui.kind.value === 'diary';
    ui.diarySection.hidden = ui.kind.value === 'task';
    ui.category.disabled = ui.kind.value === 'diary';
    ui.status.disabled = ui.kind.value === 'diary';

    const first = dateObject(month + '-01');
    first.setDate(first.getDate() - (first.getDay() + 6) % 7);
    const days = document.createDocumentFragment();
    for (let index = 0; index < 42; index += 1) {
      const date = new Date(first);
      date.setDate(first.getDate() + index);
      const value = localDate(date);
      const items = byDate.get(value) || [];
      const button = node('button', 'wl-day');
      button.type = 'button';
      button.dataset.date = value;
      button.disabled = !validDate(value);
      button.classList.toggle('is-outside', value.slice(0, 7) !== month);
      button.classList.toggle('is-today', value === today);
      button.classList.toggle('is-selected', value === selectedDate);
      button.classList.toggle('has-entries', items.length > 0);
      button.setAttribute('aria-pressed', String(value === selectedDate));
      button.setAttribute('aria-label', displayDate(value) + (value === today ? '，今天' : '') +
        '，' + items.filter((entry) => entry.type === 'task').length + ' 条事项，' +
        items.filter((entry) => entry.type === 'diary').length + ' 篇日记');
      if (value === today) button.setAttribute('aria-current', 'date');
      button.append(node('span', 'wl-day-number', date.getDate()));
      items.slice(0, 2).forEach((entry) => {
        const isDiary = entry.type === 'diary';
        const summary = entrySummary(entry);
        const title = node('span', 'wl-day-entry ' + (isDiary ? 'wl-day-diary' : 'wl-status-' + entry.status), summary);
        title.title = (isDiary ? '日记' : labels[entry.status]) + '：' + summary;
        button.append(title);
      });
      if (items.length > 2) button.append(node('span', 'wl-day-more', '+' + (items.length - 2) + ' 条'));
      const diaryCount = items.filter((entry) => entry.type === 'diary').length;
      if (diaryCount) button.append(node('span', 'wl-day-diary-mark', '日记 ' + diaryCount + ' 篇'));
      days.append(button);
    }
    ui.calendar.replaceChildren(days);

    const monthTasks = monthEntries.filter((entry) => entry.type === 'task');
    const hours = monthTasks.reduce((sum, entry) => sum + (entry.hours || 0), 0);
    ui.summary.textContent = displayDate(month) + ' · ' +
      new Set(monthEntries.map((entry) => entry.date)).size + ' 个记录日 · ' + monthTasks.length +
      ' 条事项 · ' + (monthEntries.length - monthTasks.length) + ' 篇日记 · ' +
      monthTasks.filter((entry) => entry.status === 'done').length + ' 项完成 · ' +
      hours + ' 小时' + (hasFilters() ? '（按当前筛选统计）' : '');
    const visible = monthEntries.filter((entry) => !selectedDate || entry.date === selectedDate)
      .sort((a, b) => b.date.localeCompare(a.date));
    const tasks = visible.filter((entry) => entry.type === 'task');
    const diaries = visible.filter((entry) => entry.type === 'diary');
    ui.range.textContent = displayDate(selectedDate || month) + '的事项';
    ui.count.textContent = tasks.length + ' 条';
    const rows = document.createDocumentFragment();
    tasks.forEach((entry) => {
      const row = node('tr');
      row.append(node('td', '', entry.date));
      const work = node('td');
      work.append(node('div', 'wl-row-title', entry.title));
      if (entry.project) work.append(node('div', 'wl-row-project', entry.project));
      work.append(node('div', 'wl-row-category', categories[entry.category]));
      row.append(work);
      const status = node('td');
      status.append(node('span', 'wl-badge wl-status-' + entry.status, labels[entry.status]));
      row.append(status, node('td', '', entry.hours === null ? '—' : entry.hours + ' h'));
      row.append(node('td', 'wl-row-outcome', entry.outcome || '—'));
      if (editor) {
        const actionCell = node('td');
        actionCell.append(entryActions(entry));
        row.append(actionCell);
      }
      rows.append(row);
    });
    ui.rows.replaceChildren(rows);
    ui.empty.hidden = tasks.length > 0;
    ui.empty.textContent = hasFilters() ?
      '没有符合当前筛选条件的事项。' : editor ?
        '还没有事项，点击“记事项”记下今天做了什么。' : '这个日期范围内还没有发布的事项。';
    ui.diaryRange.textContent = displayDate(selectedDate || month) + '的日记';
    ui.diaryCount.textContent = diaries.length + ' 篇';
    const cards = document.createDocumentFragment();
    diaries.forEach((entry) => {
      const card = node('details', 'wl-diary-card');
      card.open = selectedDate !== null;
      const heading = node('summary');
      heading.append(node('span', 'wl-diary-date', entry.date));
      heading.append(node('span', 'wl-diary-title', entry.title.trim() || '无题日记'));
      if (entry.mood) heading.append(node('span', 'wl-diary-mood', moods[entry.mood]));
      card.append(heading, node('p', 'wl-diary-body', entry.body));
      if (editor) card.append(entryActions(entry));
      cards.append(card);
    });
    ui.diaryList.replaceChildren(cards);
    ui.diaryEmpty.hidden = diaries.length > 0;
    ui.diaryEmpty.textContent = hasFilters() ?
      '没有符合当前筛选条件的日记。' : editor ?
        '还没有日记，点击“写日记”留下今天的感受与片段。' : '这个日期范围内还没有发布的日记。';
  }

  function selectMonth(value) {
    if (!validDate(value + '-01')) {
      ui.month.value = month;
      return;
    }
    month = value;
    selectedDate = null;
    render();
  }

  function changeMonth(offset) {
    const date = dateObject(month + '-01');
    date.setMonth(date.getMonth() + offset);
    selectMonth(localDate(date).slice(0, 7));
  }

  function formValues(source = fields) {
    return Object.fromEntries(Object.entries(source).map(([key, field]) => [key, field.value]));
  }

  function newEntryDate() {
    const today = localDate(new Date());
    return selectedDate || (today.slice(0, 7) === month ? today : month + '-01');
  }

  function openForm(entry) {
    if (!editor || !connected || busy) return;
    editing = entry ? { ...entry } : null;
    formEntryId = entry ? entry.id : newId(new Set(entries.map((item) => item.id)));
    ui.form.reset();
    ui.formError.textContent = '';
    ui.formTitle.textContent = entry ? '编辑事项' : '新增事项';
    fields.date.value = entry ? entry.date : newEntryDate();
    fields.category.value = entry ? entry.category : 'work';
    fields.project.value = entry ? entry.project : '';
    fields.title.value = entry ? entry.title : '';
    fields.status.value = entry ? entry.status : 'todo';
    fields.hours.value = entry && entry.hours !== null ? entry.hours : '';
    fields.outcome.value = entry ? entry.outcome : '';
    formSnapshot = JSON.stringify(formValues());
    ui.dialog.showModal();
    fields.title.focus();
  }

  function closeForm() {
    if (busy) return;
    if (JSON.stringify(formValues()) !== formSnapshot && !window.confirm('编辑尚未保存，确定放弃这些修改吗？')) return;
    ui.dialog.close();
  }

  function openDiaryForm(entry) {
    if (!editor || !connected || busy) return;
    diaryEditing = entry ? { ...entry } : null;
    diaryEntryId = entry ? entry.id : newId(new Set(entries.map((item) => item.id)));
    ui.diaryForm.reset();
    ui.diaryFormError.textContent = '';
    ui.diaryFormTitle.textContent = entry ? '编辑日记' : '写日记';
    diaryFields.date.value = entry ? entry.date : newEntryDate();
    diaryFields.title.value = entry ? entry.title : '';
    diaryFields.body.value = entry ? entry.body : '';
    diaryFields.mood.value = entry ? entry.mood : '';
    diaryFormSnapshot = JSON.stringify(formValues(diaryFields));
    ui.diaryDialog.showModal();
    diaryFields.body.focus();
  }

  function closeDiaryForm() {
    if (busy) return;
    if (JSON.stringify(formValues(diaryFields)) !== diaryFormSnapshot &&
      !window.confirm('日记尚未保存，确定放弃这些修改吗？')) return;
    ui.diaryDialog.close();
  }

  async function saveEntry(entry, original) {
    await persist((latest) => {
      const index = latest.findIndex((item) => item.id === entry.id);
      // A previous PUT may have reached disk even when its response was lost.
      // Keep the dialog's ID across retries and accept an already-saved match.
      if (index >= 0 && JSON.stringify(latest[index]) === JSON.stringify(entry)) return latest;
      if (original) {
        if (index < 0 || JSON.stringify(latest[index]) !== JSON.stringify(original)) {
          throw new Error('这条记录已在其他页面或文件中修改或删除，本次修改尚未保存。当前输入已保留，请检查最新记录后重新编辑。');
        }
        latest[index] = entry;
      } else {
        if (index >= 0) {
          throw new Error('这条新记录已保存，但文件内容与当前输入不同。当前输入已保留，请检查已保存的记录后重新打开编辑，避免重复或覆盖。');
        }
        latest.push(entry);
      }
      return latest;
    });
    month = entry.date.slice(0, 7);
    selectedDate = entry.date;
    ui.search.value = '';
    ui.kind.value = 'all';
    ui.category.value = 'all';
    ui.status.value = 'all';
    render();
    notice('已保存到仓库文件 static/data/worklog.json，发布后可查看。');
  }

  ui.prev.addEventListener('click', () => changeMonth(-1));
  ui.next.addEventListener('click', () => changeMonth(1));
  ui.month.addEventListener('change', () => selectMonth(ui.month.value));
  ui.today.addEventListener('click', () => {
    selectedDate = localDate(new Date());
    month = selectedDate.slice(0, 7);
    render();
  });
  ui.all.addEventListener('click', () => { selectedDate = null; render(); });
  ui.search.addEventListener('input', render);
  ui.status.addEventListener('change', render);
  ui.kind.addEventListener('change', render);
  ui.category.addEventListener('change', render);
  ui.calendar.addEventListener('click', (event) => {
    const day = event.target.closest('button[data-date]');
    if (!day || !ui.calendar.contains(day) || day.disabled) return;
    selectedDate = day.dataset.date;
    month = selectedDate.slice(0, 7);
    render();
    // Rendering replaces the calendar buttons; keep keyboard focus on the selected date.
    const replacement = ui.calendar.querySelector('[data-date="' + selectedDate + '"]');
    if (replacement) replacement.focus({ preventScroll: true });
  });
  ui.month.min = '1900-01';
  ui.month.max = '9999-12';
  try {
    const initial = get('initial-data');
    entries = parseBackup(initial ? initial.textContent : '', true);
    if (!editor && entries.length && !entries.some((entry) => entry.date.slice(0, 7) === month)) {
      month = entries.reduce((latest, entry) => entry.date > latest ? entry.date : latest, '').slice(0, 7);
    }
  } catch (error) {
    notice('页面中的记录数据无法读取。' + (error instanceof SyntaxError ? '请检查 static/data/worklog.json 后重新构建。' : error.message), true);
  }
  syncControls();
  render();

  // Published pages never read browser storage, contact the editing service,
  // or attach editing listeners. Only the embedded build-time data is shown.
  if (!editor) return;

  if (ui.reconnect) ui.reconnect.addEventListener('click', refreshFile);
  ui.add.addEventListener('click', () => openForm(null));
  ui.cancel.addEventListener('click', closeForm);
  ui.dialog.addEventListener('cancel', (event) => { event.preventDefault(); closeForm(); });
  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    ui.formError.textContent = '';
    if (!ui.form.reportValidity()) return;
    try {
      const values = formValues();
      const entry = normalizedEntry({
        ...values, type: 'task', project: values.project.trim(), title: values.title.trim(),
        id: formEntryId,
        hours: values.hours === '' ? null : Number(values.hours)
      });
      await saveEntry(entry, editing);
      ui.dialog.close();
    } catch (error) {
      ui.formError.textContent = error.message || '保存失败，当前编辑尚未保存。';
    }
  });
  ui.writeDiary.addEventListener('click', () => openDiaryForm(null));
  ui.diaryCancel.addEventListener('click', closeDiaryForm);
  ui.diaryDialog.addEventListener('cancel', (event) => { event.preventDefault(); closeDiaryForm(); });
  ui.diaryForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    ui.diaryFormError.textContent = '';
    if (!ui.diaryForm.reportValidity()) return;
    try {
      const values = formValues(diaryFields);
      const entry = normalizedEntry({
        ...values, type: 'diary', title: values.title.trim(),
        id: diaryEntryId
      });
      await saveEntry(entry, diaryEditing);
      ui.diaryDialog.close();
    } catch (error) {
      ui.diaryFormError.textContent = error.message || '保存失败，当前日记尚未保存。';
    }
  });

  async function handleEntryAction(event) {
    if (busy || !connected) return;
    const button = event.target.closest('button[data-action]');
    if (!button || !event.currentTarget.contains(button) || button.disabled) return;
    const entry = entries.find((item) => item.id === button.dataset.id);
    if (!entry) return;
    if (button.dataset.action === 'edit') return entry.type === 'diary' ? openDiaryForm(entry) : openForm(entry);
    if (!window.confirm('确定删除“' + entrySummary(entry) + '”吗？删除后可通过之前导出的备份恢复。')) return;
    try {
      await persist((latest) => {
        const current = latest.find((item) => item.id === entry.id);
        if (current && JSON.stringify(current) !== JSON.stringify(entry)) {
          throw new Error('这条记录已在其他页面或文件中修改，请检查最新内容后再删除。');
        }
        return latest.filter((item) => item.id !== entry.id);
      });
      notice('记录已从仓库文件删除，重新发布后生效。');
    } catch (error) {
      notice(error.message || '删除失败，请检查最新记录。', true);
    }
  }
  ui.rows.addEventListener('click', handleEntryAction);
  ui.diaryList.addEventListener('click', handleEntryAction);

  ui.export.addEventListener('click', async () => {
    if (busy || !connected) return;
    try {
      await exclusive(async () => {
        useFile(await requestFile('GET'));
        render();
        const data = JSON.stringify({ version: 2, entries }, null, 2);
        const url = URL.createObjectURL(new Blob([data], { type: 'application/json;charset=utf-8' }));
        const link = node('a');
        link.href = url;
        link.download = 'worklog-' + localDate(new Date()) + '.json';
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        notice('已请求下载仓库中的全部 ' + entries.length + ' 条记录。');
      });
    } catch (error) {
      notice('导出失败。' + error.message, true);
    }
  });

  function mergeEntries(latest, incoming, counts) {
    const byId = new Map(latest.map((entry) => [entry.id, entry]));
    const used = new Set([...byId.keys(), ...incoming.map((entry) => entry.id)]);
    incoming.forEach((entry) => {
      const existing = byId.get(entry.id);
      if (existing && JSON.stringify(existing) === JSON.stringify(entry)) {
        counts.skipped += 1;
        return;
      }
      if (existing) {
        entry = { ...entry, id: newId(used) };
        counts.conflicts += 1;
      }
      latest.push(entry);
      byId.set(entry.id, entry);
      used.add(entry.id);
      counts.added += 1;
    });
    return latest;
  }

  function mergeSummary(counts) {
    return '新增 ' + counts.added + ' 条，跳过相同记录 ' + counts.skipped + ' 条' +
      (counts.conflicts ? '；' + counts.conflicts + ' 条编号冲突记录已另存为新记录' : '') + '。';
  }

  ui.import.addEventListener('change', async () => {
    if (busy || !connected) { ui.import.value = ''; return; }
    const file = ui.import.files && ui.import.files[0];
    if (!file) return;
    const counts = { added: 0, skipped: 0, conflicts: 0 };
    try {
      await persist(async (latest) => {
        const incoming = parseBackup(await file.text(), false);
        return mergeEntries(latest, incoming, counts);
      });
      notice('已导入仓库文件：' + mergeSummary(counts));
    } catch (error) {
      notice('未确认完成导入，原有记录不会被覆盖。' + (error instanceof SyntaxError ? '文件不是有效的 JSON。' : error.message), true);
    } finally {
      ui.import.value = '';
    }
  });

  window.addEventListener('focus', () => { refreshFile(); });
  window.addEventListener('beforeunload', (event) => {
    if (pendingWrite || (ui.dialog.open && JSON.stringify(formValues()) !== formSnapshot) ||
      (ui.diaryDialog.open && JSON.stringify(formValues(diaryFields)) !== diaryFormSnapshot)) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  fields.date.min = '1900-01-01';
  fields.date.max = '9999-12-31';
  diaryFields.date.min = '1900-01-01';
  diaryFields.date.max = '9999-12-31';
  refreshFile();
})();
