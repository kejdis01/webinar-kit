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
   * Shared location data for the world map widget. One person =
   * one pin: SSNLink.matchLocation(text) finds the most specific
   * place mentioned (city beats country, longer name beats shorter).
   * Keys are ASCII lowercase; incoming text is diacritic-stripped
   * before matching, so "São Paulo" and "Türkiye" still match.
   * ------------------------------------------------------------ */
  var GEO_COUNTRIES = {"afghanistan":[33,66],"albania":[41,20],"algeria":[28,3],"argentina":[-34,-64],"armenia":[40,45],"australia":[-25,134],"austria":[47,14],"azerbaijan":[40,47],"bangladesh":[24,90],"belarus":[53,28],"belgium":[50,4],"bolivia":[-17,-64],"bosnia":[44,18],"brazil":[-10,-52],"bulgaria":[43,25],"burundi":[-3,30],"rwanda":[-2,30],"malawi":[-13,34],"zambia":[-14,28],"botswana":[-22,24],"namibia":[-22,17],"mozambique":[-18,35],"angola":[-12,18],"madagascar":[-20,47],"sudan":[13,30],"south sudan":[7,30],"democratic republic of congo":[-3,23],"drc":[-3,23],"congo":[-1,15],"mali":[17,-4],"niger":[17,8],"chad":[15,19],"burkina faso":[13,-2],"ivory coast":[8,-5],"cote d ivoire":[8,-5],"liberia":[6,-9],"sierra leone":[8,-11],"guinea":[10,-11],"benin":[9,2],"togo":[8,1],"somalia":[6,48],"eritrea":[15,39],"djibouti":[12,43],"cambodia":[12,105],"cameroon":[5,12],"canada":[56,-106],"chile":[-32,-71],"china":[35,104],"colombia":[4,-73],"costa rica":[10,-84],"croatia":[45,16],"cuba":[22,-79],"cyprus":[35,33],"czech":[49,15],"czechia":[49,15],"denmark":[56,10],"dominican republic":[19,-70],"ecuador":[-1,-78],"egypt":[26,30],"estonia":[58,25],"ethiopia":[9,39],"finland":[62,26],"france":[46,2],"georgia":[42,43],"germany":[51,10],"ghana":[8,-1],"greece":[39,22],"guatemala":[15,-90],"honduras":[14,-86],"hungary":[47,19],"iceland":[65,-18],"india":[21,78],"indonesia":[-2,118],"iran":[32,53],"iraq":[33,43],"ireland":[53,-8],"israel":[31,35],"italy":[42,12],"jamaica":[18,-77],"japan":[36,138],"jordan":[31,36],"kazakhstan":[48,67],"kenya":[0,38],"kosovo":[42,21],"kuwait":[29,47],"latvia":[57,25],"lebanon":[34,36],"libya":[27,17],"lithuania":[55,24],"luxembourg":[49,6],"malaysia":[3,102],"malta":[36,14],"mexico":[23,-102],"moldova":[47,29],"mongolia":[46,105],"montenegro":[42,19],"morocco":[32,-6],"myanmar":[21,96],"nepal":[28,84],"netherlands":[52,5],"new zealand":[-42,172],"nicaragua":[13,-85],"nigeria":[9,8],"north macedonia":[41,21],"macedonia":[41,21],"norway":[61,9],"oman":[21,57],"pakistan":[30,69],"panama":[9,-80],"paraguay":[-23,-58],"peru":[-10,-76],"philippines":[13,122],"poland":[52,19],"portugal":[39,-8],"qatar":[25,51],"romania":[46,25],"russia":[60,90],"saudi arabia":[24,45],"senegal":[14,-14],"serbia":[44,21],"singapore":[1,104],"slovakia":[48,19],"slovenia":[46,15],"south africa":[-29,24],"south korea":[36,128],"korea":[36,128],"spain":[40,-4],"sri lanka":[8,81],"sweden":[62,15],"switzerland":[47,8],"syria":[35,38],"taiwan":[24,121],"tanzania":[-6,35],"thailand":[15,101],"tunisia":[34,9],"turkey":[39,35],"turkiye":[39,35],"uganda":[1,32],"ukraine":[49,32],"united arab emirates":[24,54],"uae":[24,54],"united kingdom":[54,-2],"uk":[54,-2],"england":[52,-1],"scotland":[56,-4],"united states":[38,-97],"usa":[38,-97],"us":[38,-97],"america":[38,-97],"uruguay":[-33,-56],"uzbekistan":[41,64],"venezuela":[7,-66],"vietnam":[16,106],"yemen":[15,48],"zimbabwe":[-19,30]};

  var GEO_CITIES = {"tirana":[41.3,19.8],"durres":[41.3,19.4],"vlore":[40.5,19.5],"shkoder":[42.1,19.5],"pristina":[42.7,21.2],"skopje":[42.0,21.4],"podgorica":[42.4,19.3],"sarajevo":[43.9,18.4],"belgrade":[44.8,20.5],"zagreb":[45.8,16.0],"ljubljana":[46.1,14.5],"vienna":[48.2,16.4],"budapest":[47.5,19.0],"prague":[50.1,14.4],"bratislava":[48.1,17.1],"warsaw":[52.2,21.0],"krakow":[50.1,19.9],"berlin":[52.5,13.4],"munich":[48.1,11.6],"hamburg":[53.6,10.0],"frankfurt":[50.1,8.7],"cologne":[50.9,7.0],"amsterdam":[52.4,4.9],"rotterdam":[51.9,4.5],"brussels":[50.8,4.4],"paris":[48.9,2.4],"lyon":[45.8,4.8],"marseille":[43.3,5.4],"london":[51.5,-0.1],"manchester":[53.5,-2.2],"birmingham":[52.5,-1.9],"edinburgh":[55.9,-3.2],"glasgow":[55.9,-4.3],"dublin":[53.3,-6.3],"madrid":[40.4,-3.7],"barcelona":[41.4,2.2],"valencia":[39.5,-0.4],"seville":[37.4,-6.0],"lisbon":[38.7,-9.1],"porto":[41.1,-8.6],"rome":[41.9,12.5],"milan":[45.5,9.2],"naples":[40.8,14.3],"turin":[45.1,7.7],"florence":[43.8,11.3],"venice":[45.4,12.3],"athens":[38.0,23.7],"thessaloniki":[40.6,23.0],"istanbul":[41.0,29.0],"ankara":[39.9,32.9],"izmir":[38.4,27.1],"bucharest":[44.4,26.1],"sofia":[42.7,23.3],"chisinau":[47.0,28.8],"kyiv":[50.5,30.5],"kiev":[50.5,30.5],"lviv":[49.8,24.0],"odesa":[46.5,30.7],"minsk":[53.9,27.6],"moscow":[55.8,37.6],"saint petersburg":[59.9,30.3],"riga":[56.9,24.1],"vilnius":[54.7,25.3],"tallinn":[59.4,24.8],"helsinki":[60.2,24.9],"stockholm":[59.3,18.1],"gothenburg":[57.7,12.0],"oslo":[59.9,10.8],"copenhagen":[55.7,12.6],"reykjavik":[64.1,-21.9],"zurich":[47.4,8.5],"geneva":[46.2,6.1],"bern":[46.9,7.4],"new york":[40.7,-74.0],"los angeles":[34.1,-118.2],"chicago":[41.9,-87.6],"houston":[29.8,-95.4],"dallas":[32.8,-96.8],"austin":[30.3,-97.7],"miami":[25.8,-80.2],"atlanta":[33.7,-84.4],"boston":[42.4,-71.1],"seattle":[47.6,-122.3],"san francisco":[37.8,-122.4],"san diego":[32.7,-117.2],"denver":[39.7,-105.0],"phoenix":[33.4,-112.1],"philadelphia":[40.0,-75.2],"washington":[38.9,-77.0],"las vegas":[36.2,-115.1],"portland":[45.5,-122.7],"minneapolis":[45.0,-93.3],"detroit":[42.3,-83.0],"toronto":[43.7,-79.4],"vancouver":[49.3,-123.1],"montreal":[45.5,-73.6],"ottawa":[45.4,-75.7],"calgary":[51.0,-114.1],"mexico city":[19.4,-99.1],"guadalajara":[20.7,-103.3],"monterrey":[25.7,-100.3],"guatemala city":[14.6,-90.5],"panama city":[9.0,-79.5],"bogota":[4.7,-74.1],"medellin":[6.2,-75.6],"lima":[-12.0,-77.0],"quito":[-0.2,-78.5],"caracas":[10.5,-66.9],"santiago":[-33.5,-70.7],"buenos aires":[-34.6,-58.4],"cordoba":[-31.4,-64.2],"montevideo":[-34.9,-56.2],"sao paulo":[-23.6,-46.6],"rio de janeiro":[-22.9,-43.2],"brasilia":[-15.8,-47.9],"havana":[23.1,-82.4],"santo domingo":[18.5,-69.9],"san juan":[18.5,-66.1],"cairo":[30.0,31.2],"alexandria":[31.2,29.9],"casablanca":[33.6,-7.6],"rabat":[34.0,-6.8],"tunis":[36.8,10.2],"algiers":[36.8,3.1],"lagos":[6.5,3.4],"abuja":[9.1,7.4],"accra":[5.6,-0.2],"nairobi":[-1.3,36.8],"addis ababa":[9.0,38.7],"dar es salaam":[-6.8,39.3],"kampala":[0.3,32.6],"johannesburg":[-26.2,28.0],"cape town":[-33.9,18.4],"durban":[-29.9,31.0],"dakar":[14.7,-17.5],"tel aviv":[32.1,34.8],"jerusalem":[31.8,35.2],"amman":[32.0,35.9],"beirut":[33.9,35.5],"damascus":[33.5,36.3],"baghdad":[33.3,44.4],"riyadh":[24.7,46.7],"jeddah":[21.5,39.2],"dubai":[25.2,55.3],"abu dhabi":[24.5,54.4],"doha":[25.3,51.5],"kuwait city":[29.4,48.0],"muscat":[23.6,58.4],"manama":[26.2,50.6],"tehran":[35.7,51.4],"sanaa":[15.4,44.2],"delhi":[28.6,77.2],"new delhi":[28.6,77.2],"mumbai":[19.1,72.9],"bangalore":[13.0,77.6],"bengaluru":[13.0,77.6],"hyderabad":[17.4,78.5],"chennai":[13.1,80.3],"kolkata":[22.6,88.4],"pune":[18.5,73.9],"ahmedabad":[23.0,72.6],"karachi":[24.9,67.0],"lahore":[31.6,74.3],"islamabad":[33.7,73.1],"dhaka":[23.8,90.4],"kathmandu":[27.7,85.3],"colombo":[6.9,79.9],"kabul":[34.5,69.2],"tashkent":[41.3,69.3],"almaty":[43.3,76.9],"astana":[51.2,71.4],"baku":[40.4,49.9],"tbilisi":[41.7,44.8],"yerevan":[40.2,44.5],"beijing":[39.9,116.4],"shanghai":[31.2,121.5],"shenzhen":[22.5,114.1],"guangzhou":[23.1,113.3],"chengdu":[30.7,104.1],"hong kong":[22.3,114.2],"taipei":[25.0,121.6],"tokyo":[35.7,139.7],"osaka":[34.7,135.5],"kyoto":[35.0,135.8],"seoul":[37.6,127.0],"busan":[35.2,129.1],"bangkok":[13.8,100.5],"hanoi":[21.0,105.8],"ho chi minh":[10.8,106.7],"saigon":[10.8,106.7],"phnom penh":[11.6,104.9],"kuala lumpur":[3.1,101.7],"jakarta":[-6.2,106.8],"bali":[-8.4,115.2],"surabaya":[-7.3,112.7],"manila":[14.6,121.0],"cebu":[10.3,123.9],"yangon":[16.8,96.2],"sydney":[-33.9,151.2],"melbourne":[-37.8,145.0],"brisbane":[-27.5,153.0],"perth":[-32.0,115.9],"adelaide":[-34.9,138.6],"auckland":[-36.8,174.8],"wellington":[-41.3,174.8],"christchurch":[-43.5,172.6]};

  function geoNormalize(text) {
    var t = String(text).toLowerCase();
    try { t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) {}
    return ' ' + t.replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
  }

  /* Returns { type: 'city'|'country', key, coords } or null.
   * Cities beat countries; among several matches the longest
   * name wins, so "mexico city" is preferred over "mexico". */
  function matchLocation(text) {
    var t = geoNormalize(text);
    var best = null;
    function scan(dict, type) {
      for (var name in dict) {
        if (t.indexOf(' ' + name + ' ') !== -1) {
          if (!best || name.length > best.key.length) {
            best = { type: type, key: name, coords: dict[name] };
          }
        }
      }
    }
    scan(GEO_CITIES, 'city');
    if (!best) scan(GEO_COUNTRIES, 'country');
    return best;
  }

  /* ------------------------------------------------------------ *
   * Public API
   * ------------------------------------------------------------ */
  var SSNLink = {
    VERSION: '14',
    session: resolveSession(),
    GEO: { countries: GEO_COUNTRIES, cities: GEO_CITIES },
    matchLocation: matchLocation,

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
