 // Newave Nuevo Formulario — Google Apps Script

const SHEET_ID   = '10J5chMWPrFFzIYEkjc36HMDJ1H-_q5Q2IsE7srnv1MA';
const SHEET_NAME = 'Registros';

const SKOOL_URL        = 'https://www.skool.com/newave';
const COMUNIDAD_URL    = 'https://www.newaveacademy.com/#comunidad';
const FROM_NAME        = 'Newave Academy';
const FROM_EMAIL       = 'hello@nwave.co';
const WA_LINK          = 'https://wa.me/525573906923?text=Hola%2C%20llen%C3%A9%20el%20formulario%20y%20tengo%20una%20duda';

// Interruptor de WhatsApp. En true no se manda la plantilla de bienvenida ni
// se enlaza WhatsApp en los correos. Se apagó el 1 sep 2026 porque el bot
// dejó de contestar. Al reactivarlo hay que volver a poner la línea de
// "Cualquier duda..." en las plantillas de correo de abajo.
const WHATSAPP_APAGADO = true;

// Column indices (1-based) — must match sheet headers
const COL_FECHA      = 1;
const COL_NOMBRE     = 2;
const COL_CORREO     = 3;
const COL_ESTATUS    = 12; // Column L
const COL_CLICK      = 13; // Column M — "Click a plan"
// Columna N — cuántos correos había recibido la persona cuando entró a Skool.
// Se llena de dos formas: `onEdit` la calcula al marcar un trial nuevo, y
// `calcularCorreoRealAlConvertir` la reconstruye para los viejos cruzando el
// export de Skool. Vive aparte porque marcar "trial" a mano sobrescribe la
// columna Estatus y borra el "email N" que estaba ahí.
const COL_CORREO_AL_CONVERTIR = 14;
// Columna O — de dónde vino el lead. Por ahora solo distingue Google Ads del
// resto: el formulario manda el `gclid` que Google agrega a cada clic de sus
// anuncios. Si viene vacío, el lead llegó por Meta, orgánico o directo (eso ya
// se sabe por otras vías). Va al FINAL a propósito: las columnas 12, 13 y 14
// están hardcodeadas por número y meter una en medio rompería el registro.
const COL_FUENTE = 15;

// Columnas que lee la notificación de Slack. No están hardcodeadas en ningún
// otro lado, pero se declaran aquí para no repetir números mágicos.
const COL_LINKEDIN = 5;
const COL_INGLES   = 6;
const COL_TRABAJO  = 7;
const COL_RAZON    = 8;

// Email sequence delays (ms after signup)
const EMAIL_DELAYS = {
  1: 2 * 60 * 1000,            // 2 min
  2: 24 * 60 * 60 * 1000,      // 24 h
  3: 2 * 24 * 60 * 60 * 1000,  // 2 días
  4: 4 * 24 * 60 * 60 * 1000,  // 4 días
  5: 6 * 24 * 60 * 60 * 1000,  // 6 días
};

// Máximo de correos por corrida (cada 5 min). Reparte los envíos en vez de
// mandarlos de golpe: más suave para la cuota diaria y para los filtros de Gmail.
const MAX_POR_CORRIDA = 10;

// Delay before sending the WhatsApp welcome template (ms after signup)
const WHATSAPP_DELAY = 2 * 60 * 1000; // 2 min, same as email 1

// Si un envío encolado lleva más de esto esperando, se descarta en vez de
// mandarse. Un "hola, vi que llenaste el formulario" que llega 3 días después
// se lee como spam, no como bienvenida.
const MAX_RETRASO_WHATSAPP = 6 * 60 * 60 * 1000; // 6 horas

// WhatsApp Cloud API config — token y phone number id viven en Script
// Properties (Project Settings > Script Properties), no aquí en el código:
//   WA_TOKEN            = token permanente del System User
//   WA_PHONE_NUMBER_ID  = Phone Number ID de producción
const WA_TEMPLATE_NAME = 'nw_bienvenida_lead_v3';
const WA_TEMPLATE_LANG = 'es_MX';

// ─── FORM SUBMISSION ──────────────────────────────────────────────────────

