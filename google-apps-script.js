// ============================================================
// Google Apps Script - Vehicle Licensing API
// העתק את כל הקוד הזה לתוך Google Apps Script
// ============================================================

const SHEET_NAME = 'להדפסה';
const DEF_SHEET_NAME = 'ליקויים';

// ============================================================
// Migration: Run this ONCE to update sheet columns
// In Apps Script editor: Run > migrateColumns
// ============================================================

function migrateColumns() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) { Logger.log('Sheet not found: ' + SHEET_NAME); return; }

  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  // Check if migration already done
  if (headers.includes('יצרן רכב') || headers.includes('manufacturer')) {
    Logger.log('Migration already applied. Skipping.');
    return;
  }

  // Add new column headers at end (after appSynced which is col 15)
  const newHeaders = ['תסקיר רמפה/מנוף', 'יצרן רכב', 'משקל כולל', 'מספר ק״מ', 'מורשה חומ״ס'];
  const startCol = lastCol + 1;
  sheet.getRange(1, startCol, 1, newHeaders.length).setValues([newHeaders]);

  // Rename brakeTestExpiry header
  for (let i = 0; i < headers.length; i++) {
    if (headers[i] === 'בדיקת בלמים') {
      sheet.getRange(1, i + 1).setValue('אישור בלמים חצי שנתי');
      break;
    }
  }

  Logger.log('Migration complete! 5 new columns added, brakeTestExpiry renamed. Old columns kept for compatibility.');
}

// Column mapping (0-based index)
const COLS = {
  customerName: 0,
  location: 1,
  licenseNumber: 2,
  vehicleType: 3,
  licenseExpiry: 4,
  mandatoryInsurance: 5,
  calibrationExpiry: 6,
  brakeTestExpiry: 7,
  carrierLicense: 8,
  inspectionDate: 9,
  contactName: 10,
  contactPhone: 11,
  appSynced: 12,
  rampCraneInspection: 13,
  manufacturer: 14,
  totalWeight: 15,
  mileage: 16,
  hazmatCertified: 17
};

// ============================================================
// HTTP Handlers
// ============================================================

function ensureAppSyncedColumn() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) return;
  const header = sheet.getRange(1, COLS.appSynced + 1).getValue();
  if (!header) {
    sheet.getRange(1, COLS.appSynced + 1).setValue('appSynced');
  }
}

