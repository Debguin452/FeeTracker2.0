// Analytics dashboard — teacher & student charts (Chart.js).
// Lazy-loaded: only fetched when the user actually opens a dashboard
// (dashBtn, the "Teacher Dashboard" home-card header, or Analytics nav).
// Chart.js itself (~200KB from CDN) is also deferred until first use here,
// instead of being loaded unconditionally on every app boot.
//
// init(deps) wires the real window.openTeacherDash / closeTeacherDash /
// openStudentDash / closeStudentDash / renderStudentDash implementations,
// replacing the bootstrap stubs core defines eagerly (see js/app.js).

let _chartLoadPromise = null;
function ensureChartJs() {
  if (window.Chart) return Promise.resolve();
  if (_chartLoadPromise) return _chartLoadPromise;
  _chartLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
    s.onload = resolve;
    s.onerror = () => { _chartLoadPromise = null; reject(new Error('Failed to load Chart.js')); };
    document.head.appendChild(s);
  });
  return _chartLoadPromise;
}

function chartDefaults(isDarkMode) {
  const dark = isDarkMode(), tc = dark ? 'rgba(255,255,255,.55)' : 'rgba(30,30,60,.6)', gc = dark ? 'rgba(255,255,255,.04)' : 'rgba(0,0,0,.05)';
  return {
    responsive: true, maintainAspectRatio: false, animation: { duration: 700, easing: 'easeInOutQuart' },
    plugins: { legend: { labels: { color: tc, font: { family: "'DM Sans'", size: 11 }, padding: 12 } },
      tooltip: { backgroundColor: dark ? '#1c1c38' : '#fff', titleColor: dark ? '#ebebf5' : '#18182e', bodyColor: dark ? '#8e8eb8' : '#4e4e82', borderColor: dark ? 'rgba(255,255,255,.12)' : 'rgba(80,80,140,.15)', borderWidth: 1, cornerRadius: 10, padding: 10 } },
    scales: { x: { ticks: { color: tc, font: { size: 10 } }, grid: { color: gc } }, y: { ticks: { color: tc, font: { size: 10 } }, grid: { color: gc } } }
  };
}

async function fetchAllBatchStats(deps) {
  const { getBatches, stuCol, bpyCol, getDocs } = deps;
  const batches = getBatches();
  const stats = {};
  await Promise.all(Object.keys(batches).map(async bid => {
    try {
      const [ss, ps] = await Promise.all([getDocs(stuCol(bid)), getDocs(bpyCol(bid))]);
      const stus = {}, pays = []; ss.forEach(d => stus[d.id] = d.data()); ps.forEach(d => pays.push({ id: d.id, ...d.data() }));
      stats[bid] = { students: stus, payments: pays };
    } catch (e) { stats[bid] = { students: {}, payments: [] }; }
  }));
  return stats;
}

function dashSkeleton() {
  return `<div style="padding:0">
    <div class="dash-sk-row">
      <div class="dash-sk-stat"><div class="sk" style="width:28px;height:28px;border-radius:8px;margin-bottom:10px"></div><div class="sk" style="width:70%;height:22px;border-radius:6px;margin-bottom:6px"></div><div class="sk" style="width:50%;height:10px;border-radius:5px;opacity:.5"></div></div>
      <div class="dash-sk-stat"><div class="sk" style="width:28px;height:28px;border-radius:8px;margin-bottom:10px"></div><div class="sk" style="width:70%;height:22px;border-radius:6px;margin-bottom:6px"></div><div class="sk" style="width:50%;height:10px;border-radius:5px;opacity:.5"></div></div>
      <div class="dash-sk-stat"><div class="sk" style="width:28px;height:28px;border-radius:8px;margin-bottom:10px"></div><div class="sk" style="width:70%;height:22px;border-radius:6px;margin-bottom:6px"></div><div class="sk" style="width:50%;height:10px;border-radius:5px;opacity:.5"></div></div>
      <div class="dash-sk-stat"><div class="sk" style="width:28px;height:28px;border-radius:8px;margin-bottom:10px"></div><div class="sk" style="width:70%;height:22px;border-radius:6px;margin-bottom:6px"></div><div class="sk" style="width:50%;height:10px;border-radius:5px;opacity:.5"></div></div>
    </div>
    <div class="dash-sk-chart"><div class="sk" style="width:40%;height:14px;border-radius:6px;margin-bottom:8px"></div><div class="sk" style="width:25%;height:10px;border-radius:5px;opacity:.5;margin-bottom:16px"></div><div style="display:flex;gap:16px;align-items:center"><div class="sk" style="width:130px;height:130px;border-radius:50%;flex-shrink:0"></div><div style="flex:1"><div class="sk" style="width:60%;height:32px;border-radius:8px;margin-bottom:8px"></div><div class="sk" style="width:80%;height:10px;border-radius:5px;margin-bottom:6px;opacity:.6"></div><div class="sk" style="width:70%;height:10px;border-radius:5px;opacity:.4"></div></div></div></div>
    <div class="dash-sk-chart"><div class="sk" style="width:40%;height:14px;border-radius:6px;margin-bottom:8px"></div><div class="sk" style="width:25%;height:10px;border-radius:5px;opacity:.5;margin-bottom:16px"></div><div class="sk" style="width:100%;height:160px;border-radius:10px"></div></div>
    <div class="dash-sk-chart"><div class="sk" style="width:40%;height:14px;border-radius:6px;margin-bottom:8px"></div><div class="sk" style="width:25%;height:10px;border-radius:5px;opacity:.5;margin-bottom:16px"></div><div class="sk" style="width:100%;height:160px;border-radius:10px"></div></div>
  </div>`;
}