function doGet(e) {
  try {
    // Registro de click en el CTA final — no crea lead nuevo
    if (e.parameter.action === 'click') {
      registrarClick(e.parameter.correo || '');
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'ok', click: true }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Métricas para el dashboard del bot. Va con clave porque devuelve
    // información agregada del negocio, no algo que deba ser público.
    if (e.parameter.action === 'metricas') {
      const claveOk = PropertiesService.getScriptProperties().getProperty('DASHBOARD_PASSWORD');
      if (!claveOk || e.parameter.clave !== claveOk) {
        return ContentService
          .createTextOutput(JSON.stringify({ status: 'error', message: 'No autorizado' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      return ContentService
        .createTextOutput(JSON.stringify(calcularMetricas()))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // El formulario manda el interés en IA en este parámetro. Se llamaba
    // 'track' y guardaba low/high/disqualified, pero desde que el flujo
    // high-ticket se retiró siempre valía 'low' y no servía de nada. Ahora
    // guarda una respuesta que sí varía y que sirve para segmentar.
    // El header de la columna K en el sheet se renombró a "Interés en IA".
    const interesIA = e.parameter.track || '';
    const sheet = getSheet(SHEET_NAME);

    const nombre   = e.parameter.nombre   || '';
    const correo   = e.parameter.correo   || '';
    const whatsapp = e.parameter.whatsapp || '';

    const row = [
      new Date(),
      nombre,
      correo,
      e.parameter.whatsapp   || '',
      "'" + (e.parameter.linkedin || ''),
      e.parameter.ingles     || '',
      e.parameter.trabajo    || '',
      e.parameter.razon      || '',
      e.parameter.compromiso || '',
      e.parameter.inversion  || '',
      interesIA,
      'Registrado',
    ];

    // Lock obligatorio: Apps Script atiende peticiones en paralelo y
    // appendRow no es atómico entre ejecuciones. Sin esto, dos formularios
    // enviados en el mismo segundo (normal con campañas activas) pueden
    // pisarse la fila. Además getLastRow() justo después podría devolver la
    // fila del OTRO lead y encolarle los correos a la persona equivocada.
    //
    // La deduplicación va DENTRO del lock a propósito: el formulario envía el
    // registro por dos caminos a la vez (fetch + imagen) para que ningún lead
    // se pierda, y esos dos llegan casi simultáneos. Comprobar el duplicado
    // fuera del lock dejaría pasar ambos.
    const lock = LockService.getScriptLock();
    let lastRow;
    let duplicado = false;
    try {
      lock.waitLock(30000);

      const filaPrevia = buscarDuplicadoReciente(sheet, correo);
      if (filaPrevia) {
        duplicado = true;
        lastRow = filaPrevia;
      } else {
        sheet.appendRow(row);
        lastRow = sheet.getLastRow();

        // La fuente se escribe aparte del array `row` porque las columnas 13 y
        // 14 (click y correo al convertir) se llenan después, no al registrar.
        // Si se metiera en el array caería en la 13 y pisaría el click.
        const gclid = (e.parameter.gclid || '').toString().trim();
        if (gclid) sheet.getRange(lastRow, COL_FUENTE).setValue('Google Ads');
      }
    } finally {
      lock.releaseLock();
    }

    // Si ya existía, no se vuelve a encolar la secuencia de correos: el lead
    // recibiría la serie completa por duplicado.
    if (duplicado) {
      return ContentService
        .createTextOutput(JSON.stringify({ status: 'ok', duplicado: true }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const compromiso = e.parameter.compromiso || '';
    // Cambio 3 ago 2026: los correos van a TODOS los niveles de compromiso,
    // incluido "Buscando, no listo aun". Razón: son ~7% de los leads (31 de
    // 458 en junio), el nurture por correo es justo la herramienta para quien
    // aún no está listo, y el costo en cuota de Gmail es mínimo (~7-10
    // correos extra al día). El correo es de baja intrusión; WhatsApp abajo
    // sigue filtrado porque un mensaje directo a quien dijo "aún no" sí se
    // siente invasivo.
    queueSequence(nombre, correo, lastRow);
    // Reactivado 3 ago 2026 (se pausó el 30 jul por sospecha de que bajaba
    // los leads; los datos no confirmaron esa correlación). Mismo criterio
    // que los correos de arriba: no se le escribe a quien de entrada dijo
    // que solo está viendo. Si algo sale mal, volver a comentar esta línea.
    if (compromiso !== 'Buscando, no listo aun') {
      // WHATSAPP APAGADO (1 sep 2026). El bot no está contestando (se acabó
      // el saldo de la API), así que mandar la plantilla de bienvenida abre
      // una conversación que nadie responde. Peor que no escribir.
      // Para reactivar: quitar el if y volver a llamar queueWhatsapp.
      if (!WHATSAPP_APAGADO) queueWhatsapp(nombre, whatsapp, lastRow);
    }

    // Le pasa al bot lo que la persona escribió, para que si escribe por
    // WhatsApp ya sepa quién es y no pregunte de cero lo que ya contestó.
    enviarLeadAlBot({
      nombre:     nombre,
      whatsapp:   whatsapp,
      trabajo:    e.parameter.trabajo || '',
      razon:      e.parameter.razon || '',
      ingles:     e.parameter.ingles || '',
      compromiso: compromiso,
    });

    ensureProcessorTrigger();

    return ContentService
      .createTextOutput(JSON.stringify({ status: 'ok' }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'error', message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Manda los datos del formulario al bot de WhatsApp. Va envuelto en try/catch
// a propósito: si el bot está caído o cambia de URL, el lead ya quedó guardado
// en el sheet y no se debe perder el registro por esto. Falla en silencio
// (solo log) porque este envío es un extra, no parte del registro del lead.
function enviarLeadAlBot(datos) {
  try {
    const props  = PropertiesService.getScriptProperties();
    const url    = props.getProperty('BOT_LEAD_URL');
    const secret = props.getProperty('BOT_LEAD_SECRET');
    if (!url || !secret) return; // no configurado todavía, no es un error

    const resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-lead-secret': secret },
      payload: JSON.stringify(datos),
      muteHttpExceptions: true,
    });

    const code = resp.getResponseCode();
    if (code >= 300) {
      console.error('enviarLeadAlBot: HTTP ' + code + ' — ' + resp.getContentText());
    }
  } catch (err) {
    console.error('enviarLeadAlBot falló: ' + err);
  }
}

// Calcula el embudo (leads → click al plan → trial) por periodo y por
// segmento, leyendo el sheet de Registros. Lo consume el dashboard del bot.
function calcularMetricas() {
  const sheet = getSheet(SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { total: vacio(), hoy: vacio(), semana: vacio(), mes: vacio(), segmentos: {} };

  // Una sola lectura del rango completo: pedir celda por celda sobre miles de
  // filas es lentísimo en Apps Script.
  const datos = sheet.getRange(2, 1, lastRow - 1, COL_FUENTE).getValues();

  const ahora = new Date();
  const inicioHoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
  const inicioSemana = new Date(inicioHoy.getTime() - 7 * 24 * 60 * 60 * 1000);
  const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1);

  // El registro de clicks se implementó el 11 jul 2026 (commit 893f7b7). Los
  // leads anteriores tienen la columna vacía por diseño, no porque no hayan
  // dado click, así que se cuentan aparte para no diluir el porcentaje.
  const INICIO_TRACKING_CLICKS = new Date(2026, 6, 11); // 11 jul 2026
  let leadsConTrackingClick = 0;
  let clicksDesdeTracking = 0;

  const total  = vacio();
  const hoy    = vacio();
  const semana = vacio();
  const mes    = vacio();
  const porCompromiso = {};
  const porIngles = {};
  const porTrack = {};
  // De dónde vino el lead. Solo distingue Google Ads del resto: la columna se
  // llena con el gclid que Google agrega a sus clics. "Otras fuentes" junta
  // Meta, orgánico y directo, que ya se distinguen por otras vías.
  const porFuente = {};
  // Cuántos correos había recibido cada quien al momento de convertir.
  // Es el último correo ENVIADO antes del trial, no prueba de causalidad,
  // pero sirve para ver en qué punto de la secuencia se concentran.
  const porCorreo = { 'Sin correo aún': 0, 'Correo 1': 0, 'Correo 2': 0, 'Correo 3': 0, 'Correo 4': 0, 'Correo 5': 0, 'Sin dato': 0 };
  const porVelocidad = { 'El mismo día': 0, 'En 1-2 días': 0, 'Después de 4+ días': 0 };
  const numerosTrial = [];

  for (let i = 0; i < datos.length; i++) {
    const fila = datos[i];
    const fecha      = fila[COL_FECHA - 1];
    const ingles     = (fila[5]  || '').toString().trim();   // col 6
    const compromiso = (fila[8]  || '').toString().trim();   // col 9
    const interesIA  = (fila[10] || '').toString().trim();   // col 11 — Interés en IA
    const estatus    = (fila[COL_ESTATUS - 1] || '').toString().toLowerCase();
    const click      = (fila[COL_CLICK - 1] || '').toString().trim();
    const fuente     = (fila[COL_FUENTE - 1] || '').toString().trim();

    // El estatus acumula notas separadas por " | " (correos, WhatsApp), así
    // que se busca la palabra dentro, no una igualdad exacta.
    const esTrial = estatus.indexOf('trial') !== -1 || estatus.indexOf('pago') !== -1;
    const dioClick = click !== '';

    sumar(total, esTrial, dioClick);

    if (fecha instanceof Date && !isNaN(fecha.getTime())) {
      if (fecha >= inicioHoy)    sumar(hoy, esTrial, dioClick);
      if (fecha >= inicioSemana) sumar(semana, esTrial, dioClick);
      if (fecha >= inicioMes)    sumar(mes, esTrial, dioClick);

      if (fecha >= INICIO_TRACKING_CLICKS) {
        leadsConTrackingClick++;
        if (dioClick) clicksDesdeTracking++;
      }
    }

    acumularSegmento(porCompromiso, compromiso || 'Sin dato', esTrial, dioClick);
    acumularSegmento(porIngles,     ingles     || 'Sin dato', esTrial, dioClick);
    acumularSegmento(porTrack,      interesIA  || 'Sin dato', esTrial, dioClick);
    acumularSegmento(porFuente,     fuente     || 'Meta, orgánico o directo', esTrial, dioClick);

    if (esTrial) {
      // La columna N la llena onEdit al marcar el trial. Si está vacía, es un
      // trial de antes de esa mecánica y no hay dato — se cuenta aparte en vez
      // de meterlo en "Sin correo aún", que significaría otra cosa.
      const registrado = fila[COL_CORREO_AL_CONVERTIR - 1];
      if (registrado === '' || registrado === null || registrado === undefined) {
        porCorreo['Sin dato']++;
      } else {
        const n = parseInt(registrado, 10);
        const llave = n === 0 ? 'Sin correo aún' : 'Correo ' + n;
        if (porCorreo[llave] !== undefined) porCorreo[llave]++;

        // Cuánto tardaron en decidirse. El promedio de "en qué correo
        // convierten" esconde que son dos públicos distintos: unos entran el
        // mismo día y otros necesitan días de acompañamiento (el 3 ago fue
        // casi mitad y mitad). Sin este corte, la cola larga parece
        // despreciable y no lo es.
        if (n <= 1)      porVelocidad['El mismo día']++;
        else if (n <= 3) porVelocidad['En 1-2 días']++;
        else             porVelocidad['Después de 4+ días']++;
      }

      // Solo el número normalizado, para que el bot pueda cruzar quién de
      // los que convirtieron había hablado con él. Sin nombre ni correo.
      const wa = normalizarNumero(fila[3] || '');
      if (wa) numerosTrial.push(wa);
    }
  }

  return {
    actualizado: ahora.toISOString(),
    total: total,
    hoy: hoy,
    semana: semana,
    mes: mes,
    segmentos: {
      compromiso: porCompromiso,
      ingles: porIngles,
      track: porTrack,
      fuente: porFuente,
    },
    trialsPorCorreo: porCorreo,
    trialsPorVelocidad: porVelocidad,
    numerosTrial: numerosTrial,
    // Base real para el % de clicks: solo los leads que llegaron cuando el
    // registro de clicks ya existía.
    tracking: {
      clicksDesde: INICIO_TRACKING_CLICKS.toISOString(),
      leadsDesdeTracking: leadsConTrackingClick,
      clicksDesdeTracking: clicksDesdeTracking,
    },
  };

  function vacio() { return { leads: 0, clicks: 0, trials: 0 }; }

  function sumar(acc, esTrial, dioClick) {
    acc.leads++;
    if (dioClick) acc.clicks++;
    if (esTrial)  acc.trials++;
  }

  function acumularSegmento(mapa, llave, esTrial, dioClick) {
    if (!mapa[llave]) mapa[llave] = { leads: 0, clicks: 0, trials: 0 };
    sumar(mapa[llave], esTrial, dioClick);
  }
}

// Se dispara al editar el sheet. Cuando se marca una fila como "trial",
// calcula cuántos correos de la secuencia ya habían salido y lo guarda en la
// columna N, antes de que ese dato se pierda para siempre.
//
// Se deduce del tiempo transcurrido desde el registro (los correos salen en
// tiempos fijos) en vez de leerlo del estatus, porque marcar el trial a mano
// sobrescribe esa celda y borra el "Correo enviado: email N" que tenía.
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    const sheet = e.range.getSheet();
    if (sheet.getName() !== SHEET_NAME) return;
    if (e.range.getColumn() !== COL_ESTATUS) return;

    const fila = e.range.getRow();
    if (fila < 2) return;

    const valor = (e.range.getValue() || '').toString().toLowerCase();
    if (valor.indexOf('trial') === -1 && valor.indexOf('pago') === -1) return;

    // Encola el correo de onboarding. Va ANTES del registro de la columna N a
    // propósito: ese bloque hace return si la celda ya tiene valor, y eso
    // impediría encolar cuando se re-edita el estatus.
    queueOnboarding(sheet, fila);
    queueSlack(sheet, fila);

    // Si ya se registró antes, no pisarlo (por si se re-edita la celda)
    const celdaDestino = sheet.getRange(fila, COL_CORREO_AL_CONVERTIR);
    if (celdaDestino.getValue() !== '') return;

    const fechaRegistro = sheet.getRange(fila, COL_FECHA).getValue();
    if (!(fechaRegistro instanceof Date) || isNaN(fechaRegistro.getTime())) return;

    celdaDestino.setValue(correosEnviadosAl(Date.now() - fechaRegistro.getTime()));
  } catch (err) {
    // Nunca romper la edición del sheet por esto
    console.error('onEdit falló: ' + err);
  }
}

// ─── ONBOARDING: correo para quien ya entró al trial ──────────────────────
//
// Distinto de la secuencia de 5 correos (`seq_`), que es para leads que NO
// entraron. Este arranca cuando se marca "Trial" en la columna L y busca una
// sola cosa: que la persona se presente en la comunidad y conteste el DM de
// Jaime, porque de ahí él la encamina. Firmado por Jaime, que es quien da el
// seguimiento dentro de la plataforma.
//
// Empieza con UN correo a propósito. Si funciona, agregar un segundo es
// copiar el bloque de sendOnboarding1 y añadir la entrada al mapa de delays.
const ONBOARDING_DELAYS = {
  1: 60 * 60 * 1000,   // 1 h después de marcar el trial
};

const POST_BIENVENIDA_URL = 'https://www.skool.com/newave/welcome-introduce-yourself-share-a-pic-of-your-workspace';

// Encola el correo de onboarding para la fila marcada como trial.
//
// Idempotente: la marca `onb_hecho_<fila>` evita que re-editar la celda de
// estatus vuelva a encolar y la persona reciba el correo dos veces. La marca
// NO se borra al enviarse, justamente para que siga bloqueando reenvíos.
//
// Nota sobre triggers simples: onEdit no puede llamar a GmailApp (requiere
// autorización). Por eso aquí solo se escribe en Script Properties, que sí
// está permitido, y processQueue —que corre con un trigger instalable— es
// quien manda el correo.
function queueOnboarding(sheet, fila) {
  try {
    const props = PropertiesService.getScriptProperties();
    const marca = 'onb_hecho_' + fila;
    if (props.getProperty(marca)) return; // ya se encoló para esta fila

    const nombre = (sheet.getRange(fila, COL_NOMBRE).getValue() || '').toString().trim();
    const correo = (sheet.getRange(fila, COL_CORREO).getValue() || '').toString().trim();
    if (!correo) return;

    const now = Date.now();
    props.setProperty('onb_' + fila + '_1', JSON.stringify({
      emailNum: 1,
      nombre:   nombre,
      correo:   correo,
      row:      fila,
      dueAt:    now + ONBOARDING_DELAYS[1],
    }));
    props.setProperty(marca, String(now));
  } catch (err) {
    // Nunca romper la edición del sheet por esto
    console.error('queueOnboarding falló: ' + err);
  }
}

// Cuántos correos de la secuencia ya habían salido tras X ms del registro.
// Nota: es cuántos se ENVIARON, no cuántos se abrieron o leyeron.
function correosEnviadosAl(transcurridoMs) {
  let n = 0;
  for (let i = 1; i <= 5; i++) {
    if (transcurridoMs >= EMAIL_DELAYS[i]) n = i;
  }
  return n;
}

function registrarClick(correo) {
  const sheet = getSheet(SHEET_NAME);
  const row = buscarFilaPorCorreo(sheet, correo);
  if (row) sheet.getRange(row, COL_CLICK).setValue('Sí');
}

// ─── QUEUE + SINGLE RECURRING TRIGGER ─────────────────────────────────────

function queueSequence(nombre, correo, rowNumber) {
  const props = PropertiesService.getScriptProperties();
  const now   = Date.now();

  for (let n = 1; n <= 5; n++) {
    const key  = 'seq_' + rowNumber + '_' + n;
    const data = JSON.stringify({
      emailNum: n,
      nombre:   nombre,
      correo:   correo,
      row:      rowNumber,
      dueAt:    now + EMAIL_DELAYS[n],
    });
    props.setProperty(key, data);
  }
}

// Queue the WhatsApp welcome template for this lead, if they gave a number.
function queueWhatsapp(nombre, whatsapp, rowNumber) {
  if (!whatsapp) return; // no number given, nothing to send

  const props = PropertiesService.getScriptProperties();
  const key   = 'wa_' + rowNumber;
  const data  = JSON.stringify({
    nombre:   nombre,
    whatsapp: whatsapp,
    row:      rowNumber,
    dueAt:    Date.now() + WHATSAPP_DELAY,
  });
  props.setProperty(key, data);
}

function ensureProcessorTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    if (t.getHandlerFunction() === 'processQueue') return;
  }
  ScriptApp.newTrigger('processQueue')
    .timeBased()
    .everyMinutes(5)
    .create();
}

// Ventana para considerar dos registros del mismo correo como el mismo envío.
// El formulario manda fetch + imagen casi a la vez, y el reintento diferido de
// localStorage puede llegar bastante después si la persona cerró la pestaña.
// 10 min cubre ambos casos sin bloquear a quien vuelve a aplicar otro día.
const VENTANA_DUPLICADO_MS = 10 * 60 * 1000;

// Devuelve la fila de un registro reciente con el mismo correo, o 0 si no hay.
// Solo mira las últimas filas: el duplicado siempre está al final, y así no se
// recorre todo el sheet en cada submit.
function buscarDuplicadoReciente(sheet, correo) {
  if (!correo) return 0;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  const FILAS_A_REVISAR = 30;
  const desde = Math.max(2, lastRow - FILAS_A_REVISAR + 1);
  const numFilas = lastRow - desde + 1;
  if (numFilas < 1) return 0;

  // Columnas 1..3 = Fecha, Nombre, Correo
  const datos = sheet.getRange(desde, COL_FECHA, numFilas, COL_CORREO).getValues();
  const target = correo.trim().toLowerCase();
  const ahora = Date.now();

  for (let i = datos.length - 1; i >= 0; i--) {
    const correoFila = datos[i][COL_CORREO - 1];
    if (!correoFila || correoFila.toString().trim().toLowerCase() !== target) continue;

    const fecha = datos[i][COL_FECHA - 1];
    // Si la fecha no es una fecha válida, se prefiere NO tratarlo como
    // duplicado: registrar de más es mejor que perder el lead.
    if (!(fecha instanceof Date) || isNaN(fecha.getTime())) continue;

    if (ahora - fecha.getTime() <= VENTANA_DUPLICADO_MS) {
      return desde + i;
    }
  }
  return 0;
}

// Encuentra la fila actual de un lead por su correo (el más reciente).
// Se busca por correo, no por índice, para que borrar filas nunca desincronice.
function buscarFilaPorCorreo(sheet, correo) {
  if (!correo) return 0;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  const correos = sheet.getRange(1, COL_CORREO, lastRow, 1).getValues();
  const target = correo.trim().toLowerCase();

  for (let i = correos.length - 1; i >= 1; i--) {
    // Guard contra celdas vacías o con error de fórmula: sin esto, un
    // .toString() sobre null lanza excepción y tumba processQueue entero,
    // dejando sin correos a TODOS los leads pendientes de esa corrida.
    const val = correos[i][0];
    if (val && val.toString().trim().toLowerCase() === target) {
      return i + 1;
    }
  }
  return 0;
}

// Corre cada 5 min: manda los correos vencidos, con tope por corrida y
// reintento automático si Gmail se queda sin cuota. También procesa la
// cola de WhatsApp (plantilla de bienvenida para leads nuevos).
function processQueue() {
  const props = PropertiesService.getScriptProperties();
  const sheet = getSheet(SHEET_NAME);
  const allProps = props.getProperties();
  const now = Date.now();

  const senders = {
    1: sendEmail1, 2: sendEmail2, 3: sendEmail3, 4: sendEmail4, 5: sendEmail5,
  };

  let enviados = 0;

  // Sin cuota de Gmail, se salta el bloque de correos pero el de WhatsApp
  // sigue corriendo abajo — no dependen del mismo límite.
  const sinCuotaGmail = MailApp.getRemainingDailyQuota() <= 0;

  for (const key in allProps) {
    if (sinCuotaGmail) break;
    if (key.indexOf('seq_') !== 0) continue;
    if (enviados >= MAX_POR_CORRIDA) break; // throttle: rest waits for next run

    // Una clave con JSON corrupto no debe tumbar la cola entera: se descarta
    // y se sigue con los demás leads.
    let data;
    try {
      data = JSON.parse(allProps[key]);
    } catch (err) {
      props.deleteProperty(key);
      continue;
    }
    if (now < data.dueAt) continue; // not due yet

    const row = buscarFilaPorCorreo(sheet, data.correo);

    // Email 1 always sends; 2-5 skip if the lead already started trial or paid
    const skip = (data.emailNum !== 1) && row && isTrialOrPaid(sheet, row);

    if (skip || !data.correo) {
      props.deleteProperty(key);
      continue;
    }

    try {
      senders[data.emailNum](data.nombre, data.correo);
      if (row) sheet.getRange(row, COL_ESTATUS).setValue('Correo enviado: email ' + data.emailNum);
      enviados++;
      props.deleteProperty(key);
    } catch (err) {
      const msg = err.message || '';
      if (msg.indexOf('too many times') !== -1 || msg.indexOf('Límite') !== -1) {
        if (row) sheet.getRange(row, COL_ESTATUS).setValue('En espera (límite diario)');
        break; // se acabó la cuota de Gmail — el bloque de WhatsApp sigue abajo
      }
      if (row) sheet.getRange(row, COL_ESTATUS).setValue('Error correo ' + data.emailNum + ': ' + msg);
      props.deleteProperty(key);
    }
  }

  for (const key in allProps) {
    if (key.indexOf('wa_') !== 0) continue;

    let data;
    try {
      data = JSON.parse(allProps[key]);
    } catch (err) {
      props.deleteProperty(key);
      continue;
    }
    Logger.log('[WA queue] ' + key + ' dueAt=' + data.dueAt + ' now=' + now + ' pendiente=' + (now < data.dueAt));
    if (now < data.dueAt) continue; // not due yet

    // Un mensaje de bienvenida que llega días tarde es peor que no mandarlo:
    // la persona ya no se acuerda del formulario y se siente spam. Si la cola
    // se atoró (pausa, error, cuota), se descarta en vez de enviarse tarde.
    if (now - data.dueAt > MAX_RETRASO_WHATSAPP) {
      Logger.log('[WA queue] descartado por viejo: ' + key + ' (' + Math.round((now - data.dueAt) / 3600000) + ' h de retraso)');
      if (data.row) agregarEstatus(sheet, data.row, 'WhatsApp no enviado (encolado muy viejo)');
      props.deleteProperty(key);
      continue;
    }

    try {
      enviarPlantillaWhatsapp(data.nombre, data.whatsapp);
      if (data.row) agregarEstatus(sheet, data.row, 'WhatsApp enviado');
      Logger.log('[WA queue] enviado OK a fila ' + data.row);
    } catch (err) {
      Logger.log('[WA queue] ERROR: ' + (err.message || err));
      if (data.row) agregarEstatus(sheet, data.row, 'Error WhatsApp: ' + (err.message || err));
    }
    props.deleteProperty(key);
  }

  // Cola de onboarding (quien ya entró al trial). Comparte el tope de
  // MAX_POR_CORRIDA con la secuencia normal para no golpear la cuota de Gmail
  // en una sola pasada.
  const sendersOnb = { 1: sendOnboarding1 };

  for (const key in allProps) {
    if (sinCuotaGmail) break;
    if (key.indexOf('onb_') !== 0) continue;
    if (key.indexOf('onb_hecho_') === 0) continue; // marca de control, no es cola
    if (enviados >= MAX_POR_CORRIDA) break;

    let data;
    try {
      data = JSON.parse(allProps[key]);
    } catch (err) {
      props.deleteProperty(key);
      continue;
    }
    if (now < data.dueAt) continue; // aún no toca

    if (!data.correo || !sendersOnb[data.emailNum]) {
      props.deleteProperty(key);
      continue;
    }

    try {
      sendersOnb[data.emailNum](data.nombre, data.correo);
      enviados++;
      props.deleteProperty(key);
      Logger.log('[onboarding] enviado correo ' + data.emailNum + ' a fila ' + data.row);
    } catch (err) {
      const msg = err.message || '';
      if (msg.indexOf('too many times') !== -1 || msg.indexOf('Límite') !== -1) {
        break; // sin cuota: se reintenta en la siguiente corrida, no se borra
      }
      // Otro error: se descarta para no atorar la cola con un envío imposible
      Logger.log('[onboarding] ERROR correo ' + data.emailNum + ' a ' + data.correo + ': ' + msg);
      props.deleteProperty(key);
    }
  }

  // Cola de Slack. Va aparte de las de Gmail: no consume cuota de correo, así
  // que no la limita `sinCuotaGmail` ni MAX_POR_CORRIDA.
  for (const key in allProps) {
    if (key.indexOf('slack_') !== 0) continue;
    if (key.indexOf('slack_hecho_') === 0) continue; // marca de control

    let data;
    try {
      data = JSON.parse(allProps[key]);
    } catch (err) {
      props.deleteProperty(key);
      continue;
    }

    try {
      enviarNotificacionSlack(data);
      Logger.log('[slack] notificado trial de fila ' + data.row);
    } catch (err) {
      // Un fallo de Slack no debe atorar la cola ni tocar el estatus del lead:
      // es una notificación interna, no parte del flujo del cliente.
      Logger.log('[slack] ERROR fila ' + data.row + ': ' + (err.message || err));
    }
    props.deleteProperty(key);
  }

  // Al final de cada corrida: ¿lleva el sheet demasiado sin leads nuevos?
  vigilarSilencioDeLeads();
}

// ─── SLACK: aviso al equipo cuando alguien entra al trial ──────────────────
//
// Se dispara al marcar "trial" en la columna L, igual que el correo de
// onboarding. La idea es que el equipo vea el perfil sin abrir el sheet.
//
// Mismo patrón que la cola de WhatsApp: onEdit es un trigger simple y no
// puede hacer llamadas HTTP (UrlFetchApp requiere autorización), así que aquí
// solo se escribe en Script Properties y processQueue —que corre con trigger
// instalable— es quien manda el mensaje.
function queueSlack(sheet, fila) {
  try {
    const props = PropertiesService.getScriptProperties();
    const marca = 'slack_hecho_' + fila;
    if (props.getProperty(marca)) return; // ya se avisó de esta fila

    const val = function (col) {
      return (sheet.getRange(fila, col).getValue() || '').toString().trim();
    };

    const data = {
      row:      fila,
      nombre:   val(COL_NOMBRE),
      trabajo:  val(COL_TRABAJO),
      razon:    val(COL_RAZON),
      linkedin: val(COL_LINKEDIN),
      ingles:   val(COL_INGLES),
    };

    props.setProperty('slack_' + fila, JSON.stringify(data));
    // Se guarda el timestamp, no un '1': limpiarMarcasViejas() lo usa para
    // saber qué marcas ya son viejas y se pueden borrar.
    props.setProperty(marca, String(Date.now()));
  } catch (err) {
    Logger.log('[slack] no se pudo encolar fila ' + fila + ': ' + err);
  }
}

// Manda el mensaje al canal. El webhook vive en Script Properties como
// SLACK_WEBHOOK_URL — no se pone aquí porque es una credencial.
function enviarNotificacionSlack(data) {
  const url = PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL');
  if (!url) throw new Error('Falta SLACK_WEBHOOK_URL en Script Properties');

  // Los campos vacíos se marcan en vez de dejarse en blanco, para que se note
  // la diferencia entre "no contestó" y "se rompió el mensaje".
  const oNada = function (v) { return v || '_Sin dato_'; };

  // El LinkedIn se guarda a veces con https:// y a veces sin. Se normaliza
  // para que Slack lo muestre como liga clicable en los dos casos.
  let linkedin = data.linkedin;
  if (linkedin && linkedin.indexOf('http') !== 0) linkedin = 'https://' + linkedin;
  const lineaLinkedin = linkedin
    ? '<' + linkedin + '|Ver perfil>'
    : '_Sin LinkedIn_';

  const payload = {
    text: '🎉 Nuevo trial: ' + (data.nombre || 'Sin nombre'),
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '🎉 Nuevo trial: ' + (data.nombre || 'Sin nombre'), emoji: true },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*Nivel de inglés*\n' + oNada(data.ingles) },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*Trabajo actual*\n' + oNada(data.trabajo) },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*Razón del cambio*\n' + oNada(data.razon) },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*LinkedIn*\n' + lineaLinkedin },
      },
    ],
  };

  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = resp.getResponseCode();
  if (code >= 300) throw new Error('Slack ' + code + ': ' + resp.getContentText());
}

// Guarda el webhook de Slack desde código.
//
// Existe porque la interfaz de Script Properties se vuelve de solo lectura al
// pasar de 50 propiedades, y las marcas `onb_hecho_<fila>` (una por trial) ya
// pasaron ese tope. Pega la URL abajo, corre esta función UNA VEZ, y después
// vuelve a dejar la constante vacía para no dejar la credencial en el código.
function guardarWebhookSlack() {
  const URL = ''; // <-- pega aquí la URL de https://hooks.slack.com/services/...

  if (!URL) throw new Error('Pega la URL del webhook en la constante URL antes de correr esto.');
  PropertiesService.getScriptProperties().setProperty('SLACK_WEBHOOK_URL', URL);
  Logger.log('Guardado. Ahora corre probarSlack para verificar.');
}

// Borra las marcas `onb_hecho_` y `slack_hecho_` de filas viejas, que son las
// que llenaron el cupo de 50 propiedades visibles. Solo conserva las de los
// últimos 30 días: las viejas ya no sirven para nada porque esos trials no se
// van a re-marcar.
//
// Correr cuando la lista de propiedades vuelva a crecer de más.
function limpiarMarcasViejas() {
  const props = PropertiesService.getScriptProperties();
  const todas = props.getProperties();
  const corte = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let borradas = 0;

  for (const key in todas) {
    const esMarca = key.indexOf('onb_hecho_') === 0 || key.indexOf('slack_hecho_') === 0;
    if (!esMarca) continue;

    // El valor de onb_hecho_ es un timestamp; el de slack_hecho_ es '1'. Las
    // que no traen fecha se borran igual: son marcas de control sin utilidad
    // una vez pasado el trial.
    const val = parseInt(todas[key], 10);
    if (!isNaN(val) && val > corte) continue; // reciente, se conserva

    props.deleteProperty(key);
    borradas++;
  }

  Logger.log('Marcas borradas: ' + borradas);
}

// Prueba manual: correr desde el editor para verificar que el webhook y el
// formato funcionan, sin tener que marcar un trial real.
function probarSlack() {
  enviarNotificacionSlack({
    row: 0,
    nombre: 'Prueba desde Apps Script',
    trabajo: 'Product Designer en una consultora',
    razon: 'Quiero triplicar mi salario y seguir creciendo profesionalmente',
    linkedin: 'linkedin.com/in/ejemplo',
    ingles: 'Intermedio',
  });
  Logger.log('Si no truena, el webhook funciona. Revisa el canal.');
}

// ─── WATCHDOG: alerta si el sheet se queda en silencio ────────────────────
// El 30 jul 2026 el registro de leads se cortó a las 2 PM y nadie se dio
// cuenta hasta el día siguiente. Esto corre en cada pasada de processQueue
// (cada 5 min) y manda un correo de alerta si lleva demasiado sin entrar un
// lead nuevo. No detecta pérdidas sueltas (un lead fallido entre muchos que
// sí entraron); para eso, comparar form_submit de GA4 contra las filas del
// sheet del mismo día.
// Umbral de 16 h: el silencio nocturno normal es de ~14 h (últimos leads
// ~8 PM, se reanudan ~9-10 AM), así que 5 h alarmaría en falso cada
// madrugada. Con 16 h las noches nunca alarman y un corte real de mediodía
// avisa a la mañana siguiente.
const SILENCIO_UMBRAL_MS   = 16 * 60 * 60 * 1000; // 16 h sin leads = alerta
const SILENCIO_REALERTA_MS = 6 * 60 * 60 * 1000;  // re-alertar máx cada 6 h

function vigilarSilencioDeLeads() {
  try {
    const sheet = getSheet(SHEET_NAME);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    const fecha = sheet.getRange(lastRow, COL_FECHA).getValue();
    if (!(fecha instanceof Date) || isNaN(fecha.getTime())) return;

    const silencio = Date.now() - fecha.getTime();
    if (silencio < SILENCIO_UMBRAL_MS) return;

    // No repetir la alerta en cada corrida mientras dure el silencio
    const props = PropertiesService.getScriptProperties();
    const ultima = Number(props.getProperty('ultima_alerta_silencio') || 0);
    if (Date.now() - ultima < SILENCIO_REALERTA_MS) return;

    const horas = Math.round((silencio / 3600000) * 10) / 10;
    GmailApp.sendEmail(
      FROM_EMAIL,
      'Sin leads nuevos en el sheet desde hace ' + horas + ' horas',
      'El último registro en "' + SHEET_NAME + '" es de: ' + fecha + '\n\n' +
      'Puede ser tráfico bajo real, pero si las campañas están activas, revisa en orden:\n' +
      '1. GA4 -> Eventos -> form_submit: ¿hay submits recientes que no llegaron al sheet?\n' +
      '2. Apps Script -> Ejecuciones: ¿doGet está marcando errores?\n' +
      '3. Meta Ads Manager: ¿las campañas siguen entregando?\n\n' +
      '(Alerta automática del watchdog en processQueue. Se repite máximo cada 6 horas mientras siga el silencio.)'
    );
    props.setProperty('ultima_alerta_silencio', String(Date.now()));
  } catch (err) {
    // El watchdog jamás debe tumbar processQueue: si falla, solo se loguea.
    console.error('vigilarSilencioDeLeads falló: ' + err);
  }
}

// Appends a note to the Estatus cell instead of overwriting it, so the
// email-sequence status and the WhatsApp status don't clobber each other.
function agregarEstatus(sheet, row, nota) {
  const cell = sheet.getRange(row, COL_ESTATUS);
  const actual = cell.getValue().toString().trim();
  cell.setValue(actual ? actual + ' | ' + nota : nota);
}

// ─── WHATSAPP (Cloud API) ─────────────────────────────────────────────────

// Sends the approved "nw_bienvenida_lead" template to a new lead.
// La plantilla no tiene variables, así que el payload no lleva parameters.
function enviarPlantillaWhatsapp(nombre, whatsapp) {
  const props = PropertiesService.getScriptProperties();
  const token         = props.getProperty('WA_TOKEN');
  const phoneNumberId = props.getProperty('WA_PHONE_NUMBER_ID');
  if (!token || !phoneNumberId) throw new Error('Faltan WA_TOKEN / WA_PHONE_NUMBER_ID en Script Properties');

  const to = normalizarNumero(whatsapp);

  const payload = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'template',
    template: {
      name: WA_TEMPLATE_NAME,
      language: { code: WA_TEMPLATE_LANG },
    },
  };

  const resp = UrlFetchApp.fetch(
    'https://graph.facebook.com/v21.0/' + phoneNumberId + '/messages',
    {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    }
  );

  const code = resp.getResponseCode();
  if (code >= 300) throw new Error('WhatsApp API ' + code + ': ' + resp.getContentText());
}