function doGet(e) {
  try {
    const action = e.parameter.action || 'getData';

    if (action === 'getData') {
      ensureAppSyncedColumn();
      return jsonResponse(getAllVehicles());
    }
    if (action === 'getSheetName') {
      return jsonResponse({ status: 'ok', name: SpreadsheetApp.getActiveSpreadsheet().getName() });
    }
    if (action === 'getDeficiencies') {
      return jsonResponse(getAllDeficiencies());
    }

    // Write operations via GET (to avoid CORS issues with POST)
    if (action === 'updateRecord') {
      const record = JSON.parse(e.parameter.data);
      return jsonResponse(updateVehicle(record));
    }
    if (action === 'addRecord') {
      const record = JSON.parse(e.parameter.data);
      return jsonResponse(addVehicle(record));
    }
    if (action === 'deleteRecord') {
      return jsonResponse(deleteVehicle(e.parameter.licenseNumber));
    }
    if (action === 'saveDeficiency') {
      const defs = JSON.parse(e.parameter.data);
      return jsonResponse(saveDeficiency(e.parameter.licenseNumber, defs));
    }
    if (action === 'updateAppSync') {
      return jsonResponse(updateAppSync(e.parameter.licenseNumber, e.parameter.value));
    }

    return jsonResponse({ error: 'Unknown action' });
  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const action = payload.action;

    if (action === 'updateRecord') {
      return jsonResponse(updateVehicle(payload.record));
    }
    if (action === 'addRecord') {
      return jsonResponse(addVehicle(payload.record));
    }
    if (action === 'deleteRecord') {
      return jsonResponse(deleteVehicle(payload.licenseNumber));
    }
    if (action === 'saveDeficiency') {
      return jsonResponse(saveDeficiency(payload.licenseNumber, payload.deficiencies));
    }

    return jsonResponse({ error: 'Unknown action: ' + action });
  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// Read All Vehicles
// ============================================================

function getAllVehicles() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) return { error: 'Sheet not found: ' + SHEET_NAME };

  const data = sheet.getDataRange().getValues();
  const records = [];

  // Skip header row (row 0)
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[COLS.customerName] && !row[COLS.licenseNumber]) continue; // skip empty rows

    records.push({
      id: String(row[COLS.licenseNumber]),
      rowIndex: i + 1, // 1-based row number in sheet
      customerName: String(row[COLS.customerName] || ''),
      location: String(row[COLS.location] || ''),
      licenseNumber: String(row[COLS.licenseNumber] || ''),
      vehicleType: String(row[COLS.vehicleType] || ''),
      licenseExpiry: formatDateValue(row[COLS.licenseExpiry]),
      mandatoryInsurance: formatDateValue(row[COLS.mandatoryInsurance]),
      calibrationExpiry: formatDateValue(row[COLS.calibrationExpiry]),
      brakeTestExpiry: formatDateValue(row[COLS.brakeTestExpiry]),
      carrierLicense: formatDateValue(row[COLS.carrierLicense]),
      inspectionDate: formatDateValue(row[COLS.inspectionDate]),
      contactName: String(row[COLS.contactName] || ''),
      contactPhone: String(row[COLS.contactPhone] || ''),
      appSynced: String(row[COLS.appSynced] || ''),
      rampCraneInspection: formatDateValue(row[COLS.rampCraneInspection]),
      manufacturer: String(row[COLS.manufacturer] || ''),
      totalWeight: String(row[COLS.totalWeight] || ''),
      mileage: String(row[COLS.mileage] || ''),
      hazmatCertified: String(row[COLS.hazmatCertified] || '')
    });
  }

  return { status: 'ok', data: records };
}

// ============================================================
// Update Vehicle
// ============================================================

function updateVehicle(record) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);

  // Find row by license number (use original if license was changed)
  const lookupKey = record.originalLicenseNumber || record.licenseNumber || record.id;
  const rowIndex = findRowByLicense(sheet, lookupKey);
  if (rowIndex === -1) {
    return { error: 'Record not found: ' + (record.licenseNumber || record.id) };
  }

  // Update the row
  const rowData = [
    record.customerName || '',
    record.location || '',
    record.licenseNumber || '',
    record.vehicleType || '',
    parseDateString(record.licenseExpiry),
    parseDateString(record.mandatoryInsurance),
    parseDateString(record.calibrationExpiry),
    parseDateString(record.brakeTestExpiry),
    parseDateString(record.carrierLicense),
    parseDateString(record.inspectionDate),
    record.contactName || '',
    record.contactPhone || '',
    record.appSynced || '',
    parseDateString(record.rampCraneInspection),
    record.manufacturer || '',
    record.totalWeight || '',
    record.mileage || '',
    record.hazmatCertified || ''
  ];

  sheet.getRange(rowIndex, 1, 1, rowData.length).setValues([rowData]);

  return { status: 'ok', message: 'Updated' };
}

function updateAppSync(licenseNumber, value) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  const rowIndex = findRowByLicense(sheet, licenseNumber);
  if (rowIndex === -1) return { error: 'Record not found: ' + licenseNumber };
  sheet.getRange(rowIndex, COLS.appSynced + 1).setValue(value);
  return { status: 'ok', message: 'Sync updated' };
}

// ============================================================
// Add Vehicle
// ============================================================

