/**
 * IndexedDB cache for incomplete file transfers.
 * Enables resuming downloads after page reload or connection drops.
 */

const FileCache = (() => {
  const DB_NAME = 'im-file-cache-v1';
  const STORE = 'receiving';
  let _db = null;

  async function _open() {
    if (_db) return _db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'transferId' });
        }
      };
    });
  }

  async function save(transferId, meta, chunksArray) {
    const db = await _open();
    const chunks = chunksArray.map(c => c ? Array.from(c) : null);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.put({
        transferId,
        name: meta.name,
        size: meta.size,
        type: meta.type,
        totalChunks: meta.totalChunks,
        chunks,
        updatedAt: Date.now()
      });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function load(transferId) {
    const db = await _open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const req = store.get(transferId);
      req.onsuccess = () => {
        const data = req.result;
        if (!data) return resolve(null);
        const receivedChunks = new Set();
        const chunks = data.chunks.map((c, i) => {
          if (c) {
            receivedChunks.add(i);
            return new Uint8Array(c);
          }
          return null;
        });
        resolve({
          transferId: data.transferId,
          name: data.name,
          size: data.size,
          type: data.type,
          totalChunks: data.totalChunks,
          chunks,
          receivedChunks
        });
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function remove(transferId) {
    const db = await _open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.delete(transferId);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function list() {
    const db = await _open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  return { save, load, remove, list };
})();
