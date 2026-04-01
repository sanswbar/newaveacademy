// ============================================================
// NEWAVE Academy — Webinar Registration to Google Sheets
// ============================================================
// INSTRUCCIONES:
// 1. Ve a https://script.google.com y crea un nuevo proyecto
// 2. Pega todo este codigo
// 3. Cambia SHEET_ID por el ID de tu Google Sheet (ver abajo)
// 4. Click en "Implementar" > "Nueva implementacion"
//    - Tipo: Aplicacion web
//    - Ejecutar como: Yo
//    - Quién puede acceder: Cualquier usuario
// 5. Copia la URL que te da y pegala en webinar/index.html
//    en la variable APPS_SCRIPT_URL
// ============================================================

// ID de tu Google Sheet
// Ejemplo: si tu Sheet esta en
//   https://docs.google.com/spreadsheets/d/1ABC123xyz.../edit
// entonces el ID es: 1ABC123xyz...
const SHEET_ID = 'TU_SHEET_ID_AQUI';
const SHEET_NAME = 'Registros'; // nombre de la pestaña

function doGet(e) {
  try {
    const ss    = SpreadsheetApp.openById(SHEET_ID);
    let sheet   = ss.getSheetByName(SHEET_NAME);

    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
      sheet.appendRow(['Fecha', 'Nombre', 'Email', 'WhatsApp', 'Webinar']);
      sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
    }

    sheet.appendRow([
      new Date(),
      e.parameter.nombre   || '',
      e.parameter.email    || '',
      e.parameter.whatsapp || '',
      e.parameter.webinar  || '',
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doPost(e) {
  return doGet(e);
}

// Funcion de prueba — ejecutala manualmente para verificar que funciona
function testInsert() {
  doPost({
    postData: {
      contents: JSON.stringify({
        nombre:   'Test Usuario',
        email:    'test@email.com',
        whatsapp: '+52 55 0000 0000',
        webinar:  'Webinar Gratuito NEWAVE',
      })
    }
  });
}