// Strips non-digit characters and ensures the Mexico country code (52) is present.
// El "1" después del 52 se quita: mucha gente escribe su número como
// +52 1 55..., pero la Cloud API espera 52 + los 10 dígitos. Sin esto el envío
// falla o va a un número distinto al que luego contesta por WhatsApp, y el bot
// no encuentra el contexto del lead (que se guarda ya sin ese "1").
function normalizarNumero(numero) {
  let digits = numero.toString().replace(/\D/g, '');
  if (digits.length === 10) digits = '52' + digits; // bare 10-digit MX number
  if (digits.startsWith('521') && digits.length === 13) {
    digits = '52' + digits.slice(3);
  }
  return digits;
}

function isTrialOrPaid(sheet, rowNumber) {
  const estatus = sheet.getRange(rowNumber, COL_ESTATUS).getValue().toString().toLowerCase();
  return estatus.includes('pago') || estatus.includes('trial');
}

// ─── EMAIL 1 — 2 minutos ──────────────────────────────────────────────────

function sendEmail1(nombre, correo) {
  const firstName = nombre.split(' ')[0] || 'hola';
  const subject = 'Llenaste nuestro formulario. Te queremos en Newave.';
  const utmUrl1 = SKOOL_URL + '?utm_source=email&utm_medium=registro&utm_campaign=email1';

  const html = `
<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222;">
  <p style="margin:0 0 16px">Hola ${firstName},</p>
  <p style="margin:0 0 16px">Soy Santiago, cofundador de Newave.</p>
  <p style="margin:0 0 16px">Vimos que llenaste nuestro formulario porque quieres conseguir un trabajo remoto.</p>
  <p style="margin:0 0 16px">No sé qué te frenó para entrar, pero quiero invitarte a probar Newave durante 7 días gratis.</p>
  <p style="margin:0 0 16px">Dentro tienes todo lo que necesitas para conseguir tu trabajo remoto: nuestra metodología, herramientas, comunidad, acompañamiento y vacantes remotas.</p>
  <p style="margin:0 0 16px"><a href="${utmUrl1}">Entrar a Newave</a></p>
  <p style="margin:0 0 16px">Nos vemos dentro.</p>
  <p style="margin:0">Santiago<br><strong>Co-Founder, NEWAVE</strong></p>
</div>`;

  GmailApp.sendEmail(correo, subject, '', { name: FROM_NAME, replyTo: FROM_EMAIL, htmlBody: html });
}

