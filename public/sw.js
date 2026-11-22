import { putSharedFiles } from './share-inbox.js';

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

async function receiveShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('photos').filter((value) => value instanceof File);
    await putSharedFiles(files);
    return Response.redirect(new URL('/admin?shared=1', request.url), 303);
  } catch (error) {
    console.warn('Could not receive shared photos', error);
    return new Response('공유된 사진을 받지 못했습니다. 갤러리에서 다시 공유해 주세요.', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'POST') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin && url.pathname === '/share') {
    event.respondWith(receiveShare(request));
  }
});