function addVehicle(record) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);

  const rowData = [
    record.customerName || '',
    record.location || '',
    record.licenseNumber || '',
    record.vehicleType || '',
    parseDateString(record.licenseExpiry),
    parseDateString(record.mandatoryInsurance),
    parseDateString(record.calibrationExpiry),
    parseDateString(record.brakeTestExpiry),
    parseDateString(record.carrierLicense),
    parseDateString(record.inspectionDate),
    record.contactName || '',
    record.contactPhone || '',
    '',
    parseDateString(record.rampCraneInspection),
    record.manufacturer || '',
    record.totalWeight || '',
    record.mileage || '',
    record.hazmatCertified || ''
  ];

  sheet.appendRow(rowData);

  return { status: 'ok', message: 'Added' };
}

// ============================================================
// Delete Vehicle
// ============================================================

function deleteVehicle(licenseNumber) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);

  const rowIndex = findRowByLicense(sheet, licenseNumber);
  if (rowIndex === -1) {
    return { error: 'Record not found: ' + licenseNumber };
  }

  sheet.deleteRow(rowIndex);

  return { status: 'ok', message: 'Deleted' };
}

// ============================================================
// Deficiencies (stored in a separate sheet)
// ============================================================

function getAllDeficiencies() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(DEF_SHEET_NAME);

  if (!sheet) {
    // Create deficiencies sheet if it doesn't exist
    sheet = ss.insertSheet(DEF_SHEET_NAME);
    sheet.appendRow(['רישוי', 'תיאור', 'סטטוס', 'תאריך יצירה', 'תאריך טיפול']);
    return { status: 'ok', data: {} };
  }

  const data = sheet.getDataRange().getValues();
  const defMap = {};

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const license = String(row[0]);
    if (!license) continue;

    if (!defMap[license]) defMap[license] = [];
    defMap[license].push({
      id: String(i),
      description: String(row[1] || ''),
      status: String(row[2] || 'open'),
      createdAt: String(row[3] || ''),
      resolvedAt: String(row[4] || '')
    });
  }

  return { status: 'ok', data: defMap };
}

function saveDeficiency(licenseNumber, deficiencies) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(DEF_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(DEF_SHEET_NAME);
    sheet.appendRow(['רישוי', 'תיאור', 'סטטוס', 'תאריך יצירה', 'תאריך טיפול']);
  }

  // Remove old deficiencies for this license
  const data = sheet.getDataRange().getValues();
  const rowsToDelete = [];
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]) === String(licenseNumber)) {
      rowsToDelete.push(i + 1);
    }
  }
  // Delete from bottom up to preserve row indices
  rowsToDelete.forEach(row => sheet.deleteRow(row));

  // Add new deficiencies
  if (deficiencies && deficiencies.length > 0) {
    deficiencies.forEach(def => {
      sheet.appendRow([
        licenseNumber,
        def.description || '',
        def.status || 'open',
        def.createdAt || '',
        def.resolvedAt || ''
      ]);
    });
  }

  return { status: 'ok', message: 'Deficiencies saved' };
}

// ============================================================
// Helper Functions
// ============================================================

function findRowByLicense(sheet, licenseNumber) {
  const data = sheet.getDataRange().getValues();
  const target = String(licenseNumber);
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][COLS.licenseNumber]) === target) {
      return i + 1; // 1-based row
    }
  }
  return -1;
}

function formatDateValue(val) {
  if (!val) return '';
  if (val instanceof Date) {
    // Use spreadsheet timezone to avoid off-by-one errors
    const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
    return Utilities.formatDate(val, tz, 'yyyy-MM-dd');
  }
  const s = String(val);
  if (s === '00/00/00' || s === '0') return '';
  if (s.includes('/')) {
    const parts = s.split('/');
    if (parts.length === 3) {
      return `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
    }
  }
  return s;
}

function parseDateString(dateStr) {
  if (!dateStr) return '';
  // Input format: YYYY-MM-DD
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    // Create date at noon to avoid timezone day-shift issues
    return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 12, 0, 0);
  }
  return dateStr;
}