// ─── EMAIL 2 — 24 horas ───────────────────────────────────────────────────

function sendEmail2(nombre, correo) {
  const firstName = nombre.split(' ')[0] || 'hola';
  const subject = 'Mandar más CVs no siempre funciona';
  const utmUrl2 = SKOOL_URL + '?utm_source=email&utm_medium=followup&utm_campaign=email2';

  const html = `
<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222;">
  <p style="margin:0 0 16px">Hay algo que veo todo el tiempo.</p>
  <p style="margin:0 0 16px">Personas con buenos perfiles que llevan semanas aplicando y no reciben respuestas.</p>
  <p style="margin:0 0 16px">Entonces hacen lo lógico: aplican todavía más.</p>
  <p style="margin:0 0 16px">Pero ${firstName}, si algo no está funcionando, mandar otras 50 aplicaciones probablemente no lo va a arreglar.</p>
  <p style="margin:0 0 16px">A veces el problema es tu CV.<br>A veces estás buscando los puestos equivocados.<br>A veces estás buscando en los lugares equivocados.</p>
  <p style="margin:0 0 16px">Y muchas veces simplemente no estás comunicando bien lo que sabes hacer.</p>
  <p style="margin:0 0 16px">Antes de aplicar más, hay que entender qué está fallando.</p>
  <p style="margin:0 0 16px">Eso es gran parte de lo que hacemos en Newave.</p>
  <p style="margin:0 0 16px"><a href="${utmUrl2}">Ver cómo funciona</a></p>
  <p style="margin:0">Santiago</p>
</div>`;

  GmailApp.sendEmail(correo, subject, '', { name: FROM_NAME, replyTo: FROM_EMAIL, htmlBody: html });
}