async function renderTeacherDash(deps) {
  const { getBatches, dashFmt, isDarkMode, addM, mBetween, destroyCharts, tchDashCharts } = deps;
  const batches = getBatches();
  const body = document.getElementById('teacherDashBody'); if (!body) return;
  const bKeys = Object.keys(batches);
  if (!bKeys.length) { body.innerHTML = '<div class="dash-empty"><div class="dash-empty-icon" style="display:flex;align-items:center;justify-content:center;"><svg width="40" height="40" viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0"><rect x="8" y="6" width="34" height="40" rx="5" fill="currentColor" opacity=".08" stroke="currentColor" stroke-width="2"/><line x1="16" y1="18" x2="36" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="16" y1="26" x2="30" y2="26" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="16" y1="34" x2="26" y2="34" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></div><div class="dash-empty-txt">No batches yet.</div></div>'; return; }
  body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted);">Loading…</div>';
  await ensureChartJs();
  const allStats = await fetchAllBatchStats(deps);
  const now = new Date(), curM = now.getMonth() + 1, curY = now.getFullYear();
  const batchSummaries = [], allPays = [];
  let grandDue = 0, grandStudents = 0, grandPaid = 0, grandMonthly = 0;
  for (const bid of bKeys) {
    const b = batches[bid], s = allStats[bid] || { students: {}, payments: [] };
    const stuKeys = Object.keys(s.students); let bDue = 0, bPaid = 0;
    s.payments.forEach(p => allPays.push(p));
    stuKeys.forEach(sid => {
      const st = s.students[sid], fee = b.fee || 0;
      let lp = { month: st.baselineMonth || curM, year: st.baselineYear || curY }, rp = 0;
      s.payments.filter(p => p.studentId === sid).sort((a, x) => a.timestamp - x.timestamp).forEach(p => {
        if (p.type === 'partial') { rp += p.amount; const c = Math.floor(rp / fee); if (c > 0) { lp = addM(lp, c); rp %= fee; } }
        else if (p.monthsPaid) { lp = addM(lp, p.monthsPaid); rp = 0; }
      });
      const mo = Math.max(mBetween(lp, { month: curM, year: curY }), 0);
      const _dayAdj = (mo > 0 && now.getDate() < (lp.day || 1)) ? 1 : 0;
      const moAdj = Math.max(mo - _dayAdj, 0);
      let pb = 0; s.payments.filter(p => p.studentId === sid).sort((a, x) => a.timestamp - x.timestamp).forEach(p => { if (p.type === 'partial') { pb += p.amount; pb %= fee; } else if (p.monthsPaid) pb = 0; });
      const due = Math.max(moAdj * fee - pb, 0); bDue += due; if (due === 0) bPaid++;
    });
    grandDue += bDue; grandStudents += stuKeys.length; grandPaid += bPaid; grandMonthly += stuKeys.length * (b.fee || 0);
    batchSummaries.push({ bid, name: b.name, stuCount: stuKeys.length, paidCount: bPaid, dueCount: stuKeys.length - bPaid, due: bDue });
  }
  const collRate = grandStudents > 0 ? Math.round((grandPaid / grandStudents) * 100) : 0;

  const standaloneCount = deps.getStandaloneCount ? deps.getStandaloneCount() : 0;
  grandStudents += standaloneCount;
  const overdueStu = grandStudents - grandPaid;
  const monthLabels = [], monthAmts = [];
  for (let i = 5; i >= 0; i--) { const d = new Date(curY, curM - 1 - i, 1); monthLabels.push(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]); monthAmts.push(allPays.filter(p => p.paidOn && p.paidOn.month === d.getMonth() + 1 && p.paidOn.year === d.getFullYear()).reduce((s, p) => s + (p.amount || 0), 0)); }
  const overdueList = [];
  batchSummaries.forEach(bs => { const s = allStats[bs.bid], b = batches[bs.bid], fee = b.fee || 0; Object.keys(s.students).forEach(sid => { const st = s.students[sid]; let lp = { month: st.baselineMonth || curM, year: st.baselineYear || curY }, rp = 0; s.payments.filter(p => p.studentId === sid).sort((a, x) => a.timestamp - x.timestamp).forEach(p => { if (p.type === 'partial') { rp += p.amount; const c = Math.floor(rp / fee); if (c > 0) { lp = addM(lp, c); rp %= fee; } } else if (p.monthsPaid) { lp = addM(lp, p.monthsPaid); rp = 0; } }); const mo = Math.max(mBetween(lp, { month: curM, year: curY }), 0); const _oda = (mo > 0 && now.getDate() < (lp.day || 1)) ? 1 : 0; const moAdj2 = Math.max(mo - _oda, 0); let pb = 0; s.payments.filter(p => p.studentId === sid).sort((a, x) => a.timestamp - x.timestamp).forEach(p => { if (p.type === 'partial') { pb += p.amount; pb %= fee; } else if (p.monthsPaid) pb = 0; }); const due = Math.max(moAdj2 * fee - pb, 0); if (due > 0) overdueList.push({ name: st.name, batch: b.name, due, mo: moAdj2 }); }); });
  overdueList.sort((a, b) => b.due - a.due);
  const dark = isDarkMode(), tc = dark ? 'rgba(255,255,255,.55)' : 'rgba(30,30,60,.6)', gc = dark ? 'rgba(255,255,255,.04)' : 'rgba(0,0,0,.05)';
  body.innerHTML = `
    <div class="dash-stat-grid">
      <div class="dash-stat-card" style="--stat-glow:rgba(124,107,255,.08)"><div class="dash-stat-icon"><svg width="22" height="22" viewBox="0 0 22 22" fill="none"><path d="M11 2L2 7l9 5 9-5-9-5z" fill="currentColor" opacity=".12" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M2 12l9 5 9-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity=".6"/></svg></div><div class="dash-stat-val">${grandStudents}</div><div class="dash-stat-label">Total Students</div></div>
      <div class="dash-stat-card" style="--stat-glow:rgba(0,212,170,.08)"><div class="dash-stat-icon"><svg width="22" height="22" viewBox="0 0 22 22" fill="none"><rect x="2" y="6" width="18" height="13" rx="3" fill="currentColor" opacity=".12" stroke="currentColor" stroke-width="1.6"/><path d="M7 6V4a4 4 0 0 1 8 0v2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></div><div class="dash-stat-val">${bKeys.length}</div><div class="dash-stat-label">Active Batches</div></div>
      <div class="dash-stat-card" style="--stat-glow:rgba(255,209,102,.08)"><div class="dash-stat-icon"><svg width="22" height="22" viewBox="0 0 22 22" fill="none"><circle cx="11" cy="11" r="9" fill="currentColor" opacity=".1" stroke="currentColor" stroke-width="1.6"/><path d="M8 7.5h6M8 7.5v1a4.5 4.5 0 0 0 4.5 4.5M8 7.5h2a2.5 2.5 0 0 1 0 5H8M10.5 13l3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></div><div class="dash-stat-val" style="font-size:19px">${dashFmt(grandMonthly)}</div><div class="dash-stat-label">Monthly Potential</div></div>
      <div class="dash-stat-card" style="--stat-glow:rgba(255,77,109,.08)"><div class="dash-stat-icon"><svg width="22" height="22" viewBox="0 0 22 22" fill="none"><path d="M11 2L1 20h20L11 2z" fill="currentColor" opacity=".1" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><line x1="11" y1="9" x2="11" y2="14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="11" cy="16.5" r="1.1" fill="currentColor"/></svg></div><div class="dash-stat-val" style="font-size:19px;color:${grandDue > 0 ? 'var(--yellow)' : 'var(--accent3)'}">${dashFmt(grandDue)}</div><div class="dash-stat-label">Outstanding Dues</div></div>
    </div>
    <div class="dash-two-col">
      <div>
        <div class="dash-chart-card" style="margin-bottom:14px"><div class="dash-chart-title">Collection Rate</div><div class="dash-chart-sub">Students paid vs pending</div>
          <div style="display:flex;align-items:center;gap:20px;padding-top:8px">
            <div class="dash-canvas-wrap" style="width:120px;height:120px;flex-shrink:0"><canvas id="tchDonutChart"></canvas></div>
            <div><div style="font-family:'Syne',sans-serif;font-size:36px;font-weight:800;letter-spacing:-1.5px;color:${collRate >= 80 ? 'var(--accent3)' : collRate >= 50 ? 'var(--yellow)' : 'var(--red)'}">${collRate}%</div>
              <div style="font-size:11px;color:var(--muted);margin-bottom:10px">of students paid</div>
              <div style="font-size:12px;color:var(--accent3);margin-bottom:4px">✓ ${grandPaid} paid</div>
              <div style="font-size:12px;color:var(--red)">${overdueStu} pending</div>
            </div>
          </div>
        </div>
        <div class="dash-chart-card"><div class="dash-chart-title">Monthly Revenue</div><div class="dash-chart-sub">Last 6 months collected</div><div class="dash-canvas-wrap" style="height:160px;margin-top:8px"><canvas id="tchLineChart"></canvas></div></div>
      </div>
      <div>
        <div class="dash-chart-card" style="margin-bottom:14px"><div class="dash-chart-title">Per-Batch Collection</div><div class="dash-chart-sub">Paid vs pending per batch</div><div class="dash-canvas-wrap" style="height:${Math.max(140, bKeys.length * 44)}px;margin-top:8px"><canvas id="tchBarChart"></canvas></div></div>
        <div class="dash-insight-card"><div class="dash-insight-title" style="display:flex;align-items:center;gap:6px;margin-bottom:12px;"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="1" y="2" width="14" height="12" rx="2" fill="currentColor" opacity=".1" stroke="currentColor" stroke-width="1.4"/><path d="M4 6h8M4 9h5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg> Batch Breakdown</div>
          ${batchSummaries.sort((a, b) => b.due - a.due).map(bs => { const pct = bs.stuCount > 0 ? Math.round((bs.paidCount / bs.stuCount) * 100) : 0; const fc = pct >= 80 ? 'var(--accent3)' : pct >= 50 ? 'var(--yellow)' : 'var(--red)'; return `<div style="margin-bottom:14px"><div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="font-family:'Syne',sans-serif;font-size:13px;font-weight:700;color:var(--text)">${bs.name}</span><span style="font-family:'Syne',sans-serif;font-size:13px;font-weight:800;color:${fc}">${pct}%</span></div><div style="font-size:10px;color:var(--muted);margin-bottom:5px">${bs.stuCount} students · ${dashFmt(bs.due)} due</div><div class="dash-prog-bar"><div class="dash-prog-fill" style="width:${pct}%;background:${fc}"></div></div></div>`; }).join('')}
        </div>
      </div>
    </div>
    ${overdueList.length ? `<div class="dash-insight-card" style="margin-top:14px"><div class="dash-insight-title" style="display:flex;align-items:center;gap:6px;margin-bottom:12px;"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1.5L.5 13h13L7 1.5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><line x1="7" y1="6" x2="7" y2="9.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="7" cy="11.5" r=".7" fill="currentColor"/></svg> Top Overdue Students</div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px">${overdueList.slice(0, 8).map((s, i) => `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--surface2);border-radius:12px;border:1px solid var(--border)"><div style="width:24px;height:24px;border-radius:50%;background:${i < 3 ? 'rgba(255,77,109,.15)' : 'var(--surface3)'};display:flex;align-items:center;justify-content:center;font-family:'Syne',sans-serif;font-size:11px;font-weight:800;color:${i < 3 ? 'var(--red)' : 'var(--muted)'};flex-shrink:0">${i + 1}</div><div style="flex:1;min-width:0"><div style="font-size:12px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s.name}</div><div style="font-size:10px;color:var(--muted)">${s.batch} · ${s.mo}mo</div></div><div style="font-family:'Syne',sans-serif;font-size:12px;font-weight:800;color:var(--red);flex-shrink:0">${dashFmt(s.due)}</div></div>`).join('')}</div></div>` : ''}`;
  document.getElementById('teacherDashSub').textContent = `${bKeys.length} batch${bKeys.length !== 1 ? 'es' : ''} · ${grandStudents} students`;
  const cd = chartDefaults(isDarkMode);
  const dCtx = document.getElementById('tchDonutChart')?.getContext('2d');
  if (dCtx) tchDashCharts.push(new Chart(dCtx, { type: 'doughnut', data: { labels: ['Paid', 'Pending'], datasets: [{ data: [grandPaid, overdueStu], backgroundColor: ['#00d4aa', '#ff4d6d'], borderWidth: 0, hoverOffset: 8 }] }, options: { ...cd, cutout: '72%', scales: { x: { display: false }, y: { display: false } }, plugins: { ...cd.plugins, legend: { display: false } } } }));
  const bCtx = document.getElementById('tchBarChart')?.getContext('2d');
  if (bCtx) { const sorted2 = [...batchSummaries].sort((a, b) => b.stuCount - a.stuCount); tchDashCharts.push(new Chart(bCtx, { type: 'bar', data: { labels: sorted2.map(bs => bs.name.length > 14 ? bs.name.slice(0, 14) + '…' : bs.name), datasets: [{ label: 'Paid', data: sorted2.map(bs => bs.paidCount), backgroundColor: 'rgba(0,212,170,.8)', borderRadius: 5, borderSkipped: false }, { label: 'Pending', data: sorted2.map(bs => bs.dueCount), backgroundColor: 'rgba(255,77,109,.7)', borderRadius: 5, borderSkipped: false }] }, options: { ...cd, indexAxis: 'y', plugins: { ...cd.plugins, legend: { labels: { color: tc, font: { size: 10 }, padding: 10 } } }, scales: { x: { stacked: false, ticks: { color: tc, font: { size: 10 }, stepSize: 1 }, grid: { color: gc } }, y: { ticks: { color: tc, font: { size: 10 } }, grid: { display: false } } } } })); }
  const lCtx = document.getElementById('tchLineChart')?.getContext('2d');
  if (lCtx) tchDashCharts.push(new Chart(lCtx, { type: 'line', data: { labels: monthLabels, datasets: [{ label: 'Collected (₹)', data: monthAmts, borderColor: '#7c6bff', backgroundColor: 'rgba(124,107,255,.12)', tension: .4, fill: true, pointBackgroundColor: '#7c6bff', pointRadius: 4, borderWidth: 2 }] }, options: { ...cd, plugins: { ...cd.plugins, legend: { display: false } }, scales: { x: { ticks: { color: tc, font: { size: 10 } }, grid: { color: gc } }, y: { ticks: { color: tc, font: { size: 10 }, callback: v => v >= 1000 ? '₹' + (v / 1000).toFixed(0) + 'k' : '₹' + v }, grid: { color: gc } } } } }));
}

