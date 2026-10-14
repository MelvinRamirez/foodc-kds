// Catálogo centralizado de textos de UI en español. Ninguna vista debe
// hardcodear copy inline (mismo patrón que foodc-cliente/js/messages.js).

export const messages = {
  pin: {
    title: 'Ingresá el PIN de cocina',
    submit: 'Entrar',
    // auth.error states, ver design.md "Unlock" (Data Flow) y state shape auth.error
    wrongPin: 'PIN incorrecto. Intente de nuevo.',
    offline: 'Sin conexión, reintente.',
    notConfigured: 'El PIN de cocina no está configurado en el servidor. Avise al administrador.',
    contract: 'La cocina no puede validar el PIN (versión del servidor incompatible). Use la hoja Orders.',
    lockButton: 'Bloquear',
  },
  sync: {
    // sync.status states, ver design.md "Stale data is never hidden; connectivity
    // escalates at 60 s (A2)" — tabla de status bar / queue area.
    connecting: 'Conectando…',
    ok: (time) => `Actualizado ${time}`,
    retrying: (time) => `Reconectando… último dato ${time}`,
    stale: (time) =>
      `Sin conexión con el servidor desde ${time}. Los pedidos pueden no estar al día.`,
    contract:
      'La cocina no puede leer pedidos (versión del servidor incompatible). Use la hoja Orders.',
    notConfigured: 'El PIN de cocina no está configurado en el servidor. Avise al administrador.',
    staleRibbon: 'Datos sin confirmar',
    emptyQueueOk: 'No hay pedidos pendientes',
    emptyQueueStale: 'Sin conexión: no se puede confirmar si hay pedidos',
  },
  completion: {
    completeButton: 'Completado',
    // Completion Recovery Policy outcomes, ver design.md "Data Flow" > "Completion".
    // success / NOT_FOUND → confirmado (tombstone): la tarjeta ya desapareció, sin texto adicional.
    // UNAUTHORIZED → re-lock; el pedido pendiente se conserva y el runner se pausa hasta
    // que se ingrese el PIN de nuevo (no requiere texto propio: ver pin.* / sync.*).
    // LOCK_TIMEOUT, SHEET_UNAVAILABLE, INTERNAL_ERROR, PIN_NOT_CONFIGURED, ambiguous → reintento con backoff.
    retrying: 'Reintentando marcar como completado…',
    // VALIDATION_ERROR, INVALID_JSON, UNKNOWN_ACTION → la tarjeta vuelve a la lista con aviso.
    restoredNotice: (tableNumber) =>
      `El pedido de la Mesa ${tableNumber} no se pudo marcar como completado (versión del servidor incompatible) y volvió a la lista.`,
    restoredDismiss: 'Entendido',
  },
};