// ─── EMAIL 3 — 2 días (caso de éxito) ─────────────────────────────────────

function sendEmail3(nombre, correo) {
  const firstName = nombre.split(' ')[0] || 'hola';
  const subject = 'Lo primero que le dijeron fue sobre su CV';
  const utmUrl3 = SKOOL_URL + '?utm_source=email&utm_medium=followup&utm_campaign=email3';

  const html = `
<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222;">
  <p style="margin:0 0 16px">Uno de nuestros miembros llevaba alrededor de dos meses buscando trabajo.</p>
  <p style="margin:0 0 16px">Terminó consiguiendo una posición de ADR en Samsara.</p>
  <p style="margin:0 0 16px">Pero hay una parte de su historia que me encanta.</p>
  <p style="margin:0 0 16px">Cuando llegó a una de sus entrevistas, el CCO de México le dijo:</p>
  <p style="margin:0 0 16px;border-left:2px solid #d0d0d0;padding-left:14px;color:#555555;">"Estoy viendo tu currículum y definitivamente tienes una gran habilidad de comunicar. Tengo muy claro todos tus logros."</p>
  <p style="margin:0 0 16px">Había trabajado su CV con la metodología y el acompañamiento de Newave.</p>
  <p style="margin:0 0 16px">Y ese es un error que veo muchísimo, ${firstName}.</p>
  <p style="margin:0 0 16px">Puedes tener 5, 10 o 15 años de experiencia.</p>
  <p style="margin:0 0 16px">Pero si una empresa tarda 20 segundos en ver tu CV y no entiende qué has logrado, esa experiencia sirve de poco.</p>
  <p style="margin:0 0 16px">No siempre necesitas más experiencia. A veces necesitas aprender a comunicar mejor la que ya tienes.</p>
  <p style="margin:0 0 16px"><a href="${utmUrl3}">Entrar a Newave</a></p>
  <p style="margin:0">Santiago</p>
</div>`;

  GmailApp.sendEmail(correo, subject, '', { name: FROM_NAME, replyTo: FROM_EMAIL, htmlBody: html });
}

