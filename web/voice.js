// Proximity voice chat: talk to players near you. Off until the player turns it on (the browser asks for the
// microphone). Audio goes straight between players' browsers (WebRTC); the world server only passes on the messages
// that set a connection up, and only between two players who both have voice on and stand near each other. Voices
// get quieter with distance and stop past VOICE_FAR. Anyone can be muted.

const VOICE_NEAR = 32; // blocks: connect to players with voice on this close
const VOICE_FAR = 40; // and hang up past this
const ICE = [{ urls: "stun:stun.cloudflare.com:3478" }, { urls: "stun:stun.l.google.com:19302" }];

/// `net`: the world client (send, others, id). `ui`: { status(text), changed(on) }.
export function createVoice(net, ui) {
  let mic = null, on = false;
  const voiceOn = new Set(); // ids of players with voice on
  const peers = new Map(); // id -> { pc, audio, polite, makingOffer }
  let muted = new Set();
  try { muted = new Set(JSON.parse(localStorage.getItem("mwc:voiceMuted")) ?? []); } catch {}

  function hangUp(id) {
    const p = peers.get(id);
    if (!p) return;
    try { p.pc.close(); } catch {}
    p.audio.srcObject = null;
    p.audio.remove();
    peers.delete(id);
  }

  function call(id) {
    // "Perfect negotiation": either side may start; the one with the higher id gives way on a clash.
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const audio = document.createElement("audio");
    audio.autoplay = true;
    document.body.append(audio);
    const p = { pc, audio, polite: net.id > id, makingOffer: false };
    peers.set(id, p);
    for (const t of mic.getAudioTracks()) pc.addTrack(t, mic);
    pc.ontrack = (e) => { audio.srcObject = e.streams[0]; };
    pc.onicecandidate = (e) => { if (e.candidate) net.send(["rtc", id, { c: e.candidate.toJSON() }]); };
    pc.onnegotiationneeded = async () => {
      try {
        p.makingOffer = true;
        await pc.setLocalDescription();
        net.send(["rtc", id, { d: pc.localDescription.toJSON() }]);
      } catch {} finally { p.makingOffer = false; }
    };
    pc.onconnectionstatechange = () => { if (pc.connectionState === "failed") hangUp(id); };
    return p;
  }

  /// A set-up message from player `from`.
  async function signal(from, data) {
    if (!on || !voiceOn.has(from)) return;
    const p = peers.get(from) ?? call(from);
    const pc = p.pc;
    try {
      if (data.d) {
        const offerClash = data.d.type === "offer" && (p.makingOffer || pc.signalingState !== "stable");
        if (offerClash && !p.polite) return;
        await pc.setRemoteDescription(data.d);
        if (data.d.type === "offer") {
          await pc.setLocalDescription();
          net.send(["rtc", from, { d: pc.localDescription.toJSON() }]);
        }
      } else if (data.c) {
        await pc.addIceCandidate(data.c).catch(() => {});
      }
    } catch {}
  }

  /// Every frame or so: connect to nearby players with voice on, hang up on far ones, and set volumes by distance.
  function tick(me) {
    if (!on) return;
    for (const [id, o] of net.others) {
      const d = Math.hypot(o.pos.x - me.x, o.pos.y - me.y, o.pos.z - me.z);
      const p = peers.get(id);
      if (!voiceOn.has(id) || d > VOICE_FAR) { if (p) hangUp(id); continue; }
      // The lower id rings first, so two players don't both start at once (negotiation sorts out any clash).
      if (!p && d < VOICE_NEAR && net.id < id) call(id);
      if (p) p.audio.volume = muted.has(o.name) ? 0 : Math.max(0, Math.min(1, 1.15 - d / VOICE_FAR));
    }
    for (const id of peers.keys()) if (!net.others.has(id)) hangUp(id);
    const talking = peers.size;
    ui.status(talking ? `Voice on · connected to ${talking} nearby` : "Voice on · nobody with voice nearby yet");
  }

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) throw new Error("This browser can't do voice chat.");
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    on = true;
    net.send(["voice", 1]);
    ui.changed(true);
  }
  function stop() {
    on = false;
    for (const id of [...peers.keys()]) hangUp(id);
    mic?.getTracks().forEach((t) => t.stop());
    mic = null;
    net.send(["voice", 0]);
    ui.changed(false);
    ui.status("Voice is off.");
  }

  return {
    get on() { return on; },
    async toggle() {
      try {
        if (on) stop();
        else await start();
      } catch (e) {
        ui.status(e?.name === "NotAllowedError" ? "The microphone was blocked: allow it in the browser's site settings." : e.message);
        ui.changed(false);
      }
    },
    tick,
    signal,
    /// Who has voice on (from the room).
    setVoice(id, v) { if (v) voiceOn.add(id); else { voiceOn.delete(id); hangUp(id); } },
    setVoices(ids) { for (const id of ids) voiceOn.add(id); },
    left(id) { voiceOn.delete(id); hangUp(id); },
    mute(name) {
      if (muted.has(name)) muted.delete(name); else muted.add(name);
      try { localStorage.setItem("mwc:voiceMuted", JSON.stringify([...muted])); } catch {}
      return muted.has(name);
    },
    isMuted: (name) => muted.has(name),
    reconnected() { if (on) net.send(["voice", 1]); },
  };
}
