/* ============================================================
   MWT Installer Order Manager - db.js
   IndexedDB wrapper.

   ARCHITECTURE (v3):
   Each regular job's TEXT/metadata (fields, line items, motorization,
   notes, submission state, and lightweight {id,name,type,size} photo
   METADATA) is stored as one lightweight record in the "jobs" store -
   this is what makes Save reliable and fast even for a 173-line,
   40-photo job, since a routine edit-and-save never has to write (or
   re-read) any photo binary data at all.

   The actual heavy Base64 dataUrl for every line-item photo and every
   general attachment is stored SEPARATELY, one record per photo, in a
   "jobAssets" store, keyed by that photo's own stable id (the same id
   already used everywhere else in the app) and indexed by jobId.

   A THIRD store, "jobRecovery", holds a lightweight (no photo binary)
   snapshot of each job's fields/line items/motorization/notes/status,
   written independently and BEFORE the heavier jobs+jobAssets write on
   every save - so measurements/text remain recoverable even in a
   scenario where photo storage specifically is what's failing (quota,
   corrupt asset write, etc.). Every normal read (getJob,
   getAllJobSummaries, getAllJobs) compares the "jobs" record's
   lastModified against its jobRecovery snapshot's lastModified and
   uses whichever is genuinely newer as the TEXT/measurement base - so
   a recovery snapshot that's ahead of a failed normal save is actually
   what the installer sees again after closing and reopening the app,
   not silently ignored.

   getJob(id) transparently HYDRATES a job's photos back from
   "jobAssets" before returning it, so the rest of the app (forms,
   pdf.js, Duplicate, Export Backup, etc.) keeps receiving the exact
   same object shape it always has - {id, name, type, size, dataUrl} -
   and never has to know the split (or the recovery comparison) exists.

   BACKWARD COMPATIBILITY: a job saved before this update still has its
   photos' dataUrl stored INLINE in the "jobs" record itself (the old
   v2 shape). getJob() returns those exactly as before (nothing to
   hydrate - dataUrl is already present). The NEXT time that job is
   saved, saveJob() below detects the inline dataUrl and splits it out
   into "jobAssets" automatically, with no migration screen and no data
   loss - the old record is only ever overwritten after the new asset
   rows have been committed in the SAME atomic transaction.
   ============================================================ */

const MWT_DB_NAME = "mwt_installer_db";
const MWT_DB_VERSION = 3;
const MWT_STORE_JOBS = "jobs";
const MWT_STORE_ITINERARIES = "itineraries";
const MWT_STORE_JOB_ASSETS = "jobAssets";
const MWT_STORE_JOB_RECOVERY = "jobRecovery";

// Bounded watchdog timeout, shared by BOTH the lightweight recovery
// transaction and the heavier jobs+jobAssets transaction (see
// _watchTransaction below) - the real production symptom this exists
// for was Submit & Send sitting on its confirmation modal indefinitely
// because a persistence transaction never settled at all (no error, no
// abort, just silence). Generous enough that a legitimate first-time
// migration of dozens of photos on a slow iPad is never aborted
// unnecessarily, but bounded enough that the installer is never left
// waiting forever - on EITHER transaction, not just the heavy one.
const SAVE_TRANSACTION_TIMEOUT_MS = 45000;

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
      // Existing "jobs" store (v1) - untouched structurally. Every
      // existing job record already saved here (including old-format
      // ones with inline photo dataUrl) is left exactly as it is; nothing
      // here deletes, clears, or rewrites any existing data.
      if (!db.objectStoreNames.contains(MWT_STORE_JOBS)) {
        const store = db.createObjectStore(MWT_STORE_JOBS, { keyPath: "id" });
        store.createIndex("status", "status", { unique: false });
        store.createIndex("lastModified", "lastModified", { unique: false });
        store.createIndex("formType", "formType", { unique: false });
      }
      // Weekly Itinerary's own store (v2) - completely untouched by this
      // upgrade, structurally or otherwise. Kept entirely separate so
      // every existing itinerary function needs zero changes and this
      // regular-job storage change can never affect it.
      if (!db.objectStoreNames.contains(MWT_STORE_ITINERARIES)) {
        const istore = db.createObjectStore(MWT_STORE_ITINERARIES, { keyPath: "id" });
        istore.createIndex("status", "status", { unique: false });
        istore.createIndex("lastModified", "lastModified", { unique: false });
        istore.createIndex("weekStart", "weekStart", { unique: false });
      }
      // Photo/attachment Base64 data, one record per photo, keyed by
      // that photo's own existing stable id, indexed by jobId so all of
      // one job's assets can be fetched/deleted together without
      // scanning the whole store.
      if (!db.objectStoreNames.contains(MWT_STORE_JOB_ASSETS)) {
        const astore = db.createObjectStore(MWT_STORE_JOB_ASSETS, { keyPath: "id" });
        astore.createIndex("jobId", "jobId", { unique: false });
      }
      // Lightweight (no photo binary) recovery snapshot, one per job -
      // added as part of this same v2->v3 upgrade since v3 has not yet
      // been deployed anywhere. Written independently of jobAssets so a
      // photo-storage failure can never take measurements down with it.
      if (!db.objectStoreNames.contains(MWT_STORE_JOB_RECOVERY)) {
        db.createObjectStore(MWT_STORE_JOB_RECOVERY, { keyPath: "id" });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
  return _dbPromise;
}