async function renderStudentDash(deps) {
  const { getTeachers, getPayments, dashFmt, isDarkMode, monthsDue, calcDue, USER_LOCALE, stuDashCharts } = deps;
  const teachers = getTeachers(), payments = getPayments();
  const body = document.getElementById('studentDashBody'); if (!body) return;
  const tKeys = Object.keys(teachers);
  if (!tKeys.length) { body.innerHTML = '<div class="dash-empty"><div class="dash-empty-icon" style="display:flex;align-items:center;justify-content:center;"><svg width="40" height="40" viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0"><rect x="8" y="6" width="34" height="40" rx="5" fill="currentColor" opacity=".08" stroke="currentColor" stroke-width="2"/><line x1="16" y1="18" x2="36" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="16" y1="26" x2="30" y2="26" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="16" y1="34" x2="26" y2="34" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="6" y="6" width="4" height="40" rx="2" fill="currentColor" opacity=".3"/></svg></div><div class="dash-empty-txt">No teachers yet.</div></div>'; return; }
  await ensureChartJs();
  const now = new Date(), curM = now.getMonth() + 1, curY = now.getFullYear();
  const teacherData = tKeys.map(id => { const t = teachers[id], dm = monthsDue(id), da = calcDue(id); return { id, name: t.name, subject: t.subject, fee: t.fee, dm, da, cr: dm >= 6, ov: dm >= 3 }; }).sort((a, b) => b.da - a.da);
  const totalDue2 = teacherData.reduce((s, t) => s + t.da, 0);
  const clearCount = teacherData.filter(t => t.dm === 0).length, overdueCount = teacherData.filter(t => t.dm > 0).length;
  const totalMonthly = teacherData.reduce((s, t) => s + t.fee, 0);
  const clearRate = tKeys.length > 0 ? Math.round((clearCount / tKeys.length) * 100) : 0;
  const monthLabels2 = [], monthAmts2 = [];
  for (let i = 5; i >= 0; i--) { const d = new Date(curY, curM - 1 - i, 1); monthLabels2.push(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]); monthAmts2.push(payments.filter(p => p.paidOn && p.paidOn.month === d.getMonth() + 1 && p.paidOn.year === d.getFullYear()).reduce((s, p) => s + (p.amount || 0), 0)); }
  const paidThisMonth = payments.filter(p => p.paidOn && p.paidOn.month === curM && p.paidOn.year === curY).reduce((s, p) => s + (p.amount || 0), 0);
  const nonZ = monthAmts2.filter(a => a > 0); const avgMonthly = nonZ.length ? Math.round(nonZ.reduce((s, a) => s + a, 0) / nonZ.length) : 0;
  const dark = isDarkMode(), tc = dark ? 'rgba(255,255,255,.55)' : 'rgba(30,30,60,.6)', gc = dark ? 'rgba(255,255,255,.04)' : 'rgba(0,0,0,.05)';
  body.innerHTML = `
    <div class="dash-stat-grid">
      <div class="dash-stat-card" style="--stat-glow:rgba(255,77,109,.08)"><div class="dash-stat-icon"><svg width="22" height="22" viewBox="0 0 22 22" fill="none"><rect x="1" y="5" width="20" height="13" rx="3" fill="currentColor" opacity=".1" stroke="currentColor" stroke-width="1.6"/><line x1="1" y1="10" x2="21" y2="10" stroke="currentColor" stroke-width="1.6"/><rect x="4" y="13" width="5" height="2" rx="1" fill="currentColor" opacity=".6"/></svg></div><div class="dash-stat-val" style="font-size:20px;color:${totalDue2 > 0 ? 'var(--yellow)' : 'var(--accent3)'}">${dashFmt(totalDue2)}</div><div class="dash-stat-label">Total Outstanding</div></div>
      <div class="dash-stat-card" style="--stat-glow:rgba(0,212,170,.08)"><div class="dash-stat-icon"><svg width="22" height="22" viewBox="0 0 22 22" fill="none"><rect x="2" y="3" width="18" height="16" rx="3" fill="currentColor" opacity=".1" stroke="currentColor" stroke-width="1.6"/><path d="M6 2v3M16 2v3M2 9h18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><polyline points="7,14 10,17 15,12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div><div class="dash-stat-val" style="font-size:20px;color:var(--accent3)">${dashFmt(paidThisMonth)}</div><div class="dash-stat-label">Paid This Month</div></div>
      <div class="dash-stat-card" style="--stat-glow:rgba(124,107,255,.08)"><div class="dash-stat-icon"><svg width="22" height="22" viewBox="0 0 22 22" fill="none"><rect x="1" y="5" width="20" height="13" rx="3" fill="currentColor" opacity=".1" stroke="currentColor" stroke-width="1.6"/><line x1="1" y1="10" x2="21" y2="10" stroke="currentColor" stroke-width="2"/><rect x="4" y="13" width="6" height="2" rx="1" fill="currentColor"/></svg></div><div class="dash-stat-val" style="font-size:20px">${dashFmt(totalMonthly)}</div><div class="dash-stat-label">Monthly Fees</div></div>
      <div class="dash-stat-card" style="--stat-glow:rgba(255,209,102,.08)"><div class="dash-stat-icon"><svg width="22" height="22" viewBox="0 0 22 22" fill="none"><polyline points="1,17 6,11 10,14 15,7 21,11" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/><line x1="1" y1="19" x2="21" y2="19" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity=".4"/></svg></div><div class="dash-stat-val" style="font-size:20px">${dashFmt(avgMonthly)}</div><div class="dash-stat-label">Avg Monthly Paid</div></div>
    </div>
    <div class="dash-two-col">
      <div>
        <div class="dash-chart-card" style="margin-bottom:14px"><div class="dash-chart-title">Fee Status Overview</div><div class="dash-chart-sub">Teachers — clear vs pending</div>
          <div style="display:flex;align-items:center;gap:20px;padding-top:8px">
            <div class="dash-canvas-wrap" style="width:120px;height:120px;flex-shrink:0"><canvas id="stuDonutChart"></canvas></div>
            <div><div style="font-family:'Syne',sans-serif;font-size:36px;font-weight:800;letter-spacing:-1.5px;color:${clearRate >= 80 ? 'var(--accent3)' : totalDue2 > 0 ? 'var(--yellow)' : 'var(--accent3)'}">${clearRate}%</div>
              <div style="font-size:11px;color:var(--muted);margin-bottom:10px">fees up to date</div>
              <div style="font-size:12px;color:var(--accent3);margin-bottom:4px">✓ ${clearCount} teacher${clearCount !== 1 ? 's' : ''} — clear</div>
              <div style="font-size:12px;color:var(--red)">${overdueCount} pending</div>
            </div>
          </div>
        </div>
        <div class="dash-chart-card"><div class="dash-chart-title">Payment History</div><div class="dash-chart-sub">Amount paid — last 6 months</div><div class="dash-canvas-wrap" style="height:160px;margin-top:8px"><canvas id="stuLineChart"></canvas></div></div>
      </div>
      <div>
        <div class="dash-chart-card" style="margin-bottom:14px"><div class="dash-chart-title">Per-Teacher Dues</div><div class="dash-chart-sub">Months outstanding</div><div class="dash-canvas-wrap" style="height:${Math.max(140, tKeys.length * 44)}px;margin-top:8px"><canvas id="stuBarChart"></canvas></div></div>
        <div class="dash-insight-card"><div class="dash-insight-title" style="display:flex;align-items:center;gap:6px;margin-bottom:12px;"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="1" y="9" width="4" height="7" rx="1.2" fill="currentColor" opacity=".4"/><rect x="6" y="5" width="4" height="11" rx="1.2" fill="currentColor" opacity=".68"/><rect x="11" y="1" width="4" height="15" rx="1.2" fill="currentColor"/></svg> Teacher-wise Status</div>
          ${teacherData.map(t => { const fc = t.dm === 0 ? 'var(--accent3)' : t.cr ? 'var(--red)' : t.ov ? 'var(--yellow)' : 'var(--accent4)'; return `<div style="margin-bottom:14px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px"><span style="font-family:'Syne',sans-serif;font-size:13px;font-weight:700;color:var(--text)">${t.name}</span><span style="font-family:'Syne',sans-serif;font-size:12px;font-weight:800;color:${fc}">${dashFmt(t.da)}</span></div><div style="font-size:10px;color:var(--muted);margin-bottom:5px">${t.subject} · ${t.dm === 0 ? 'All clear' : t.dm + ' mo due'}</div><div class="dash-prog-bar"><div class="dash-prog-fill" style="width:${t.dm === 0 ? 100 : Math.min(100, t.dm * 15)}%;background:${fc}"></div></div></div>`; }).join('')}
        </div>
      </div>
    </div>
    ${payments.length ? `<div class="dash-insight-card" style="margin-top:14px"><div class="dash-insight-title" style="display:flex;align-items:center;gap:6px;margin-bottom:12px;"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" fill="currentColor" opacity=".08" stroke="currentColor" stroke-width="1.4"/><polyline points="8,4.5 8,8.5 11,10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg> Recent Payments</div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px">${[...payments].sort((a, b) => b.timestamp - a.timestamp).slice(0, 6).map(p => `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--surface2);border-radius:12px;border:1px solid var(--border)"><div style="width:28px;height:28px;border-radius:9px;background:${p.type === 'partial' ? 'rgba(255,154,60,.15)' : p.type === 'advance' ? 'rgba(124,107,255,.15)' : 'rgba(0,212,170,.15)'};display:flex;align-items:center;justify-content:center;font-family:'Syne',sans-serif;font-size:10px;font-weight:800;color:${p.type === 'partial' ? 'var(--accent4)' : p.type === 'advance' ? 'var(--accent)' : 'var(--accent3)'};flex-shrink:0">${p.type === 'partial' ? 'P' : p.type === 'advance' ? 'A' : '✓'}</div><div style="flex:1;min-width:0"><div style="font-size:12px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.teacherName || 'Teacher'}</div><div style="font-size:10px;color:var(--muted)">${p.paidOn ? p.paidOn.day + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][p.paidOn.month - 1] : '—'}</div></div><div style="font-family:'Syne',sans-serif;font-size:12px;font-weight:800;color:var(--accent3);flex-shrink:0">${dashFmt(p.amount)}</div></div>`).join('')}</div></div>` : ''}`;
  const cd = chartDefaults(isDarkMode);
  const dCtx = document.getElementById('stuDonutChart')?.getContext('2d');
  if (dCtx) stuDashCharts.push(new Chart(dCtx, { type: 'doughnut', data: { labels: ['Clear', 'Pending'], datasets: [{ data: [clearCount, overdueCount], backgroundColor: ['#00d4aa', '#ff4d6d'], borderWidth: 0, hoverOffset: 8 }] }, options: { ...cd, cutout: '72%', scales: { x: { display: false }, y: { display: false } }, plugins: { ...cd.plugins, legend: { display: false } } } }));
  const bCtx = document.getElementById('stuBarChart')?.getContext('2d');
  if (bCtx) stuDashCharts.push(new Chart(bCtx, { type: 'bar', data: { labels: teacherData.map(t => t.name.length > 14 ? t.name.slice(0, 14) + '…' : t.name), datasets: [{ label: 'Months Due', data: teacherData.map(t => t.dm), backgroundColor: teacherData.map(t => t.cr ? 'rgba(255,77,109,.8)' : t.ov ? 'rgba(255,209,102,.8)' : 'rgba(0,212,170,.8)'), borderRadius: 5, borderSkipped: false }] }, options: { ...cd, indexAxis: 'y', plugins: { ...cd.plugins, legend: { display: false } }, scales: { x: { ticks: { color: tc, font: { size: 10 }, stepSize: 1 }, grid: { color: gc } }, y: { ticks: { color: tc, font: { size: 10 } }, grid: { display: false } } } } }));
  const lCtx = document.getElementById('stuLineChart')?.getContext('2d');
  if (lCtx) stuDashCharts.push(new Chart(lCtx, { type: 'line', data: { labels: monthLabels2, datasets: [{ label: 'Paid (₹)', data: monthAmts2, borderColor: '#ff6b9d', backgroundColor: 'rgba(255,107,157,.1)', tension: .4, fill: true, pointBackgroundColor: '#ff6b9d', pointRadius: 4, borderWidth: 2 }] }, options: { ...cd, plugins: { ...cd.plugins, legend: { display: false } }, scales: { x: { ticks: { color: tc, font: { size: 10 } }, grid: { color: gc } }, y: { ticks: { color: tc, font: { size: 10 }, callback: v => v >= 1000 ? '₹' + (v / 1000).toFixed(0) + 'k' : '₹' + v }, grid: { color: gc } } } } }));
}

