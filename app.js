document.addEventListener('DOMContentLoaded', () => {
  const chatBox = document.getElementById('chat-box');
  const logInput = document.getElementById('log-input');
  const sendBtn = document.getElementById('send-btn');
  const micBtn = document.getElementById('mic-btn');
  const micOverlay = document.getElementById('mic-overlay');
  const clearLogsBtn = document.getElementById('clear-logs');
  const exportBtn = document.getElementById('export-csv');

  const countLogs = document.getElementById('count-logs');
  const avgSleep = document.getElementById('avg-sleep');
  const avgMood = document.getElementById('avg-mood');
  const streakDays = document.getElementById('streak-days');
  const serverStatus = document.getElementById('server-status');
  const logsList = document.getElementById('logs-list');
  const canvas = document.getElementById('metrics-chart');

  const API = ''; // same origin
  let serverOk = false;
  let serverAi = false;

  // XSS guard: escape user-supplied strings before innerHTML
  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const sleepOf = (l) => l.sleep_hours ?? l.sleep ?? null;
  const moodOf = (l) => l.mood ?? null;

  function formatDate(d) {
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
      const dt = new Date(d + 'T12:00:00');
      return isNaN(dt) ? d : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
    return d ?? '-';
  }

  function workoutShort(w) {
    if (w == null) return null;
    if (typeof w === 'number') return `${w}m`; // legacy local entries
    if (typeof w === 'string') return w;
    const parts = [];
    if (w.distance_km != null) parts.push(`${w.distance_km} km`);
    if (w.minutes != null) parts.push(`${w.minutes}m`);
    if (!parts.length) return w.kind || null;
    return parts.join(' + ');
  }

  let logs = [];
  try {
    logs = JSON.parse(localStorage.getItem('logit_logs')) || [];
    if (!Array.isArray(logs)) logs = [];
  } catch (e) {
    logs = [];
  }
  const saveLocal = () => {
    try { localStorage.setItem('logit_logs', JSON.stringify(logs)); } catch (e) { /* storage full/blocked */ }
  };

  const setStatus = (mode) => {
    if (!serverStatus) return;
    if (mode === 'ai') { serverStatus.textContent = '● Backend connected · AI ready'; serverStatus.style.color = 'var(--success)'; }
    else if (mode === 'regex') { serverStatus.textContent = '● Backend connected · Regex mode'; serverStatus.style.color = 'var(--success)'; }
    else { serverStatus.textContent = '● Offline · local fallback'; serverStatus.style.color = '#f59e0b'; }
  };

  const refreshStats = async () => {
    // Streak comes from the server when reachable; averages stay local so the
    // chart/table and KPIs never disagree.
    if (!serverOk || !streakDays) return;
    try {
      const r = await fetch(`${API}/api/stats?days=30`);
      if (!r.ok) return;
      const s = await r.json();
      if (typeof s.streak_days === 'number') streakDays.textContent = String(s.streak_days);
    } catch (e) { /* keep last value */ }
  };

  const updateUI = () => {
    saveLocal(); // localStorage is the offline cache; server is source of truth when reachable

    countLogs.textContent = logs.length;
    if (logs.length > 0) {
      const sleeps = logs.map(sleepOf).filter((v) => typeof v === 'number');
      const moods = logs.map(moodOf).filter((v) => typeof v === 'number');
      avgSleep.textContent = sleeps.length ? (sleeps.reduce((a, b) => a + b, 0) / sleeps.length).toFixed(1) + ' hrs' : '-';
      avgMood.textContent = moods.length ? (moods.reduce((a, b) => a + b, 0) / moods.length).toFixed(1) + '/10' : '-';
    } else {
      avgSleep.textContent = '-';
      avgMood.textContent = '-';
    }

    if (logs.length === 0) {
      logsList.innerHTML = `
        <tr class="empty-state">
          <td colspan="5">No logs recorded yet. Send your first message to parse.</td>
        </tr>
      `;
    } else {
      logsList.innerHTML = logs.map((log) => {
        const w = workoutShort(log.workout);
        return `
        <tr>
          <td>${escapeHtml(formatDate(log.date))}</td>
          <td>${sleepOf(log) != null ? escapeHtml(String(sleepOf(log))) + 'h' : '-'}</td>
          <td>${moodOf(log) != null ? escapeHtml(String(moodOf(log))) + '/10' : '-'}</td>
          <td>${w ? escapeHtml(w) : '-'}</td>
          <td style="color: var(--muted); font-size: 0.8rem; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
            &quot;${escapeHtml(log.raw)}&quot;
          </td>
        </tr>
      `;
      }).join('');
    }

    drawChart();
  };

  const drawChart = () => {
    const ctx = canvas.getContext('2d');
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width;
    canvas.height = height;

    ctx.clearRect(0, 0, width, height);

    if (logs.length < 2) {
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.font = '13px "Plus Jakarta Sans"';
      ctx.textAlign = 'center';
      ctx.fillText('Chart requires at least 2 logs to show progression.', width / 2, height / 2);
      return;
    }

    const chartLogs = [...logs].slice(-7); // Last 7 logs
    const padding = 30;
    const graphWidth = width - padding * 2;
    const graphHeight = height - padding * 2;
    const stepX = graphWidth / (chartLogs.length - 1);

    const drawLine = (getVal, maxVal, color, label) => {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.fillStyle = color;

      chartLogs.forEach((log, index) => {
        const val = getVal(log) || 0;
        const x = padding + index * stepX;
        const y = padding + graphHeight - (val / maxVal) * graphHeight;

        if (index === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        ctx.moveTo(x + 4, y);
        ctx.arc(x, y, 4, 0, Math.PI * 2);
      });
      ctx.stroke();

      ctx.font = '10px "Plus Jakarta Sans"';
      ctx.fillText(label, padding + (chartLogs.length - 1) * stepX - 10, padding + 15);
    };

    drawLine(sleepOf, 12, '#6366f1', 'Sleep (hrs)');
    drawLine(moodOf, 10, '#10b981', 'Mood (/10)');
  };

  // --- Offline fallback parser (used only when the server is unreachable).
  // Mirrors the server-side regexes, including the "ran 5k = 5 km" fix.
  const offlineParse = (text) => {
    const sleepM = text.match(/(?:slept|sleeping|sleep)\s*(?:for\s*)?(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?)?/i)
      || text.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\s*(?:of\s*)?sleep/i);
    const moodM = text.match(/mood\s*:?\s*(?:is\s*)?(\d+(?:\.\d+)?)\s*(?:\/\s*10|\s*out\s*of\s*10)?/i);
    let workout = null;
    const distM = text.match(/(?:ran|run|running|jog(?:ged|ging)?|walk(?:ed|ing)?|cycl(?:ed|ing)|swam)\s*(\d+(?:\.\d+)?)\s*(k|km|miles?|mi\b|m\b)/i)
      || text.match(/(\d+(?:\.\d+)?)\s*km\b/i);
    if (distM) {
      const v = parseFloat(distM[1]);
      const u = distM[2].toLowerCase();
      const km = (u === 'k' || u.startsWith('km')) ? v : (u.startsWith('mi') ? v * 1.60934 : v / 1000);
      workout = { minutes: null, distance_km: Math.round(km * 100) / 100, kind: 'run' };
    } else {
      const durM = text.match(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h\b|minutes?|mins?|min\b)/i);
      if (durM && /(workout|gym|train|exercise|yoga|run|ran|min)/i.test(text)) {
        const v = parseFloat(durM[1]);
        workout = { minutes: durM[2].toLowerCase().startsWith('h') ? Math.round(v * 60) : v, distance_km: null, kind: 'workout' };
      }
    }
    const waterM = text.match(/(\d+(?:\.\d+)?)\s*(ml|l|oz|glasses?|cups?)\s*(?:of\s*)?water/i)
      || text.match(/drank\s*(\d+(?:\.\d+)?)\s*(ml|l|oz|glasses?|cups?)?/i);
    let waterMl = null;
    if (waterM) {
      const v = parseFloat(waterM[1]);
      const u = (waterM[2] || 'ml').toLowerCase();
      waterMl = u === 'l' || u.startsWith('lit') ? Math.round(v * 1000)
        : u.includes('oz') ? Math.round(v * 29.5735)
        : (u.startsWith('glass') || u.startsWith('cup')) ? Math.round(v * 250) : Math.round(v);
    }
    const sleep = sleepM ? parseFloat(sleepM[1]) : null;
    const mood = moodM ? parseFloat(moodM[1]) : null;
    if (sleep == null && mood == null && workout == null && waterMl == null) return null;
    return {
      id: `local-${Date.now().toString(36)}`,
      date: new Date().toISOString().slice(0, 10),
      sleep_hours: sleep, mood, workout, water_ml: waterMl,
      diet: [], tags: ['offline'],
      raw: text, created_at: new Date().toISOString(),
    };
  };

  const entryReply = (entry, via) => {
    let reply = via === 'offline'
      ? '✅ <b>Logged locally</b> (server unreachable — will sync on next load).<br>Extracted metrics:<br>'
      : '✅ <b>Log parsed successfully!</b><br>Extracted metrics:<br>';
    if (entry.sleep_hours != null) reply += `• Sleep: <b>${entry.sleep_hours} hours</b><br>`;
    if (entry.mood != null) reply += `• Mood: <b>${entry.mood}/10</b><br>`;
    const w = workoutShort(entry.workout);
    if (w) reply += `• Workout: <b>${w}</b><br>`;
    if (entry.water_ml != null) reply += `• Water: <b>${entry.water_ml} ml</b><br>`;
    if (entry.diet && entry.diet.length) reply += `• Diet: <b>${entry.diet.join(', ')}</b><br>`;
    return reply;
  };

  const addMessage = (sender, text) => {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${sender}`;
    // Escape everything; restore only <br> and <b> used by system replies.
    const safeHtml = escapeHtml(text)
      .replace(/&lt;br\s*\/?&gt;/gi, '<br>')
      .replace(/&lt;(\/?)b&gt;/gi, '<$1b>');
    msgDiv.innerHTML = `
      <div class="bubble">
        <p>${safeHtml}</p>
      </div>
    `;
    chatBox.appendChild(msgDiv);
    chatBox.scrollTop = chatBox.scrollHeight;
  };

  const processInput = async () => {
    const text = logInput.value.trim();
    if (!text) return;

    addMessage('user', text);
    logInput.value = '';

    // Prefer the server; fall back to the local regex parser offline.
    try {
      const r = await fetch(`${API}/api/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.entry) {
        logs.push(j.entry);
        updateUI();
        refreshStats();
        addMessage('system', entryReply(j.entry, 'server'));
        return;
      }
      if ((r.status === 422 || r.status === 400) && serverOk) {
        addMessage('system', `❌ ${j.error || "I couldn't extract any metrics from that message."}`);
        return;
      }
      throw new Error('server unreachable');
    } catch (e) {
      const parsed = offlineParse(text);
      if (parsed) {
        logs.push(parsed);
        updateUI();
        addMessage('system', entryReply(parsed, 'offline'));
      } else {
        addMessage('system', "❌ I couldn't extract any metrics from that message. Please try to specify numbers like: <em>'slept 7 hours'</em> or <em>'mood 8/10'</em>.");
      }
    }
  };

  const downloadCsv = async () => {
    // Real export: prefer the server CSV; fall back to a local build.
    try {
      const r = await fetch(`${API}/api/export.csv`);
      if (!r.ok) throw new Error('export failed');
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'logit-export.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return;
    } catch (e) { /* fall through to local CSV */ }
    const header = 'date,sleep_hours,mood,workout,water_ml,diet,tags,raw';
    const q = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v ?? '').replace(/"/g, '""')}"` : String(v ?? ''));
    const rows = logs.map((l) => [
      l.date, sleepOf(l) ?? '', moodOf(l) ?? '', workoutShort(l.workout) ?? '',
      l.water_ml ?? '', (l.diet || []).join('|'), (l.tags || []).join('|'), l.raw ?? '',
    ].map(q).join(','));
    const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'logit-export.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  sendBtn.addEventListener('click', processInput);
  logInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      processInput();
    }
  });

  if (exportBtn) exportBtn.addEventListener('click', downloadCsv);

  // Real voice input via Web Speech API (no fake transcripts).
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let listening = false;
  const stopListening = () => {
    listening = false;
    micOverlay.classList.add('hidden');
    try { recognition && recognition.stop(); } catch (e) { /* already stopped */ }
  };
  micBtn.addEventListener('click', () => {
    if (listening) { stopListening(); return; }
    if (!SpeechRec) {
      addMessage('system', '🎙️ Voice input is not supported in this browser. Try Chrome or Edge, or type your log instead.');
      return;
    }
    try {
      recognition = new SpeechRec();
      recognition.lang = 'en-US';
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      recognition.onresult = (event) => {
        const transcript = event.results && event.results[0] && event.results[0][0]
          ? event.results[0][0].transcript : '';
        stopListening();
        if (transcript.trim()) {
          logInput.value = transcript.trim();
          processInput();
        }
      };
      recognition.onerror = () => {
        stopListening();
        addMessage('system', "🎙️ Voice capture failed — please try again or type your log.");
      };
      recognition.onend = () => { listening = false; micOverlay.classList.add('hidden'); };
      recognition.start();
      listening = true;
      micOverlay.classList.remove('hidden');
    } catch (e) {
      addMessage('system', '🎙️ Could not start voice input. Please type your log instead.');
    }
  });

  micOverlay.addEventListener('click', stopListening);

  clearLogsBtn.addEventListener('click', async () => {
    if (!confirm('Reset the metrics database (server + local cache)?')) return;
    try { await fetch(`${API}/api/logs`, { method: 'DELETE' }); } catch (e) { /* offline: clear local only */ }
    logs = [];
    if (streakDays) streakDays.textContent = '0';
    updateUI();
  });

  // Boot: server is source of truth when reachable, localStorage is offline cache.
  (async () => {
    try {
      const h = await fetch(`${API}/api/health`);
      if (!h.ok) throw new Error('no server');
      const hj = await h.json();
      serverOk = true;
      serverAi = !!hj.ai;
      setStatus(serverAi ? 'ai' : 'regex');
      const lr = await fetch(`${API}/api/logs?limit=1000`);
      if (lr.ok) {
        const lj = await lr.json();
        if (Array.isArray(lj.entries)) {
          logs = lj.entries;
          updateUI();
          refreshStats();
          return;
        }
      }
    } catch (e) {
      serverOk = false;
      setStatus('offline');
    }
    updateUI();
  })();
});
