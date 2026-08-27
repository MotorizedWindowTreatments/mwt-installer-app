/* ============================================================
   MWT Installer Order Manager - db.js
   IndexedDB wrapper. Every job is stored as one record in the
   "jobs" store. Attachments (photos/files) are stored as base64
   strings inside the job record itself, keyed by field id, so a
   job and everything attached to it saves/loads as one unit.
   ============================================================ */

const MWT_DB_NAME = "mwt_installer_db";
const MWT_DB_VERSION = 1;
const MWT_STORE_JOBS = "jobs";

let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("This tablet's browser does not support offline storage (IndexedDB). Please use a recent version of Chrome, Edge, or Safari."));
      return;
    }
    const req = indexedDB.open(MWT_DB_NAME, MWT_DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(MWT_STORE_JOBS)) {
        const store = db.createObjectStore(MWT_STORE_JOBS, { keyPath: "id" });
        store.createIndex("status", "status", { unique: false });
        store.createIndex("lastModified", "lastModified", { unique: false });
        store.createIndex("formType", "formType", { unique: false });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
  return _dbPromise;
}

const MwtDB = {
  async saveJob(job) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MWT_STORE_JOBS, "readwrite");
      tx.objectStore(MWT_STORE_JOBS).put(job);
      tx.oncomplete = () => resolve(job);
      tx.onerror = () => reject(tx.error);
    });
  },

  async getJob(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MWT_STORE_JOBS, "readonly");
      const req = tx.objectStore(MWT_STORE_JOBS).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  },

  async getAllJobs() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MWT_STORE_JOBS, "readonly");
      const req = tx.objectStore(MWT_STORE_JOBS).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },

  async deleteJob(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MWT_STORE_JOBS, "readwrite");
      tx.objectStore(MWT_STORE_JOBS).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  // Rough estimate of how much space this job's stored data will use,
  // mainly driven by attachment size. Useful for warning the installer
  // before they attach many large files.
  estimateSize(job) {
    try {
      return new Blob([JSON.stringify(job)]).size;
    } catch (e) {
      return 0;
    }
  }
};
