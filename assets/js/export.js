/**
 * Chrono Steps — Local Export & Rendered Video Pipeline.
 * Handles .steps / .stepslite downloads, standalone HTML guides, PDF print
 * with coverpage template, and client-side WebM redaction rendering.
 */
window.ChronoExport = {
  download(blob, name) {
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  safeName(value) {
    return (
      String(value || "chrono-steps-guide")
        .trim()
        .replace(/[^a-z0-9_-]+/gi, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase() || "chrono-steps-guide"
    );
  },

  dataUrlBlob(url) {
    const [header, data] = String(url).split(",");
    const mime = header.match(/:(.*?);/)?.[1] || "application/octet-stream";
    const binary = atob(data);
    return new Blob(
      [Uint8Array.from(binary, (char) => char.charCodeAt(0))],
      { type: mime },
    );
  },

  original(currentProject) {
    if (!currentProject.videoData) {
      throw new Error("No embedded video is available in this project.");
    }
    this.download(
      this.dataUrlBlob(currentProject.videoData),
      currentProject.videoName || `${this.safeName(currentProject.name)}.webm`,
    );
  },

  drawMask(context, canvas, redaction) {
    const x = redaction.x * canvas.width;
    const y = redaction.y * canvas.height;
    const width = redaction.w * canvas.width;
    const height = redaction.h * canvas.height;

    if (redaction.style === "white" || redaction.style === "black") {
      context.fillStyle = redaction.style;
      context.fillRect(x, y, width, height);
      return;
    }

    if (redaction.style === "blur") {
      context.save();
      context.beginPath();
      context.rect(x, y, width, height);
      context.clip();
      context.filter = "blur(14px)";
      context.drawImage(canvas, x, y, width, height, x, y, width, height);
      context.restore();
      return;
    }

    const pixelCanvas = document.createElement("canvas");
    pixelCanvas.width = Math.max(1, Math.round(width * 0.06));
    pixelCanvas.height = Math.max(1, Math.round(height * 0.06));
    pixelCanvas
      .getContext("2d")
      .drawImage(canvas, x, y, width, height, 0, 0, pixelCanvas.width, pixelCanvas.height);

    context.save();
    context.imageSmoothingEnabled = false;
    context.drawImage(
      pixelCanvas,
      0,
      0,
      pixelCanvas.width,
      pixelCanvas.height,
      x,
      y,
      width,
      height,
    );
    context.restore();
  },

  async loadCoverTemplate() {
    const candidates = ["assets/templates/coverpage.html", "../assets/templates/coverpage.html"];
    for (const path of candidates) {
      try {
        const res = await fetch(path, { cache: "no-store" });
        if (res.ok) return await res.text();
      } catch {
        // Try next candidate
      }
    }
    return `
      <section class="cover-page">
        <div class="cover-top-accent"></div>
        <div class="cover-brand-row"><span class="cover-logo">CS</span><span class="cover-brand-name">{{BRANDING}}</span></div>
        <div class="cover-body">
          <span class="cover-kicker">Standard Operating Procedure</span>
          <h1 class="cover-title">{{PROJECT_NAME}}</h1>
          <p class="cover-author">Prepared by <strong>{{AUTHOR}}</strong></p>
          <div class="cover-stats">
            <div class="cover-stat"><b>{{STEP_COUNT}}</b><span>Total Steps</span></div>
            <div class="cover-stat"><b>{{SCREENSHOT_COUNT}}</b><span>Screenshots</span></div>
            <div class="cover-stat"><b>{{GENERATED_AT}}</b><span>Generated</span></div>
          </div>
        </div>
        <div class="cover-footer"><span>{{BRANDING}}</span><span>Generated {{GENERATED_AT}}</span></div>
      </section>
    `;
  },

  guide(currentProject, coverTemplate = "") {
    const escapeHtml = (value) =>
      String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]);

    const formatTime = (secondsValue) => {
      const total = Math.max(0, Number(secondsValue) || 0);
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = Math.floor(total % 60);
      return hours > 0
        ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
        : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    };

    const orderedSteps = [...(currentProject.steps || [])].sort(
      (a, b) => (a.order ?? 9999) - (b.order ?? 9999),
    );
    const parentSteps = orderedSteps.filter((step) => step.type !== "substep");
    const parentIds = new Set(parentSteps.map((step) => step.id));
    const outlineEntries = [];

    orderedSteps
      .filter((step) => step.type !== "substep" || !parentIds.has(step.parentId))
      .forEach((parentStep, parentIndex) => {
        outlineEntries.push({ step: parentStep, number: String(parentIndex + 1) });
        orderedSteps
          .filter((step) => step.type === "substep" && step.parentId === parentStep.id)
          .forEach((childStep, childIndex) => {
            outlineEntries.push({
              step: childStep,
              number: `${parentIndex + 1}.${childIndex + 1}`,
            });
          });
      });

    const generatedAt = new Date().toLocaleString("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
    });
    const documentName = escapeHtml(currentProject.name || "Chrono Steps Guide");
    const author = escapeHtml(currentProject.author || "Not specified");
    const branding = escapeHtml(window.ChronoConfig?.branding || "Chrono Steps | Unfoundry");
    const screenshotCount = outlineEntries.filter(({ step }) => step.image).length;

    const coverHtml = (coverTemplate || "")
      .replaceAll("{{PROJECT_NAME}}", documentName)
      .replaceAll("{{AUTHOR}}", author)
      .replaceAll("{{GENERATED_AT}}", escapeHtml(generatedAt))
      .replaceAll("{{STEP_COUNT}}", String(outlineEntries.length))
      .replaceAll("{{SCREENSHOT_COUNT}}", String(screenshotCount))
      .replaceAll("{{BRANDING}}", branding);

    const contents = orderedSteps
      .filter((step) => step.type !== "substep" || !parentIds.has(step.parentId))
      .map((parentStep, parentIndex) => {
        const childLinks = orderedSteps
          .filter((step) => step.type === "substep" && step.parentId === parentStep.id)
          .map(
            (childStep, childIndex) =>
              `<a class="contents-child" href="#step-${escapeHtml(childStep.id)}"><span>${parentIndex + 1}.${childIndex + 1}</span>${escapeHtml(childStep.title || "Untitled step")}</a>`,
          )
          .join("");
        return `<section class="contents-group"><a class="contents-parent" href="#step-${escapeHtml(parentStep.id)}"><span>${parentIndex + 1}</span><strong>${escapeHtml(parentStep.title || "Untitled step")}</strong></a>${childLinks ? `<div class="contents-children">${childLinks}</div>` : ""}</section>`;
      })
      .join("");

    const litePackage = {
      format: "ChronoSteps",
      version: "2.0.0",
      project: { ...currentProject, videoData: null, isLiteRecovery: true },
    };
    const litePackageBase64 = btoa(
      unescape(encodeURIComponent(JSON.stringify(litePackage, null, 2))),
    );
    const liteFileName = `${this.safeName(currentProject.name)}.stepslite`;

    const stepsHtml = outlineEntries
      .map(({ step, number }) => {
        const title = escapeHtml(step.title || "Untitled step");
        const description = escapeHtml(step.description || "");
        const image = step.image
          ? `<button class="image-button" type="button" onclick="openImage(this)"><img src="${step.image}" alt="Screenshot for ${title}"></button>`
          : "";
        return `<article id="step-${escapeHtml(step.id)}" class="step-card ${escapeHtml(step.type || "step")}"><div class="step-top"><span class="step-number">${number}</span><div><h2>${title}</h2><div class="step-time">${formatTime(step.time)}</div></div><a class="copy-link" href="#step-${escapeHtml(step.id)}" title="Link to step">#</a></div>${description ? `<p>${description}</p>` : ""}${image}</article>`;
      })
      .join("");

    return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${documentName}</title>
<style>
:root{--blue:#158cba;--dark:#1d2b3a;--muted:#667085;--line:#d9e2ec;--pale:#f2f7fc;--page:#eef3f8}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:var(--dark);background:var(--page);-webkit-print-color-adjust:exact;print-color-adjust:exact}a{color:inherit}
.toolbar{position:sticky;top:0;z-index:10;display:flex;justify-content:flex-end;gap:8px;padding:10px 18px;background:rgba(255,255,255,.95);border-bottom:1px solid var(--line);backdrop-filter:blur(8px)}
.toolbar button{padding:9px 14px;border:0;border-radius:8px;color:#fff;background:var(--blue);font-weight:700;cursor:pointer}
.page{max-width:1050px;margin:22px auto;padding:0 28px 56px}
.cover-page{display:none;flex-direction:column;justify-content:space-between;min-height:252mm;padding:20mm 16mm;background:#fff;border:1px solid var(--line);border-radius:14px;position:relative;overflow:hidden}
.cover-top-accent{position:absolute;top:0;left:0;right:0;height:10px;background:linear-gradient(90deg,#117095,#158cba,#75caeb)}
.cover-brand-row{display:flex;align-items:center;gap:12px;font-weight:800;color:#117095;font-size:14pt;margin-top:8mm}
.cover-logo{display:grid;place-items:center;width:44px;height:44px;border-radius:11px;color:#fff;background:linear-gradient(135deg,#158cba,#75caeb);font-size:16pt;font-weight:800}
.cover-body{margin:auto 0;padding:14mm 0}
.cover-kicker{display:inline-block;padding:4px 10px;border-radius:999px;background:#e8f4fa;color:#117095;font-size:9pt;font-weight:800;letter-spacing:.12em;text-transform:uppercase}
.cover-title{margin:14px 0 12px;font-size:32pt;line-height:1.1;color:#0f172a}
.cover-author{margin:0 0 28px;font-size:13pt;color:#475467}
.cover-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;max-width:540px}
.cover-stat{padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:#f8fafc}
.cover-stat b{display:block;font-size:16pt;color:#158cba;margin-bottom:4px}
.cover-stat span{font-size:8.5pt;text-transform:uppercase;letter-spacing:.08em;color:#64748b}
.cover-footer{display:flex;justify-content:space-between;padding-top:12px;border-top:2px solid var(--line);font-size:9pt;color:#64748b;font-weight:600}
.hero{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:30px;padding:38px;border-radius:18px;color:#fff;background:linear-gradient(135deg,#117095,#158cba,#75caeb);box-shadow:0 18px 45px rgba(13,45,78,.2)}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:24px;font-weight:800}.logo{display:grid;place-items:center;width:44px;height:44px;border-radius:11px;color:var(--blue);background:#fff;font-size:18px}.kicker{font-size:11px;font-weight:800;letter-spacing:.13em;text-transform:uppercase;opacity:.85}.hero h1{margin:6px 0 10px;font-size:clamp(30px,5vw,48px);line-height:1.05}.hero p{margin:0;opacity:.9}.stats{display:grid;grid-template-columns:repeat(2,minmax(90px,1fr));gap:10px;align-self:end}.stat{padding:14px;border:1px solid rgba(255,255,255,.25);border-radius:12px;background:rgba(255,255,255,.12)}.stat b{display:block;font-size:25px}.stat span{font-size:10px;text-transform:uppercase;letter-spacing:.08em}.document-meta{display:flex;flex-wrap:wrap;gap:20px;margin:14px 0 24px;padding:14px 18px;border-radius:11px;background:#fff;font-size:12px}.document-meta b{display:block;color:var(--muted);font-size:9px;letter-spacing:.08em;text-transform:uppercase}
.contents{margin-bottom:26px;padding:21px;border:1px solid var(--line);border-radius:14px;background:#fff}.contents h2{margin:0 0 14px;font-size:17px}.contents-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.contents-group{padding:12px;border:1px solid var(--line);border-radius:10px;background:#fbfdff;break-inside:avoid}.contents-parent,.contents-child{display:grid;grid-template-columns:38px minmax(0,1fr);gap:7px;text-decoration:none}.contents-parent{padding:3px 4px 9px;color:#163c6b}.contents-parent span,.contents-child span{color:var(--blue);font-weight:800}.contents-children{display:grid;gap:2px;padding:4px 0 0 12px;border-left:2px solid #cfe0f2}.contents-child{padding:5px 4px;font-size:11px}.contents-child:hover,.contents-parent:hover{background:var(--pale);border-radius:6px}
.step-card{margin:0 0 15px;padding:22px;border:1px solid var(--line);border-radius:14px;background:#fff;box-shadow:0 7px 22px rgba(20,45,72,.06);break-inside:avoid}.step-card.substep{margin-left:40px;border-left:5px solid #6f42c1}.step-card.note{border-left:5px solid #ff851b}.step-top{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:12px;align-items:start}.step-number{display:grid;place-items:center;min-width:39px;height:34px;padding:0 9px;border-radius:9px;color:var(--blue);background:#e8f2fb;font-weight:800}.step-card h2{margin:0;font-size:19px}.step-time{margin-top:5px;color:var(--muted);font:600 10px ui-monospace,Consolas,monospace}.step-card p{margin:17px 0 0 51px;white-space:pre-wrap;line-height:1.58}.copy-link{text-decoration:none;color:#98a2b3}.image-button{display:block;width:calc(100% - 51px);margin:18px 0 0 51px;padding:0;border:0;background:transparent;cursor:zoom-in}.image-button img{display:block;max-width:100%;max-height:500px;border:1px solid var(--line);border-radius:11px;object-fit:contain;box-shadow:0 6px 18px rgba(16,24,40,.1)}.screen-footer{margin-top:28px;padding:20px;border-top:1px solid var(--line);color:var(--muted);font-size:11px;text-align:center}.lightbox{position:fixed;inset:0;z-index:30;display:none;place-items:center;padding:28px;background:rgba(4,9,16,.9)}.lightbox.open{display:grid}.lightbox img{max-width:100%;max-height:100%;object-fit:contain}.lightbox button{position:absolute;top:14px;right:18px;border:0;color:#fff;background:transparent;font-size:34px;cursor:pointer}
@page{size:A4;margin:20mm 14mm 20mm;@top-left{content:"${branding}";color:#158cba;font-weight:700;font-family:sans-serif;font-size:8.5pt}@top-center{content:"${documentName}";font-family:sans-serif;font-size:8.5pt;color:#475467}@bottom-left{content:"${branding}";font-size:8pt;color:#667085;font-family:sans-serif}@bottom-right{content:"Page " counter(page) " of " counter(pages);font-size:8pt;color:#667085;font-family:sans-serif}}
@page :first{@top-left{content:none}@top-center{content:none}@bottom-left{content:"${branding}";font-size:8pt;color:#667085}@bottom-right{content:none}}
@media(max-width:700px){.page{margin:0;padding:0 12px 35px}.hero{grid-template-columns:1fr;padding:25px;border-radius:0}.contents-grid{grid-template-columns:1fr}.step-card.substep{margin-left:18px}.step-card p,.image-button{margin-left:0;width:100%}.toolbar{position:relative}}
@media print{body{background:#fff}.toolbar,.hero,.document-meta,.contents,.copy-link,.screen-footer,.lightbox{display:none!important}.page{max-width:none;margin:0;padding:0}.cover-page{display:flex!important;border:0;border-radius:0;page-break-after:always;break-after:page}.step-card{box-shadow:none;border-color:#cbd5e1}}
</style>
</head>
<body>
<div class="toolbar"><button onclick="window.print()">Print or save PDF</button><button onclick="downloadLite()">Download StepsLite</button></div>
<main class="page">
${coverHtml}
<header class="hero"><div><div class="brand"><span class="logo">CS</span> ${branding}</div><span class="kicker">Procedure guide</span><h1>${documentName}</h1><p>Prepared by ${author}</p></div><div class="stats"><div class="stat"><b>${outlineEntries.length}</b><span>Steps</span></div><div class="stat"><b>${screenshotCount}</b><span>Screenshots</span></div></div></header>
<section class="document-meta"><div><b>Document</b>${documentName}</div><div><b>Author</b>${author}</div><div><b>Generated</b>${escapeHtml(generatedAt)}</div></section>
<nav class="contents"><h2>Contents</h2><div class="contents-grid">${contents}</div></nav>
<section>${stepsHtml}</section>
<footer class="screen-footer">Generated with ${branding} · ${escapeHtml(generatedAt)}</footer>
</main>
<div id="lightbox" class="lightbox" onclick="if(event.target===this)closeImage()"><button onclick="closeImage()">×</button><img id="lightboxImage" alt="Expanded screenshot"></div>
<script>const litePackageBase64="${litePackageBase64}";function openImage(button){const box=document.getElementById('lightbox');document.getElementById('lightboxImage').src=button.querySelector('img').src;box.classList.add('open')}function closeImage(){document.getElementById('lightbox').classList.remove('open')}function downloadLite(){const json=decodeURIComponent(escape(atob(litePackageBase64)));const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([json],{type:'application/json'}));link.download="${liteFileName}";link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000)}document.addEventListener('keydown',event=>{if(event.key==='Escape')closeImage()})<\/script>
</body></html>`;
  },

  async html(currentProject) {
    const coverTemplate = await this.loadCoverTemplate();
    this.download(
      new Blob([this.guide(currentProject, coverTemplate)], { type: "text/html;charset=utf-8" }),
      `${this.safeName(currentProject.name)}-guide.html`,
    );
  },

  async print(currentProject) {
    const coverTemplate = await this.loadCoverTemplate();
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.append(frame);
    frame.contentDocument.open();
    frame.contentDocument.write(this.guide(currentProject, coverTemplate));
    frame.contentDocument.close();
    await Promise.all(
      [...frame.contentDocument.images].map((image) =>
        image.complete
          ? Promise.resolve()
          : new Promise((resolve) => {
              image.onload = resolve;
              image.onerror = resolve;
            }),
      ),
    );
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 1000);
  },

  async rendered(video, currentProject, reportProgress) {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const stream = canvas.captureStream(30);
    if (!currentProject.excludeAudio && video.captureStream) {
      video
        .captureStream()
        .getAudioTracks()
        .forEach((track) => stream.addTrack(track));
    }

    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };

    const done = new Promise((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
    });

    const oldTime = video.currentTime;
    const wasPaused = video.paused;
    const oldMuted = video.muted;
    const start = Math.max(0, currentProject.trimStart || 0);
    const end =
      currentProject.trimEnd > start
        ? Math.min(currentProject.trimEnd, video.duration)
        : video.duration;

    video.currentTime = start;
    video.muted = Boolean(currentProject.excludeAudio);
    recorder.start(500);
    await video.play();

    await new Promise((resolve) => {
      const renderFrame = () => {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        (currentProject.masks || [])
          .filter((mask) => video.currentTime >= mask.start && video.currentTime <= mask.end)
          .forEach((mask) => this.drawMask(context, canvas, mask));

        reportProgress(
          Math.max(0, Math.min(1, (video.currentTime - start) / Math.max(0.001, end - start))),
        );

        if (video.ended || video.currentTime >= end) {
          video.pause();
          resolve();
        } else {
          requestAnimationFrame(renderFrame);
        }
      };
      renderFrame();
    });

    recorder.stop();
    const blob = await done;
    video.currentTime = oldTime;
    video.muted = oldMuted;
    if (!wasPaused) await video.play();
    return blob;
  },
};

// Backward-compatible alias
window.SRExport = window.ChronoExport;
