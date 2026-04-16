// ============================================================
// NEWAVE Academy — Trabajos del Futuro — Registro a Google Sheets
// ============================================================
// 1. Ve a https://script.google.com y crea un nuevo proyecto
// 2. Pega todo este codigo
// 3. Click "Implementar" > "Nueva implementacion"
//    - Tipo: Aplicacion web
//    - Ejecutar como: Yo
//    - Quien puede acceder: Cualquier usuario
// 4. Copia la URL y pegala en trabajosdelfuturo/index.html
//    en la variable APPS_SCRIPT_URL
// ============================================================

const SHEET_ID   = '1RcSCr7Z1hOhvOlcJA4zJIAjAdHnSdDq0yvSX6Xcazbw';
const SHEET_NAME = 'Registros';

function doGet(e) {
  try {
    const ss  = SpreadsheetApp.openById(SHEET_ID);
    let sheet = ss.getSheetByName(SHEET_NAME);

    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
      sheet.appendRow(['Fecha', 'Nombre', 'Email', 'WhatsApp', 'Interes', 'Webinar']);
      sheet.getRange(1, 1, 1, 6).setFontWeight('bold');
    }

    sheet.appendRow([
      new Date(),
      e.parameter.nombre   || '',
      e.parameter.email    || '',
      e.parameter.whatsapp || '',
      e.parameter.buscando || '',
      e.parameter.webinar  || '',
    ]);

    const callback = e.parameter.callback || 'callback';
    return ContentService
      .createTextOutput(callback + '(' + JSON.stringify({ ok: true }) + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);

  } catch (err) {
    const callback = e.parameter.callback || 'callback';
    return ContentService
      .createTextOutput(callback + '(' + JSON.stringify({ ok: false, error: err.message }) + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
}
