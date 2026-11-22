const DATABASE = 'share-inbox';
const STORE = 'files';
const PENDING = 'pending';

function openInbox() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function writeInbox(operation) {
  const db = await openInbox();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      const request = operation(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? new Error('Share inbox transaction aborted'));
    });
  } finally {
    db.close();
  }
}

export async function putSharedFiles(files) {
  await writeInbox((store) => store.put({ id: PENDING, files, at: Date.now() }));
}

export function takeSharedFiles() {
  return writeInbox((store) => {
    const request = store.get(PENDING);
    request.onsuccess = () => {
      if (request.result) store.delete(PENDING);
    };
    return request;
  });
}
