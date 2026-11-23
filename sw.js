// Importar el mini-wrapper de IndexedDB en el contexto del Service Worker
importScripts("./db-helper.js");

const CACHE_STATIC_NAME = "static-outbox-v2";
const STATIC_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./db-helper.js",
  "./app.js",
  "./manifest.json",
];

self.addEventListener("install", (event) => {
  console.log("Service Worker instalado");
  //self.skipWaiting(); // Forzamos a que el SW se active inmediatamente
  event.waitUntil(
    caches.open(CACHE_STATIC_NAME).then((cache) => {
      return cache.addAll(STATIC_FILES);
    }),
  );
});

self.addEventListener("activate", (event) => {
  console.log("Service Worker activado");
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_STATIC_NAME) {
            console.log(
              "Service Worker: Limpiando cache antigua",
            );
            return caches.delete(cacheName);
          }
        }),
      );
    }),
  );
});

// self.addEventListener("fetch", (e) =>
//   e.respondWith(cacheFirst(e.request)),
// );

const cacheFirst = (request) => {
  return caches.match(request).then((resCache) => {
    console.log(resCache);
    if (resCache) return resCache;
    return fetch(request).then((resNetwork) =>
      caches.open(CACHE_VERSION).then((cache) => {
        console.log("Cacheando nuevo recurso", resNetwork);
        cache.put(request, resNetwork.clone());
        return resNetwork;
      }),
    );
  });
};

function notificarClientesActualizacion() {
  return self.clients
    .matchAll({ type: "window", includeUncontrolled: true })
    .then((clientes) => {
      clientes.forEach((cliente) => {
        cliente.postMessage({
          tipo: "OUTBOX_SINCRONIZADO",
          timestamp: Date.now(),
        });
      });
    });
}

function sincronizarPendientesSW() {
  console.log(
    "[SW-Sync] Ejecutando barrido de transacciones pendientes...",
  );

  return obtenerTodosLosRegistros().then((registros) => {
    const pendientes = registros.filter(
      (item) => item.estado === "pendiente",
    );

    if (pendientes.length === 0) {
      console.log(
        "[SW-Sync] Cola limpia. Nada por sincronizar.",
      );
      return;
    }

    const promesasDeEnvio = pendientes.map((item) => {
      return fetch(
        "<https://jsonplaceholder.typicode.com/posts>",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: item.title,
            body: item.body,
          }),
        },
      ).then((respuesta) => {
        if (!respuesta.ok) {
          throw new Error(
            `Error HTTP ${respuesta.status} al sincronizar ID ${item.id}`,
          );
        }
        return actualizarEstadoRegistro(
          item.id,
          "sincronizado",
        );
      });
    });

    return Promise.all(promesasDeEnvio).then(() =>
      notificarClientesActualizacion(),
    );
  });
}
self.addEventListener("sync", (event) => {
  console.log(
    "[SW-Sync] Evento sync disparado con etiqueta:",
    event.tag,
  );

  if (event.tag === "sync-reportes") {
    event.waitUntil(
      sincronizarPendientesSW().catch((error) => {
        console.error(
          "[SW-Sync] Falla en sincronización; el navegador reintentará luego:",
          error,
        );
        // Relanzar el error indica al navegador que debe programar un reintento automático
        throw error;
      }),
    );
  }
});
