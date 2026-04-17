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
      sheet.appendRow(['Fecha', 'Nombre', 'Email', 'Telefono', 'A que te dedicas', 'Ingles', 'Experiencia', 'Tipo de apoyo', 'Inversion previa', 'Inversion futura', 'Webinar']);
      sheet.getRange(1, 1, 1, 11).setFontWeight('bold');
    }

    sheet.appendRow([
      new Date(),
      e.parameter.nombre      || '',
      e.parameter.email       || '',
      e.parameter.telefono    || '',
      e.parameter.dedicas     || '',
      e.parameter.ingles      || '',
      e.parameter.experiencia || '',
      e.parameter.apoyo       || '',
      e.parameter.invertido   || '',
      e.parameter.invertirias || '',
      e.parameter.webinar     || '',
    ]);

    // JSONP: el callback evita el problema de CORS/redirect
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

// Funcion de prueba — ejecutala manualmente para verificar que funciona
function testInsert() {
  doGet({
    parameter: {
      nombre:      'Test Usuario',
      email:       'test@email.com',
      telefono:    '+52 55 0000 0000',
      dedicas:     'Marketing',
      ingles:      'Intermedio',
      experiencia: '3 a 5 años',
      apoyo:       'Estoy dispuesto a invertir en un programa si me demuestra resultados',
      invertido:   'Menos de 500 USD',
      invertirias: '199 a 499 USD',
      webinar:     'Webinar Gratuito NEWAVE',
    }
  });
}