// Wraps an IndexedDB transaction with a bounded watchdog timeout - if
// the transaction does not settle (complete/error/abort) within
// timeoutMs, it is aborted if still possible and the returned promise
// rejects. Shared by both the recovery write and the heavier
// jobs+jobAssets write, so NEITHER can block a save indefinitely, no
// matter which one Safari/IndexedDB happens to stall on.
// `onCompleteValue`, if provided, runs ONLY on a genuine successful
// commit (never before, never optimistically) and its return value
// becomes the resolved value - used by the heavy save to mark assets
// hydrated only after the transaction has truly committed.
function _watchTransaction(tx, timeoutMs, onCompleteValue) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const watchdog = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { tx.abort(); } catch (e) { /* transaction may already be finished - safe to ignore */ }
      reject(new Error("Save timed out - the browser's storage did not respond in time."));
    }, timeoutMs);

    function finish(fn, arg) {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      fn(arg);
    }

    tx.oncomplete = () => finish(resolve, onCompleteValue ? onCompleteValue() : undefined);
    tx.onerror = () => finish(reject, tx.error || new Error("Save failed."));
    tx.onabort = () => finish(reject, tx.error || new Error("Save was aborted (this can happen if the tablet's storage is full, or the save timed out)."));
  });
}

// Every photo/attachment currently on a job, in one flat list (only
// used internally by saveJob() below to decide what needs
// writing/pruning/marking).
function _collectAssetItems(job) {
  const items = [];
  (job.lineItems || []).forEach((row) => {
    (row.photos || []).forEach((p) => { if (p && p.id) items.push(p); });
  });
  (job.attachments || []).forEach((a) => { if (a && a.id) items.push(a); });
  return items;
}

// Strips dataUrl from one photo/attachment object, returning the
// lightweight shape that's actually stored inline in the "jobs"
// record. _assetHydrated is defined as a NON-ENUMERABLE property (see
// _markAssetHydrated below), so a plain object spread like {...item}
// already excludes it automatically - it is never copied into the
// lightweight shape, never serialized by JSON.stringify(), and never
// leaks into Export Backup or a JSON deep-clone (Duplicate Job).
function _lightweightAssetRef(item) {
  const { dataUrl, ...rest } = item;
  return rest;
}

// Same lightweight shape used for BOTH the "jobs" record and the
// "jobRecovery" snapshot - fields/lineItems/motorization/notes/status
// kept in full, only photo dataUrl stripped.
function _buildLightweightSnapshot(job) {
  const snapshot = { ...job };
  snapshot.lineItems = (job.lineItems || []).map((row) => {
    if (!row.photos || !row.photos.length) return row;
    return { ...row, photos: row.photos.map(_lightweightAssetRef) };
  });
  if (job.attachments && job.attachments.length) {
    snapshot.attachments = job.attachments.map(_lightweightAssetRef);
  }
  return snapshot;
}

