/**
 * Chrono Steps — Local IndexedDB + localStorage recovery storage.
 * Stores the active draft locally in browser memory/disk with zero server calls.
 */
window.ChronoStorage = (() => {
  const DB_NAME = "chrono-steps-db";
  const STORE_NAME = "recovery";
  const RECOVERY_KEY = "active-project";
  const LEGACY_KEYS = ["chrono-steps-recovery", "stepsrecorder-recovery-v1.8.5", "stepsrecorder-recovery"];

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        reject(new Error("IndexedDB unavailable"));
        return;
      }
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function saveRecovery(project) {
    const payload = {
      format: "ChronoSteps",
      version: "2.0.0",
      savedAt: new Date().toISOString(),
      project,
    };

    try {
      const db = await openDatabase();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(payload, RECOVERY_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      return true;
    } catch {
      // Fallback to video-free localStorage if IndexedDB is blocked
      try {
        const litePayload = {
          ...payload,
          project: { ...project, videoData: null },
        };
        localStorage.setItem(LEGACY_KEYS[0], JSON.stringify(litePayload));
        return true;
      } catch {
        return false;
      }
    }
  }

  async function restoreRecovery() {
    try {
      const db = await openDatabase();
      const record = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(RECOVERY_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
      db.close();
      if (record) return record.project || record;
    } catch {
      // Ignore IndexedDB errors and check localStorage fallback
    }

    for (const key of LEGACY_KEYS) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (parsed) return parsed.project || parsed;
      } catch {
        // Continue to next key
      }
    }
    return null;
  }

  async function clearRecovery() {
    try {
      const db = await openDatabase();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(RECOVERY_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch {
      // Ignore
    }
    LEGACY_KEYS.forEach((key) => {
      try {
        localStorage.removeItem(key);
      } catch {
        // Ignore
      }
    });
  }

  return {
    saveRecovery,
    restoreRecovery,
    clearRecovery,
  };
})();

