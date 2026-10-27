const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const state = {
  user: null, authMode: "login", joined: false, ws: null, peerId: null,
  localStream: null, peers: new Map(), remoteStreams: new Map(), micOn: true,
  cameraOn: true, facingMode: "user", viewer: null, weatherLayer: null,
  borders: null, geolocationEnabled: false, geoMarker: null, globeMode: "normal",
  recognition: null, voiceFinal: "", voiceTimer: null, voiceManualStop: false,
  aiBusy: false, orbFrames: [], volumeOpen: false, localWeather: null
};
const toast = (message) => {
  const el = $("#toast"); el.textContent = message; el.classList.remove("hidden");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.add("hidden"), 3600);
};
async function api(url, options = {}) {
  const response = await fetch(url, {credentials:"same-origin", ...options, headers:{"Content-Type":"application/json", ...(options.headers || {})}});
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error(data.detail || data.message || ("Ошибка запроса: " + response.status));
  return data;
}
function setAuthMode(mode) {
  state.authMode = mode;
  $("#authTitle").textContent = mode === "login" ? "Встречаемся здесь." : "Твоё место здесь.";
  $("#authSubtitle").textContent = mode === "login" ? "Войди в общую комнату — камера и микрофон будут под рукой." : "Придумай никнейм, создай пароль и присоединяйся.";
  $("#authSubmit").innerHTML = mode === "login" ? "Войти и присоединиться <span>↗</span>" : "Создать аккаунт <span>↗</span>";
  $("#authSwitchText").textContent = mode === "login" ? "Впервые здесь?" : "Уже есть аккаунт?";
  $("#authSwitch").textContent = mode === "login" ? "Создать аккаунт" : "Войти";
  $("#password").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("#authError").classList.add("hidden");
}
$("#authSwitch").addEventListener("click", () => setAuthMode(state.authMode === "login" ? "register" : "login"));
$("#authForm").addEventListener("submit", async (event) => {
  event.preventDefault(); $("#authSubmit").disabled = true; $("#authError").classList.add("hidden");
  try {
    const data = await api("/api/auth/" + state.authMode, {method:"POST", body:JSON.stringify({nickname:$("#nickname").value.trim(), password:$("#password").value})});
    state.user = data.user; showApp(); await loadAiHistory(); await loadPreferences(); await joinCall();
  } catch (err) {
    $("#authError").textContent = err.message; $("#authError").classList.remove("hidden");
  } finally { $("#authSubmit").disabled = false; }
});
async function init() {
  try {
    const data = await api("/api/auth/me");
    state.user = data.user; showApp(); await loadAiHistory(); await loadPreferences(); await joinCall();
  } catch { $("#authView").classList.remove("hidden"); $("#appView").classList.add("hidden"); }
  drawOrb($("#aiOrb"), false); drawOrb($("#voiceOrb"), true);
}
function showApp() {
  $("#authView").classList.add("hidden"); $("#appView").classList.remove("hidden");
  $("#profileName").textContent = state.user.nickname; $("#profileAvatar").textContent = state.user.nickname.slice(0,1).toUpperCase();
  $("#selfLabel").textContent = state.user.nickname + " (ты)"; $("#selfTileName").textContent = state.user.nickname;
  $("#aiNickname").textContent = state.user.nickname;
  if (!sessionStorage.getItem("commonspace_weather_requested")) {
    sessionStorage.setItem("commonspace_weather_requested", "1");
    if (navigator.geolocation) navigator.geolocation.getCurrentPosition(pos => loadLocalWeather(pos.coords.latitude, pos.coords.longitude), () => {}, {timeout:9000, maximumAge:300000});
  }
}
$("#logoutBtn").addEventListener("click", async () => {
  await leaveCall(false);
  try { await api("/api/auth/logout", {method:"POST",body:"{}"}); } catch {}
  state.user = null; $("#appView").classList.add("hidden"); $("#authView").classList.remove("hidden"); $("#password").value = "";
});
function showView(view) {
  const labels = {call:"Общий звонок",ai:"ИИ-помощник",earth:"Земля и погода"};
  ["call","ai","earth"].forEach(v => $("#" + v + "View").classList.toggle("hidden", v !== view));
  $$("[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $("#pageTitle").textContent = labels[view] || "Пространство";
  if (view === "earth") setTimeout(initGlobe, 80);
  if (view === "ai") setTimeout(() => drawOrb($("#aiOrb"), false), 10);
}
$$("[data-view]").forEach(b => b.addEventListener("click", () => showView(b.dataset.view)));
function updateCount(count) {
  $("#participantCount").textContent = count;
  $("#sideCount").textContent = count + (count === 1 ? " в комнате" : " в комнате");
  $("#callStatus").textContent = state.joined ? "В звонке" : "Не в звонке";
  $("#topJoinBtn").classList.toggle("hidden", state.joined);
  $("#joinBtn").classList.toggle("hidden", state.joined);
  $("#leaveBtn").classList.toggle("hidden", !state.joined);
  $("#emptyRoom").classList.toggle("hidden", state.joined && state.peers.size > 0);
  $("#callStage").classList.toggle("not-joined", !state.joined);
}
function makePeer(peerId, nickname) {
  if (state.peers.has(peerId)) return state.peers.get(peerId);
  const pc = new RTCPeerConnection({iceServers:[
    {urls:"stun:stun.l.google.com:19302"},
    {urls:"stun:stun1.l.google.com:19302"}
  ]});
  const record = {pc, nickname:nickname || "Участник", stream:new MediaStream(), tile:null, audio:null};
  state.peers.set(peerId, record);
  if (state.localStream) state.localStream.getTracks().forEach(track => pc.addTrack(track, state.localStream));
  pc.onicecandidate = (event) => {
    if (event.candidate) sendSignal(peerId, {candidate:event.candidate});
  };
  pc.ontrack = (event) => {
    const stream = event.streams && event.streams[0];
    if (stream) record.stream = stream;
    else record.stream.addTrack(event.track);
    state.remoteStreams.set(peerId, record.stream);
    ensureRemoteTile(peerId, record.nickname, record.stream);
  };
  pc.onconnectionstatechange = () => {
    if (["failed","closed","disconnected"].includes(pc.connectionState) && pc.connectionState === "failed") {
      toast("Не удалось соединиться с " + record.nickname + ". Возможно, нужна TURN-сеть.");
    }
  };
  return record;
}
function sendSignal(target, signal) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({type:"signal", target, signal}));
}
async function makeOffer(peerId, nickname) {
  const rec = makePeer(peerId, nickname);
  try {
    const offer = await rec.pc.createOffer();
    await rec.pc.setLocalDescription(offer);
    sendSignal(peerId, {description:rec.pc.localDescription});
  } catch (e) { console.warn("Offer failed", e); }
}
async function joinCall() {
  if (state.joined) return;
  $("#callStatus").textContent = "Запрашиваем доступ…";
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({audio:true, video:{facingMode:state.facingMode}});
    state.micOn = true; state.cameraOn = true;
  } catch (err) {
    try {
      state.localStream = await navigator.mediaDevices.getUserMedia({audio:true, video:false});
      state.cameraOn = false;
      toast("Камера недоступна — подключились только с микрофоном.");
    } catch {
      toast("Разреши микрофон/камеру в браузере, затем нажми «Присоединиться».");
      $("#callStatus").textContent = "Нужен доступ к микрофону";
      return;
    }
  }
  $("#localVideo").srcObject = state.localStream;
  $("#localVideo").play().catch(()=>{});
  updateSelfMedia();
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(scheme + "//" + location.host + "/ws/room");
  state.ws = ws;
  ws.onopen = () => { state.joined = true; updateCount(state.peers.size + 1); };
  ws.onmessage = async (event) => {
    let msg; try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === "welcome") {
      state.peerId = msg.peerId; updateCount(msg.count);
      for (const peer of (msg.peers || [])) await makeOffer(peer.peerId, peer.nickname);
    } else if (msg.type === "peer-joined") {
      updateCount(msg.count);
    } else if (msg.type === "peer-left") {
      removePeer(msg.peerId); updateCount(msg.count);
    } else if (msg.type === "count") updateCount(msg.count);
    else if (msg.type === "signal") await handleSignal(msg.from, msg.signal);
  };
  ws.onerror = () => toast("Связь с комнатой прервалась. Попробуй присоединиться снова.");
  ws.onclose = () => { if (state.joined) { state.joined = false; updateCount(state.peers.size); } };
}
async function handleSignal(from, signal) {
  const rec = makePeer(from, "Участник");
  try {
    if (signal.description) {
      await rec.pc.setRemoteDescription(new RTCSessionDescription(signal.description));
      if (signal.description.type === "offer") {
        const answer = await rec.pc.createAnswer(); await rec.pc.setLocalDescription(answer);
        sendSignal(from, {description:rec.pc.localDescription});
      }
    } else if (signal.candidate) {
      try { await rec.pc.addIceCandidate(new RTCIceCandidate(signal.candidate)); } catch(e) { console.warn(e); }
    }
  } catch(e) { console.warn("Signal error", e); }
}
function ensureRemoteTile(peerId, nickname, stream) {
  const rec = state.peers.get(peerId); if (!rec) return;
  rec.nickname = nickname || rec.nickname;
  let tile = document.getElementById("tile-" + peerId);
  if (!tile) {
    tile = document.createElement("div"); tile.className = "video-tile remote-tile"; tile.id = "tile-" + peerId;
    const video = document.createElement("video"); video.autoplay = true; video.playsInline = true; video.srcObject = stream;
    const placeholder = document.createElement("div"); placeholder.className = "video-placeholder"; placeholder.innerHTML = '<div class="big-avatar">✦</div><b></b><small>Камера выключена</small>';
    const name = document.createElement("div"); name.className = "tile-name"; name.innerHTML = '<span class="you-dot"></span><span class="remote-name"></span><small>участник</small>';
    const mic = document.createElement("span"); mic.className = "tile-mic"; mic.textContent = "🎙";
    tile.append(video, placeholder, name, mic); $("#videoGrid").append(tile);
    rec.tile = tile; rec.audio = video;
    const volumeItem = document.createElement("label"); volumeItem.className = "volume-item"; volumeItem.innerHTML = '<span></span><input type="range" min="0" max="1" step="0.05" value="1"><b>100%</b>';
    volumeItem.querySelector("span").textContent = rec.nickname;
    volumeItem.querySelector("input").addEventListener("input", e => { video.volume = Number(e.target.value); volumeItem.querySelector("b").textContent = Math.round(video.volume*100)+"%"; });
    volumeItem.id = "volume-" + peerId; $("#volumeControls").append(volumeItem);
  }
  tile.querySelector(".remote-name").textContent = rec.nickname;
  tile.querySelector(".video-placeholder b").textContent = rec.nickname;
  const video = tile.querySelector("video"); if (video.srcObject !== stream) video.srcObject = stream;
  const hasVideo = stream.getVideoTracks().some(t => t.enabled && t.readyState === "live");
  tile.querySelector(".video-placeholder").classList.toggle("hidden", hasVideo);
  video.classList.toggle("hidden", !hasVideo);
  video.play().catch(()=>{});
  $("#emptyRoom").classList.add("hidden");
}
function removePeer(peerId) {
  const rec = state.peers.get(peerId);
  if (rec) { try {rec.pc.close();} catch{} rec.tile?.remove(); $("#volume-"+peerId)?.remove(); }
  state.peers.delete(peerId); state.remoteStreams.delete(peerId);
  $("#emptyRoom").classList.toggle("hidden", state.peers.size > 0 || !state.joined);
}
async function leaveCall(showMessage = true) {
  state.joined = false;
  if (state.ws) { try { state.ws.close(); } catch{} state.ws = null; }
  for (const id of [...state.peers.keys()]) removePeer(id);
  state.localStream?.getTracks().forEach(t => t.stop()); state.localStream = null; state.peerId = null;
  $("#localVideo").srcObject = null;
  updateCount(0); updateSelfMedia();
  if (showMessage) toast("Ты вышел из звонка. Можно присоединиться снова.");
}
$("#joinBtn").addEventListener("click", joinCall); $("#topJoinBtn").addEventListener("click", joinCall); $("#emptyJoinBtn").addEventListener("click", joinCall);
$("#leaveBtn").addEventListener("click", () => leaveCall(true));
$("#micBtn").addEventListener("click", () => {
  if (!state.localStream) return toast("Сначала присоединись к звонку.");
  state.micOn = !state.micOn; state.localStream.getAudioTracks().forEach(t => t.enabled = state.micOn); updateSelfMedia();
});
$("#cameraBtn").addEventListener("click", async () => {
  if (!state.localStream) return toast("Сначала присоединись к звонку.");
  const track = state.localStream.getVideoTracks()[0];
  if (!track) {
    try { const stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:state.facingMode}}); const newTrack = stream.getVideoTracks()[0]; state.localStream.addTrack(newTrack); for (const [peerId, r] of state.peers) { const sender = r.pc.getSenders().find(s => s.track && s.track.kind === "video"); if (sender) await sender.replaceTrack(newTrack); else { r.pc.addTrack(newTrack,state.localStream); try { const offer=await r.pc.createOffer(); await r.pc.setLocalDescription(offer); sendSignal(peerId,{description:r.pc.localDescription}); } catch(err) { console.warn("Camera renegotiation failed",err); } } } state.cameraOn = true; $("#localVideo").srcObject = state.localStream; updateSelfMedia(); }
    catch { toast("Не удалось включить камеру. Проверь разрешение браузера."); }
    return;
  }
  state.cameraOn = !state.cameraOn; track.enabled = state.cameraOn; updateSelfMedia();
});
$("#switchCameraBtn").addEventListener("click", async () => {
  if (!state.localStream) return toast("Сначала присоединись к звонку.");
  const old = state.localStream.getVideoTracks()[0];
  state.facingMode = state.facingMode === "user" ? "environment" : "user";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:state.facingMode}},audio:false});
    const newTrack = stream.getVideoTracks()[0]; if (!newTrack) throw new Error();
    if (old) { state.localStream.removeTrack(old); old.stop(); }
    state.localStream.addTrack(newTrack); state.cameraOn = true;
    for (const rec of state.peers.values()) {
      const sender = rec.pc.getSenders().find(s => s.track && s.track.kind === "video");
      if (sender) await sender.replaceTrack(newTrack);
    }
    $("#localVideo").srcObject = state.localStream; updateSelfMedia(); toast("Камера переключена.");
  } catch { toast("На этом устройстве не удалось переключить камеру."); }
});
function updateSelfMedia() {
  const hasVideo = !!(state.localStream && state.cameraOn && state.localStream.getVideoTracks().some(t=>t.enabled));
  $("#localVideo").classList.toggle("hidden", !hasVideo);
  $("#selfPlaceholder").classList.toggle("hidden", hasVideo);
  $("#micBtn").classList.toggle("off", !state.micOn); $("#cameraBtn").classList.toggle("off", !state.cameraOn);
  $("#micBtn").classList.toggle("active", state.micOn); $("#cameraBtn").classList.toggle("active", state.cameraOn);
  $("#micBtn").querySelector("small").textContent = state.micOn ? "Микрофон" : "Без звука";
  $("#cameraBtn").querySelector("small").textContent = state.cameraOn ? "Камера" : "Камера выкл.";
  $("#selfMicIcon").textContent = state.micOn ? "🎙" : "🔇";
}
$("#soundBtn").addEventListener("click", () => { state.volumeOpen = !state.volumeOpen; $("#volumePanel").classList.toggle("hidden", !state.volumeOpen); });
$("#aiCallBtn").addEventListener("click", () => { showView("ai"); startVoice(); });