// Marks a photo/attachment's dataUrl as known-already-stored, so a
// LATER saveJob() call does not rewrite that same Base64 data again.
// Defined as non-enumerable specifically so this internal bookkeeping
// property can never accidentally end up inside JSON.stringify()
// output (Export Backup) or a JSON-based deep-clone (Duplicate Job) -
// both of those only ever copy/serialize an object's ENUMERABLE
// properties, so a non-enumerable marker is structurally excluded
// without needing any extra stripping logic at those call sites.
function _markAssetHydrated(item) {
  try {
    Object.defineProperty(item, "_assetHydrated", {
      value: true,
      enumerable: false,
      configurable: true,
      writable: true
    });
  } catch (e) {
    // Extremely defensive - if for any reason the property can't be
    // redefined (e.g. already non-configurable), fall back to a plain
    // assignment rather than throwing; worst case this one photo gets
    // rewritten on the next save, which is safe, just not optimal.
    item._assetHydrated = true;
  }
}

// Picks whichever of a job's normal "jobs" record and its "jobRecovery"
// snapshot is genuinely the newer TEXT/measurement base, by comparing
// lastModified (ISO 8601 strings - plain string comparison is correct
// chronological order for this format, same as the sort used
// elsewhere in this app). Recovery must be STRICTLY newer to win - a
// tie (the normal, expected case immediately after any fully
// successful save, since both writes share the same job.lastModified
// value) means the normal record stays authoritative, exactly as
// required. Never mutates either input.
function _pickNewerBase(job, recovery) {
  if (!recovery) return job;
  if (!job) return recovery;
  const jobTime = job.lastModified || "";
  const recTime = recovery.lastModified || "";
  return recTime > jobTime ? recovery : job;
}

