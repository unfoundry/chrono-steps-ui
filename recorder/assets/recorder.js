/**
 * Chrono Steps — Standalone Screen Recorder, Redactor & Video Exporter
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const state = {
    name: "screen-recording",
    videoData: null,
    videoName: "",
    trimStart: 0,
    trimEnd: 0,
    excludeAudio: false,
    masks: [],
  };

  let editingMaskId = null;
  let selectedMaskId = null;
  let boxInteraction = null;
  let pendingMaskGeometry = null;
  let canvasMode = "idle";
  let isDrawing = false;
  let drawStart = null;
  let drawCurrent = null;

  let mediaRecorder = null;
  let recordedChunks = [];
  let recordingStream = null;
  let recordingTimer = null;
  let recordingSeconds = 0;
  let playbackRafId = null;
  let durationLimitNotified = false;
  let maskModalInstance = null;

  function getConfig() {
    return {
      MAX_CACHED_VIDEO_DURATION: 300,
      MAX_VIDEO_DURATION: 900,
      ...(window.ChronoConfig || {}),
    };
  }

  function createId() {
    return crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function formatTime(secondsValue) {
    const total = Math.max(0, Number(secondsValue) || 0);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = Math.floor(total % 60);
    const ms = Math.floor((total % 1) * 1000);
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
  }

  function parseTimeInput(value) {
    const text = String(value ?? "").trim();
    if (!text) return NaN;
    if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
    const parts = text.split(":").map(Number);
    if (parts.some((n) => !Number.isFinite(n))) return NaN;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return NaN;
  }

  function playLimitChime() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      [523.25, 659.25].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.15, ctx.currentTime + idx * 0.16);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.16 + 0.25);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + idx * 0.16);
        osc.stop(ctx.currentTime + idx * 0.16 + 0.26);
      });
    } catch {
      // Ignore
    }
  }

  function showToast(title, icon = "success") {
    Swal.fire({ toast: true, position: "bottom-end", icon, title, showConfirmButton: false, timer: 2200 });
  }

  function showAlert(title, text, icon = "info") {
    return Swal.fire({ title, text, icon, confirmButtonColor: "#158cba" });
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function getDisplayedVideoRectangle() {
    const video = $("video");
    const videoBox = video.getBoundingClientRect();
    const stageBox = $("stage").getBoundingClientRect();
    if (!video.videoWidth || !video.videoHeight || !videoBox.width || !videoBox.height) return null;
    const sourceRatio = video.videoWidth / video.videoHeight;
    const containerRatio = videoBox.width / videoBox.height;
    const width = sourceRatio > containerRatio ? videoBox.width : videoBox.height * sourceRatio;
    const height = sourceRatio > containerRatio ? videoBox.width / sourceRatio : videoBox.height;
    return {
      left: videoBox.left - stageBox.left + (videoBox.width - width) / 2,
      top: videoBox.top - stageBox.top + (videoBox.height - height) / 2,
      width,
      height,
    };
  }

  function resizeOverlayCanvas() {
    const rect = getDisplayedVideoRectangle();
    const canvas = $("overlay");
    if (!rect) {
      canvas.width = 0;
      canvas.height = 0;
      return;
    }
    canvas.width = Math.max(1, Math.round(rect.width));
    canvas.height = Math.max(1, Math.round(rect.height));
    Object.assign(canvas.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    drawOverlay();
  }

  function getMaskHandles(mask, canvas) {
    const x = mask.x * canvas.width;
    const y = mask.y * canvas.height;
    const w = mask.w * canvas.width;
    const h = mask.h * canvas.height;
    return {
      nw: { x, y, cursor: "nwse-resize" },
      n: { x: x + w / 2, y, cursor: "ns-resize" },
      ne: { x: x + w, y, cursor: "nesw-resize" },
      e: { x: x + w, y: y + h / 2, cursor: "ew-resize" },
      se: { x: x + w, y: y + h, cursor: "nwse-resize" },
      s: { x: x + w / 2, y: y + h, cursor: "ns-resize" },
      sw: { x, y: y + h, cursor: "nesw-resize" },
      w: { x, y: y + h / 2, cursor: "ew-resize" },
    };
  }

  function drawLiveVideoMask(context, canvas, video, mask) {
    const dx = mask.x * canvas.width;
    const dy = mask.y * canvas.height;
    const dw = mask.w * canvas.width;
    const dh = mask.h * canvas.height;

    if (mask.style === "white" || mask.style === "black") {
      context.fillStyle = mask.style;
      context.fillRect(dx, dy, dw, dh);
      return;
    }
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;

    const sx = mask.x * video.videoWidth;
    const sy = mask.y * video.videoHeight;
    const sw = Math.max(1, mask.w * video.videoWidth);
    const sh = Math.max(1, mask.h * video.videoHeight);

    if (mask.style === "blur") {
      context.save();
      context.beginPath();
      context.rect(dx, dy, dw, dh);
      context.clip();
      context.filter = "blur(14px)";
      context.drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh);
      context.restore();
      return;
    }

    const px = document.createElement("canvas");
    px.width = Math.max(2, Math.round(dw * 0.06));
    px.height = Math.max(2, Math.round(dh * 0.06));
    px.getContext("2d").drawImage(video, sx, sy, sw, sh, 0, 0, px.width, px.height);
    context.save();
    context.imageSmoothingEnabled = false;
    context.drawImage(px, 0, 0, px.width, px.height, dx, dy, dw, dh);
    context.restore();
  }

  function drawOverlay() {
    const canvas = $("overlay");
    const ctx = canvas.getContext("2d");
    if (!canvas.width || !canvas.height) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const video = $("video");
    const now = video.currentTime || 0;

    state.masks
      .filter((m) => now >= m.start && now <= m.end)
      .forEach((m) => {
        drawLiveVideoMask(ctx, canvas, video, m);
        if (m.id === selectedMaskId) {
          ctx.save();
          ctx.strokeStyle = "#ff4136";
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 4]);
          ctx.strokeRect(m.x * canvas.width, m.y * canvas.height, m.w * canvas.width, m.h * canvas.height);
          ctx.setLineDash([]);
          Object.values(getMaskHandles(m, canvas)).forEach((h) => {
            ctx.fillStyle = "#ffffff";
            ctx.strokeStyle = "#ff4136";
            ctx.lineWidth = 1.5;
            ctx.fillRect(h.x - 4, h.y - 4, 8, 8);
            ctx.strokeRect(h.x - 4, h.y - 4, 8, 8);
          });
          ctx.restore();
        }
      });

    if (isDrawing && drawStart && drawCurrent) {
      const x = Math.min(drawStart.x, drawCurrent.x);
      const y = Math.min(drawStart.y, drawCurrent.y);
      const w = Math.abs(drawCurrent.x - drawStart.x);
      const h = Math.abs(drawCurrent.y - drawStart.y);
      ctx.save();
      ctx.strokeStyle = "#ff4136";
      ctx.fillStyle = "rgba(255, 65, 54, 0.2)";
      ctx.lineWidth = 2.5;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    }
  }

  function updatePlayerDisplay() {
    const video = $("video");
    const dur = Number.isFinite(video.duration) ? video.duration : 0;
    const now = video.currentTime || 0;

    $("now").textContent = formatTime(now);
    $("total").textContent = formatTime(dur);
    $("progress").style.width = dur ? `${(now / dur) * 100}%` : "0%";

    const trimStart = Math.max(0, state.trimStart || 0);
    const trimEnd = state.trimEnd > trimStart && dur ? Math.min(state.trimEnd, dur) : dur;
    $("shadeBefore").style.left = "0%";
    $("shadeBefore").style.width = dur ? `${(trimStart / dur) * 100}%` : "0%";
    $("shadeAfter").style.left = dur ? `${(trimEnd / dur) * 100}%` : "100%";
    $("shadeAfter").style.width = dur ? `${Math.max(0, ((dur - trimEnd) / dur) * 100)}%` : "0%";

    $("rangeStartText").textContent = formatTime(trimStart);
    $("rangeEndText").textContent = state.trimEnd > 0 ? formatTime(state.trimEnd) : "End";
    $("play").innerHTML = video.paused ? '<i class="bi bi-play-fill"></i>' : '<i class="bi bi-pause-fill"></i>';
    $("mute").innerHTML = video.muted ? '<i class="bi bi-volume-mute"></i>' : '<i class="bi bi-volume-up"></i>';
    $("menuExcludeAudio").querySelector(".toggle-check").className =
      `bi ${state.excludeAudio ? "bi-check-lg" : ""} toggle-check text-primary`;

    drawOverlay();
  }

  function renderMasksList() {
    $("maskCount").textContent = String(state.masks.length);
    $("noMasks").hidden = state.masks.length > 0;
    const container = $("masks");
    container.innerHTML = "";

    state.masks.forEach((mask) => {
      const item = document.createElement("div");
      item.className = `mask-item ${mask.id === selectedMaskId ? "selected" : ""}`;
      item.style.cursor = "pointer";
      item.innerHTML = `
        <div class="d-flex align-items-center gap-2 min-w-0">
          <span class="badge text-bg-dark text-uppercase">${mask.style}</span>
          <span class="font-monospace text-truncate">${formatTime(mask.start)} – ${formatTime(mask.end)}</span>
        </div>
        <div class="btn-group btn-group-sm">
          <button class="btn btn-link btn-sm p-0 px-1 text-primary edit-mask" type="button" title="Edit"><i class="bi bi-pencil"></i></button>
          <button class="btn btn-link btn-sm p-0 px-1 text-danger del-mask" type="button" title="Delete"><i class="bi bi-trash"></i></button>
        </div>
      `;
      item.onclick = (event) => {
        if (event.target.closest("button")) return;
        selectedMaskId = mask.id;
        const video = $("video");
        if (video.src && (video.currentTime < mask.start || video.currentTime > mask.end)) {
          video.pause();
          video.currentTime = mask.start;
        }
        renderMasksList();
        drawOverlay();
      };
      item.querySelector(".edit-mask").onclick = () => openMaskDialog(mask.id);
      item.querySelector(".del-mask").onclick = async () => {
        const res = await Swal.fire({
          title: "Delete redaction?",
          icon: "warning",
          showCancelButton: true,
          confirmButtonColor: "#ff4136",
          confirmButtonText: "Delete",
        });
        if (res.isConfirmed) {
          if (selectedMaskId === mask.id) selectedMaskId = null;
          state.masks = state.masks.filter((m) => m.id !== mask.id);
          renderMasksList();
          drawOverlay();
        }
      };
      container.append(item);
    });
  }

  function openMaskDialog(maskId = null) {
    editingMaskId = maskId;
    const mask = maskId ? state.masks.find((m) => m.id === maskId) : null;
    const now = $("video").currentTime || 0;
    const dur = Number.isFinite($("video").duration) ? $("video").duration : now + 5;
    $("maskStart").value = formatTime(mask ? mask.start : now);
    $("maskEnd").value = formatTime(mask ? mask.end : Math.min(dur, now + 5));
    $("maskStyle").value = mask ? mask.style : "blur";
    if (mask) pendingMaskGeometry = { x: mask.x, y: mask.y, w: mask.w, h: mask.h };
    maskModalInstance.show();
  }

  function setCanvasMode(mode) {
    canvasMode = mode;
    isDrawing = false;
    drawStart = null;
    drawCurrent = null;
    $("overlay").classList.toggle("drawing", mode !== "idle");
    $("overlay").style.cursor = mode === "idle" ? "default" : "crosshair";
    $("stage").style.cursor = mode === "idle" ? "default" : "crosshair";
    $("cancelDraw").hidden = mode === "idle";
    $("drawModeBanner").classList.toggle("d-none", mode === "idle");
    $("drawModeBanner").classList.toggle("d-flex", mode !== "idle");
    drawOverlay();
  }

  function loadVideoSource(url, name = "") {
    durationLimitNotified = false;
    $("stage").classList.remove("empty");
    $("empty").hidden = true;
    $("video").src = url;
    if (name) state.videoName = name;
  }

  async function toggleScreenRecording() {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
      return;
    }
    try {
      recordingStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
    } catch {
      return;
    }

    recordedChunks = [];
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
    mediaRecorder = new MediaRecorder(recordingStream, { mimeType });
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      clearInterval(recordingTimer);
      $("recordBadge").hidden = true;
      $("recordClock").hidden = true;
      $("recordText").textContent = "Record screen";
      recordingStream.getTracks().forEach((t) => t.stop());

      const blob = new Blob(recordedChunks, { type: "video/webm" });
      state.videoData = await readFileAsDataUrl(blob);
      state.videoName = `${window.ChronoExport.safeName(state.name)}.webm`;
      loadVideoSource(state.videoData, state.videoName);
      showToast("Screen recording ready");
    };

    recordingStream.getVideoTracks()[0].onended = () => {
      if (mediaRecorder?.state === "recording") mediaRecorder.stop();
    };

    recordingSeconds = 0;
    $("recordBadgeClock").textContent = "00:00";
    $("recordClock").textContent = "00:00";
    $("recordBadge").hidden = false;
    $("recordClock").hidden = false;
    $("recordText").textContent = "Stop recording";

    recordingTimer = setInterval(() => {
      recordingSeconds += 1;
      const mins = String(Math.floor(recordingSeconds / 60)).padStart(2, "0");
      const secs = String(recordingSeconds % 60).padStart(2, "0");
      $("recordBadgeClock").textContent = `${mins}:${secs}`;
      $("recordClock").textContent = `${mins}:${secs}`;

      const maxDur = getConfig().MAX_VIDEO_DURATION;
      if (maxDur > 0 && recordingSeconds >= maxDur) {
        playLimitChime();
        if (mediaRecorder?.state === "recording") mediaRecorder.stop();
        showAlert(
          "Recording limit reached",
          `Recording safely stopped at the configured maximum duration (${Math.round(maxDur / 60)} min).`,
          "info",
        );
      }
    }, 1000);

    mediaRecorder.start(500);
  }

  function getCanvasPoint(event) {
    const canvas = $("overlay");
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(canvas.width, ((event.clientX - rect.left) * canvas.width) / rect.width)),
      y: Math.max(0, Math.min(canvas.height, ((event.clientY - rect.top) * canvas.height) / rect.height)),
    };
  }

  function hitTestMask(pt, canvas, now) {
    const active = state.masks.filter((m) => now >= m.start && now <= m.end);
    if (selectedMaskId) {
      const sel = active.find((m) => m.id === selectedMaskId);
      if (sel) {
        for (const [key, h] of Object.entries(getMaskHandles(sel, canvas))) {
          if (Math.abs(pt.x - h.x) <= 7 && Math.abs(pt.y - h.y) <= 7) {
            return { mask: sel, type: key, cursor: h.cursor };
          }
        }
      }
    }
    for (let i = active.length - 1; i >= 0; i -= 1) {
      const m = active[i];
      if (
        pt.x >= m.x * canvas.width &&
        pt.x <= (m.x + m.w) * canvas.width &&
        pt.y >= m.y * canvas.height &&
        pt.y <= (m.y + m.h) * canvas.height
      ) {
        return { mask: m, type: "move", cursor: "move" };
      }
    }
    return null;
  }

  function bindEvents() {
    const video = $("video");
    $("videoTitle").oninput = (e) => { state.name = e.target.value.trim() || "screen-recording"; };

    const pickVideo = () => $("videoInput").click();
    $("loadVideo").onclick = pickVideo;
    $("menuLoadVideo").onclick = pickVideo;
    $("quickLoadVideo").onclick = pickVideo;
    $("emptyLoadVideo").onclick = pickVideo;

    $("videoInput").onchange = async (event) => {
      const file = event.target.files[0];
      event.target.value = "";
      if (!file) return;
      state.videoData = await readFileAsDataUrl(file);
      state.videoName = file.name;
      loadVideoSource(state.videoData, file.name);
      showToast("Video loaded");
    };

    $("recordScreen").onclick = toggleScreenRecording;
    $("menuRecord").onclick = toggleScreenRecording;
    $("quickRecord").onclick = toggleScreenRecording;
    $("emptyRecord").onclick = toggleScreenRecording;
    $("stopRecord").onclick = toggleScreenRecording;

    $("menuClear").onclick = () => {
      state.videoData = null;
      state.masks = [];
      state.trimStart = 0;
      state.trimEnd = 0;
      $("stage").classList.add("empty");
      $("empty").hidden = false;
      video.removeAttribute("src");
      video.load();
      renderMasksList();
      updatePlayerDisplay();
    };

    $("play").onclick = () => (video.paused ? video.play() : video.pause());
    $("back").onclick = () => { video.currentTime = Math.max(0, video.currentTime - 10); };
    $("forward").onclick = () => { video.currentTime = Math.min(video.duration || 0, video.currentTime + 10); };
    $("mute").onclick = () => { video.muted = !video.muted; updatePlayerDisplay(); };
    $("menuExcludeAudio").onclick = () => { state.excludeAudio = !state.excludeAudio; updatePlayerDisplay(); };

    video.addEventListener("loadedmetadata", () => {
      resizeOverlayCanvas();
      updatePlayerDisplay();
      const cfg = getConfig();
      const dur = Number.isFinite(video.duration) ? video.duration : 0;
      if (!durationLimitNotified && cfg.MAX_VIDEO_DURATION > 0 && dur > cfg.MAX_VIDEO_DURATION) {
        durationLimitNotified = true;
        playLimitChime();
        showAlert(
          "Video exceeds max duration",
          `This video is longer than ${Math.round(cfg.MAX_VIDEO_DURATION / 60)} minutes. Export your video manually when ready.`,
          "warning",
        );
      }
    });
    ["play", "pause", "timeupdate", "durationchange", "ended"].forEach((evt) =>
      video.addEventListener(evt, updatePlayerDisplay),
    );
    const tick = () => {
      if (!video.paused && !video.ended) {
        updatePlayerDisplay();
        playbackRafId = requestAnimationFrame(tick);
      } else playbackRafId = null;
    };
    video.addEventListener("play", () => { if (!playbackRafId) playbackRafId = requestAnimationFrame(tick); });
    ["pause", "ended"].forEach((evt) =>
      video.addEventListener(evt, () => {
        if (playbackRafId) cancelAnimationFrame(playbackRafId);
        playbackRafId = null;
      }),
    );
    window.addEventListener("resize", resizeOverlayCanvas);

    // Timeline scrubbing
    let scrubbing = false;
    const seek = (e) => {
      if (!Number.isFinite(video.duration)) return;
      const r = $("timeline").getBoundingClientRect();
      video.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * video.duration;
    };
    $("timeline").onpointerdown = (e) => { scrubbing = true; $("timeline").setPointerCapture(e.pointerId); seek(e); };
    $("timeline").onpointermove = (e) => { if (scrubbing) seek(e); };
    $("timeline").onpointerup = () => { scrubbing = false; };

    $("rangeStart").onclick = () => { state.trimStart = video.currentTime || 0; updatePlayerDisplay(); };
    $("rangeEnd").onclick = () => { state.trimEnd = video.currentTime || 0; updatePlayerDisplay(); };
    $("rangeReset").onclick = () => { state.trimStart = 0; state.trimEnd = 0; updatePlayerDisplay(); };

    const startMask = () => {
      if (!video.src) return showAlert("No video loaded", "Record or load a video first.", "info");
      video.pause();
      setCanvasMode("mask");
    };
    $("addMask").onclick = startMask;
    $("menuAddMask").onclick = startMask;
    $("quickAddMask").onclick = startMask;
    $("cancelDraw").onclick = () => setCanvasMode("idle");

    const overlay = $("overlay");
    overlay.onpointerdown = (e) => {
      const pt = getCanvasPoint(e);
      if (canvasMode !== "idle") {
        isDrawing = true;
        drawStart = pt;
        drawCurrent = pt;
        overlay.setPointerCapture(e.pointerId);
        return;
      }
      const hit = hitTestMask(pt, overlay, video.currentTime || 0);
      if (hit) {
        selectedMaskId = hit.mask.id;
        boxInteraction = {
          type: hit.type,
          mask: hit.mask,
          startPt: pt,
          orig: { x: hit.mask.x, y: hit.mask.y, w: hit.mask.w, h: hit.mask.h },
        };
        overlay.setPointerCapture(e.pointerId);
        renderMasksList();
        drawOverlay();
      } else if (selectedMaskId) {
        selectedMaskId = null;
        renderMasksList();
        drawOverlay();
      }
    };
    overlay.onpointermove = (e) => {
      const pt = getCanvasPoint(e);
      if (isDrawing) { drawCurrent = pt; drawOverlay(); return; }
      if (boxInteraction) {
        const dx = (pt.x - boxInteraction.startPt.x) / Math.max(1, overlay.width);
        const dy = (pt.y - boxInteraction.startPt.y) / Math.max(1, overlay.height);
        const o = boxInteraction.orig;
        const m = boxInteraction.mask;
        const minSize = 0.02;
        if (boxInteraction.type === "move") {
          m.x = Math.max(0, Math.min(1 - o.w, o.x + dx));
          m.y = Math.max(0, Math.min(1 - o.h, o.y + dy));
        } else {
          let nx = o.x, ny = o.y, nw = o.w, nh = o.h;
          if (boxInteraction.type.includes("w")) { const c = Math.min(dx, o.w - minSize); nx = Math.max(0, o.x + c); nw = o.x + o.w - nx; }
          if (boxInteraction.type.includes("e")) { nw = Math.max(minSize, Math.min(1 - o.x, o.w + dx)); }
          if (boxInteraction.type.includes("n")) { const c = Math.min(dy, o.h - minSize); ny = Math.max(0, o.y + c); nh = o.y + o.h - ny; }
          if (boxInteraction.type.includes("s")) { nh = Math.max(minSize, Math.min(1 - o.y, o.h + dy)); }
          m.x = nx; m.y = ny; m.w = nw; m.h = nh;
        }
        drawOverlay();
        return;
      }
      if (canvasMode === "idle") {
        const hit = hitTestMask(pt, overlay, video.currentTime || 0);
        overlay.style.cursor = hit ? hit.cursor : "default";
      }
    };
    overlay.onpointerup = () => {
      if (boxInteraction) { boxInteraction = null; return; }
      if (!isDrawing) return;
      isDrawing = false;
      const canvas = $("overlay");
      const x = Math.min(drawStart.x, drawCurrent.x);
      const y = Math.min(drawStart.y, drawCurrent.y);
      const w = Math.abs(drawCurrent.x - drawStart.x);
      const h = Math.abs(drawCurrent.y - drawStart.y);
      setCanvasMode("idle");
      if (w >= 8 && h >= 8) {
        pendingMaskGeometry = { x: x / canvas.width, y: y / canvas.height, w: w / canvas.width, h: h / canvas.height };
        openMaskDialog(null);
      }
    };

    $("maskNowStart").onclick = () => { $("maskStart").value = formatTime(video.currentTime || 0); };
    $("maskNowEnd").onclick = () => { $("maskEnd").value = formatTime(video.currentTime || 0); };
    $("maskProjectStart").onclick = () => { $("maskStart").value = formatTime(state.trimStart || 0); };
    $("maskProjectEnd").onclick = () => { $("maskEnd").value = formatTime(state.trimEnd > 0 ? state.trimEnd : video.duration || 0); };

    $("maskForm").onsubmit = (e) => {
      e.preventDefault();
      const start = parseTimeInput($("maskStart").value);
      const end = parseTimeInput($("maskEnd").value);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        return showAlert("Invalid range", "End time must be greater than Start time.", "warning");
      }
      const existing = editingMaskId ? state.masks.find((m) => m.id === editingMaskId) : null;
      const data = { id: existing ? existing.id : createId(), ...pendingMaskGeometry, start, end, style: $("maskStyle").value };
      if (existing) Object.assign(existing, data);
      else state.masks.push(data);
      maskModalInstance.hide();
      renderMasksList();
      drawOverlay();
    };

    $("exportOriginal").onclick = () => {
      try {
        window.ChronoExport.original(state);
      } catch (err) {
        showAlert("Export unavailable", err.message, "warning");
      }
    };

    const runExportRendered = async () => {
      if (!video.src) return showAlert("No video loaded", "Record or load a video before exporting.", "warning");
      $("exportOverlay").hidden = false;
      $("exportOverlayBar").style.width = "0%";
      try {
        const blob = await window.ChronoExport.rendered(video, state, (pct) => {
          const p = Math.round(pct * 100);
          $("exportOverlayBar").style.width = `${p}%`;
          $("exportOverlayDetail").textContent = `Rendering frames (${p}%)...`;
        });
        window.ChronoExport.download(blob, `${window.ChronoExport.safeName(state.name)}-redacted.webm`);
        showToast("Exported redacted WebM");
      } catch (err) {
        showAlert("Export failed", err.message, "error");
      } finally {
        $("exportOverlay").hidden = true;
      }
    };
    $("exportRendered").onclick = runExportRendered;
    $("quickExportRendered").onclick = runExportRendered;
  }

  function init() {
    maskModalInstance = new bootstrap.Modal($("maskModal"));
    bindEvents();
    renderMasksList();
    updatePlayerDisplay();
  }

  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", init) : init();
})();

