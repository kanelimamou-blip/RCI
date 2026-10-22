/*
 * Pont entre l'application RCI (mêmes écrans que la version web et mobile) et le serveur RCI.
 * Fournit window.claude.use('db' | 'user' | 'assets') :
 *  - db     : collections de l'application, enregistrées dans PostgreSQL, partagées entre tous les appareils ;
 *             l'écran se met à jour seul (toutes les 3 secondes) quand quelqu'un modifie une donnée ;
 *  - user   : compte connecté (identifiant, droit d'écriture, noms des auteurs) ;
 *  - assets : fichiers joints (documents, preuves, photos).
 * Hors connexion (terrain sans réseau) : l'appareil garde une copie des données visibles par le compte
 * et la « réserve » des saisies en attente ; tout part au serveur dès le retour du réseau.
 * Version 2.9 : code d'accès hors ligne, conflits signalés (au lieu d'écraser le travail d'un autre),
 * réserve exportable / importable (fichier chiffré), dossier « téléphone » pour un collègue, préparation des photos.
 * Version 2.10 : ouverture instantanée (la dernière copie s'affiche aussitôt, puis se met à jour).
 * La copie est effacée à la déconnexion (« Se déconnecter »).
 */
(function () {
  'use strict';
  var COMPTE = window.RCI_SERVEUR;
  if (!COMPTE) return;
  try { sessionStorage.removeItem('rci_renouv'); } catch (e) {}

  var SAISIE = ['ADMIN', 'PILOTE', 'CHEF', 'CONTROLEUR'];
  var CAN_WRITE = SAISIE.indexOf(COMPTE.role) >= 0;
  var JSON_H = { 'Content-Type': 'application/json', 'x-rci-csrf': '1' };
  var VALIDITE_JOURS = 30;          // accès hors ligne sans repasser en ligne
  var KIT = window.RCI_KIT || null;  // appli téléphone d'un collègue (dossier importé) : jamais de serveur

  function erreur(code, msg) { var e = new Error(msg); e.code = code; return e; }

  /* ---------- Copie locale (IndexedDB) ---------- */
  var IDB = null, CLE = 'u:' + COMPTE.id + ':';
  function base() {
    if (IDB) return IDB;
    IDB = new Promise(function (ok, ko) {
      try {
        var r = indexedDB.open('rci-hors-ligne', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
        r.onsuccess = function () { ok(r.result); };
        r.onerror = function () { ko(r.error); };
      } catch (e) { ko(e); }
    });
    return IDB;
  }
  function lireLocal(k) {
    return base().then(function (d) {
      return new Promise(function (ok) { var q = d.transaction('kv').objectStore('kv').get(CLE + k); q.onsuccess = function () { ok(q.result); }; q.onerror = function () { ok(undefined); }; });
    }, function () { return undefined; });
  }
  function ecrireLocal(k, v) {
    return base().then(function (d) {
      return new Promise(function (ok) { var t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, CLE + k); t.oncomplete = function () { ok(true); }; t.onerror = function () { ok(false); }; });
    }, function () { return false; });
  }
  function effacerLocal() {
    var p1 = base().then(function (d) {
      return new Promise(function (ok) { var t = d.transaction('kv', 'readwrite'), s = t.objectStore('kv'); ['snap', 'file', 'verrou', 'vu', 'prep'].forEach(function (k) { s.delete(CLE + k); }); t.oncomplete = function () { ok(); }; t.onerror = function () { ok(); }; });
    }, function () {});
    var p2 = window.caches ? Promise.all(['rci-pages', 'rci-blobs'].map(function (n) { return caches.delete(n).catch(function () {}); })) : Promise.resolve();
    try { Object.keys(localStorage).forEach(function (k) { if (k.indexOf('rci_brouillons_') === 0 || k === 'rci_dernier_ecart' || k === 'rci_vues') localStorage.removeItem(k); }); } catch (e) {}
    var p3 = KIT ? base().then(function (d) { return new Promise(function (ok) { var t = d.transaction('kv', 'readwrite'), s = t.objectStore('kv'); ['kit:compte', 'kit:cree'].forEach(function (k) { s.delete(k); }); t.oncomplete = function () { ok(); }; t.onerror = function () { ok(); }; }); }, function () {}) : Promise.resolve();
    return Promise.all([p1, p2, p3]);
  }

  /* ---------- Appels au serveur, avec renouvellement automatique de la session ---------- */
  var renouv = null;
  function renouveler() {
    if (!renouv) {
      renouv = fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin', headers: JSON_H, body: '{}' })
        .then(function (r) { renouv = null; return r.ok; }, function () { renouv = null; return false; });
    }
    return renouv;
  }
  // Délai maximal : un téléphone hors du réseau du PC ne doit pas attendre une minute avant de passer hors ligne.
  function avecDelai(url, o, ms) {
    if (!window.AbortController) return fetch(url, o);
    var c = new AbortController(), t = setTimeout(function () { c.abort(); }, ms); o.signal = c.signal;
    return fetch(url, o).then(function (r) { clearTimeout(t); return r; }, function (e) { clearTimeout(t); throw e; });
  }
  function appel(methode, chemin, corps, formulaire, deja) {
    if (KIT) { var e0 = erreur('reseau', 'Appli téléphone hors ligne'); e0.statut = 0; return Promise.reject(e0); }
    var o = { method: methode, credentials: 'same-origin', headers: formulaire ? { 'x-rci-csrf': '1' } : JSON_H };
    if (corps !== undefined) o.body = formulaire ? corps : JSON.stringify(corps);
    return avecDelai('/api' + chemin, o, methode === 'GET' ? 9000 : 180000).catch(function () {
      var e = erreur('reseau', 'Serveur RCI injoignable'); e.statut = 0; throw e;
    }).then(function (r) {
      if (r.status === 401 && !deja) {
        return renouveler().then(function (ok) {
          if (ok) return appel(methode, chemin, corps, formulaire, true);
          sauverFile().then(function () { location.replace('/login'); });   // saisies en attente gardées pour la prochaine connexion
          throw erreur('unauthenticated', 'Session expirée');
        });
      }
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          var m = j && j.message; if (Array.isArray(m)) m = m.join(' ; ');
          var e = erreur(r.status === 403 ? 'invalid_argument' : 'error', m || ('Erreur ' + r.status)); e.statut = r.status; throw e;
        });
      }
      return r.status === 204 ? null : r.json();
    });
  }

  /* ---------- État du réseau ---------- */
  var horsLigne = false;
  function attente() { return file.length + (enVol ? enVolN : 0) + conflits.length; }
  function avertir() {
    try { window.dispatchEvent(new CustomEvent('rci-reseau', { detail: { enLigne: !horsLigne, attente: attente(), conflits: conflits.length } })); } catch (e) {}
  }
  function passerHorsLigne(v) { if (horsLigne !== v) { horsLigne = v; avertir(); } if (!v) noterEnLigne(); }
  var tVu = 0;
  function noterEnLigne() { var n = Date.now(); if (n - tVu > 60000) { tVu = n; ecrireLocal('vu', n); } }

  /* ---------- Données ---------- */
  var DATA = {};          // collection -> { id -> données } (ce que voit l'écran, saisies en attente comprises)
  var SERV = {};          // 'coll/id' -> version connue du serveur (date « maj »), pour repérer les conflits
  var SERVDOC = {};       // 'coll/id' -> dernière version du serveur d'un élément modifié ici et pas encore envoyé
  var ECOUTE = {};        // collection -> [ { next, error } ]
  var ENCOURS = {};       // 'coll/id' -> nombre d'écritures pas encore confirmées
  var seq = 0, pret = false, demarre = false, attenteT = null, apercu = false;

  function copie(o) { return JSON.parse(JSON.stringify(o)); }
  function vue(c) {
    var m = DATA[c] || {};
    return { docs: Object.keys(m).map(function (id) { var d = m[id]; return { id: id, data: function () { return d; } }; }) };
  }
  var sales = {}, minuterie = null;
  function signaler(c) { sales[c] = 1; if (!minuterie) minuterie = setTimeout(diffuser, (enVol || file.length) ? 1200 : 30); planifierCopie(); }
  function diffuser() {
    minuterie = null; var L = Object.keys(sales); sales = {};
    L.forEach(function (c) {
      (ECOUTE[c] || []).forEach(function (l) { try { l.next(vue(c)); } catch (e) { console.error(e); } });
    });
  }
  var tCopie = null;
  function planifierCopie() { if (!pret || tCopie) return; tCopie = setTimeout(function () { tCopie = null; ecrireLocal('snap', { seq: seq, data: DATA, serv: SERV, servdoc: SERVDOC, t: Date.now() }); }, 8000); }

  function majDe(d) { return d && typeof d === 'object' ? (d.maj || null) : null; }
  function appliquer(docs, ignorerEnCours) {
    docs.forEach(function (x) {
      var k = x.c + '/' + x.id;
      SERV[k] = (x.d === null || x.d === undefined) ? null : majDe(x.d);
      if (ENCOURS[k]) SERVDOC[k] = x.d === undefined ? null : x.d;      // version du serveur d'un élément modifié ici (conflit éventuel)
      if (ignorerEnCours && ENCOURS[k]) return;
      var m = DATA[x.c] || (DATA[x.c] = {});
      if (x.d === null || x.d === undefined) { if (x.id in m) { delete m[x.id]; signaler(x.c); } return; }
      if (x.id in m && JSON.stringify(m[x.id]) === JSON.stringify(x.d)) return;
      m[x.id] = x.d; signaler(x.c);
    });
  }
  function rejouerLocal(ops) {
    ops.forEach(function (op) { var m = DATA[op.c] || (DATA[op.c] = {}); if (op.del) delete m[op.id]; else m[op.id] = copie(op.d); signaler(op.c); });
  }
  function toutesOps() { return enVolOps.concat(file.map(function (x) { return x.op; })).concat(conflits.map(function (x) { return x.op; })); }

  /* Ouverture instantanée : si la page vient du serveur (session valide) et qu'une copie récente existe sur
     l'appareil, elle s'affiche tout de suite ; les données du serveur la remplacent dès leur arrivée.
     Jamais quand la page vient de la copie de l'appareil (hors ligne) : le code d'accès passe d'abord. */
  function apercuLocal(etat) {
    if (KIT || window.RCI_DEPUIS_CACHE) return;
    setTimeout(function () {
      if (etat.fini) return;
      lireLocal('snap').then(function (s) {
        if (etat.fini || !s || !s.data || !s.t || Date.now() - s.t > VALIDITE_JOURS * 86400e3) return;
        DATA = s.data; SERV = s.serv || {}; SERVDOC = s.servdoc || {};
        rejouerLocal(toutesOps());
        apercu = true;
        try { window.dispatchEvent(new CustomEvent('rci-apercu', { detail: { t: s.t } })); } catch (e) {}
        Object.keys(ECOUTE).forEach(signaler);
      });
    }, 120);
  }
  function charger() {
    var etat = { fini: false };
    apercuLocal(etat);
    return appel('GET', '/store/snapshot').then(function (r) {
      etat.fini = true;
      if (apercu) { apercu = false; try { window.dispatchEvent(new CustomEvent('rci-apercu', { detail: null })); } catch (e) {} }
      DATA = {}; SERV = {};
      appliquer(r.docs || [], false);
      rejouerLocal(toutesOps());
      seq = r.seq || 0; pret = true; passerHorsLigne(false);
      Object.keys(ECOUTE).forEach(signaler);
      ecrireLocal('snap', { seq: seq, data: DATA, serv: SERV, servdoc: SERVDOC, t: Date.now() });
    }, function (e) {
      etat.fini = true;
      if (e && e.statut !== 0 && !(e.statut >= 500)) { if (apercu) { apercu = false; DATA = {}; Object.keys(ECOUTE).forEach(signaler); } throw e; }
      return lireLocal('snap').then(function (s) {           // pas de réseau : copie locale
        if (!s || !s.data) throw e;
        DATA = s.data; SERV = s.serv || {}; SERVDOC = s.servdoc || {}; seq = s.seq || 0; pret = true;
        rejouerLocal(toutesOps());
        passerHorsLigne(true);
        return verrouHorsLigne().then(function () { Object.keys(ECOUTE).forEach(signaler); });
      });
    });
  }

  function interroger() {
    clearTimeout(attenteT);
    appel('GET', '/store/changes?since=' + seq).then(function (r) {
      var revenu = horsLigne;
      passerHorsLigne(false);
      appliquer(r.docs || [], true);
      seq = Math.max(seq, r.seq || 0);
      if (revenu && file.length) planifier(0);
      attenteT = setTimeout(interroger, r.plus ? 0 : (document.hidden ? 15000 : 3000));
    }, function (e) { if (e && e.statut === 0) passerHorsLigne(true); attenteT = setTimeout(interroger, 10000); });
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && pret) interroger(); });
  window.addEventListener('online', function () { if (pret) interroger(); });
  window.addEventListener('offline', function () { passerHorsLigne(true); });

  function demarrer() {
    if (demarre) return; demarre = true;
    restaurerFile().then(charger).then(function () {
      attenteT = setTimeout(interroger, horsLigne ? 5000 : 3000);
      if (file.length) planifier(horsLigne ? 5000 : 0);
    }, function (e) {
      Object.keys(ECOUTE).forEach(function (c) { (ECOUTE[c] || []).forEach(function (l) { if (l.error) l.error(e); }); });
    });
  }

  /* Écritures regroupées : un seul envoi à la fois, par lots. Sans réseau, les saisies forment la « réserve » de
     l'appareil (elle survit à la fermeture de l'application) et partent automatiquement au retour du réseau.
     Conflit : si l'élément a été modifié sur le serveur par quelqu'un d'autre depuis la saisie, il n'est pas
     écrasé : la saisie attend la décision de l'utilisateur (« Ma réserve »). */
  var file = [], tempo = null, enVol = false, enVolN = 0, essais = 0, enVolOps = [], conflits = [];
  function planifier(d) { if (!tempo && !enVol) tempo = setTimeout(envoyer, d); }
  var tFile = null;
  function sauverFile() {
    clearTimeout(tFile); tFile = null;
    return ecrireLocal('file', enVolOps.concat(file.map(function (x) { return x.op; })).concat(conflits.map(function (x) { var o = copie(x.op); o.conflit = true; return o; })));
  }
  function sauverFileBientot() { if (!tFile) tFile = setTimeout(sauverFile, 300); }
  function restaurerFile() {
    return lireLocal('file').then(function (L) {
      (L || []).forEach(function (op) {
        var k = op.c + '/' + op.id; ENCOURS[k] = (ENCOURS[k] || 0) + 1;
        var x = { op: op, ok: function () {}, ko: function () {} };
        if (op.conflit) { delete op.conflit; conflits.push(x); } else file.push(x);
      });
    });
  }
  function enfiler(op) {
    var k = op.c + '/' + op.id;
    op.t = op.t || Date.now(); op.u = op.u || COMPTE.id;
    // Même élément déjà en attente (pas encore parti) : une seule saisie, la plus récente, avec la version
    // du serveur notée lors de la PREMIÈRE saisie (pour détecter un changement fait entre-temps au bureau).
    for (var i = file.length - 1; i >= 0; i--) {
      var y = file[i];
      if (y.op.c !== op.c || y.op.id !== op.id || y.op.u !== op.u || !y.op.force !== !op.force) continue;
      if (op.del) { y.op.del = true; delete y.op.d; } else { delete y.op.del; y.op.d = op.d; }
      y.op.t = op.t;
      sauverFileBientot(); avertir();
      return new Promise(function (ok, ko) {
        if (horsLigne) { sauverFile().then(function () { ok(); }); return; }
        var ok0 = y.ok, ko0 = y.ko;
        y.ok = function () { ok0(); ok(); }; y.ko = function (e) { ko0(e); ko(e); };
        planifier(40);
      });
    }
    ENCOURS[k] = (ENCOURS[k] || 0) + 1;
    if (!('base' in op)) op.base = k in SERV ? SERV[k] : undefined;    // version du serveur au moment de la saisie
    return new Promise(function (ok, ko) {
      var x = { op: op, ok: ok, ko: ko };
      file.push(x); sauverFileBientot(); avertir();
      if (horsLigne) { sauverFile().then(function () { x.ok = function () {}; x.ko = function () {}; ok(); }); }
      else planifier(40);
    });
  }
  function liberer(op) { var k = op.c + '/' + op.id; if (!--ENCOURS[k]) { delete ENCOURS[k]; delete SERVDOC[k]; } }
  function passagere(e) { return !e || e.code === 'reseau' || e.statut === 0 || e.statut === 408 || e.statut === 429 || e.statut >= 500; }
  function enConflit(op) {
    if (op.force || op.base === undefined) return false;
    var k = op.c + '/' + op.id;
    if (!(k in SERV)) return false;
    return SERV[k] !== op.base;
  }
  function envoyer() {
    tempo = null; if (!file.length || enVol) return;
    var lot = [], taille = 0, nouveauxConflits = 0;
    while (file.length && lot.length < 400 && taille < 6e6) {
      var x = file.shift();
      if (enConflit(x.op)) { conflits.push(x); x.ok(); x.ok = function () {}; x.ko = function () {}; nouveauxConflits++; continue; }
      taille += JSON.stringify(x.op).length; lot.push(x);
    }
    if (nouveauxConflits) { sauverFile(); avertir(); }
    if (!lot.length) { if (file.length) planifier(0); return; }
    enVol = true; enVolN = lot.length; enVolOps = lot.map(function (x) { return x.op; });
    appel('POST', '/store/batch', { ops: enVolOps.map(nettoyerOp) }).then(function () {
      essais = 0; passerHorsLigne(false);
      lot.forEach(function (x) { confirmer(x.op); liberer(x.op); x.ok(); });
      enVolOps = []; return sauverFile();
    }, function (e) {
      if (e && e.statut === 0) {
        passerHorsLigne(true);
        lot.forEach(function (x) { x.ok(); x.ok = function () {}; x.ko = function () {}; });
        file = lot.concat(file); enVolOps = [];
        return sauverFile().then(function () { return new Promise(function (r) { setTimeout(r, 15000); }); });
      }
      if (passagere(e) && essais < 8) {
        essais++; file = lot.concat(file); enVolOps = [];
        return new Promise(function (r) { setTimeout(r, Math.min(30000, 1000 * Math.pow(2, essais))); });
      }
      essais = 0;
      lot.forEach(function (x) { liberer(x.op); x.ko(e); });
      enVolOps = []; sauverFile();
      charger().catch(function () {});
    }).then(function () { enVol = false; enVolN = 0; avertir(); if (file.length) planifier(horsLigne ? 15000 : 0); });
  }
  function nettoyerOp(op) { return op.del ? { c: op.c, id: op.id, del: true } : { c: op.c, id: op.id, d: op.d }; }
  // Écriture acceptée : c'est désormais la version du serveur (les saisies suivantes du même élément partent de là)
  function confirmer(op) {
    var k = op.c + '/' + op.id, avant = SERV[k], apres = op.del ? null : majDe(op.d);
    SERV[k] = apres;
    file.forEach(function (x) { if (x.op.c === op.c && x.op.id === op.id && x.op.base === avant) x.op.base = apres; });
  }
  window.addEventListener('beforeunload', function () { if (file.length || enVol || conflits.length) sauverFile(); });

  var db = {
    collection: function (c) {
      return {
        doc: function (id) {
          return {
            set: function (d) {
              var m = DATA[c] || (DATA[c] = {}); m[id] = copie(d); signaler(c);
              return enfiler({ c: c, id: id, d: d });
            },
            delete: function () {
              var m = DATA[c] || {}; if (id in m) { delete m[id]; signaler(c); }
              return enfiler({ c: c, id: id, del: true });
            },
          };
        },
        onSnapshot: function (next, error) {
          var l = { next: next, error: error };
          (ECOUTE[c] || (ECOUTE[c] = [])).push(l);
          if (pret || apercu) signaler(c); else demarrer();
          return function () { ECOUTE[c] = (ECOUTE[c] || []).filter(function (x) { return x !== l; }); };
        },
      };
    },
  };

  var user = {
    id: function () { return Promise.resolve(COMPTE.id); },
    can: function (p) { return Promise.resolve(p === 'data.write' ? CAN_WRITE : false); },
    profiles: function (ids) { return appel('POST', '/store/profiles', { ids: ids || [] }).catch(function () { return {}; }); },
  };

  var EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };
  var assets = {
    upload: function (f) {
      var nom = f && f.name ? f.name : 'photo.' + (EXT[f && f.type] || 'jpg');
      var fd = new FormData(); fd.append('fichier', f, nom);
      return appel('POST', '/store/blob', fd, true);
    },
  };

  /* ---------- Chiffrement des fichiers échangés (réserve, dossier téléphone) ---------- */
  var ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // sans lettres ambiguës (O/0, I/1, L)
  function nouveauCode() { var a = new Uint8Array(8); crypto.getRandomValues(a); var s = ''; for (var i = 0; i < 8; i++) s += ALPHA[a[i] % ALPHA.length]; return s.slice(0, 4) + '-' + s.slice(4); }
  function normCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function cleDe(code, sel, usage) {
    var te = new TextEncoder();
    return crypto.subtle.importKey('raw', te.encode(normCode(code)), 'PBKDF2', false, ['deriveKey']).then(function (k) {
      return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: sel, iterations: 250000, hash: 'SHA-256' }, k, { name: 'AES-GCM', length: 256 }, false, usage);
    });
  }
  function compresser(u8) {
    if (!window.CompressionStream) return Promise.resolve({ z: 0, b: u8 });
    var s = new Blob([u8]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Response(s).arrayBuffer().then(function (b) { return { z: 1, b: new Uint8Array(b) }; });
  }
  function decompresser(u8, z) {
    if (!z) return Promise.resolve(u8);
    var s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(s).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }
  var ENTETE = 'RCI-CHIFFRE-1';
  function chiffrer(objet, code) {
    var sel = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    return compresser(new TextEncoder().encode(JSON.stringify(objet))).then(function (c) {
      return cleDe(code, sel, ['encrypt']).then(function (k) { return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, k, c.b); }).then(function (ct) {
        var tete = new TextEncoder().encode(ENTETE + '\n' + c.z + '\n');
        return new Blob([tete, sel, iv, new Uint8Array(ct)], { type: 'application/octet-stream' });
      });
    });
  }
  function dechiffrer(fichier, code) {
    return fichier.arrayBuffer().then(function (ab) {
      var u = new Uint8Array(ab), txt = new TextDecoder().decode(u.slice(0, 40)), p = txt.split('\n');
      if (p[0] !== ENTETE) throw erreur('format', 'Ce fichier n\'est pas un fichier RCI (réserve ou dossier téléphone).');
      var d = (p[0] + '\n' + p[1] + '\n').length, sel = u.slice(d, d + 16), iv = u.slice(d + 16, d + 28), ct = u.slice(d + 28);
      return cleDe(code, sel, ['decrypt']).then(function (k) { return crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, k, ct); })
        .catch(function () { throw erreur('code', 'Code incorrect (ou fichier abîmé).'); })
        .then(function (pt) { return decompresser(new Uint8Array(pt), p[1] === '1'); })
        .then(function (b) { return JSON.parse(new TextDecoder().decode(b)); });
    });
  }
  function horodate() { var d = new Date(); return d.toISOString().slice(0, 16).replace(/[-:T]/g, ''); }
  function nomFichier(prefixe) { return prefixe + '-' + String(COMPTE.fullName || COMPTE.email || 'compte').normalize('NFD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + horodate() + '.rci'; }

  /* ---------- Code d'accès hors ligne (verrou de l'appareil) ---------- */
  function empreinte(code, sel) {
    var te = new TextEncoder();
    return crypto.subtle.importKey('raw', te.encode(String(code)), 'PBKDF2', false, ['deriveBits']).then(function (k) {
      return crypto.subtle.deriveBits({ name: 'PBKDF2', salt: sel, iterations: 250000, hash: 'SHA-256' }, k, 256);
    }).then(function (b) { return Array.from(new Uint8Array(b)); });
  }
  function definirCode(code) {
    if (!/^\d{6,12}$/.test(String(code))) return Promise.reject(erreur('code', 'Le code doit faire 6 à 12 chiffres.'));
    var sel = Array.from(crypto.getRandomValues(new Uint8Array(16)));
    return empreinte(code, new Uint8Array(sel)).then(function (h) {
      return ecrireLocal('verrou', { sel: sel, h: h, essais: 0, le: Date.now() }).then(function () { tVu = Date.now(); return ecrireLocal('vu', tVu); }).then(function () { return true; });
    });
  }
  function verifierCode(code) {
    return lireLocal('verrou').then(function (v) {
      if (!v) return false;
      return empreinte(code, new Uint8Array(v.sel)).then(function (h) {
        var bon = h.length === v.h.length && h.every(function (x, i) { return x === v.h[i]; });
        v.essais = bon ? 0 : (v.essais || 0) + 1;
        return ecrireLocal('verrou', v).then(function () { return { bon: bon, essais: v.essais }; });
      });
    });
  }
  // Ouverture hors ligne : l'écran reste masqué tant que le code n'est pas donné (5 erreurs = copie effacée)
  function verrouHorsLigne() {
    return Promise.all([lireLocal('verrou'), lireLocal('vu')]).then(function (r) {
      var v = r[0], vu = r[1] || 0;
      if (!v) return;                                   // aucun code choisi : comportement d'avant
      return new Promise(function (fini) {
        var vieux = Date.now() - vu > VALIDITE_JOURS * 86400000, perime = vieux && !KIT;   // appli d'un collègue : on peut encore ouvrir pour exporter la réserve
        var o = document.createElement('div'); o.id = 'rci-verrou';
        o.setAttribute('style', 'position:fixed;inset:0;z-index:99999;background:#f6f5f3;display:flex;align-items:center;justify-content:center;padding:16px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#1c1917');
        o.innerHTML = '<form style="background:#fff;border:1px solid #e7e5e4;border-radius:16px;padding:22px;max-width:380px;width:100%" autocomplete="off">' +
          '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px"><img src="/icons/rci-192.png" alt="" style="width:40px;height:40px;border-radius:10px"><b style="font-size:18px">RCI · hors ligne</b></div>' +
          '<p style="margin:0 0 4px;color:#57534e;font-size:14px">' + echapper(COMPTE.fullName || '') + '</p><p style="margin:0 0 14px;color:#57534e;font-size:13px">' + echapper(COMPTE.email || '') + '</p>' +
          (perime ? '<p style="margin:0;color:#b91c1c;font-size:14.5px">Le PC serveur n\'a pas été joint depuis plus de ' + VALIDITE_JOURS + ' jours : connectez ce téléphone au même réseau que le PC (maison ou partage de connexion), puis rouvrez l\'appli.</p></form>' :
          (vieux ? '<p style="margin:0 0 10px;color:#b7791f;font-size:13.5px">Dossier de plus de ' + VALIDITE_JOURS + ' jours : exportez votre réserve (Ma réserve), puis importez un nouveau dossier préparé sur votre ordinateur.</p>' : '') +
          '<label style="display:block;font-size:13px;color:#57534e;font-weight:600">Code d\'accès hors ligne<input id="rci-verrou-code" type="password" inputmode="numeric" pattern="[0-9]*" style="display:block;width:100%;box-sizing:border-box;font-size:22px;letter-spacing:.3em;padding:10px;margin-top:6px;border:1px solid #d6d3d1;border-radius:10px"></label>' +
          '<p id="rci-verrou-msg" style="min-height:20px;margin:8px 0;color:#b91c1c;font-size:13.5px"></p><button style="width:100%;background:#c2410c;color:#fff;border:0;border-radius:10px;padding:12px;font-size:16px;font-weight:600">Ouvrir</button></form>');
        document.documentElement.appendChild(o);
        if (perime) return;
        var champ = o.querySelector('#rci-verrou-code'); setTimeout(function () { champ.focus(); }, 50);
        o.querySelector('form').onsubmit = function (ev) {
          ev.preventDefault();
          verifierCode(champ.value).then(function (r) {
            if (r && r.bon) { o.remove(); fini(); return; }
            var reste = 5 - ((r && r.essais) || 0);
            if (reste <= 0) {
              effacerLocal().then(function () { o.querySelector('form').innerHTML = '<p style="margin:0;color:#b91c1c">Trop d\'essais : la copie hors ligne de ce téléphone a été effacée. Reconnectez-vous en ligne.</p>'; });
              return;
            }
            champ.value = ''; o.querySelector('#rci-verrou-msg').textContent = 'Code incorrect. Encore ' + reste + ' essai' + (reste > 1 ? 's' : '') + ' avant l\'effacement de la copie.';
          });
        };
      });
    });
  }
  function echapper(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ---------- Préparer le hors ligne : photos et pièces jointes gardées sur l'appareil ---------- */
  function preparer(filtre) {
    var vus = {}, L = [];
    Object.keys(DATA).forEach(function (c) {
      Object.keys(DATA[c]).forEach(function (id) {
        var d = DATA[c][id]; if (filtre && !filtre(c, d)) return;
        var t = JSON.stringify(d), re = /\/_blob\/([A-Za-z0-9_-]+)/g, m;
        while ((m = re.exec(t))) if (!vus[m[1]]) { vus[m[1]] = 1; L.push('/_blob/' + m[1]); }
      });
    });
    var n = 0, ko = 0, i = 0;
    function suivant() {
      if (i >= L.length) return Promise.resolve();
      var u = L[i++];
      return caches.open('rci-blobs').then(function (c) {
        return c.match(u).then(function (deja) {
          if (deja) { n++; return; }
          return fetch(u, { credentials: 'same-origin' }).then(function (r) { if (r.ok) { n++; return c.put(u, r); } ko++; }, function () { ko++; });
        });
      }).then(suivant);
    }
    var lots = []; for (var k = 0; k < 4; k++) lots.push(suivant());
    return Promise.all(lots).then(function () { return ecrireLocal('prep', { t: Date.now(), n: n, ko: ko }); }).then(function () { return { fichiers: L.length, gardes: n, echecs: ko }; });
  }

  /* ---------- Réserve : liste, export, import, conflits ---------- */
  function resume(op) {
    var d = op.d || (SERVDOC[op.c + '/' + op.id]) || (DATA[op.c] || {})[op.id] || {};
    return { c: op.c, id: op.id, del: !!op.del, t: op.t || null, ref: d.ref || d.numero || (d.ident && d.ident.site) || d.site || d.titre || d.nom || '', site: d.site || (d.ident && d.ident.site) || '', libelle: d.point || d.titre || d.action || d.texte || '' };
  }
  var RESERVE = {
    liste: function () {
      return {
        attente: enVolOps.concat(file.map(function (x) { return x.op; })).map(function (op) { var r = resume(op); r.etat = enVolOps.indexOf(op) >= 0 ? 'envoi' : 'attente'; return r; }),
        conflits: conflits.map(function (x, i) {
          var k = x.op.c + '/' + x.op.id, s = SERVDOC[k] || (DATA[x.op.c] || {})[x.op.id] || null, r = resume(x.op);
          r.i = i; r.serveur = s ? { par: s.par || '', maj: s.maj || '', statut: s.statut || '' } : { supprime: true }; r.mien = x.op.d ? { statut: x.op.d.statut || '' } : { supprime: true };
          return r;
        }),
        enLigne: !horsLigne,
      };
    },
    envoyerMaintenant: function () { if (!horsLigne) { interroger(); planifier(0); } return Promise.resolve(!horsLigne); },
    resoudre: function (i, choix) {
      var x = conflits[i]; if (!x) return Promise.resolve(false);
      conflits.splice(i, 1);
      var k = x.op.c + '/' + x.op.id;
      if (choix === 'mien') { x.op.force = true; file.push(x); planifier(0); }
      else {                                            // garder la version du serveur
        liberer(x.op);
        var s = SERVDOC[k]; var m = DATA[x.op.c] || (DATA[x.op.c] = {});
        if (s) m[x.op.id] = s; else if (SERV[k] === null) delete m[x.op.id];
        signaler(x.op.c);
        if (!horsLigne) charger().catch(function () {});
      }
      return sauverFile().then(function () { avertir(); return true; });
    },
    // Fichier chiffré de la réserve, à importer depuis un ordinateur connecté (ou par l'administrateur)
    exporter: function () {
      var ops = toutesOps().map(function (o) { var c = copie(o); delete c.conflit; return c; });
      if (!ops.length) return Promise.reject(erreur('vide', 'La réserve est vide : rien à exporter.'));
      var code = nouveauCode();
      return chiffrer({ format: 'rci-reserve', v: 1, compte: { id: COMPTE.id, email: COMPTE.email, nom: COMPTE.fullName }, cree: new Date().toISOString(), ops: ops }, code)
        .then(function (b) { return { fichier: b, nom: nomFichier('RCI-reserve'), code: code, n: ops.length }; });
    },
    importer: function (fichier, code) {
      return dechiffrer(fichier, code).then(function (o) {
        if (!o || o.format !== 'rci-reserve' || !Array.isArray(o.ops)) throw erreur('format', 'Ce fichier n\'est pas une réserve RCI.');
        if (o.compte && o.compte.id !== COMPTE.id && COMPTE.role !== 'ADMIN') throw erreur('droits', 'Cette réserve appartient à ' + (o.compte.nom || o.compte.email) + ' : seul un administrateur peut l\'importer pour lui.');
        if (!CAN_WRITE) throw erreur('droits', 'Votre compte ne peut pas enregistrer de saisies.');
        var n = 0, nc = 0, deja = 0;
        o.ops.forEach(function (op) {
          var k = op.c + '/' + op.id, cur = (DATA[op.c] || {})[op.id];
          if (op.d && cur && JSON.stringify(cur) === JSON.stringify(op.d)) { deja++; return; }   // déjà dans la base
          var x = { c: op.c, id: op.id, t: op.t, u: op.u, base: op.base };
          if (op.del) x.del = true; else x.d = op.d;
          if (!(k in SERV) && cur) SERV[k] = majDe(cur);
          if (enConflit(x)) { ENCOURS[k] = (ENCOURS[k] || 0) + 1; SERVDOC[k] = cur || null; conflits.push({ op: x, ok: function () {}, ko: function () {} }); nc++; return; }
          var m = DATA[op.c] || (DATA[op.c] = {}); if (op.del) delete m[op.id]; else m[op.id] = copie(op.d); signaler(op.c);
          enfiler(x); n++;
        });
        sauverFile(); avertir();
        return { saisies: n, conflits: nc, deja: deja, de: o.compte ? (o.compte.nom || o.compte.email) : '', cree: o.cree };
      });
    },
    vider: function () { file = []; conflits = []; Object.keys(ENCOURS).forEach(function (k) { delete ENCOURS[k]; }); return sauverFile().then(function () { avertir(); return charger().catch(function () {}); }); },
    // Dossier « téléphone » d'un collègue : ses données (selon ses droits), chiffrées, pour l'appli hors ligne
    exporterTelephone: function () {
      var code = nouveauCode();
      var docs = []; Object.keys(DATA).forEach(function (c) { Object.keys(DATA[c]).forEach(function (id) { docs.push({ c: c, id: id, d: DATA[c][id] }); }); });
      return chiffrer({ format: 'rci-telephone', v: 1, compte: { id: COMPTE.id, email: COMPTE.email, nom: COMPTE.fullName, role: COMPTE.role, organisation: COMPTE.organisation || null, zones: COMPTE.zones || null }, cree: new Date().toISOString(), seq: seq, serv: SERV, docs: docs }, code)
        .then(function (b) { return { fichier: b, nom: nomFichier('RCI-telephone'), code: code, n: docs.length }; });
    },
    nouveauCode: nouveauCode,
  };

  /* ---------- Hors connexion : accès pour l'application ---------- */
  window.RCI_HORSLIGNE = {
    kit: !!KIT,
    etat: function () { return { enLigne: !horsLigne, attente: attente(), conflits: conflits.length }; },
    effacer: effacerLocal,
    equipe: function () { return appel('GET', '/store/equipe').catch(function () { return []; }); },
    reserve: RESERVE,
    codeDefini: function () { return lireLocal('verrou').then(function (v) { return !!v; }); },
    definirCode: definirCode,
    preparer: preparer,
    preparation: function () { return lireLocal('prep'); },
    vu: function () { return lireLocal('vu'); },
  };

  /* ---------- Installation comme une application (téléphone, tablette, ordinateur) ---------- */
  var invite = null;
  var ua = navigator.userAgent || '';
  var INSTALL = {
    installee: function () {
      return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
    },
    possible: function () { return !!invite; },
    ios: function () { return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document); },
    securise: function () { return window.isSecureContext === true; },
    lancer: function () {
      if (!invite) return Promise.resolve('indisponible');
      var p = invite; invite = null;
      p.prompt();
      return p.userChoice.then(function (c) { avertirInstall(); return c && c.outcome === 'accepted' ? 'installee' : 'refusee'; });
    },
  };
  function avertirInstall() { try { window.dispatchEvent(new Event('rci-install')); } catch (e) {} }
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); invite = e; avertirInstall(); });
  window.addEventListener('appinstalled', function () { invite = null; avertirInstall(); });
  if (!KIT && 'serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function (e) { console.warn('Service hors connexion non activé', e); });
  }
  window.RCI_INSTALL = INSTALL;

  window.claude = {
    use: function (nom) {
      if (nom === 'db') return Promise.resolve(db);
      if (nom === 'user') return Promise.resolve(user);
      if (nom === 'assets') return Promise.resolve(assets);
      return Promise.resolve(null);
    },
  };
})();