async function loadAiHistory() {
  try {
    const data = await api("/api/ai/history");
    $("#aiMessages").innerHTML = "";
    if (!data.messages.length) { $("#aiMessages").innerHTML = '<div class="ai-welcome"><div class="message-orb">✳</div><div><b>Я здесь, чтобы помочь.</b><p>Задай вопрос голосом или текстом. Можем обсудить идею, найти погоду или создать изображение.</p></div></div>'; return; }
    data.messages.forEach(m => appendMessage(m.role, m.content, m.kind));
  } catch {}
}
function appendMessage(role, content, kind = "text", imageUrl = null) {
  const el = document.createElement("div"); el.className = "chat-message " + (role === "user" ? "user" : "assistant");
  if (kind === "image" && imageUrl) {
    const p = document.createElement("div"); p.textContent = content; el.append(p);
    const img = document.createElement("img"); img.src = imageUrl; img.alt = "Сгенерированное изображение"; el.append(img);
  } else el.textContent = content;
  $("#aiMessages").append(el); $("#aiMessages").scrollTop = $("#aiMessages").scrollHeight;
  return el;
}
async function sendAiMessage(message) {
  const text = (message || "").trim(); if (!text || state.aiBusy) return;
  state.aiBusy = true; $("#aiInput").value = ""; appendMessage("user", text); $("#aiThinking").classList.remove("hidden");
  try {
    const data = await api("/api/ai/chat", {method:"POST",body:JSON.stringify({message:text})});
    appendMessage("assistant", data.answer);
    speakIfEnabled(data.answer);
  } catch(e) { appendMessage("assistant", "Не удалось получить ответ: " + e.message); }
  finally { state.aiBusy = false; $("#aiThinking").classList.add("hidden"); }
}
$("#aiForm").addEventListener("submit", e => { e.preventDefault(); sendAiMessage($("#aiInput").value); });
$$("[data-prompt]").forEach(b => b.addEventListener("click", () => sendAiMessage(b.dataset.prompt)));
$("#clearAiBtn").addEventListener("click", loadAiHistory);
$("#imageBtn").addEventListener("click", async () => {
  const prompt = $("#aiInput").value.trim() || window.prompt("Опиши изображение, которое нужно создать:");
  if (!prompt) return;
  appendMessage("user", "Создать изображение: " + prompt); $("#aiInput").value = ""; $("#aiThinking").classList.remove("hidden");
  try { const data = await api("/api/ai/image", {method:"POST",body:JSON.stringify({prompt})}); appendMessage("assistant", "Готово! " + prompt, "image", data.image); }
  catch(e) { appendMessage("assistant", "Не удалось создать изображение: " + e.message); }
  finally { $("#aiThinking").classList.add("hidden"); }
});
function speakIfEnabled(text) {
  if (!("speechSynthesis" in window) || !localStorage.getItem("commonspace_voice_reply")) return;
  speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(text); utterance.lang = "ru-RU"; utterance.rate = 1; speechSynthesis.speak(utterance);
}
$("#aiVoiceBtn").addEventListener("click", startVoice);
$("#voiceStop").addEventListener("click", () => stopVoice(true));
$("#closeVoice").addEventListener("click", () => stopVoice(false));
$("#voiceOrb").addEventListener("click", () => stopVoice(true));
function startVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast("Голосовой ввод не поддерживается в этом браузере. Используй текстовое поле.");
  if (state.recognition) { stopVoice(true); return; }
  state.voiceFinal = ""; state.voiceManualStop = false;
  const rec = new SR(); state.recognition = rec; rec.lang = "ru-RU"; rec.continuous = true; rec.interimResults = true;
  $("#aiVoiceOverlay").classList.remove("hidden"); $("#voiceState").textContent = "Я слушаю тебя"; $("#voiceTranscript").textContent = "Говори свободно. После короткой паузы сообщение отправится.";
  rec.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const phrase = event.results[i][0].transcript;
      if (event.results[i].isFinal) state.voiceFinal += phrase + " "; else interim += phrase;
    }
    $("#voiceTranscript").textContent = (state.voiceFinal + interim).trim() || "Я слушаю тебя…";
    clearTimeout(state.voiceTimer);
    state.voiceTimer = setTimeout(() => { if (state.recognition) { state.voiceManualStop = true; try {rec.stop();} catch{} } }, 1900);
  };
  rec.onerror = (e) => { if (e.error !== "no-speech" && e.error !== "aborted") toast("Ошибка микрофона: " + e.error); };
  rec.onend = () => {
    const result = state.voiceFinal.trim(); state.recognition = null; clearTimeout(state.voiceTimer);
    $("#aiVoiceOverlay").classList.add("hidden");
    if (result) sendAiMessage(result);
    else if (!state.voiceManualStop) toast("Не удалось распознать речь. Попробуй ещё раз.");
  };
  try { rec.start(); } catch { state.recognition = null; $("#aiVoiceOverlay").classList.add("hidden"); toast("Не удалось начать запись."); }
}
function stopVoice(send) {
  clearTimeout(state.voiceTimer);
  if (!state.recognition) { $("#aiVoiceOverlay").classList.add("hidden"); return; }
  state.voiceManualStop = !!send;
  if (!send) { state.voiceFinal = ""; }
  try { state.recognition.stop(); } catch { state.recognition = null; $("#aiVoiceOverlay").classList.add("hidden"); }
}
function drawOrb(canvas, large) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d"); const w = canvas.width, h = canvas.height; let t = 0;
  const pointer = {x:w*.5,y:h*.5,active:false};
  canvas.onpointermove = e => { const r=canvas.getBoundingClientRect(); pointer.x=(e.clientX-r.left)/r.width*w; pointer.y=(e.clientY-r.top)/r.height*h; pointer.active=true; };
  canvas.onpointerleave = () => pointer.active=false;
  const frame = () => {
    if (!canvas.isConnected) return;
    t += .012; ctx.clearRect(0,0,w,h);
    const cx = pointer.active ? pointer.x*.18 + w*.41 : w*.5 + Math.sin(t*.6)*w*.025;
    const cy = pointer.active ? pointer.y*.18 + h*.42 : h*.49 + Math.cos(t*.7)*h*.02;
    const radius = Math.min(w,h)*(large?.31:.32);
    ctx.save(); ctx.globalCompositeOperation="screen";
    for(let layer=0;layer<7;layer++){
      ctx.beginPath(); const points=100;
      for(let i=0;i<=points;i++){
        const a=i/points*Math.PI*2;
        const wave=Math.sin(a*3+t*1.2+layer)*radius*.12+Math.cos(a*5-t*.7+layer*.6)*radius*.08;
        const r=radius*(.65+layer*.075)+wave;
        const x=cx+Math.cos(a)*r*(1+.12*Math.sin(t+layer));
        const y=cy+Math.sin(a)*r*(.78+.12*Math.cos(t*.7+layer));
        if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
      }
      ctx.closePath();
      const grad=ctx.createLinearGradient(cx-radius,cy-radius,cx+radius,cy+radius);
      grad.addColorStop(0,"rgba(121,103,255,"+(.045+layer*.006)+")");grad.addColorStop(.5,"rgba(79,225,218,"+(.055+layer*.005)+")");grad.addColorStop(1,"rgba(235,151,222,"+(.035+layer*.006)+")");
      ctx.fillStyle=grad;ctx.fill();ctx.lineWidth=large?1.5:1;ctx.strokeStyle="rgba(194,183,255,"+(.09+layer*.018)+")";ctx.stroke();
    }
    for(let i=0;i<40;i++){const a=i*2.399+t*(i%2?.1:-.08);const r=radius*(.45+((i*37)%53)/100);const x=cx+Math.cos(a)*r,y=cy+Math.sin(a)*r*.8;ctx.beginPath();ctx.arc(x,y,(i%3)+.5,0,Math.PI*2);ctx.fillStyle=i%2?"rgba(135,239,227,.6)":"rgba(208,187,255,.7)";ctx.fill();}
    ctx.restore();
    requestAnimationFrame(frame);
  };
  frame();
}

