# Chrono Steps UI

Chrono Steps — Zero-Trust, Client-Side Screen Recording, Timed Video Redaction, and Illustrated Procedure Guide Studio.

---

## ⚡ Highlights

- **100% Client-Side Execution**: Screen recording (`getDisplayMedia` + `MediaRecorder`), timed redactions (`white`, `black`, `blur`, `pixelate`), step authoring, and WebM/HTML/PDF exports run strictly inside browser memory.
- **Three Apps in One Suite**: Full procedure studio (`/`), standalone screen recorder & redactor (`/recorder/`), and embeddable read-only viewer (`/view/`).
- **Progressive Web App (PWA)**: Complete offline and air-gapped readiness with local service worker caching and IndexedDB auto-recovery.
- **Zero Third-Party CDNs**: All JS/CSS dependencies (Bootstrap, Bootswatch Lumen, Bootstrap Icons, SweetAlert2) are self-contained locally.

---

## 🚀 Running Locally

Because Chrono Steps UI is 100% static HTML5/JavaScript, it can be served using any static web server:

### Python HTTP Server
```bash
python3 -m http.server 3000
```
Open `http://localhost:3000` in your web browser.

### Node `npx serve`
```bash
npx serve .
```

### Nginx / Production
Deploy the repository root directly into `/usr/share/nginx/html` or your web server root (over HTTPS or `localhost` for screen recording).


## License

GNU General Public License Copyright &copy; 2026 Chrono Steps / Unfoundry.