// ─── EMAIL 4 — 4 días ─────────────────────────────────────────────────────

function sendEmail4(nombre, correo) {
  const firstName = nombre.split(' ')[0] || 'hola';
  const subject = '¿Mi perfil aplica?';
  const utmUrl4 = SKOOL_URL + '?utm_source=email&utm_medium=followup&utm_campaign=email4';

  const html = `
<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222;">
  <p style="margin:0 0 16px">Esta probablemente es una de las preguntas que más recibimos.</p>
  <p style="margin:0 0 16px">"¿Pero esto funciona para mi perfil?"</p>
  <p style="margin:0 0 16px">Hemos visto abogados, ingenieros, marketers, gente de ventas, finanzas, operaciones y hospitality.</p>
  <p style="margin:0 0 16px">Todos buscando lo mismo: trabajar para una empresa internacional sin estar atados a una oficina.</p>
  <p style="margin:0 0 16px">El trabajo remoto no es una profesión. Es una forma de trabajar.</p>
  <p style="margin:0 0 16px">Lo importante, ${firstName}, es entender qué habilidades de tu experiencia pueden competir en ese mercado y aprender a comunicarlas correctamente.</p>
  <p style="margin:0 0 16px">Eso es lo que te ayudamos a hacer.</p>
  <p style="margin:0 0 16px"><a href="${utmUrl4}">Probar Newave 7 días gratis</a></p>
  <p style="margin:0">Santiago</p>
</div>`;

  GmailApp.sendEmail(correo, subject, '', { name: FROM_NAME, replyTo: FROM_EMAIL, htmlBody: html });
}