async function loadPreferences() {
  try {
    const data = await api("/api/preferences"); state.globeMode = data.globe_mode || "normal";
    state.geolocationEnabled = !!data.geolocation_enabled; updateLayerButtons();
    $("#geoToggle").textContent = "◎ Моя геолокация: " + (state.geolocationEnabled ? "вкл." : "выкл.");
  } catch {}
}
async function saveMode(mode) {
  state.globeMode = mode;
  try { await api("/api/preferences", {method:"PUT",body:JSON.stringify({globe_mode:mode})}); } catch(e) { toast("Режим выбран, но не удалось сохранить: " + e.message); }
  updateLayerButtons();
}
function updateLayerButtons() {
  $$(".layer-btn").forEach(b => b.classList.toggle("selected", b.dataset.layer === state.globeMode));
  const names={normal:"Рельеф и спутник",temperature:"Температура",precipitation:"Осадки",wind:"Ветер",pressure:"Давление",clouds:"Облачность"};
  $("#currentLayerLabel").textContent=names[state.globeMode]||names.normal;
  if(state.viewer) applyGlobeLayer(state.globeMode);
}
let globeInitPromise = null;
async function initGlobe() {
  if (state.viewer) { state.viewer.resize(); return; }
  if (globeInitPromise) return globeInitPromise;
  globeInitPromise = (async()=>{
    if (!window.Cesium) { $("#globeLoading").classList.add("done"); toast("Не удалось загрузить Cesium."); return; }
    try {
      const config=await api("/api/config");
      if (config.cesiumIonToken) Cesium.Ion.defaultAccessToken=config.cesiumIonToken;
      const viewer = new Cesium.Viewer("cesiumContainer", {
        animation:false,baseLayerPicker:false,geocoder:false,homeButton:false,infoBox:false,
        navigationHelpButton:false,sceneModePicker:false,selectionIndicator:false,timeline:false,
        fullscreenButton:false,shouldAnimate:true,terrainProvider:await Cesium.CesiumTerrainProvider.fromIonAssetId(1),
        imageryProvider: false,
        requestRenderMode:false
      });
      state.viewer=viewer;
      try {
        const imagery = await Cesium.IonImageryProvider.fromAssetId(2);
        viewer.imageryLayers.addImageryProvider(imagery);
      } catch (imageryError) {
        console.warn("Cesium imagery unavailable; using a public satellite fallback", imageryError);
        viewer.imageryLayers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({
          url:"https://tile.openstreetmap.org/{z}/{x}/{y}.png",
          maximumLevel:19,
          credit:"© OpenStreetMap contributors"
        }));
      }
      viewer.scene.globe.enableLighting=true;
      viewer.scene.globe.showGroundAtmosphere=true;
      viewer.scene.globe.depthTestAgainstTerrain=false;
      viewer.camera.flyTo({destination:Cesium.Cartesian3.fromDegrees(15,22,19000000),duration:1.5});
      try {
        state.borders=await Cesium.GeoJsonDataSource.load("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_boundary_lines_land.geojson",{stroke:Cesium.Color.fromCssColorString("#b7c7ff").withAlpha(.72),strokeWidth:1.2,clampToGround:true});
        await viewer.dataSources.add(state.borders);
      } catch(e){console.warn("Borders not loaded",e);}
      $("#globeLoading").classList.add("done");
      applyGlobeLayer(state.globeMode);
      $("#bordersToggle").addEventListener("change",()=>{if(state.borders)state.borders.show=$("#bordersToggle").checked;});
    } catch(e) {
      console.error(e); $("#globeLoading").classList.add("done");
      toast("Cesium не загрузился. Проверь CESIUM_ION_TOKEN и логи браузера.");
    }
  })();
  return globeInitPromise;
}
function applyGlobeLayer(layer) {
  if(!state.viewer) return;
  const viewer=state.viewer;
  if(state.weatherLayer){viewer.imageryLayers.remove(state.weatherLayer,true);state.weatherLayer=null;}
  viewer.scene.globe.baseColor=Cesium.Color.fromCssColorString("#101b2d");
  if(layer!=="normal"){
    const provider=new Cesium.UrlTemplateImageryProvider({
      url:location.origin+"/api/weather/tiles/"+layer+"/{z}/{x}/{y}.png",
      tilingScheme:new Cesium.WebMercatorTilingScheme(),minimumLevel:0,maximumLevel:12,
      credit:"Weather tiles © OpenWeather"
    });
    state.weatherLayer=viewer.imageryLayers.addImageryProvider(provider);
    state.weatherLayer.alpha=0.88;state.weatherLayer.brightness=1.22;state.weatherLayer.contrast=1.18;state.weatherLayer.saturation=1.3;
    $("#globeLegend").classList.remove("hidden");
  } else $("#globeLegend").classList.add("hidden");
}
$$(".layer-btn").forEach(b=>b.addEventListener("click",()=>saveMode(b.dataset.layer)));
$("#bordersToggle").addEventListener("change",()=>{if(state.borders)state.borders.show=$("#bordersToggle").checked;});
$("#geoToggle").addEventListener("click", async()=>{
  if(!navigator.geolocation) return toast("Геолокация не поддерживается.");
  if(!state.geolocationEnabled){
    navigator.geolocation.getCurrentPosition(async pos=>{
      state.geolocationEnabled=true;$("#geoToggle").textContent="◎ Моя геолокация: вкл.";
      api("/api/preferences",{method:"PUT",body:JSON.stringify({globe_mode:state.globeMode,geolocation_enabled:true})}).catch(()=>{});
      const {latitude:lat,longitude:lon}=pos.coords;
      if(state.viewer){
        if(state.geoMarker)state.viewer.entities.remove(state.geoMarker);
        state.geoMarker=state.viewer.entities.add({position:Cesium.Cartesian3.fromDegrees(lon,lat,50),point:{pixelSize:13,color:Cesium.Color.fromCssColorString("#8df5db"),outlineColor:Cesium.Color.WHITE,outlineWidth:2},label:{text:"Ты здесь",font:"13px DM Sans",fillColor:Cesium.Color.WHITE,outlineColor:Cesium.Color.BLACK,outlineWidth:3,style:Cesium.LabelStyle.FILL_AND_OUTLINE,verticalOrigin:Cesium.VerticalOrigin.BOTTOM,pixelOffset:new Cesium.Cartesian2(0,-18)}});
        state.viewer.camera.flyTo({destination:Cesium.Cartesian3.fromDegrees(lon,lat,250000),duration:1.6});
      }
      $("#placeSearch").value=lat.toFixed(5)+", "+lon.toFixed(5); await searchWeather(lat+","+lon,true); loadLocalWeather(lat,lon);
    },err=>toast("Не удалось получить геолокацию: "+err.message),{enableHighAccuracy:true,timeout:12000});
  }else{
    state.geolocationEnabled=false;$("#geoToggle").textContent="◎ Моя геолокация: выкл.";
    api("/api/preferences",{method:"PUT",body:JSON.stringify({globe_mode:state.globeMode,geolocation_enabled:false})}).catch(()=>{});
    if(state.viewer&&state.geoMarker){state.viewer.entities.remove(state.geoMarker);state.geoMarker=null;}
  }
});
$("#locateWeatherBtn").addEventListener("click",()=>{
  if(!navigator.geolocation)return toast("Геолокация не поддерживается.");
  navigator.geolocation.getCurrentPosition(pos=>loadLocalWeather(pos.coords.latitude,pos.coords.longitude),()=>toast("Разреши геолокацию в браузере."));
});
async function loadLocalWeather(lat,lon){
  try{
    const w=await api("/api/weather?lat="+encodeURIComponent(lat)+"&lon="+encodeURIComponent(lon));
    state.localWeather=w;
    const icon="https://openweathermap.org/img/wn/"+w.icon+"@2x.png";
    $("#callWeather").innerHTML='<img width="54" height="54" alt="" src="'+icon+'"><div><b>'+escapeHtml(w.name)+(w.country?", "+escapeHtml(w.country):"")+' · '+w.temp+'°C</b><small>'+escapeHtml(w.description)+' · ветер '+w.wind+' м/с</small></div>';
  }catch(e){toast("Погода: "+e.message);}
}
$("#searchWeatherBtn").addEventListener("click",()=>searchWeather($("#placeSearch").value.trim(),false));
$("#placeSearch").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();searchWeather($("#placeSearch").value.trim(),false);}});
async function searchWeather(input,coordsOnly){
  if(!input)return toast("Введи название места или координаты.");
  try{
    let url;
    const match=input.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if(match)url="/api/weather?lat="+encodeURIComponent(match[1])+"&lon="+encodeURIComponent(match[2]);
    else url="/api/weather?q="+encodeURIComponent(input);
    const w=await api(url);
    $("#searchedWeather").classList.remove("hidden");
    $("#searchedWeather").innerHTML='<div class="eyebrow">WEATHER NOW</div><h3>'+escapeHtml(w.name)+(w.country?", "+escapeHtml(w.country):"")+'</h3><div class="weather-temp">'+w.temp+'°C <img style="width:54px;vertical-align:middle" src="https://openweathermap.org/img/wn/'+w.icon+'@2x.png" alt=""></div><p>'+escapeHtml(w.description)+'</p><div class="weather-stats"><span>Ощущается <b>'+w.feels_like+'°C</b></span><span>Влажность <b>'+w.humidity+'%</b></span><span>Ветер <b>'+w.wind+' м/с</b></span><span>Координаты <b>'+Number(w.lat).toFixed(3)+', '+Number(w.lon).toFixed(3)+'</b></span></div>';
    $("#globeLocation").textContent=w.name+(w.country?", "+w.country:"");
    if(state.viewer){state.viewer.camera.flyTo({destination:Cesium.Cartesian3.fromDegrees(w.lon,w.lat,Math.max(180000,coordsOnly?250000:400000)),duration:1.5});}
    if(!state.localWeather)loadLocalWeather(w.lat,w.lon);
  }catch(e){toast(e.message);}
}
function escapeHtml(text){return String(text).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
init();
