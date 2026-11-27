// ChemFlow Web — Phase 1 app logic
// Multi-tenant PWA on Supabase (Postgres + Auth + Storage, RLS-enforced tenancy).
(function(){
'use strict';
if(!window.CF_CONFIG || !window.CF_CONFIG.url || window.CF_CONFIG.url.indexOf('YOUR-PROJECT') === 0){
  document.body.innerHTML = '<p style="padding:20px;font-family:sans-serif">ChemFlow is not configured yet (missing backend keys in config.js).</p>';
  return;
}
var sb = window.supabase.createClient(window.CF_CONFIG.url, window.CF_CONFIG.anonKey);

// Steps seeded for a new business's "Standard Visit" template — the exact
// Genesis ChemFlo template steps (read from the sheet 2026-11-26); editable
// per business in Settings.
var DEFAULT_STEPS = ["Check probe is online", "Log chemistry (pH, ORP, chlorine)", "Check dispenser status", "Add service notes"];

var me = null;          // profile row
var business = null;    // business row
var profilesMap = {};   // id -> profile
var template = null;    // checklist template row
var ci = null;          // active check-in state
var editingCustomerId = null;

function $(id){ return document.getElementById(id); }
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function num(id){ var v = $(id).value.trim(); if(v === '') return null; var n = parseFloat(v); return isNaN(n) ? null : n; }
function showErr(id, msg){ var e = $(id); if(!e) return; e.textContent = msg || ''; e.style.display = msg ? 'block' : 'none'; }
function showOk(id, msg){ var e = $(id); if(!e) return; e.textContent = msg || ''; e.style.display = msg ? 'block' : 'none'; }
function todayName(){ return new Date().toLocaleDateString('en-US', { weekday: 'long' }); }
function dateKey(){ return new Date().toLocaleDateString('en-CA'); } // YYYY-MM-DD local
function dayBoundsISO(){
  var start = new Date(); start.setHours(0,0,0,0);
  var end = new Date(start); end.setDate(end.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

/* ---------------- offline queue (IndexedDB) ---------------- */
var idb = null;
function idbOpen(){
  return new Promise(function(res, rej){
    if(idb) return res(idb);
    var req = indexedDB.open('chemflow', 1);
    req.onupgradeneeded = function(){ req.result.createObjectStore('queue', { keyPath: 'qid', autoIncrement: true }); };
    req.onsuccess = function(){ idb = req.result; res(idb); };
    req.onerror = function(){ rej(req.error); };
  });
}
function queueAdd(item){
  return idbOpen().then(function(db){
    return new Promise(function(res, rej){
      var tx = db.transaction('queue', 'readwrite');
      tx.objectStore('queue').add(item);
      tx.oncomplete = res; tx.onerror = function(){ rej(tx.error); };
    });
  });
}
function queueAll(){
  return idbOpen().then(function(db){
    return new Promise(function(res, rej){
      var out = [];
      var cur = db.transaction('queue', 'readonly').objectStore('queue').openCursor();
      cur.onsuccess = function(){ var c = cur.result; if(c){ out.push(c.value); c.continue(); } else res(out); };
      cur.onerror = function(){ rej(cur.error); };
    });
  });
}
function queueRemove(qid){
  return idbOpen().then(function(db){
    return new Promise(function(res){
      var tx = db.transaction('queue', 'readwrite');
      tx.objectStore('queue').delete(qid);
      tx.oncomplete = res; tx.onerror = res;
    });
  });
}
function pendingSet(){
  try { return JSON.parse(localStorage.getItem('cf_pending_' + dateKey()) || '[]'); } catch(e){ return []; }
}
function markPending(customerId){
  var s = pendingSet(); if(s.indexOf(customerId) < 0) s.push(customerId);
  localStorage.setItem('cf_pending_' + dateKey(), JSON.stringify(s));
}

/* ------- one-tap check-in helpers (Carter's rule, 2026-11-26) ------- */
function newUuid(){
  if(window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(ch){ var r = (Math.random() * 16) | 0; var v = ch === 'x' ? r : ((r & 0x3) | 0x8); return v.toString(16); });
}
function getPos(){
  // GPS is a bonus, never a blocker: resolve with the position if the phone
  // offers one quickly, otherwise null after ~3.5s.
  return new Promise(function(res){
    if(!navigator.geolocation) return res(null);
    var done = false;
    var t = setTimeout(function(){ if(!done){ done = true; res(null); } }, 3500);
    try {
      navigator.geolocation.getCurrentPosition(function(p){
        if(done) return; done = true; clearTimeout(t);
        res({ lat: p.coords.latitude, lng: p.coords.longitude });
      }, function(){ if(!done){ done = true; clearTimeout(t); res(null); } }, { timeout: 10000, maximumAge: 60000 });
    } catch(e){ if(!done){ done = true; clearTimeout(t); res(null); } }
  });
}
function fmtTime(iso){
  var d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function localOpenMap(){
  try { return JSON.parse(localStorage.getItem('cf_open_' + dateKey()) || '{}'); } catch(e){ return {}; }
}
function setLocalOpen(customerId, visitId, startedAtIso){
  var m = localOpenMap(); m[customerId] = { visitId: visitId, startedAt: startedAtIso };
  try { localStorage.setItem('cf_open_' + dateKey(), JSON.stringify(m)); } catch(e){}
}
function clearLocalOpen(customerId, visitId){
  var m = localOpenMap();
  if(m[customerId] && (!visitId || m[customerId].visitId === visitId)) delete m[customerId];
  try { localStorage.setItem('cf_open_' + dateKey(), JSON.stringify(m)); } catch(e){}
}

/* ---------------- auth & bootstrap ---------------- */
var signupMode = false;
function setAuthMode(signup){
  signupMode = signup;
  $('auth-title').textContent = signup ? 'Create account' : 'Sign in';
  $('btn-auth-main').textContent = signup ? 'Create account' : 'Sign in';
  $('auth-bizname-wrap').classList.toggle('hidden', !signup);
  $('btn-auth-toggle').textContent = signup ? 'Already have an account? Sign in' : 'New here? Create account';
  $('auth-password').setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
}
$('btn-auth-toggle').addEventListener('click', function(){ showErr('auth-err',''); showOk('auth-ok',''); setAuthMode(!signupMode); });

$('btn-auth-main').addEventListener('click', function(){
  var email = $('auth-email').value.trim(), pw = $('auth-password').value;
  showErr('auth-err',''); showOk('auth-ok','');
  if(!email || !pw){ showErr('auth-err','Enter your email and password.'); return; }
  if(signupMode){
    localStorage.setItem('cf_pending_biz', JSON.stringify({ bizName: $('auth-bizname').value.trim(), name: $('auth-name').value.trim() }));
    sb.auth.signUp({ email: email, password: pw }).then(function(r){
      if(r.error){ showErr('auth-err', r.error.message); return; }
      if(!r.data.session){ showOk('auth-ok','Account created — check your email to confirm, then sign in.'); setAuthMode(false); return; }
      boot();
    });
  } else {
    sb.auth.signInWithPassword({ email: email, password: pw }).then(function(r){
      if(r.error){ showErr('auth-err', r.error.message); return; }
      boot();
    });
  }
});
$('btn-signout').addEventListener('click', function(){ sb.auth.signOut().then(function(){ location.reload(); }); });

function boot(){
  sb.auth.getUser().then(function(r){
    if(r.error || !r.data.user){ return; }
    var user = r.data.user;
    sb.from('profiles').select('*').eq('id', user.id).maybeSingle().then(function(pr){
      if(pr.data){ me = pr.data; enterApp(); return; }
      // No profile yet: invited?
      sb.from('invites').select('*').eq('email', user.email).then(function(inv){
        if(inv.data && inv.data.length){
          var invite = inv.data[0];
          var pend = {};
          try { pend = JSON.parse(localStorage.getItem('cf_pending_biz') || '{}'); } catch(e){}
          var prof = { id: user.id, business_id: invite.business_id, role: invite.role, email: user.email, name: pend.name || user.email.split('@')[0] };
          sb.from('profiles').insert(prof).then(function(ins){
            if(ins.error){ showErr('auth-err', ins.error.message); return; }
            me = prof;
            sb.from('invites').delete().eq('id', invite.id);
            localStorage.removeItem('cf_pending_biz');
            enterApp();
          });
          return;
        }
        // Not invited: create a new business (owner).
        showSetupCard(user);
      });
    });
  });
}

function showSetupCard(user){
  $('view-auth').classList.add('hidden');
  $('view-app').classList.remove('hidden');
  var pend = {};
  try { pend = JSON.parse(localStorage.getItem('cf_pending_biz') || '{}'); } catch(e){}
  var wrap = document.createElement('div');
  wrap.className = 'card';
  wrap.innerHTML = '<h3>Set up your business</h3>' +
    '<p class="muted">You are signed in as ' + esc(user.email) + '. Name your pool service business to finish.</p>' +
    '<label>Business name</label><input id="setup-biz" type="text" value="' + esc(pend.bizName || '') + '">' +
    '<label>Your name</label><input id="setup-name" type="text" value="' + esc(pend.name || '') + '">' +
    '<div class="err" id="setup-err"></div>' +
    '<button class="primary" id="btn-setup">Create business</button>';
  $('view-app').prepend(wrap);
  $('btn-setup').addEventListener('click', function(){
    var bizName = $('setup-biz').value.trim(), myName = $('setup-name').value.trim();
    if(!bizName){ showErr('setup-err','Business name is required.'); return; }
    // Client-generated id: the app must not read the new row back, because the
    // caller's profile (which the businesses SELECT policy keys off) is only
    // created next, using this id — an INSERT ... RETURNING fails RLS for a
    // first-time owner (chicken-and-egg, found by the 2026-11-26 re-test).
    var bizId = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(ch){ var r = (Math.random() * 16) | 0; var v = ch === 'x' ? r : ((r & 0x3) | 0x8); return v.toString(16); });
    sb.from('businesses').insert({ id: bizId, name: bizName, owner_email: user.email }).then(function(b){
      if(b.error){ showErr('setup-err', b.error.message); return; }
      var prof = { id: user.id, business_id: bizId, role: 'owner', email: user.email, name: myName || user.email.split('@')[0] };
      sb.from('profiles').insert(prof).then(function(ins){
        if(ins.error){ showErr('setup-err', ins.error.message); return; }
        me = prof;
        sb.from('checklist_templates').insert({ business_id: bizId, name: 'Standard Visit', steps: DEFAULT_STEPS }).then(function(){
          localStorage.removeItem('cf_pending_biz');
          wrap.remove();
          enterApp();
        });
      });
    });
  });
}

function enterApp(){
  $('view-auth').classList.add('hidden');
  $('view-app').classList.remove('hidden');
  $('tabbar').classList.remove('hidden');
  $('btn-signout').classList.remove('hidden');
  sb.from('businesses').select('*').eq('id', me.business_id).single().then(function(b){
    business = b.data || { name: 'ChemFlow' };
    $('hdr-sub').textContent = business.name + ' · ' + (me.name || me.email) + (me.role === 'owner' ? ' (owner)' : ' (tech)');
    $('about-line').textContent = business.name + ' · Signed in as ' + me.email + ' · Role: ' + me.role;
    loadProfiles().then(function(){
      loadTemplate();
      showTab('route');
      renderRoute();
      renderCustomers();
      renderTeam();
      renderSteps();
      updateQueueBar();
      flushQueue();
    });
  });
}
function loadProfiles(){
  return sb.from('profiles').select('*').eq('business_id', me.business_id).then(function(r){
    profilesMap = {};
    (r.data || []).forEach(function(p){ profilesMap[p.id] = p; });
  });
}
function loadTemplate(){
  return sb.from('checklist_templates').select('*').eq('business_id', me.business_id).limit(1).then(function(r){
    template = (r.data && r.data[0]) || null;
  });
}

/* ---------------- tabs ---------------- */
function showTab(name){
  ['route','customers','team','settings'].forEach(function(t){
    $('tab-' + t).classList.toggle('hidden', t !== name);
  });
  $('tab-checkin').classList.add('hidden');
  document.querySelectorAll('nav.tabs button').forEach(function(b){
    b.classList.toggle('active', b.getAttribute('data-tab') === name);
  });
  if(name === 'route') renderRoute();
  if(name === 'customers') renderCustomers();
  if(name === 'team') renderTeam();
  if(name === 'settings') renderSteps();
}
document.querySelectorAll('nav.tabs button').forEach(function(b){
  b.addEventListener('click', function(){ showTab(b.getAttribute('data-tab')); });
});

/* ---------------- route ---------------- */
function renderRoute(){
  var day = todayName();
  $('route-title').textContent = "Today's Stops · " + day;
  var bounds = dayBoundsISO();
  var q = sb.from('customers').select('*')
    .eq('business_id', me.business_id).eq('service_day', day).eq('active', true)
    .order('name');
  if(me.role === 'tech') q = q.eq('technician_id', me.id);
  q.then(function(r){
    if(r.error){ renderRouteFromCache('Could not load stops (offline?). Showing the last saved list.'); return; }
    var customers = r.data || [];
    var ids = customers.map(function(c){ return c.id; });
    var visitedP = ids.length
      ? sb.from('visits').select('id, customer_id, ph, orp, tds, temp, fc, tc, ta, th, stabilizer, notes, started_at, finished_at').eq('business_id', me.business_id)
          .gte('started_at', bounds.start).lt('started_at', bounds.end)
        .then(function(v){ return v.data || []; })
      : Promise.resolve([]);
    var lastP = ids.length
      ? sb.from('visits').select('customer_id, ph, orp, tds, temp, started_at').eq('business_id', me.business_id)
          .in('customer_id', ids).order('started_at', { ascending: false })
        .then(function(v){ return v.data || []; })
      : Promise.resolve([]);
    var bodyP = ids.length
      ? sb.from('bodies_of_water').select('id, customer_id').eq('business_id', me.business_id)
          .in('customer_id', ids)
        .then(function(v){ return v.data || []; })
      : Promise.resolve([]);
    Promise.all([visitedP, lastP, bodyP]).then(function(res){
      var bodyByCust = {};
      res[2].forEach(function(b){ if(!bodyByCust[b.customer_id]) bodyByCust[b.customer_id] = b.id; });
      customers.forEach(function(c){ c._bodyId = bodyByCust[c.id] || null; });
      var visitedIds = {};
      var openVisits = {};
      res[0].forEach(function(v){
        if(v.finished_at) visitedIds[v.customer_id] = true;
        else if(!openVisits[v.customer_id]) openVisits[v.customer_id] = v;
      });
      var lastByCust = {};
      res[1].forEach(function(v){ if(!lastByCust[v.customer_id]) lastByCust[v.customer_id] = v; });
      var payload = { customers: customers, visitedIds: visitedIds, openVisits: openVisits, lastByCust: lastByCust, profilesMap: profilesMap, templateSteps: template ? template.steps : DEFAULT_STEPS, savedAt: Date.now() };
      try { localStorage.setItem('cf_route_' + dateKey(), JSON.stringify(payload)); } catch(e){}
      drawRoute(payload);
    });
  });
}
function renderRouteFromCache(note){
  var raw = null;
  try { raw = localStorage.getItem('cf_route_' + dateKey()); } catch(e){}
  if(!raw){ $('route-list').innerHTML = '<div class="card"><p class="muted">' + esc(note) + ' No saved list for today yet — connect once to load it.</p></div>'; return; }
  var payload = JSON.parse(raw);
  profilesMap = payload.profilesMap || profilesMap;
  drawRoute(payload, note);
}
function drawRoute(payload, note){
  var pend = pendingSet();
  var html = '';
  if(note) html += '<div class="card"><p class="muted">' + esc(note) + '</p></div>';
  if(!payload.customers.length){
    html += '<div class="card"><p class="muted">No stops scheduled for today. Enjoy the quiet — or check Customers for the week\'s list.</p></div>';
  }
  var localOpen = localOpenMap();
  payload.customers.forEach(function(c){
    var serverOpen = (payload.openVisits || {})[c.id];
    var localRec = localOpen[c.id];
    var openInfo = serverOpen
      ? { visitId: serverOpen.id, startedAt: serverOpen.started_at }
      : (localRec ? { visitId: localRec.visitId, startedAt: localRec.startedAt } : null);
    var done = !openInfo && (payload.visitedIds[c.id] || pend.indexOf(c.id) >= 0);
    var last = payload.lastByCust[c.id];
    var chip = last && last.ph != null
      ? '<span class="chip">Last: pH ' + esc(last.ph) + ' · ORP ' + esc(last.orp == null ? '—' : last.orp) + '</span>'
      : '<span class="chip">No readings yet</span>';
    var techName = c.technician_id && payload.profilesMap[c.technician_id] ? payload.profilesMap[c.technician_id].name || payload.profilesMap[c.technician_id].email : 'Unassigned';
    var action = '';
    if(openInfo){
      action = ' <span class="chip done">Checked in · ' + esc(fmtTime(openInfo.startedAt)) + '</span>' +
        '<div class="rowbtns"><button class="ghost" data-act="details" data-cust="' + c.id + '">Add details</button>' +
        '<button class="ghost" data-act="checkout" data-cust="' + c.id + '">Check Out</button></div>';
    } else if(done){
      action = ' <span class="chip done">Visited today</span>';
    } else {
      action = '<div class="rowbtns"><button class="ghost" data-act="checkin" data-cust="' + c.id + '">Check In</button></div>';
    }
    html += '<div class="card stopcard" data-cust="' + c.id + '">' +
      '<h3>' + esc(c.name) + '</h3>' +
      '<div class="muted">' + esc(c.address || '') + '</div>' +
      '<div class="muted">Tech: ' + esc(techName) + '</div>' +
      chip + action +
      '</div>';
  });
  $('route-list').innerHTML = html;
  Array.prototype.forEach.call(document.querySelectorAll('.stopcard'), function(el){
    el.addEventListener('click', function(){
      var id = el.getAttribute('data-cust');
      var cust = payload.customers.filter(function(c){ return c.id === id; })[0];
      if(cust) openCheckin(cust, payload);
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-act]'), function(btn){
    btn.addEventListener('click', function(ev){
      ev.stopPropagation();
      var id = btn.getAttribute('data-cust');
      var cust = payload.customers.filter(function(c){ return c.id === id; })[0];
      if(!cust) return;
      var act = btn.getAttribute('data-act');
      if(act === 'checkin'){
        btn.disabled = true; btn.textContent = 'Checking in…';
        doCheckin(cust).then(function(){ renderRoute(); });
      } else if(act === 'details'){
        openCheckin(cust, payload);
      } else if(act === 'checkout'){
        var serverOpen = (payload.openVisits || {})[cust.id];
        var localRec = localOpenMap()[cust.id];
        var info = serverOpen
          ? { visitId: serverOpen.id, startedAt: serverOpen.started_at }
          : (localRec ? { visitId: localRec.visitId, startedAt: localRec.startedAt } : null);
        if(info){
          btn.disabled = true; btn.textContent = 'Checking out…';
          doCheckoutFor(cust, info).then(function(){ renderRoute(); });
        }
      }
    });
  });
}

/* ---------------- check-in (one tap; everything else optional) ---------------- */
function doCheckin(customer){
  var startedAt = new Date();
  var visitId = newUuid();
  return getPos().then(function(pos){
    var visit = {
      id: visitId,
      business_id: me.business_id,
      customer_id: customer.id,
      body_id: customer._bodyId || null,
      tech_id: me.id,
      started_at: startedAt.toISOString(),
      label: 'Web Check-In',
      checkin_lat: pos ? pos.lat : null,
      checkin_lng: pos ? pos.lng : null
    };
    var info = { visitId: visitId, startedAt: visit.started_at };
    var queued = function(){
      return queueAdd({ type: 'checkin', visit: visit }).then(function(){
        setLocalOpen(customer.id, visitId, visit.started_at);
        updateQueueBar();
        return info;
      });
    };
    if(!navigator.onLine) return queued();
    return sb.from('visits').upsert(visit).then(function(r){
      if(r.error) return queued();
      setLocalOpen(customer.id, visitId, visit.started_at);
      return info;
    }).catch(queued);
  });
}
function doCheckoutFor(customer, openInfo){
  var finished = new Date();
  var started = new Date(openInfo.startedAt);
  return getPos().then(function(pos){
    var patch = {
      finished_at: finished.toISOString(),
      duration_sec: Math.max(0, Math.round((finished - started) / 1000)),
      checkout_lat: pos ? pos.lat : null,
      checkout_lng: pos ? pos.lng : null
    };
    var doneLocal = function(){ clearLocalOpen(customer.id, openInfo.visitId); markPending(customer.id); };
    var queued = function(){
      return queueAdd({ type: 'checkout', visitId: openInfo.visitId, customerId: customer.id, patch: patch }).then(function(){
        doneLocal(); updateQueueBar();
      });
    };
    if(!navigator.onLine) return queued();
    return sb.from('visits').update(patch).eq('id', openInfo.visitId).then(function(r){
      if(r.error) return queued();
      doneLocal();
    }).catch(queued);
  });
}
function refreshCiChrome(){
  var open = !!(ci && ci.visitId);
  $('btn-checkin').classList.toggle('hidden', open);
  $('btn-save-details').classList.toggle('hidden', !open);
  $('btn-checkout').classList.toggle('hidden', !open);
  $('ci-status').textContent = open
    ? 'Checked in at ' + fmtTime(ci.startedAt.toISOString()) + ' — everything below is optional.'
    : 'Not checked in yet — tap Check In when you arrive. Nothing else is required.';
}
function openCheckin(customer, routePayload){
  var steps = (template && template.steps) || (routePayload && routePayload.templateSteps) || DEFAULT_STEPS;
  var last = routePayload && routePayload.lastByCust ? routePayload.lastByCust[customer.id] : null;
  var serverOpen = routePayload && routePayload.openVisits ? routePayload.openVisits[customer.id] : null;
  var localRec = localOpenMap()[customer.id];
  var openRow = serverOpen || null;
  var openInfo = serverOpen
    ? { visitId: serverOpen.id, startedAt: serverOpen.started_at }
    : (localRec ? { visitId: localRec.visitId, startedAt: localRec.startedAt } : null);
  ci = { customer: customer, visitId: openInfo ? openInfo.visitId : null, startedAt: openInfo ? new Date(openInfo.startedAt) : null, photos: [], steps: steps };
  ['route','customers','team','settings'].forEach(function(t){ $('tab-' + t).classList.add('hidden'); });
  $('tab-checkin').classList.remove('hidden');
  $('ci-name').textContent = customer.name;
  $('ci-address').textContent = customer.address || '';
  $('ci-nav').href = 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(customer.address || customer.name);
  if(customer.phone){
    $('ci-call').href = 'tel:' + customer.phone; $('ci-call').classList.remove('hidden');
    $('ci-text').href = 'sms:' + customer.phone; $('ci-text').classList.remove('hidden');
  } else { $('ci-call').classList.add('hidden'); $('ci-text').classList.add('hidden'); }
  // Prefill: the open visit's own saved readings win; otherwise the most
  // recent visit's (device prefill arrives with the device layer).
  var src = openRow || last;
  $('ci-ph').value = src && src.ph != null ? src.ph : '';
  $('ci-orp').value = src && src.orp != null ? src.orp : '';
  $('ci-tds').value = src && src.tds != null ? src.tds : '';
  $('ci-temp').value = src && src.temp != null ? src.temp : '';
  $('ci-fc').value = openRow && openRow.fc != null ? openRow.fc : '';
  $('ci-tc').value = openRow && openRow.tc != null ? openRow.tc : '';
  $('ci-ta').value = openRow && openRow.ta != null ? openRow.ta : '';
  $('ci-th').value = openRow && openRow.th != null ? openRow.th : '';
  $('ci-stab').value = openRow && openRow.stabilizer != null ? openRow.stabilizer : '';
  $('ci-notes').value = openRow && openRow.notes ? openRow.notes : '';
  $('ci-prefill-note').textContent = openRow
    ? 'Showing this visit\u2019s saved details — edit and tap Save details to update.'
    : (last ? 'Pre-filled from the last visit — confirm or correct before saving.' : '');
  showErr('ci-err',''); showOk('ci-ok','');
  $('ci-checklist').innerHTML = steps.map(function(s, i){
    return '<label class="checkrow"><input type="checkbox" id="ci-step-' + i + '"><span>' + esc(s) + '</span></label>';
  }).join('');
  $('ci-photoprev').innerHTML = '';
  $('ci-photos').value = '';
  refreshCiChrome();
  if(openInfo && navigator.onLine){
    var vid = openInfo.visitId;
    sb.from('visit_checklist').select('step_label, done').eq('visit_id', vid).then(function(r){
      if(!ci || ci.visitId !== vid) return;
      var doneMap = {};
      (r.data || []).forEach(function(row){ doneMap[row.step_label] = row.done; });
      ci.steps.forEach(function(s, i){
        var box = $('ci-step-' + i);
        if(box && doneMap[s]) box.checked = true;
      });
    });
  }
  window.scrollTo(0, 0);
}
$('btn-back-route').addEventListener('click', function(){ ci = null; showTab('route'); });
$('btn-checkin').addEventListener('click', function(){
  if(!ci || ci.visitId) return;
  var btn = $('btn-checkin');
  btn.disabled = true; btn.textContent = 'Checking in…';
  doCheckin(ci.customer).then(function(info){
    ci.visitId = info.visitId;
    ci.startedAt = new Date(info.startedAt);
    btn.disabled = false; btn.textContent = 'Check In';
    refreshCiChrome();
    showOk('ci-ok', 'Checked in at ' + fmtTime(info.startedAt) + '. Add any details below — or just Check Out when you leave.');
  });
});

function compressImage(file){
  return new Promise(function(res){
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function(){
      var scale = Math.min(1, 1280 / Math.max(img.width, img.height));
      var cv = document.createElement('canvas');
      cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      cv.toBlob(function(b){ res(b || file); }, 'image/jpeg', 0.72);
    };
    img.onerror = function(){ URL.revokeObjectURL(url); res(file); };
    img.src = url;
  });
}
$('ci-photos').addEventListener('change', function(){
  var files = Array.prototype.slice.call($('ci-photos').files || []);
  files.forEach(function(f){
    compressImage(f).then(function(blob){
      ci.photos.push(blob);
      var img = document.createElement('img');
      img.src = URL.createObjectURL(blob);
      $('ci-photoprev').appendChild(img);
    });
  });
});

function blobToDataURL(blob){
  return new Promise(function(res){ var r = new FileReader(); r.onload = function(){ res(r.result); }; r.readAsDataURL(blob); });
}
function dataURLToBlob(d){
  return fetch(d).then(function(r){ return r.blob(); });
}

function collectDetails(){
  return {
    fields: {
      ph: num('ci-ph'), orp: num('ci-orp'), temp: num('ci-temp'),
      fc: num('ci-fc'), tc: num('ci-tc'), tds: num('ci-tds'),
      ta: num('ci-ta'), th: num('ci-th'), stabilizer: num('ci-stab'),
      notes: $('ci-notes').value.trim() || null
    },
    checklist: ci.steps.map(function(s, i){
      return { step_label: s, done: $('ci-step-' + i).checked };
    })
  };
}

function saveDetailsOnline(visitId, details, photoBlobs){
  return sb.from('visits').update(details.fields).eq('id', visitId).then(function(r){
    if(r.error) throw r.error;
    return sb.from('visit_checklist').delete().eq('visit_id', visitId);
  }).then(function(r){
    if(r && r.error) throw r.error;
    var chain = Promise.resolve();
    details.checklist.forEach(function(item){
      chain = chain.then(function(){
        return sb.from('visit_checklist').insert({ business_id: me.business_id, visit_id: visitId, step_label: item.step_label, done: item.done })
          .then(function(rr){ if(rr.error) throw rr.error; });
      });
    });
    photoBlobs.forEach(function(blob, i){
      chain = chain.then(function(){
        var path = me.business_id + '/' + visitId + '/' + Date.now() + '-' + i + '.jpg';
        return sb.storage.from('visit-photos').upload(path, blob, { contentType: 'image/jpeg' })
          .then(function(rr){
            if(rr.error) throw rr.error;
            return sb.from('visit_photos').insert({ business_id: me.business_id, visit_id: visitId, storage_path: path });
          }).then(function(rr){ if(rr && rr.error) throw rr.error; });
      });
    });
    return chain;
  });
}

// Used only to flush legacy queue items written by the pre-one-tap version
// (a whole visit saved in one go).
function submitVisitOnline(payload, photoBlobs){
  return sb.from('visits').insert(payload.visit).select().single().then(function(v){
    if(v.error) throw v.error;
    var visitId = v.data.id;
    var chain = Promise.resolve();
    payload.checklist.forEach(function(item){
      chain = chain.then(function(){
        return sb.from('visit_checklist').insert({ business_id: me.business_id, visit_id: visitId, step_label: item.step_label, done: item.done })
          .then(function(r){ if(r.error) throw r.error; });
      });
    });
    photoBlobs.forEach(function(blob, i){
      chain = chain.then(function(){
        var path = me.business_id + '/' + visitId + '/' + Date.now() + '-' + i + '.jpg';
        return sb.storage.from('visit-photos').upload(path, blob, { contentType: 'image/jpeg' })
          .then(function(r){
            if(r.error) throw r.error;
            return sb.from('visit_photos').insert({ business_id: me.business_id, visit_id: visitId, storage_path: path });
          }).then(function(r){ if(r && r.error) throw r.error; });
      });
    });
    return chain.then(function(){ return visitId; });
  });
}

$('btn-save-details').addEventListener('click', function(){
  if(!ci || !ci.visitId) return;
  showErr('ci-err',''); showOk('ci-ok','');
  var details = collectDetails();
  var blobs = ci.photos.slice();
  var visitId = ci.visitId;
  var clearPhotos = function(){ ci.photos = []; $('ci-photoprev').innerHTML = ''; $('ci-photos').value = ''; };
  if(navigator.onLine){
    saveDetailsOnline(visitId, details, blobs).then(function(){
      clearPhotos();
      showOk('ci-ok','Details saved.');
    }).catch(function(){
      queueDetails(visitId, details, blobs).then(function(){
        clearPhotos();
        showOk('ci-ok','Saved on this phone — will sync when you have signal.');
      });
    });
  } else {
    queueDetails(visitId, details, blobs).then(function(){
      clearPhotos();
      showOk('ci-ok','Saved on this phone — will sync when you have signal.');
    });
  }
});
function queueDetails(visitId, details, photoBlobs){
  return Promise.all(photoBlobs.map(blobToDataURL)).then(function(urls){
    return queueAdd({ type: 'details', visitId: visitId, fields: details.fields, checklist: details.checklist, photoDataUrls: urls, queuedAt: Date.now() });
  }).then(updateQueueBar);
}
$('btn-checkout').addEventListener('click', function(){
  if(!ci || !ci.visitId) return;
  var cust = ci.customer;
  var info = { visitId: ci.visitId, startedAt: ci.startedAt.toISOString() };
  var btn = $('btn-checkout');
  btn.disabled = true; btn.textContent = 'Checking out…';
  doCheckoutFor(cust, info).then(function(){
    ci = null;
    showTab('route');
  });
});
function updateQueueBar(){
  queueAll().then(function(items){
    var bar = $('queuebar');
    if(items.length){
      bar.style.display = 'block';
      bar.textContent = items.length + ' visit(s) saved on this phone, waiting to sync. They send automatically when you have signal.';
    } else bar.style.display = 'none';
  }).catch(function(){});
}
function flushQueue(){
  if(!navigator.onLine || !me) return;
  queueAll().then(function(items){
    var chain = Promise.resolve();
    items.forEach(function(item){
      chain = chain.then(function(){
        var op;
        if(item.type === 'checkin'){
          op = sb.from('visits').upsert(item.visit).then(function(r){ if(r.error) throw r.error; });
        } else if(item.type === 'details'){
          op = Promise.all((item.photoDataUrls || []).map(dataURLToBlob)).then(function(blobs){
            return saveDetailsOnline(item.visitId, { fields: item.fields, checklist: item.checklist }, blobs);
          });
        } else if(item.type === 'checkout'){
          op = sb.from('visits').update(item.patch).eq('id', item.visitId).then(function(r){
            if(r.error) throw r.error;
            clearLocalOpen(item.customerId, item.visitId);
          });
        } else {
          // Legacy queue item (pre one-tap): a whole visit saved in one go.
          op = Promise.all((item.photoDataUrls || []).map(dataURLToBlob)).then(function(blobs){
            return submitVisitOnline({ visit: item.visit, checklist: item.checklist }, blobs);
          });
        }
        return op.then(function(){ return queueRemove(item.qid); })
          .catch(function(){ /* leave in queue for next time */ });
      });
    });
    return chain;
  }).then(function(){ updateQueueBar(); if(me) renderRoute(); });
}
window.addEventListener('online', flushQueue);

/* ---------------- customers ---------------- */
function renderCustomers(){
  var isOwner = me.role === 'owner';
  $('cust-form-card').classList.toggle('hidden', !isOwner);
  var techSel = $('cf-tech');
  techSel.innerHTML = '<option value="">Unassigned</option>' + Object.keys(profilesMap).map(function(id){
    var p = profilesMap[id];
    return '<option value="' + id + '">' + esc(p.name || p.email) + ' (' + p.role + ')</option>';
  }).join('');
  sb.from('customers').select('*').eq('business_id', me.business_id).eq('active', true).order('name').then(function(r){
    var list = r.data || [];
    if(!list.length){
      $('cust-list').innerHTML = '<div class="card"><p class="muted">No customers yet.' + (isOwner ? ' Add the first one below.' : '') + '</p></div>';
      return;
    }
    $('cust-list').innerHTML = list.map(function(c){
      var techName = c.technician_id && profilesMap[c.technician_id] ? (profilesMap[c.technician_id].name || profilesMap[c.technician_id].email) : 'Unassigned';
      return '<div class="card"><h3>' + esc(c.name) + '</h3>' +
        '<div class="muted">' + esc(c.address || '') + '</div>' +
        '<div class="muted">' + esc(c.service_day || '') + ' · ' + esc(techName) + ' · pH ' + esc(c.ph_min) + '–' + esc(c.ph_max) + ' · ORP ' + esc(c.orp_min) + '–' + esc(c.orp_max) + '</div>' +
        (isOwner ? '<div class="rowbtns"><button class="ghost small" data-edit="' + c.id + '">Edit</button></div>' : '') +
        '</div>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('[data-edit]'), function(btn){
      btn.addEventListener('click', function(){
        var c = list.filter(function(x){ return x.id === btn.getAttribute('data-edit'); })[0];
        if(c) fillCustomerForm(c);
      });
    });
  });
}
function fillCustomerForm(c){
  editingCustomerId = c.id;
  $('cust-form-title').textContent = 'Edit customer';
  $('cf-name').value = c.name || ''; $('cf-address').value = c.address || '';
  $('cf-phone').value = c.phone || ''; $('cf-email').value = c.email || '';
  $('cf-day').value = c.service_day || 'Thursday';
  $('cf-tech').value = c.technician_id || '';
  $('cf-phmin').value = c.ph_min; $('cf-phmax').value = c.ph_max;
  $('cf-orpmin').value = c.orp_min; $('cf-orpmax').value = c.orp_max;
  $('btn-cust-cancel').classList.remove('hidden');
  window.scrollTo(0, document.body.scrollHeight);
}
function resetCustomerForm(){
  editingCustomerId = null;
  $('cust-form-title').textContent = 'Add customer';
  ['cf-name','cf-address','cf-phone','cf-email'].forEach(function(id){ $(id).value = ''; });
  var d = (business && business.settings && business.settings.defaults) || {};
  $('cf-phmin').value = d.ph_min != null ? d.ph_min : 7.2;
  $('cf-phmax').value = d.ph_max != null ? d.ph_max : 7.8;
  $('cf-orpmin').value = d.orp_min != null ? d.orp_min : 800;
  $('cf-orpmax').value = d.orp_max != null ? d.orp_max : 850;
  $('btn-cust-cancel').classList.add('hidden');
}
$('btn-cust-cancel').addEventListener('click', resetCustomerForm);
$('btn-cust-save').addEventListener('click', function(){
  showErr('cust-err','');
  var row = {
    business_id: me.business_id,
    name: $('cf-name').value.trim(),
    address: $('cf-address').value.trim() || null,
    phone: $('cf-phone').value.trim() || null,
    email: $('cf-email').value.trim() || null,
    service_day: $('cf-day').value,
    technician_id: $('cf-tech').value || null,
    ph_min: num('cf-phmin') != null ? num('cf-phmin') : 7.2,
    ph_max: num('cf-phmax') != null ? num('cf-phmax') : 7.8,
    orp_min: num('cf-orpmin') != null ? num('cf-orpmin') : 800,
    orp_max: num('cf-orpmax') != null ? num('cf-orpmax') : 850
  };
  if(!row.name){ showErr('cust-err','Name is required.'); return; }
  var op = editingCustomerId
    ? sb.from('customers').update(row).eq('id', editingCustomerId)
    : sb.from('customers').insert(row).select().single();
  op.then(function(r){
    if(r.error){ showErr('cust-err', r.error.message); return; }
    var done = function(){ resetCustomerForm(); renderCustomers(); renderRoute(); };
    if(!editingCustomerId && r.data){
      sb.from('bodies_of_water').insert({ business_id: me.business_id, customer_id: r.data.id, name: 'Main Pool' }).then(done);
    } else done();
  });
});

/* ---------------- team ---------------- */
function renderTeam(){
  var isOwner = me.role === 'owner';
  $('invite-card').classList.toggle('hidden', !isOwner);
  var people = Object.keys(profilesMap).map(function(id){ return profilesMap[id]; });
  $('team-list').innerHTML = people.map(function(p){
    return '<div class="card"><h3>' + esc(p.name || p.email) + '</h3>' +
      '<div class="muted">' + esc(p.email || '') + '</div>' +
      '<span class="chip">' + esc(p.role) + '</span></div>';
  }).join('') || '<div class="card"><p class="muted">No team members yet.</p></div>';
  if(isOwner){
    sb.from('invites').select('*').eq('business_id', me.business_id).order('created_at').then(function(r){
      var inv = r.data || [];
      $('inv-pending').innerHTML = inv.length
        ? '<p class="muted" style="margin-top:12px">Waiting to join:</p>' + inv.map(function(i){
            return '<div class="muted">• ' + esc(i.email) + ' (' + esc(i.role) + ')</div>';
          }).join('')
        : '';
    });
  }
}
$('btn-invite').addEventListener('click', function(){
  showErr('inv-err',''); showOk('inv-ok','');
  var email = $('inv-email').value.trim().toLowerCase();
  if(!email){ showErr('inv-err','Enter an email.'); return; }
  sb.from('invites').insert({ business_id: me.business_id, email: email, role: 'tech' }).then(function(r){
    if(r.error){ showErr('inv-err', r.error.message); return; }
    $('inv-email').value = '';
    showOk('inv-ok','Invite saved for ' + email + '. They create an account with that email and join automatically.');
    renderTeam();
  });
});

/* ---------------- settings: checklist steps ---------------- */
var editSteps = null;
function renderSteps(){
  var isOwner = me.role === 'owner';
  loadTemplate().then(function(){
    editSteps = template ? (template.steps || []).slice() : DEFAULT_STEPS.slice();
    drawSteps(isOwner);
  });
}
function drawSteps(isOwner){
  $('steps-list').innerHTML = editSteps.map(function(s, i){
    return '<div class="stepitem"><span style="flex:1">' + (i + 1) + '. ' + esc(s) + '</span>' +
      (isOwner ? '<button class="ghost small" data-delstep="' + i + '">Remove</button>' : '') + '</div>';
  }).join('') || '<p class="muted">No steps yet.</p>';
  $('btn-steps-save').classList.toggle('hidden', !isOwner);
  $('btn-step-add').classList.toggle('hidden', !isOwner);
  $('step-new').classList.toggle('hidden', !isOwner);
  Array.prototype.forEach.call(document.querySelectorAll('[data-delstep]'), function(btn){
    btn.addEventListener('click', function(){
      editSteps.splice(parseInt(btn.getAttribute('data-delstep'), 10), 1);
      drawSteps(isOwner);
    });
  });
}
$('btn-step-add').addEventListener('click', function(){
  var v = $('step-new').value.trim();
  if(!v) return;
  editSteps.push(v);
  $('step-new').value = '';
  drawSteps(me.role === 'owner');
});
$('btn-steps-save').addEventListener('click', function(){
  showOk('steps-ok','');
  var save = template
    ? sb.from('checklist_templates').update({ steps: editSteps }).eq('id', template.id)
    : sb.from('checklist_templates').insert({ business_id: me.business_id, name: 'Standard Visit', steps: editSteps });
  save.then(function(r){
    if(r.error){ return; }
    loadTemplate().then(function(){ showOk('steps-ok','Checklist saved.'); });
  });
});

/* ---------------- init ---------------- */
if('serviceWorker' in navigator){
  navigator.serviceWorker.register('sw.js').catch(function(){});
}
resetCustomerForm();
setAuthMode(false);
sb.auth.getSession().then(function(s){ if(s.data && s.data.session) boot(); });
})();
