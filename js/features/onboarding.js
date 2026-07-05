// Onboarding flow — role select, name, class/subjects, first profile save.
// Lazy-loaded: only fetched the first time a user with no profile.role hits
// bootApp(). Returning users never download this chunk.
//
// init() wires window.ob* handlers because obStep*.html markup uses inline
// onclick="obX()" attributes (module scripts don't leak to global scope).
//
// deps: { toast, prRef, saveProfileToCache, updateRole, hideSplash, loadAll,
//         setDoc, getProfile, setProfile }

let obRole = '', obSubjects = [], obClasses = [];
let _deps = null;

function _hideAllObBtns() {
  ['obNextBtn1', 'obNextBtn2', 'obDoneBtn', 'obDoneTeacherBtn'].forEach(b => {
    const el = document.getElementById(b); if (el) el.style.display = 'none';
  });
}
function obShowBtn(id) {
  _hideAllObBtns();
  const el = document.getElementById(id); if (el) el.style.display = '';
}

function obAnimateStep(el) {
  if (!el) return;
  el.classList.remove('ob-step-enter');
  void el.offsetWidth;
  el.classList.add('ob-step-enter');
  el.addEventListener('animationend', () => el.classList.remove('ob-step-enter'), { once: true });
}

function obRenderSubjs() {
  const el = document.getElementById('obSubjTags'); if (!el) return;
  el.innerHTML = obSubjects.map((s, i) =>
    '<div class="ob-subj-tag">' + s + '<button class="ob-subj-rm" onclick="obRmSubj(' + i + ')">&#215;</button></div>'
  ).join('');
}
function obRenderClasses() {
  const el = document.getElementById('obClassTags'); if (!el) return;
  el.innerHTML = obClasses.map((c, i) =>
    '<div class="ob-subj-tag" style="background:rgba(0,212,170,.12);border-color:rgba(0,212,170,.25);color:var(--accent3);">' + c + '<button class="ob-subj-rm" onclick="obRmClass(' + i + ')">&#215;</button></div>'
  ).join('');
  document.querySelectorAll('#obTeacherFields .ob-chip[data-val]').forEach(ch => {
    ch.classList.toggle('sel', obClasses.includes(ch.dataset.val));
  });
}

async function obSubmit() {
  const { toast, prRef, setDoc, saveProfileToCache, updateRole, hideSplash, loadAll, setProfile } = _deps;
  const name = document.getElementById('obName').value.trim();
  if (!name) { toast('Enter your name first', 'error'); return; }
  if (!obRole) { toast('Select a role first', 'error'); return; }
  const btnId = obRole === 'student' ? 'obDoneBtn' : 'obDoneTeacherBtn';
  const btn = document.getElementById(btnId);
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  const d = { role: obRole, displayName: name, updatedAt: Date.now() };
  if (obRole === 'student') {
    d.className = document.getElementById('obClass').value.trim();
  } else {
    if (!obSubjects.length) { if (btn) { btn.disabled = false; btn.textContent = 'Get Started →'; } return toast('Add at least one subject', 'error'); }
    d.subjects = [...obSubjects];
    d.classes = [...obClasses];
    d.session = document.getElementById('obSession').value.trim();
  }
  try {
    await setDoc(prRef(), d);
    setProfile(d); saveProfileToCache(d); updateRole();
    document.getElementById('onboardScreen').classList.add('hidden');
    hideSplash();
    document.getElementById('appScreen').classList.remove('hidden');
    await loadAll();
    toast('Welcome, ' + name.split(' ')[0] + '!', 'success');
  } catch (e) { toast('Save failed: ' + e.message, 'error'); }
  if (btn) { btn.disabled = false; btn.textContent = 'Get Started →'; }
}

/** Call once, right before the onboarding screen is unhidden. Attaches all
 *  window.ob* handlers the inline HTML onclick attributes need, and binds
 *  the one-time input listeners for the name/class fields. */