// ─── EMAIL 5 — 6 días (última llamada) ────────────────────────────────────

function sendEmail5(nombre, correo) {
  const firstName = nombre.split(' ')[0] || 'hola';
  const subject = 'Esto es lo último que te escribo';
  const utmUrl5 = SKOOL_URL + '?utm_source=email&utm_medium=followup&utm_campaign=email5';

  const html = `
<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222;">
  <p style="margin:0 0 16px">Hola ${firstName},</p>
  <p style="margin:0 0 16px">Este es el último correo que te mando sobre esto.</p>
  <p style="margin:0 0 16px">Hace días diste un paso: llenaste el formulario porque algo te dijo que querías cambiar tu situación.</p>
  <p style="margin:0 0 16px">Trabajar remoto.<br>Ganar en dólares.<br>Tener más libertad.</p>
  <p style="margin:0 0 16px">Esa razón sigue ahí.</p>
  <p style="margin:0 0 16px">La pregunta es si vas a hacer algo al respecto o lo vas a dejar pasar otra vez.</p>
  <p style="margin:0 0 16px">Newave sigue abierto para ti. 7 días gratis, sin compromiso. Lo único que tienes que hacer es entrar.</p>
  <p style="margin:0 0 16px"><a href="${utmUrl5}">Entrar a Newave</a></p>
  <p style="margin:0 0 16px">Si decides que no es tu momento, lo entiendo.</p>
  <p style="margin:0 0 16px">Pero si tu meta sigue siendo trabajar remoto para una empresa internacional, este es tu mejor camino.</p>
  <p style="margin:0 0 16px">Tú decides.</p>
  <p style="margin:0">Santiago<br><strong>Co-Founder, NEWAVE</strong></p>
</div>`;

  GmailApp.sendEmail(correo, subject, '', { name: FROM_NAME, replyTo: FROM_EMAIL, htmlBody: html });
}

// ─── ONBOARDING 1 — 1 hora después de marcar el trial ─────────────────────

function sendOnboarding1(nombre, correo) {
  const firstName = nombre.split(' ')[0] || '';
  // El nombre va en el asunto, pero hay registros con iniciales o basura en
  // ese campo. Sin nombre el asunto queda 'Ya estás dentro' a secas, que se
  // lee bien igual.
  const subject = firstName ? ('Ya estás dentro, ' + firstName) : 'Ya estás dentro';
  // Link directo al Módulo 1, no al classroom completo: un click menos entre
  // el correo y empezar. El `md=` es el módulo dentro del curso, así que el
  // UTM va con & y no con ? — la URL ya trae query string.
  const urlModulo = 'https://www.skool.com/newave/classroom/ec6bce91?md=bcb08855563a4dc6bf4205c7c59e31b8'
    + '&utm_source=email&utm_medium=onboarding&utm_campaign=onb1';

  const html = `
<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222;">
  <p style="margin:0 0 16px">${firstName ? firstName + ', ya' : 'Ya'} estás dentro.</p>
  <p style="margin:0 0 16px">Ahora sí empieza el proceso.</p>
  <p style="margin:0 0 16px">Te mandé un mensaje directo dentro de Newave. Respóndeme por ahí para saber que ya pudiste entrar.</p>
  <p style="margin:0 0 16px">Después haz dos cosas:</p>
  <p style="margin:0 0 8px"><strong>1. Preséntate en el post de bienvenida.</strong></p>
  <p style="margin:0 0 16px">Cuéntanos de dónde eres, a qué te dedicas y qué quieres conseguir con un trabajo remoto.</p>
  <p style="margin:0 0 16px"><a href="${POST_BIENVENIDA_URL}">Presentarme</a></p>
  <p style="margin:0 0 8px"><strong>2. Empieza hoy el Módulo 1.</strong></p>
  <p style="margin:0 0 16px">Es muy importante que empieces. No lo dejes para después porque probablemente no regreses.</p>
  <p style="margin:0 0 16px"><a href="${urlModulo}">Ir al Módulo 1</a></p>
  <p style="margin:0 0 16px">Todo lo que necesitas para conseguir tu trabajo remoto está dentro de Newave. Solo tienes que seguir el curso y aplicar lo que vas aprendiendo.</p>
  <p style="margin:0 0 16px">Nos vemos dentro.</p>
  <p style="margin:0">Jaime</p>
</div>`;

  GmailApp.sendEmail(correo, subject, '', { name: FROM_NAME, replyTo: FROM_EMAIL, htmlBody: html });
}

// ─── SHEET SETUP ──────────────────────────────────────────────────────────

function getSheet(name) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    // Deben coincidir con los del sheet real y en el mismo orden: COL_ESTATUS
    // (12), COL_CLICK (13), COL_CORREO_AL_CONVERTIR (14) y COL_FUENTE (15)
    // están hardcodeadas por número. Este bloque solo corre si la hoja no
    // existe, pero si algún día se recrea, el orden tiene que quedar igual.
    const headers = [
      'Fecha', 'Nombre', 'Correo', 'WhatsApp', 'LinkedIn',
      'Inglés', 'Trabajo actual', 'Razón del cambio',
      'Nivel de compromiso', 'Capacidad de inversión',
      'Interés en IA', 'Estatus', 'Click a Skool (Si /No) ',
      'En que correo convirtieron', 'Fuente',
    ];
    const headerRow = sheet.getRange(1, 1, 1, headers.length);
    headerRow.setValues([headers]);
    headerRow.setFontWeight('bold');
    headerRow.setBackground('#1a1f26');
    headerRow.setFontColor('#FC7342');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// Corre esta función una sola vez para forzar el prompt de autorización
// de UrlFetchApp (llamadas HTTP salientes, necesarias para WhatsApp).
function autorizarUrlFetch() {
  const resp = UrlFetchApp.fetch('https://www.google.com', { muteHttpExceptions: true });
  Logger.log('OK, código: ' + resp.getResponseCode());
}

// Borra todas las claves wa_ pendientes (limpieza de pruebas viejas).
function limpiarColaWhatsapp() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  let borradas = 0;
  for (const key in all) {
    if (key.indexOf('wa_') === 0) {
      props.deleteProperty(key);
      borradas++;
    }
  }
  Logger.log('Borradas ' + borradas + ' claves wa_');
}

