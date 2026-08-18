// WebGBLink — PeerJS wrapper for serverless Game Boy link cable over WebRTC.
//
// Host calls setupAsHost() → Promise<roomId>  (Peer open, waiting for guest)
// Guest calls setupAsGuest(roomId) → Promise<void>  (DataChannel open)
//
// Events dispatched on the instance:
//   'ready'        — DataChannel open, handshake can begin
//   'disconnected' — peer gone or error
//   'message'      — incoming JSON message, detail = parsed object
//   'status'       — human-readable progress, detail = { text, level? }

// PeerJS signaling + Google STUN for host/srflx ICE. Works across Wi‑Fi and
// mobile data when NAT traversal succeeds. TURN is intentionally omitted —
// if ICE never opens a data channel, the path is blocked (symmetric NAT /
// firewall / captive portal), not “must be same Wi‑Fi”.
const WGL_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

function peerOpts() {
  return {
    debug: 2,
    config: {
      iceServers: WGL_ICE_SERVERS,
      // Prefer direct host/srflx paths; do not force relay.
      iceTransportPolicy: "all",
      iceCandidatePoolSize: 4,
    },
  };
}

function makeRoomId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  // Reject bytes >= 252 (252 = 7×36) to avoid modulo bias; probability ~1.6% per byte.
  const pool = new Uint8Array(16);
  crypto.getRandomValues(pool);
  let id = "";
  for (const b of pool) {
    if (b < 252) {
      id += chars[b % 36];
      if (id.length === 6) break;
    }
  }
  // Extremely unlikely: not enough unbiased bytes in one draw.
  while (id.length < 6) {
    const b = crypto.getRandomValues(new Uint8Array(1))[0];
    if (b < 252) id += chars[b % 36];
  }
  return id;
}

function errText(err) {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  return err.type || err.message || String(err);
}

/** Extract private IPv4 host candidates from an RTCPeerConnection (best-effort). */
function hostCandidateIps(pc) {
  const ips = [];
  try {
    // peerConnection.getStats is async; for sync status we only scrape localDescription SDP.
    const sdp = pc?.localDescription?.sdp || "";
    for (const line of sdp.split(/\r?\n/)) {
      // a=candidate:... <ip> ... typ host
      const m = /candidate:\S+\s+\d+\s+\w+\s+\d+\s+([0-9.]+)\s+\d+\s+typ\s+host/i.exec(line);
      if (!m) continue;
      const ip = m[1];
      if (ip.startsWith("127.") || ips.includes(ip)) continue;
      ips.push(ip);
    }
  } catch (_) { /* ignore */ }
  return ips;
}

export class WebGBLink extends EventTarget {
  constructor() {
    super();
    this.peer = null;
    this.conn = null;
    this.isHost = false;
    this.isGuest = false;
    this.isConnected = false;
    this._connectTimer = null;
    this._iceWatchTimer = null;
    this._closed = false;
  }

  _emitStatus(text, level) {
    console.log("[webgblink]", text);
    this.dispatchEvent(new CustomEvent("status", { detail: { text, level: level || "info" } }));
  }

  _clearTimers() {
    if (this._connectTimer) {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
    }
    if (this._iceWatchTimer) {
      clearInterval(this._iceWatchTimer);
      this._iceWatchTimer = null;
    }
  }

  /** Best-effort ICE state from the underlying PeerJS DataConnection. */
  _iceSnapshot(conn) {
    try {
      const pc = conn?.peerConnection || conn?._peerConnection || null;
      if (!pc) return null;
      return {
        ice: pc.iceConnectionState || "?",
        conn: pc.connectionState || "?",
        gather: pc.iceGatheringState || "?",
        hosts: hostCandidateIps(pc),
      };
    } catch (_) {
      return null;
    }
  }

  _watchIce(conn, label) {
    if (this._iceWatchTimer) clearInterval(this._iceWatchTimer);
    let last = "";
    this._iceWatchTimer = setInterval(() => {
      if (this.isConnected || this._closed) {
        clearInterval(this._iceWatchTimer);
        this._iceWatchTimer = null;
        return;
      }
      const snap = this._iceSnapshot(conn);
      if (!snap) return;
      const hosts = snap.hosts?.length ? snap.hosts.join(",") : "—";
      const key = `${snap.ice}|${snap.conn}|${snap.gather}|${hosts}`;
      if (key === last) return;
      last = key;
      this._emitStatus(
        `${label}: ICE=${snap.ice} · PC=${snap.conn} · gather=${snap.gather} · host=${hosts}`
      );
    }, 1000);
  }

  // Host: open a Peer at the given room ID, resolve once the Peer is open.
  // The returned roomId is what the guest must pass to setupAsGuest().
  setupAsHost() {
    const roomId = makeRoomId();
    this.isHost = true;
    this.isGuest = false;
    this._closed = false;
    return new Promise((resolve, reject) => {
      this._emitStatus("Opening host peer…");
      const peer = new Peer(roomId, peerOpts());
      this.peer = peer;
      peer.on("open", (id) => {
        console.log("[webgblink] host open id=", id);
        this._emitStatus("Room " + id + " open — waiting for guest");
        peer.on("connection", (conn) => {
          this._emitStatus("Guest peer connecting…");
          this._attachConn(conn);
          this._watchIce(conn, "Host");
        });
        resolve(roomId);
      });
      peer.on("error", (err) => {
        console.error("[webgblink] host error", err);
        this._emitStatus("Host error: " + errText(err), "error");
        reject(err);
      });
      peer.on("disconnected", () => {
        console.warn("[webgblink] host peer disconnected from broker — trying reconnect");
        try { peer.reconnect(); } catch (_) { /* ignore */ }
      });
    });
  }