const MwtDB = {
  // Splits any new/changed photo Base64 data out into "jobAssets" and
  // writes only a lightweight job record to "jobs" - both in the SAME
  // atomic transaction, so a mid-write failure (quota, browser crash,
  // etc.) can never leave a job referencing assets that were never
  // actually committed, or vice versa. A separate, independent
  // lightweight "jobRecovery" snapshot is written FIRST (see below), so
  // measurements/text survive even if this heavier step fails - and
  // BOTH transactions are bounded by their own watchdog, so neither can
  // block this call forever no matter which one Safari/IndexedDB stalls
  // on.
  //
  // A photo/attachment that already has NO dataUrl on it (already
  // lightweight - either previously split, or hydrated-but-unchanged,
  // see _assetHydrated above) is never rewritten to "jobAssets" here -
  // only photos with a genuinely NEW or CHANGED dataUrl (a fresh
  // upload, or an old v2 record's still-inline photo being migrated
  // for the first time) cost a write. This is what makes a routine
  // measurement edit on a 40-photo job cheap: typing in a field and
  // saving does not rewrite those 40 photos' Base64 data again.
  //
  // IMPORTANT: an asset is only marked _assetHydrated AFTER the heavy
  // transaction has genuinely committed (tx.oncomplete) - never before,
  // and never optimistically. If the transaction fails or times out,
  // nothing is marked, so a retry correctly attempts to write those
  // photos again rather than skipping them.
  async saveJob(job) {
    const db = await openDb();

    // --- Step 1: lightweight recovery snapshot, written FIRST, in its
    // own separate/independent transaction, bounded by the SAME
    // watchdog timeout as the heavy transaction below - if Safari/
    // IndexedDB itself stalls while writing this, it is aborted and
    // rejected rather than hanging saveJob() indefinitely before the
    // heavy transaction's own watchdog would ever get a chance to run.
    // Cheap (no photo binary), so very unlikely to be the thing that
    // fails even when photo storage genuinely is failing. Never
    // touches "jobAssets" at all, so it can never discard or overwrite
    // an already-successfully-saved photo. A failure here (including a
    // timeout) is logged but does not block the main save attempt
    // below from still being tried - matching the existing recovery
    // best-effort design.
    const recoverySnapshot = _buildLightweightSnapshot(job);
    try {
      let rtx;
      try {
        rtx = db.transaction(MWT_STORE_JOB_RECOVERY, "readwrite");
      } catch (err) {
        throw err;
      }
      rtx.objectStore(MWT_STORE_JOB_RECOVERY).put(recoverySnapshot);
      await _watchTransaction(rtx, SAVE_TRANSACTION_TIMEOUT_MS);
    } catch (recErr) {
      console.error("Lightweight measurement recovery snapshot failed to save (continuing to attempt the full save):", recErr);
    }

    // --- Step 2: the full jobs+jobAssets write, also watchdog-bounded.
    const items = _collectAssetItems(job);
    const currentIds = new Set(items.map((i) => i.id));
    const assetsToWrite = items
      .filter((i) => i.dataUrl && !i._assetHydrated)
      .map((i) => ({ id: i.id, jobId: job.id, name: i.name, type: i.type, size: i.size, dataUrl: i.dataUrl }));

    const lightweightJob = _buildLightweightSnapshot(job);

    let tx;
    try {
      tx = db.transaction([MWT_STORE_JOBS, MWT_STORE_JOB_ASSETS], "readwrite");
    } catch (err) {
      throw err;
    }

    tx.objectStore(MWT_STORE_JOBS).put(lightweightJob);

    const assetStore = tx.objectStore(MWT_STORE_JOB_ASSETS);
    assetsToWrite.forEach((a) => assetStore.put(a));

    // Prune any asset rows for this job that are no longer referenced
    // (e.g. the installer removed a photo since the last save) - scoped
    // to just this job's own assets via the jobId index, not a scan of
    // the whole store, so this stays cheap even with many other jobs
    // saved on the same tablet.
    const idx = assetStore.index("jobId");
    const cursorReq = idx.openCursor(IDBKeyRange.only(job.id));
    cursorReq.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        if (!currentIds.has(cursor.value.id)) {
          cursor.delete();
        }
        cursor.continue();
      }
    };

    // Resolves with the ORIGINAL (full, still-hydrated) job object the
    // caller passed in - not the lightweight record actually written -
    // so the rest of the app keeps working with complete in-memory
    // data exactly as before. onCompleteValue only runs after the
    // transaction has genuinely committed, marking every asset that
    // was actually written this round as successfully stored - this is
    // what stops those same photos from being rewritten on the NEXT
    // save within the same session.
    return _watchTransaction(tx, SAVE_TRANSACTION_TIMEOUT_MS, () => {
      assetsToWrite.forEach((a) => {
        const original = items.find((i) => i.id === a.id);
        if (original) _markAssetHydrated(original);
      });
      return job;
    });
  },

  // Full read - returns the job with every photo's dataUrl present,
  // hydrating from "jobAssets" as needed, using whichever of the normal
  // "jobs" record and its "jobRecovery" snapshot is genuinely newer as
  // the TEXT/measurement base (see _pickNewerBase). If recovery wins,
  // the normal "jobs" record - which may still be an old, un-migrated
  // v2 record with photos stored INLINE - is passed along as a legacy
  // fallback source: any photo the recovery snapshot references that
  // has no row in "jobAssets" yet (because the heavier migration/save
  // that would have written it never completed) is recovered from that
  // legacy inline data instead of being lost. An old v2 record read on
  // its own (recovery not newer) is returned exactly as-is (nothing to
  // hydrate - dataUrl is already present). Used for editing, PDF
  // generation, Submit & Send, Duplicate, and full Export Backup.
  async getJob(id) {
    const db = await openDb();
    const [job, recovery] = await Promise.all([
      new Promise((resolve, reject) => {
        const tx = db.transaction(MWT_STORE_JOBS, "readonly");
        const req = tx.objectStore(MWT_STORE_JOBS).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      }),
      new Promise((resolve, reject) => {
        const tx = db.transaction(MWT_STORE_JOB_RECOVERY, "readonly");
        const req = tx.objectStore(MWT_STORE_JOB_RECOVERY).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      })
    ]);

    const base = _pickNewerBase(job, recovery);
    if (!base) return null;
    const legacyFallback = base === recovery ? job : null;
    return _hydrateOneJob(db, base, legacyFallback);
  },

  // Full read of every job, each fully hydrated - used only where
  // genuinely needed (Full Export Backup). For every job, the newer of
  // its normal "jobs" record and "jobRecovery" snapshot is used as the
  // TEXT/measurement base (see _pickNewerBase), so a Full Export Backup
  // taken after reopening does not silently export an older
  // measurement version when a newer recovery snapshot exists. Exactly
  // as in getJob() above, when recovery wins for a given job, its
  // normal "jobs" record is carried along as a legacy-photo fallback in
  // case that job is an old v2 record whose migration to "jobAssets"
  // never completed. A job that only ever got as far as its recovery
  // snapshot (its very first heavy save never completed) is still
  // included, not silently dropped. Loads every job's asset rows in ONE
  // pass (grouped by jobId) rather than one IndexedDB round trip per
  // job, so this stays reasonably efficient even with many saved jobs.
  async getAllJobs() {
    const db = await openDb();
    const [jobs, recoveries] = await Promise.all([
      new Promise((resolve, reject) => {
        const tx = db.transaction(MWT_STORE_JOBS, "readonly");
        const req = tx.objectStore(MWT_STORE_JOBS).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      }),
      new Promise((resolve, reject) => {
        const tx = db.transaction(MWT_STORE_JOB_RECOVERY, "readonly");
        const req = tx.objectStore(MWT_STORE_JOB_RECOVERY).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      })
    ]);

    const recoveryById = new Map(recoveries.map((r) => [r.id, r]));
    const jobById = new Map(jobs.map((j) => [j.id, j]));
    const jobIds = new Set(jobs.map((j) => j.id));
    const recoveryOnlyJobs = recoveries.filter((r) => !jobIds.has(r.id));

    const bases = jobs.map((job) => _pickNewerBase(job, recoveryById.get(job.id)));
    const allBases = bases.concat(recoveryOnlyJobs);
    if (!allBases.length) return allBases;

    const assetsByJobId = await _getAllAssetsGroupedByJobId(db);
    allBases.forEach((base) => {
      const recovery = recoveryById.get(base.id);
      const legacyFallback = recovery && base === recovery ? jobById.get(base.id) || null : null;
      _applyHydration(base, assetsByJobId.get(base.id), legacyFallback);
    });
    return allBases;
  },

  // LIGHTWEIGHT read of every job - for the sidebar, Dashboard, and
  // Saved Jobs list. Never touches "jobAssets" at all, so it stays fast
  // regardless of how many photos any job has. For every job, the newer
  // of its normal "jobs" record and "jobRecovery" snapshot is used (see
  // _pickNewerBase), so Dashboard/Saved Jobs show the correct latest
  // name/status/lastModified even when a recovery snapshot is ahead of
  // a failed normal save. Any job that still has inline photo dataUrl
  // (an old v2 record not yet migrated) has that dataUrl stripped from
  // the returned copy only - the actual stored record is left
  // completely untouched (it's only migrated to the lightweight shape
  // the next time that job is genuinely saved).
  async getAllJobSummaries() {
    const db = await openDb();
    const [jobs, recoveries] = await Promise.all([
      new Promise((resolve, reject) => {
        const tx = db.transaction(MWT_STORE_JOBS, "readonly");
        const req = tx.objectStore(MWT_STORE_JOBS).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      }),
      new Promise((resolve, reject) => {
        const tx = db.transaction(MWT_STORE_JOB_RECOVERY, "readonly");
        const req = tx.objectStore(MWT_STORE_JOB_RECOVERY).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      })
    ]);

    const recoveryById = new Map(recoveries.map((r) => [r.id, r]));
    const jobIds = new Set(jobs.map((j) => j.id));
    const recoveryOnlyJobs = recoveries.filter((r) => !jobIds.has(r.id));

    const combined = jobs.map((job) => {
      const base = _pickNewerBase(job, recoveryById.get(job.id));
      // A recovery-sourced base is already lightweight by construction
      // (recovery snapshots are always built via
      // _buildLightweightSnapshot); a normal-record base only needs
      // stripping if it's an old, not-yet-migrated v2 record still
      // carrying inline dataUrl.
      return _jobHasInlinePhotos(base) ? _buildLightweightSnapshot(base) : base;
    });
    recoveryOnlyJobs.forEach((r) => {
      combined.push(_jobHasInlinePhotos(r) ? _buildLightweightSnapshot(r) : r);
    });

    return combined;
  },

  // Reads the lightweight recovery snapshot for one job, if any,
  // reconstructed alongside whatever "jobAssets" rows already happen to
  // exist for it (never deleting or requiring anything - purely a
  // best-effort combination of the two independent, always-additive
  // data sources).
  async getJobRecovery(id) {
    const db = await openDb();
    const [snapshot, normalJob] = await Promise.all([
      new Promise((resolve, reject) => {
        const tx = db.transaction(MWT_STORE_JOB_RECOVERY, "readonly");
        const req = tx.objectStore(MWT_STORE_JOB_RECOVERY).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      }),
      new Promise((resolve, reject) => {
        const tx = db.transaction(MWT_STORE_JOBS, "readonly");
        const req = tx.objectStore(MWT_STORE_JOBS).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      })
    ]);
    if (!snapshot) return null;
    // Same legacy-photo fallback as getJob()/getAllJobs() - this always
    // exposes the recovery version, so the normal record (possibly an
    // old un-migrated v2 job with inline photos) is always offered as
    // a fallback source here too.
    return _hydrateOneJob(db, snapshot, normalJob);
  },

  // Deletes the job record AND every asset row that belongs to it (via
  // the jobId index) - nothing belonging to any other job is touched.
  // Also removes its recovery snapshot, if any. All in one atomic
  // transaction.
  async deleteJob(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([MWT_STORE_JOBS, MWT_STORE_JOB_ASSETS, MWT_STORE_JOB_RECOVERY], "readwrite");
      tx.objectStore(MWT_STORE_JOBS).delete(id);
      tx.objectStore(MWT_STORE_JOB_RECOVERY).delete(id);
      const assetStore = tx.objectStore(MWT_STORE_JOB_ASSETS);
      const idx = assetStore.index("jobId");
      const cursorReq = idx.openCursor(IDBKeyRange.only(id));
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Delete was aborted."));
    });
  },

  // Rough estimate of how much space this job's stored data will use,
  // mainly driven by attachment size. Operates on the in-memory job
  // object exactly as before (with dataUrls present while being
  // edited) - unaffected by the storage split, since it never reads
  // from IndexedDB itself.
  estimateSize(job) {
    try {
      return new Blob([JSON.stringify(job)]).size;
    } catch (e) {
      return 0;
    }
  }
};

