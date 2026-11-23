// Ejemplo de guardado y lectura encadenada con .then() y .catch()}
const nuevaOrden = {
  cliente: "Empresa Logística SA",
  monto: 14500,
  fecha: Date.now(),
};

/* ---------- 1. Detección de capacidades ---------- */
const capacidesPWA = {
  serviceWorker: "serviceWorker" in navigator,
  cacheAPI: "caches" in window,
  indexedDB: "indexedDB" in window,
  pushNotifications: "PushManager" in window,
  webBluetooth: "bluetooth" in navigator,
  storage: "storage" in navigator,
  camara: !!(
    navigator.mediaDevices &&
    navigator.mediaDevices.getUserMedia
  ),
};
console.log("Capacidades:", capacidesPWA);

/* ---------- 2. Service Worker ---------- */
if (capacidesPWA.serviceWorker) {
  console.log("Service worker disponible");
  navigator.serviceWorker
    .register("./sw.js")
    .then((registro) => {
      console.log(
        "Service worker registrado. Scope:",
        registro.scope,
      );
    })
    .catch((error) => {
      console.error(
        "No se pudo registrar el service worker:",
        error,
      );
    });
} else {
  console.log("Service worker no disponible");
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener(
    "message",
    (event) => {
      if (
        event.data &&
        event.data.tipo === "OUTBOX_SINCRONIZADO"
      ) {
        console.log(
          "[UI] Confirmación recibida del Service Worker. Actualizando bandeja...",
        );
        renderizarColaOutbox().catch((error) => {
          console.error(
            "Falla al renderizar la cola de outbox:",
            error,
          );
        });
      }
    },
  );
}

function procesarEnvioReporte(datosFormulario) {
  const endpoint =
    "https://jsonplaceholder.typicode.com/posts";

  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(datosFormulario),
  })
    .then((respuesta) => {
      if (!respuesta.ok)
        throw new Error("Error HTTP del servidor");
      return respuesta.json();
    })
    .then(() => {
      // Envío exitoso en vivo: registrar en bitácora local como sincronizado
      console.log(
        "[Outbox] Envío en vivo exitoso. Guardando registro como sincronizado...",
      );
      return guardarRegistro({
        ...datosFormulario,
        estado: "sincronizado",
        fechaCreacion: Date.now(),
      });
    })
    .catch(() => {
      console.warn(
        "[Outbox] Sin conexión. Encolando en IndexedDB...",
      );

      return guardarRegistro({
        ...datosFormulario,
        estado: "pendiente",
        fechaCreacion: Date.now(),
      }).then(() => {
        // Detección de soporte para Background Sync API
        if (
          "serviceWorker" in navigator &&
          "SyncManager" in window
        ) {
          return navigator.serviceWorker.ready.then(
            (registro) => {
              console.log(
                "[Outbox] Registrando etiqueta sync-reportes en el SW...",
              );
              return registro.sync.register(
                "sync-reportes",
              );
            },
          );
        }
      });
    })
    .then(() => {
      console.log(
        "[Outbox] Registro guardado en IndexedDB y listo para sincronizar.",
      );
      return renderizarColaOutbox();
    });
}
function sincronizarPendientesFallback() {
  console.log(
    "[Outbox] Conexión detectada. Buscando registros pendientes...",
  );

  return obtenerTodosLosRegistros().then((registros) => {
    const pendientes = registros.filter(
      (item) => item.estado === "pendiente",
    );

    if (pendientes.length === 0) {
      console.log(
        "[Outbox] No hay transacciones pendientes por sincronizar.",
      );
      return;
    }

    // Convertir cada registro pendiente en una promesa de envío + actualización
    const promesasDeEnvio = pendientes.map((item) => {
      return fetch(
        "https://jsonplaceholder.typicode.com/posts",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: item.title,
            body: item.body,
          }),
        },
      ).then((res) => {
        if (!res.ok)
          throw new Error("Falla al reintentar envío");
        // Actualizar estado en IndexedDB de 'pendiente' a 'sincronizado'
        return actualizarEstadoRegistro(
          item.id,
          "sincronizado",
        );
      });
    });

    // Esperar a que todos los reenvíos concluyan
    return Promise.all(promesasDeEnvio).then(() => {
      console.log(
        "[Outbox] Todos los registros pendientes han sido sincronizados.",
      );
      return renderizarColaOutbox();
    });
  });
}

function renderizarColaOutbox() {
  const ul = document.getElementById("lista-outbox");
  ul.innerHTML = "<li>Cargando registros...</li>";
  return obtenerTodosLosRegistros().then((registros) => {
    ul.innerHTML = "";
    if (registros.length === 0) {
      ul.innerHTML =
        "<li>No hay registros en la cola.</li>";
      return;
    }
    registros.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = `${item.title} - ${item.body} - Estado: ${item.estado}`;
      ul.appendChild(li);
    });
  });
}

function purgarColaOutbox() {
  console.log(
    "[Outbox] Purga de registros sincronizados iniciada...",
  );
  const lista = obtenerTodosLosRegistros().then(
    (registros) => {
      const ids = registros
        .filter((item) => item.estado === "sincronizado")
        .map((item) => item.id);
      return Promise.all(
        ids.map((id) => eliminarRegistro(id)),
      ).then(renderizarColaOutbox);
    },
  );
}

function onSubmit(e) {
  e.preventDefault();

  const btn = document.getElementById("btn-enviar");

  btn.textContent = "Enviando...";

  const title = e.target["titulo"].value;
  const body = e.target["descripcion"].value;
  procesarEnvioReporte({ title, body }).then(() => {
    e.target.reset();
    btn.textContent = "Enviar Reporte";
    renderizarColaOutbox();
  });
}

function actualizarIndicadorRed(isOffline = true) {
  const indicador = document.getElementById("badge-red");
  if (isOffline) {
    indicador.textContent = "Sin conexión";
    indicador.classList.add("offline");
  } else {
    indicador.textContent = "En línea";
    indicador.classList.remove("offline");
  }
}

// Escuchar el regreso de la conectividad
window.addEventListener("online", () => {
  actualizarIndicadorRed(false);

  // Degradación elegante: Solo sincronizar desde UI si el navegador NO soporta Background Sync (ej. Safari/iOS)
  if (!("SyncManager" in window)) {
    console.log(
      "[Outbox] Navegador sin SyncManager. Ejecutando fallback por evento online...",
    );
    sincronizarPendientesFallback();
  }
});

window.addEventListener("offline", actualizarIndicadorRed);

window.addEventListener("load", () => {
  renderizarColaOutbox().catch((error) => {
    console.error(
      "Falla al renderizar la cola de outbox:",
      error,
    );
  });
  actualizarIndicadorRed(!navigator.onLine);
  document
    .getElementById("btn-purgar")
    .addEventListener("click", purgarColaOutbox);
  document
    .getElementById("form-incidencia")
    .addEventListener("submit", (e) => onSubmit(e));
});
