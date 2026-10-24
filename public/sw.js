const CACHE='cotology-shell-v4';
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const cache=await caches.open(CACHE);const response=await fetch('/');const html=await response.text();
  const assets=[...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(x=>x[1]);
  await cache.put('/',new Response(html,{headers:{'Content-Type':'text/html;charset=utf-8'}}));
  await cache.addAll([...assets,'/icon.svg','/icon-192.png','/icon-512.png','/manifest.webmanifest']);await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const key of await caches.keys())if(key!==CACHE)await caches.delete(key);await self.clients.claim();})()));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);if(url.origin!==location.origin||url.pathname.startsWith('/api/')||event.request.method!=='GET')return;
  if(event.request.mode==='navigate')event.respondWith(fetch(event.request).catch(()=>caches.match('/')));
  else event.respondWith(caches.match(event.request).then(hit=>hit||fetch(event.request)));
});

