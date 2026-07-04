/* ssn-link.js — shared WebSocket layer for the webinar toolkit.
 *
 * Talks to Social Stream Ninja's public relay. SSN's join URL is
 *   wss://io.socialstream.ninja/join/SESSION/IN/OUT
 * You receive whatever is sent to your IN channel; what you send
 * goes to your OUT channel (defaults to 1 if omitted).
 *
 * Two connections:
 *   - chat    joins IN=4          : chat SSN scrapes from Zoom/Meet
 *   - control joins IN=6, OUT=6   : commands between panel & overlay
 *
 * Session ID is NOT hardcoded. It's resolved in this order:
 *   1. ?session=... or #session=... in the page URL
 *   2. whatever was last saved in this browser (localStorage)
 * Set it once in the control panel and it sticks. This is what makes
 * the same files portable across machines with different SSN sessions.
 */
(function (global) {
  'use strict';

  var RELAY_HOST = 'wss://io.socialstream.ninja';

  var CHAT_CHANNEL = 4;
  var CONTROL_CHANNEL = 6;

  var PING_INTERVAL_MS = 25000;
  var BACKOFF_START_MS = 1000;
  var BACKOFF_MAX_MS = 15000;

  /* ------------------------------------------------------------ *
   * Session ID resolution: URL wins, then whatever's saved here.
   * The overlay in OBS has its own browser profile, so the first
   * time on a machine, open overlay.html once in a normal browser
   * tab to save the ID (or pass ?session= / #session= in the URL).
   * ------------------------------------------------------------ */
  function resolveSession() {
    var fromUrl = null;
    try {
      // ?session=... first, then #session=... (hash survives OBS's
      // file:// URL handling better than query strings do)
      fromUrl = new URLSearchParams(global.location.search).get('session');
      if (!fromUrl && global.location.hash) {
        var m = global.location.hash.match(/session=([^&]+)/);
        if (m) fromUrl = decodeURIComponent(m[1]);
      }
    } catch (e) { /* non-browser context */ }
    if (fromUrl) {
      try { global.localStorage.setItem('ssnlink_session', fromUrl); } catch (e) {}
      return fromUrl.trim();
    }
    try {
      return (global.localStorage.getItem('ssnlink_session') || '').trim();
    } catch (e) {
      return '';
    }
  }

  /* SSN relay semantics (per socialstream.ninja/api.html):
   * /join/SESSION/IN_CHANNEL/OUT_CHANNEL — you receive what's sent
   * to your IN channel; what you send goes to your OUT channel.
   * If OUT is omitted it defaults to channel 1, which is why both
   * IN and OUT must be set for two pages to talk on channel 6. */
  function buildUrl(session, inCh, outCh) {
    var url = RELAY_HOST + '/join/' + encodeURIComponent(session) + '/' + inCh;
    if (outCh != null) url += '/' + outCh;
    return url;
  }

  /* ------------------------------------------------------------ *
   * Connection: one WebSocket with auto-reconnect + keepalive.
   * ------------------------------------------------------------ */
  function Connection(label, inCh, outCh, opts) {
    this.label = label;
    this.inCh = inCh;
    this.outCh = outCh;
    this.onMessage = opts.onMessage || function () {};
    this.onStatus = opts.onStatus || function () {};
    this.session = opts.session;
    this.ws = null;
    this.backoff = BACKOFF_START_MS;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.closedByUser = false;
    this.queue = []; // messages sent while disconnected
    this._open();
  }

  Connection.prototype._status = function (state) {
    try { this.onStatus(state, this.label); } catch (e) {}
  };

  Connection.prototype._open = function () {
    if (!this.session) {
      this._status('no-session');
      return;
    }
    var self = this;
    this._status('connecting');
    var ws;
    try {
      ws = new WebSocket(buildUrl(this.session, this.inCh, this.outCh));
    } catch (e) {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = function () {
      self.backoff = BACKOFF_START_MS;
      self._status('connected');
      // flush anything queued while we were down
      while (self.queue.length && ws.readyState === 1) {
        ws.send(self.queue.shift());
      }
      clearInterval(self.pingTimer);
      self.pingTimer = setInterval(function () {
        if (ws.readyState === 1) {
          try { ws.send('ping'); } catch (e) {}
        }
      }, PING_INTERVAL_MS);
    };

    ws.onmessage = function (ev) {
      var raw = ev.data;
      if (raw === 'pong' || raw === 'ping') return;
      var parsed = null;
      if (typeof raw === 'string') {
        try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
      }
      if (parsed === null) return; // ignore non-JSON relay noise
      try { self.onMessage(parsed, raw); } catch (e) {
        if (global.console) console.error('[ssn-link]', self.label, 'handler error', e);
      }
    };

    ws.onclose = function () {
      clearInterval(self.pingTimer);
      if (self.closedByUser) return;
      self._status('disconnected');
      self._scheduleReconnect();
    };

    ws.onerror = function () {
      // onclose follows; nothing extra to do
    };
  };

  Connection.prototype._scheduleReconnect = function () {
    var self = this;
    clearTimeout(this.reconnectTimer);
    this._status('reconnecting');
    this.reconnectTimer = setTimeout(function () { self._open(); }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
  };

  Connection.prototype.send = function (obj) {
    var payload = typeof obj === 'string' ? obj : JSON.stringify(obj);
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(payload);
      return true;
    }
    // keep at most the 20 most recent queued messages
    this.queue.push(payload);
    if (this.queue.length > 20) this.queue.shift();
    return false;
  };

  Connection.prototype.close = function () {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    if (this.ws) try { this.ws.close(); } catch (e) {}
  };

  /* ------------------------------------------------------------ *
   * Chat message normalization. SSN payload shapes vary a little
   * between sources, so be defensive: accept single objects or
   * arrays, and pull the fields we care about with fallbacks.
   * ------------------------------------------------------------ */
  function normalizeChat(data, emit) {
    if (Array.isArray(data)) {
      for (var i = 0; i < data.length; i++) normalizeChat(data[i], emit);
      return;
    }
    if (!data || typeof data !== 'object') return;
    // some relay frames wrap the message
    if (data.contents && typeof data.contents === 'object') {
      return normalizeChat(data.contents, emit);
    }
    var message = stripHtml(String(data.chatmessage || data.message || data.msg || ''));
    var name = String(data.chatname || data.name || data.username || '').trim();
    if (!message && !name) return;
    emit({
      name: name || 'anonymous',
      message: message,
      userid: data.userid || data.userId || null,
      // stable identity for "one vote per person"
      voterKey: String(data.userid || data.userId || name || 'anonymous'),
      raw: data
    });
  }

  function stripHtml(s) {
    // SSN sometimes includes emotes/badges as inline HTML
    return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /* ------------------------------------------------------------ *
   * Public API
   * ------------------------------------------------------------ */
  var SSNLink = {
    session: resolveSession(),

    setSession: function (id) {
      this.session = (id || '').trim();
      try { global.localStorage.setItem('ssnlink_session', this.session); } catch (e) {}
    },

    /* Channel 4 — incoming chat. opts: { onMessage(msg), onStatus(state) } */
    connectChat: function (opts) {
      opts = opts || {};
      var userHandler = opts.onMessage || function () {};
      return new Connection('chat', opts.channel || CHAT_CHANNEL, null, {
        session: this.session,
        onStatus: opts.onStatus,
        onMessage: function (data) { normalizeChat(data, userHandler); }
      });
    },

    /* Channel 6 — toolkit commands. opts: { onMessage(cmdObj), onStatus(state) }
     * Only messages tagged with our toolkit marker are passed through. */
    connectControl: function (opts) {
      opts = opts || {};
      var userHandler = opts.onMessage || function () {};
      var ctrlCh = opts.channel || CONTROL_CHANNEL;
      var conn = new Connection('control', ctrlCh, ctrlCh, {
        session: this.session,
        onStatus: opts.onStatus,
        onMessage: function (data) {
          if (!data) return;
          // our own tagged commands
          if (data.toolkit === 'webinar-kit' && data.cmd) return userHandler(data);
          // messages injected via SSN's HTTP API arrive as {action, value}
          // e.g. GET https://io.socialstream.ninja/SESSION/trigger/null/spin?channel=6
          if (data.action) return userHandler(data);
        }
      });
      var plainSend = conn.send.bind(conn);
      conn.send = function (obj) {
        if (obj && typeof obj === 'object') obj.toolkit = 'webinar-kit';
        return plainSend(obj);
      };
      return conn;
    }
  };

  global.SSNLink = SSNLink;
})(window);