function _jobHasInlinePhotos(job) {
  const items = _collectAssetItems(job);
  return items.some((i) => !!i.dataUrl);
}

function _jobNeedsHydration(job) {
  const items = _collectAssetItems(job);
  return items.some((i) => !i.dataUrl);
}

// Builds a lookup of every photo/attachment id that still has real,
// inline dataUrl on the given legacy fallback job (an old, un-migrated
// v2 "jobs" record) - used only as a last-resort source below when a
// photo isn't found in "jobAssets". Returns null if there's no legacy
// data to offer.
function _buildLegacyInlineLookup(legacyFallbackJob) {
  if (!legacyFallbackJob) return null;
  const byId = new Map();
  (legacyFallbackJob.lineItems || []).forEach((row) => {
    (row.photos || []).forEach((p) => { if (p && p.id && p.dataUrl) byId.set(p.id, p); });
  });
  (legacyFallbackJob.attachments || []).forEach((a) => { if (a && a.id && a.dataUrl) byId.set(a.id, a); });
  return byId.size ? byId : null;
}

// Hydrates a single job's missing photo dataUrls from "jobAssets", with
// an optional legacyFallbackJob (the job's normal "jobs" record, passed
// in only when this `job` is actually a jobRecovery-sourced base) used
// as a last-resort source for any photo not found in "jobAssets" -
// covering the case where a still-un-migrated v2 job's photos are only
// ever stored inline on that old record, and the heavier
// jobs+jobAssets migration that would have split them out never
// completed. Only a photo id the recovery snapshot itself still
// references is ever looked up this way - nothing is added that
// wasn't already part of `job`'s own structure, and nothing the
// recovery snapshot says was removed is ever reintroduced.
//
// IMPORTANT: a photo recovered from this legacy inline fallback is
// deliberately NOT marked _assetHydrated - unlike one found in
// "jobAssets", it has not actually been migrated yet, so the next
// successful save must still write it into "jobAssets" for migration
// to finally complete.
async function _hydrateOneJob(db, job, legacyFallbackJob) {
  const needsHydration = [];
  (job.lineItems || []).forEach((row) => {
    (row.photos || []).forEach((p) => { if (p && p.id && !p.dataUrl) needsHydration.push(p); });
  });
  (job.attachments || []).forEach((a) => { if (a && a.id && !a.dataUrl) needsHydration.push(a); });
  if (!needsHydration.length) return job;

  const assets = await new Promise((resolve, reject) => {
    const tx = db.transaction(MWT_STORE_JOB_ASSETS, "readonly");
    const idx = tx.objectStore(MWT_STORE_JOB_ASSETS).index("jobId");
    const req = idx.getAll(IDBKeyRange.only(job.id));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  const byId = new Map(assets.map((a) => [a.id, a]));
  const legacyById = _buildLegacyInlineLookup(legacyFallbackJob);

  needsHydration.forEach((p) => {
    const asset = byId.get(p.id);
    if (asset) {
      p.dataUrl = asset.dataUrl;
      // Marks this dataUrl as known-unchanged (just rehydrated for the
      // UI/PDF code's convenience) - saveJob() uses this to avoid
      // rewriting it again unless it's genuinely replaced. Non-
      // enumerable, so it can never leak into JSON.stringify() output.
      _markAssetHydrated(p);
      return;
    }
    if (legacyById) {
      const legacy = legacyById.get(p.id);
      if (legacy) {
        // Recovered from the OLD inline v2 record, not from
        // "jobAssets" - deliberately left un-marked so the next
        // successful save still migrates it properly.
        p.dataUrl = legacy.dataUrl;
        return;
      }
    }
    // If neither source has this photo - including the case where a
    // recovery snapshot references a photo whose upload never
    // successfully reached "jobAssets" AND was never part of any
    // legacy inline record either - dataUrl is simply left unset.
    // Every OTHER measurement/text field on this job is completely
    // unaffected; only this one photo is unavailable. The existing
    // UI/PDF fallback (placeholder box / "Could not preview") already
    // handles a photo that can't be rendered, without crashing.
  });
  return job;
}

// Batch counterpart to _hydrateOneJob() above, used by getAllJobs() -
// same legacy inline-photo fallback, same rule that a legacy-recovered
// photo is never marked _assetHydrated.
function _applyHydration(job, assets, legacyFallbackJob) {
  const byId = new Map((assets || []).map((a) => [a.id, a]));
  const legacyById = _buildLegacyInlineLookup(legacyFallbackJob);
  if (!byId.size && !legacyById) return job;

  function hydrateItem(p) {
    if (!p || !p.id || p.dataUrl) return;
    const asset = byId.get(p.id);
    if (asset) {
      p.dataUrl = asset.dataUrl;
      _markAssetHydrated(p);
      return;
    }
    if (legacyById) {
      const legacy = legacyById.get(p.id);
      if (legacy) {
        p.dataUrl = legacy.dataUrl; // not marked hydrated - still needs migrating
      }
    }
  }

  (job.lineItems || []).forEach((row) => (row.photos || []).forEach(hydrateItem));
  (job.attachments || []).forEach(hydrateItem);
  return job;
}

function _getAllAssetsGroupedByJobId(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MWT_STORE_JOB_ASSETS, "readonly");
    const req = tx.objectStore(MWT_STORE_JOB_ASSETS).getAll();
    req.onsuccess = () => {
      const map = new Map();
      (req.result || []).forEach((a) => {
        if (!map.has(a.jobId)) map.set(a.jobId, []);
        map.get(a.jobId).push(a);
      });
      resolve(map);
    };
    req.onerror = () => reject(req.error);
  });
}

// Weekly Itinerary storage - identical shape to MwtDB above, pointed at
// the separate "itineraries" store. Kept as its own object (rather than
// parameterizing MwtDB) so MwtDB's own code above never has to change.
// Completely unaffected by the "jobs"/"jobAssets"/"jobRecovery" split
// above.
const MwtItineraryDB = {
  async saveItinerary(itinerary) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MWT_STORE_ITINERARIES, "readwrite");
      tx.objectStore(MWT_STORE_ITINERARIES).put(itinerary);
      tx.oncomplete = () => resolve(itinerary);
      tx.onerror = () => reject(tx.error);
    });
  },

  async getItinerary(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MWT_STORE_ITINERARIES, "readonly");
      const req = tx.objectStore(MWT_STORE_ITINERARIES).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  },

  async getAllItineraries() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MWT_STORE_ITINERARIES, "readonly");
      const req = tx.objectStore(MWT_STORE_ITINERARIES).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },

  async deleteItinerary(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MWT_STORE_ITINERARIES, "readwrite");
      tx.objectStore(MWT_STORE_ITINERARIES).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
};