function diagnostico() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const waKeys = Object.keys(all).filter(k => k.indexOf('wa_') === 0);
  Logger.log('Total properties: ' + Object.keys(all).length);
  Logger.log('Claves wa_: ' + JSON.stringify(waKeys));

  const sheet = getSheet(SHEET_NAME);
  const lastRow = sheet.getLastRow();
  Logger.log('Última fila del sheet: ' + lastRow);
  const rowData = sheet.getRange(lastRow, 1, 1, 13).getValues()[0];
  Logger.log('Datos última fila: ' + JSON.stringify(rowData));
}
const TRIALS_SKOOL = {
  'vero.salinas.garza@gmail.com':1785830777, 'jmartingranja@gmail.com':1785823182, 'josecarlos100991@icloud.com':1785821717,
  'richard310885@gmail.com':1785813653, 'melissa.cassiog@gmail.com':1785811107, 'regina.ardavin98@gmail.com':1785804191,
  'nayeliivette@hotmail.com':1785802287, 'karolinmoya@gmail.com':1785723132, 'edbarrientosc17@gmail.com':1785638911,
  'anahislegaspi@gmail.com':1785625793, 'andresfletcherg@gmail.com':1785617511, 'dafneballeza@outlook.com':1785578182,
  'aaguioli@gmail.com':1785571896, 'jairberpos@gmail.com':1785553590, 'hectrdd@gmail.com':1785490642,
  'jorgeandresnegretemorayta@gmail.com':1785393910, 'gerardores202@gmail.com':1785379675, 'jp_jasso@hotmail.com':1785372761,
  'aguirre.somera@gmail.com':1785304087, 'nicole.abbud@hotmail.com':1785209392, 'al.mosqueradavid@gmail.com':1785198277,
  'alvaropgordon@gmail.com':1785045164, 'sebmarmolejo12@gmail.com':1784932980, 'jromo.mgmt@gmail.com':1784864752,
  'daniela.san@hotmail.es':1784760993, 'bettytrujillo@live.com':1784614865, 'gera.ledesma.ramos@gmail.com':1784614422,
  'danielafocilnavarro@gmail.com':1784256785, 'andrepe26@gmail.com':1784178541, 'adrian.toledanog@gmail.com':1784177019,
  'rocio.abad@icloud.com':1784146048, 'reginamujicaruiz@hotmail.com':1784098581, 'psnchzb@gmail.com':1784078098,
  'fernandarasu@outlook.com':1784063319, 'diegogdelag@gmail.com':1783983305, 'leonardosuarezromero@gmail.com':1783930249,
  'santirosetel@gmail.com':1783734027, 'avalosmezam@gmail.com':1783574268, 'mfgarciaochoa@gmail.com':1783570361,
  'talledo.ricardo@gmail.com':1783544821, 'blanca.yocelyn@gmail.com':1783491513, 'janjanp78@gmail.com':1783386731,
  'andrea.diazza444@gmail.com':1783381273, 'marianacaraveo1@gmail.com':1783299641, 'dianasoes@hotmail.com':1783119558,
  'jportega145@gmail.com':1783063707, 'majozetunaa@gmail.com':1783052486, 'jhdealbaf@gmail.com':1782992563,
  'anavaleriacastaneda@gmail.com':1782949586, 'lucichandrea@gmail.com':1782868632, 'ara.s.peralta@gmail.com':1782790414,
  'blam1233@gmail.com':1782789580, 'canalespaloma@gmail.com':1782618571, 'sergiorojasbroker@gmail.com':1782540850,
  'humandesignbypaola@gmail.com':1782536401, 'lucianasv001@gmail.com':1782469353, 'mildredp1526@gmail.com':1782357435,
  'fer.lagunesgt@gmail.com':1782349618, 'victor.rezae@gmail.com':1782335545, 'cami12parra@gmail.com':1782328670,
  'danielmartinezdecastroc@gmail.com':1782267761, 'paola.herediahernandez@gmail.com':1782259884, 'emanuel.martinez@outlook.com':1782180280,
  'aldopancaaz@gmail.com':1782176090, 'drajenniferjackson@gmail.com':1782112062, 'jorgemenapicon@hotmail.com':1782082147,
  'kmrescalera@gmail.com':1781936437, 'carmen.castrejon@proton.me':1781897039, 'brenrcarcao@gmail.com':1781772399,
  'victormpartida@gmail.com':1781672131, 'raulgarsegovia@gmail.com':1781668532, 'asofia_lozano@hotmail.com':1781580142,
  'jledesma4@live.com.mx':1781559282, 'annachie@gmail.com':1781509528, 'santoselav.96@gmail.com':1781410073,
  'dannielafome@gmail.com':1781241430, 'dortegafrau@gmail.com':1781133160, 'janinehdzv@gmail.com':1781123107,
  'danielajmzn@gmail.com':1781120194, 'luciana.barbag@gmail.com':1780998597, 'alexlopezfut99@gmail.com':1780995636,
  'morettoaltamiranovaleria@outlook.com':1780956979, 'belen.pelop@gmail.com':1780730870, 'ortegakaryme@gmail.com':1780621582,
  'gabslb81@gmail.com':1780556759, 'mejiacastillo696@gmail.com':1780556202, 'anaguayabas@gmail.com':1780486387,
};

// Calcula en qué correo iba REALMENTE cada persona al entrar a Skool,
// cruzando la fecha de registro del sheet con la fecha de alta de Skool.
// Sin deducir nada: son las dos fechas reales.
function calcularCorreoRealAlConvertir() {
  const sheet = getSheet(SHEET_NAME);
  const lastRow = sheet.getLastRow();
  const datos = sheet.getRange(2, 1, lastRow - 1, COL_CORREO_AL_CONVERTIR).getValues();

  const conteo = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let cruzados = 0, sinRegistro = 0;
  const ejemplos = [];

  // Del sheet: el registro más antiguo de cada correo (el original)
  const registroPorCorreo = {};
  datos.forEach(function (fila, i) {
    const correo = (fila[COL_CORREO - 1] || '').toString().trim().toLowerCase();
    const fecha = fila[COL_FECHA - 1];
    if (!correo || !(fecha instanceof Date) || isNaN(fecha.getTime())) return;
    if (!registroPorCorreo[correo] || fecha < registroPorCorreo[correo].fecha) {
      registroPorCorreo[correo] = { fecha: fecha, filaIdx: i };
    }
  });

  for (const correo in TRIALS_SKOOL) {
    const reg = registroPorCorreo[correo];
    if (!reg) { sinRegistro++; continue; }

    const msTrial = TRIALS_SKOOL[correo] * 1000;
    const transcurrido = msTrial - reg.fecha.getTime();
    if (transcurrido < 0) { sinRegistro++; continue; }

    const n = correosEnviadosAl(transcurrido);
    conteo[n]++;
    cruzados++;

    sheet.getRange(reg.filaIdx + 2, COL_CORREO_AL_CONVERTIR).setValue(n);

    if (ejemplos.length < 10) {
      const horas = Math.round(transcurrido / 3600000 * 10) / 10;
      ejemplos.push(correo.slice(0, 30) + '  ' + horas + 'h despues  -> correo ' + n);
    }
  }

  Logger.log('=== EJEMPLOS ===');
  ejemplos.forEach(function (e) { Logger.log(e); });
  Logger.log('');
  Logger.log('=== EN QUE CORREO IBAN AL ENTRAR A SKOOL ===');
  const etiquetas = { 0: 'Sin correo aun', 1: 'Correo 1', 2: 'Correo 2', 3: 'Correo 3', 4: 'Correo 4', 5: 'Correo 5' };
  for (let n = 0; n <= 5; n++) {
    const pct = cruzados ? Math.round(conteo[n] / cruzados * 100) : 0;
    Logger.log(etiquetas[n] + ': ' + conteo[n] + '  (' + pct + '%)  ' + '#'.repeat(Math.round(pct / 2)));
  }
  Logger.log('');
  Logger.log('Cruzados con exito: ' + cruzados);
  Logger.log('Sin registro en el sheet: ' + sinRegistro + ' (entraron por otra via)');
}