export function initDashboard(deps) {
  const { screenFadeTo, destroyCharts, tchDashCharts, stuDashCharts, sbSetPage } = deps;

  window.openTeacherDash = async function (force = false) {
    screenFadeTo('teacherDashScreen', 'appScreen');
    document.getElementById('teacherDashBody').innerHTML = dashSkeleton();
    const btn = document.getElementById('teacherDashRefresh'); if (btn) btn.classList.add('spinning');
    try { await renderTeacherDash(deps); }
    catch (e) { const b = document.getElementById('teacherDashBody'); if (b) b.innerHTML = `<div style="text-align:center;padding:40px;color:var(--red);font-size:13px;">Failed to load dashboard.<br><small style="color:var(--muted)">${e.message}</small></div>`; }
    if (btn) setTimeout(() => btn.classList.remove('spinning'), 600);
  };
  window.closeTeacherDash = function () {
    destroyCharts(tchDashCharts);
    screenFadeTo('appScreen', 'teacherDashScreen');
    window.sbSetActive?.('sbHome'); sbSetPage?.('home');
  };
  window.openStudentDash = function () {
    screenFadeTo('studentDashScreen', 'appScreen');
    document.getElementById('studentDashBody').innerHTML = dashSkeleton();
    renderStudentDash(deps);
  };
  window.closeStudentDash = function () {
    destroyCharts(stuDashCharts);
    screenFadeTo('appScreen', 'studentDashScreen');
    window.sbSetActive?.('sbHome'); sbSetPage?.('home');
  };
  window.renderStudentDash = () => renderStudentDash(deps);
}