  // Guest: open an anonymous Peer then connect to host's room.
  // Resolves once the DataChannel is open (fires 'ready' event simultaneously).
  // Single attempt — same-LAN should complete via host candidates + STUN.
  setupAsGuest(roomId) {
    this.isHost = false;
    this.isGuest = true;
    this._closed = false;

    return new Promise((resolve, reject) => {
      if (this._closed) {
        reject(new Error("closed"));
        return;
      }

      this._emitStatus("Opening guest peer…");
      const peer = new Peer(undefined, peerOpts());
      this.peer = peer;
      let settled = false;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        this._clearTimers();
        console.error("[webgblink] guest error", err);
        try { peer.destroy(); } catch (_) { /* ignore */ }
        if (this.peer === peer) this.peer = null;
        reject(err instanceof Error ? err : new Error(errText(err)));
      };

      const succeed = () => {
        if (settled) return;
        settled = true;
        this._clearTimers();
        resolve();
      };

      peer.on("open", () => {
        console.log("[webgblink] guest open, connecting to", roomId);
        this._emitStatus("Signaling OK — negotiating data channel to " + roomId + "…");

        const conn = peer.connect(roomId, {
          reliable: true,
          serialization: "binary",
        });

        const timeoutMs = 20000;
        this._connectTimer = setTimeout(() => {
          if (this.isConnected || settled) return;
          const snap = this._iceSnapshot(conn);
          const iceHint = snap
            ? ` ICE=${snap.ice} host=${(snap.hosts || []).join(",") || "—"}`
            : "";
          fail(new Error(
            `Data channel timeout (${timeoutMs / 1000}s).${iceHint}. ` +
            "Works over Wi‑Fi or mobile data via STUN/PeerJS. If this hangs, " +
            "check firewall / captive portal / symmetric NAT — or AP client " +
            "isolation when both are on the same LAN (e.g. iPhone hotspot)."
          ));
          try { conn.close(); } catch (_) { /* ignore */ }
        }, timeoutMs);

        conn.on("open", succeed);
        conn.on("error", (err) => fail(err));
        this._attachConn(conn);
        this._watchIce(conn, "Guest");
      });

      peer.on("error", (err) => fail(err));
      peer.on("disconnected", () => {
        console.warn("[webgblink] guest peer disconnected from broker — trying reconnect");
        try { peer.reconnect(); } catch (_) { /* ignore */ }
      });
    });
  }

  send(msg) {
    if (this.conn && this.isConnected) {
      try {
        this.conn.send(msg);
      } catch (err) {
        console.error("[webgblink] send failed", err);
      }
    }
  }

  close() {
    this._closed = true;
    this._clearTimers();
    if (this.conn) {
      try { this.conn.close(); } catch (_) { /* ignore */ }
      this.conn = null;
    }
    if (this.peer) {
      try { this.peer.destroy(); } catch (_) { /* ignore */ }
      this.peer = null;
    }
    this.isConnected = false;
    this.isHost = false;
    this.isGuest = false;
  }

  _attachConn(conn) {
    // Replace any previous connection (re-join).
    if (this.conn && this.conn !== conn) {
      try { this.conn.close(); } catch (_) { /* ignore */ }
    }
    this.conn = conn;
    conn.on("open", () => {
      this.isConnected = true;
      this._clearTimers();
      console.log("[webgblink] DataChannel open");
      const snap = this._iceSnapshot(conn);
      this._emitStatus(
        snap
          ? `Data channel open (ICE=${snap.ice} host=${(snap.hosts || []).join(",") || "—"})`
          : "Data channel open"
      );
      this.dispatchEvent(new CustomEvent("ready"));
    });
    conn.on("data", (data) => {
      this.dispatchEvent(new CustomEvent("message", { detail: data }));
    });
    conn.on("close", () => {
      this.isConnected = false;
      console.log("[webgblink] disconnected");
      this._emitStatus("Peer disconnected", "warn");
      this.dispatchEvent(new CustomEvent("disconnected"));
    });
    conn.on("error", (err) => {
      console.error("[webgblink] conn error", err);
      this.isConnected = false;
      this._emitStatus("Connection error: " + errText(err), "error");
      this.dispatchEvent(new CustomEvent("disconnected"));
    });
  }
}

/**
 * Best-effort discovery of a non-loopback IPv4 via WebRTC host candidates.
 * Used so "Copy link" can hand phones a reachable LAN URL when the host
 * is browsing at http://localhost:….
 */
export function discoverLanIPv4(timeoutMs = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ip) => {
      if (done) return;
      done = true;
      try { pc.close(); } catch (_) { /* ignore */ }
      resolve(ip || null);
    };
    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
    } catch (_) {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => finish(null), timeoutMs);
    pc.createDataChannel("lan-probe");
    pc.onicecandidate = (ev) => {
      if (!ev.candidate || !ev.candidate.candidate) {
        if (ev.candidate === null) {
          clearTimeout(timer);
          finish(null);
        }
        return;
      }
      // candidate:... typ host ...
      const m = /([0-9]{1,3}(?:\.[0-9]{1,3}){3})/.exec(ev.candidate.candidate);
      if (!m) return;
      const ip = m[1];
      if (ip.startsWith("127.") || ip.startsWith("0.")) return;
      // Prefer private ranges (LAN / hotspot).
      if (
        ip.startsWith("10.") ||
        ip.startsWith("192.168.") ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
      ) {
        clearTimeout(timer);
        finish(ip);
      }
    };
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(() => {
        clearTimeout(timer);
        finish(null);
      });
  });
}