export function initOnboarding(deps) {
  _deps = deps;
  const { toast } = deps;

  window.obSelectRole = function (r) {
    obRole = r;
    document.getElementById('obRoleS').className = 'ob-role-card' + (r === 'student' ? ' sel-s' : '');
    document.getElementById('obRoleT').className = 'ob-role-card' + (r === 'teacher' ? ' sel-t' : '');
    const cs = document.getElementById('obCheckS'), ct = document.getElementById('obCheckT');
    const SVG_CHECK = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><polyline points="1.5,5 4,8 8.5,2" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    if (cs) cs.innerHTML = r === 'student' ? SVG_CHECK : '';
    if (ct) ct.innerHTML = r === 'teacher' ? SVG_CHECK : '';
    obShowBtn('obNextBtn1');
  };

  function obSetStep(n) {
    document.querySelectorAll('#obProgress .ob-progress-dot').forEach(dot => {
      const s = Number(dot.dataset.step);
      dot.classList.toggle('active', s === n);
      dot.classList.toggle('done', s < n);
    });
  }

  window.obNext = function (from) {
    if (from === 1) {
      if (!obRole) { toast('Please select Student or Teacher', 'error'); return; }
      document.getElementById('obStep1').classList.add('hidden');
      const s2 = document.getElementById('obStep2');
      s2.classList.remove('hidden');
      obAnimateStep(s2);
      obSetStep(2);
      const preN = document.getElementById('obName').value.trim();
      obShowBtn(preN ? 'obNextBtn2' : '__none__');
      setTimeout(() => document.getElementById('obName')?.focus(), 100);
    } else if (from === 2) {
      const name = document.getElementById('obName').value.trim();
      if (!name) { toast('Please enter your name', 'error'); return; }
      document.getElementById('obStep2').classList.add('hidden');
      obSetStep(3);
      if (obRole === 'student') {
        const sf = document.getElementById('obStudentFields');
        sf.classList.remove('hidden');
        obAnimateStep(sf);
      } else {
        const tf = document.getElementById('obTeacherFields');
        tf.classList.remove('hidden');
        obAnimateStep(tf);
      }
      _hideAllObBtns();
    }
  };

  // from = the step being left (2 = leaving name step back to role select,
  // 3 = leaving the student/teacher details step back to name)
  window.obBack = function (from) {
    if (from === 2) {
      document.getElementById('obStep2').classList.add('hidden');
      const s1 = document.getElementById('obStep1');
      s1.classList.remove('hidden');
      obAnimateStep(s1);
      obSetStep(1);
    } else if (from === 3) {
      document.getElementById('obStudentFields').classList.add('hidden');
      document.getElementById('obTeacherFields').classList.add('hidden');
      const s2 = document.getElementById('obStep2');
      s2.classList.remove('hidden');
      obAnimateStep(s2);
      obSetStep(2);
      const name = document.getElementById('obName').value.trim();
      obShowBtn(name ? 'obNextBtn2' : '__none__');
    }
  };

  window.obChip = function (el) {
    document.querySelectorAll('.ob-chip').forEach(c => c.classList.remove('sel'));
    el.classList.add('sel');
    document.getElementById('obClass').value = el.dataset.val;
    obShowBtn('obDoneBtn');
  };

  window.obAddSubj = function () {
    const inp = document.getElementById('obSubjInp'), v = inp.value.trim();
    if (!v) return;
    if (!obSubjects.includes(v)) obSubjects.push(v);
    inp.value = ''; inp.focus(); obRenderSubjs();
    if (obSubjects.length > 0) obShowBtn('obDoneTeacherBtn');
  };
  window.obRmSubj = function (i) {
    obSubjects.splice(i, 1); obRenderSubjs();
    if (obSubjects.length === 0) _hideAllObBtns();
  };

  window.obAddClass = function () {
    const inp = document.getElementById('obClassInp'), v = inp.value.trim();
    if (!v) return;
    if (!obClasses.includes(v)) obClasses.push(v);
    inp.value = ''; inp.focus(); obRenderClasses();
  };
  window.obRmClass = function (i) { obClasses.splice(i, 1); obRenderClasses(); };
  window.obToggleClassChip = function (el) {
    const v = el.dataset.val;
    if (obClasses.includes(v)) obClasses = obClasses.filter(c => c !== v);
    else obClasses.push(v);
    obRenderClasses();
  };

  window.obSubmit = obSubmit;

  document.getElementById('obName')?.addEventListener('input', () => {
    const v = document.getElementById('obName').value.trim();
    const btn = document.getElementById('obNextBtn2');
    if (btn && !document.getElementById('obStep2').classList.contains('hidden'))
      btn.style.display = v ? '' : 'none';
  });
  document.getElementById('obName')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); window.obNext(2); }
  });
  document.getElementById('obClass')?.addEventListener('input', () => {
    const v = document.getElementById('obClass').value.trim();
    document.querySelectorAll('.ob-chip').forEach(c => c.classList.toggle('sel', c.dataset.val === v));
    const btn = document.getElementById('obDoneBtn');
    if (btn) btn.style.display = v ? '' : 'none';
  });
  document.getElementById('obSubjInp')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); window.obAddSubj(); }
  });
}
