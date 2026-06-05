// ============================================================
// Vehicle Licensing Management App
// Connected to Google Sheets via Apps Script
// ============================================================

// ⚠️ IMPORTANT: Replace this URL after deploying your Google Apps Script
let APPS_SCRIPT_URL = localStorage.getItem('apps_script_url') || '';

// In-memory data cache
let _vehicleData = [];
let _deficiencyData = {};
let _isLoading = false;

// Work page sort state
let _workSort = { column: 'inspectionDate', direction: 'asc' };

// Default number of days before an expiry date that a field starts warning
const DEFAULT_EXPIRY_DAYS = 30;

// Default (built-in) labels in Hebrew
const DEFAULT_FIELD_LABELS = {
    licenseExpiry: 'תוקף רישוי',
    mandatoryInsurance: 'ביטוח חובה',
    calibrationExpiry: 'כיול',
    brakeTestExpiry: 'אישור בלמים חצי שנתי',
    carrierLicense: 'רשיון מוביל',
    rampCraneInspection: 'תסקיר רמפה/מנוף',
    winterInspection: 'בדיקת חורף',
    carrierLicenseSigned: 'נחתם רישיון מוביל עד'
};

const DATE_FIELDS = Object.keys(DEFAULT_FIELD_LABELS);

// ============================================================
// Card Template Configuration
//   expiryDays: per-field warning window (days)
//   labels:     label overrides for built-in date fields
//   customFields: user-added fields [{key,label,type,options,expiryDays}]
// ============================================================

let _config = { expiryDays: {}, labels: {}, customFields: [] };

function normalizeConfig(cfg) {
    cfg = cfg || {};
    return {
        expiryDays: cfg.expiryDays || {},
        labels: cfg.labels || {},
        fieldTypes: cfg.fieldTypes || {},   // built-in field type overrides
        fieldOptions: cfg.fieldOptions || {}, // built-in select options
        hidden: cfg.hidden || {},           // built-in fields hidden from the card
        customFields: Array.isArray(cfg.customFields) ? cfg.customFields : []
    };
}

// Effective type/options/visibility for a built-in date field
function builtinType(key) {
    return (_config.fieldTypes && _config.fieldTypes[key]) || 'date';
}
function builtinOptions(key) {
    return (_config.fieldOptions && _config.fieldOptions[key]) || [];
}
function isFieldHidden(key) {
    return !!(_config.hidden && _config.hidden[key]);
}

// Built-in date fields as full field descriptors (config overrides applied)
function templateDateFields() {
    return DATE_FIELDS.map(key => ({
        key,
        builtin: true,
        label: fieldLabel(key),
        type: builtinType(key),
        options: builtinOptions(key),
        expiryDays: getExpiryDays(key),
        hidden: isFieldHidden(key)
    }));
}

// Render a single card-field input (works for built-in and custom fields)
function cardFieldInput(field, value) {
    const name = field.builtin ? field.key : 'cf_' + field.key;
    value = value || '';
    if (field.type === 'date') {
        const status = getDateStatus(value, field.key);
        const tag = value ? ` <span class="date-${status} text-xs">(${statusLabel(status)})</span>` : '';
        return `<label>${escapeText(field.label)}${tag}</label>${dateFieldHtml(name, value)}`;
    }
    if (field.type === 'select') {
        const opts = (field.options || []).map(o =>
            `<option value="${escapeText(o)}" ${o === value ? 'selected' : ''}>${escapeText(o)}</option>`).join('');
        return `<label>${escapeText(field.label)}</label><select name="${name}"><option value="">-</option>${opts}</select>`;
    }
    return `<label>${escapeText(field.label)}</label><input type="text" name="${name}" value="${escapeText(value)}">`;
}

// Build the "validity dates" + "custom fields" section shared by add/edit forms
function templateFieldsHtml(record) {
    const r = record || {};
    let inner = templateDateFields().map(f => {
        const val = r[f.key] || '';
        if (f.hidden) return `<input type="hidden" name="${f.key}" value="${escapeText(val)}">`;
        return `<div class="modal-field">${cardFieldInput(f, val)}</div>`;
    }).join('');
    inner += `<div class="modal-field"><label>תאריך בדיקה</label>${dateFieldHtml('inspectionDate', r.inspectionDate || '')}</div>`;

    let html = `<h4 class="font-bold text-sm mt-4 mb-2 text-gray-700 border-b pb-1">תאריכי תוקף</h4>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">${inner}</div>`;

    const customs = getCustomFields();
    if (customs.length) {
        html += `<h4 class="font-bold text-sm mt-4 mb-2 text-gray-700 border-b pb-1">שדות נוספים</h4>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">`;
        customs.forEach(f => {
            const val = (r.customFields || {})[f.key] || '';
            html += `<div class="modal-field">${cardFieldInput({ key: f.key, builtin: false, label: f.label, type: f.type, options: f.options }, val)}</div>`;
        });
        html += `</div>`;
    }
    return html;
}

// Collect built-in date-field values from a form, respecting each field's type
function collectBuiltinFields(form) {
    const out = {};
    DATE_FIELDS.forEach(key => {
        const el = form.elements[key];
        if (!el) return;
        out[key] = builtinType(key) === 'date' ? parseDateInput(el.value) : el.value;
    });
    return out;
}

// Label for any field (built-in override or custom field)
function fieldLabel(field) {
    if (_config.labels && _config.labels[field]) return _config.labels[field];
    if (DEFAULT_FIELD_LABELS[field]) return DEFAULT_FIELD_LABELS[field];
    const cf = (_config.customFields || []).find(f => f.key === field);
    return cf ? cf.label : field;
}

// Warning window (days) for a given date field
function getExpiryDays(field) {
    if (field && _config.expiryDays && _config.expiryDays[field] != null) {
        const n = parseInt(_config.expiryDays[field], 10);
        if (!isNaN(n) && n >= 0) return n;
    }
    const cf = (_config.customFields || []).find(f => f.key === field);
    if (cf && cf.expiryDays != null) {
        const n = parseInt(cf.expiryDays, 10);
        if (!isNaN(n) && n >= 0) return n;
    }
    return DEFAULT_EXPIRY_DAYS;
}

function getCustomFields() {
    return _config.customFields || [];
}

function customDateFields() {
    return getCustomFields().filter(f => f.type === 'date');
}

// All date fields (built-in + custom) used for worst-status calculations
function allDateFields() {
    return DATE_FIELDS.concat(customDateFields().map(f => f.key));
}

// Read a date value from a record (built-in column or customFields map)
function getDateFieldValue(record, field) {
    if (DEFAULT_FIELD_LABELS[field] || field === 'inspectionDate') return record[field];
    return (record.customFields || {})[field] || '';
}

// ============================================================
// Phone helpers — Israeli numbers must keep their leading 0
// ============================================================

function normalizePhone(phone) {
    let p = String(phone == null ? '' : phone).trim();
    if (!p) return '';
    // Strip separators (hyphens, spaces, parentheses, dots) — show digits only
    p = p.replace(/[\s\-().]/g, '');
    // Recover a leading zero stripped by spreadsheet number formatting
    if (/^\d+$/.test(p) && !p.startsWith('0') && (p.length === 8 || p.length === 9)) {
        p = '0' + p;
    }
    return p;
}

// Normalize a record's contacts into [{name, phone}] (back-compat with the
// old single contactName / contactPhone columns).
function getContacts(record) {
    let list = Array.isArray(record.contacts) ? record.contacts.slice() : [];
    list = list
        .map(c => ({ name: (c.name || '').trim(), phone: normalizePhone(c.phone) }))
        .filter(c => c.name || c.phone);
    if (!list.length && (record.contactName || record.contactPhone)) {
        list = [{ name: (record.contactName || '').trim(), phone: normalizePhone(record.contactPhone) }];
    }
    return list;
}

// Compact contacts rendering for table cells
function renderContactsInline(record) {
    const contacts = getContacts(record);
    if (!contacts.length) return '<div class="text-xs text-gray-400">-</div>';
    return contacts.map(c => `
        <div class="contact-line text-xs">
            ${c.name ? `<span>${escapeText(c.name)}</span>` : ''}
            ${c.phone ? `<a href="tel:${c.phone}" class="text-blue-600">${escapeText(c.phone)}</a>` : ''}
        </div>`).join('');
}

function escapeText(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================
// API Communication
// ============================================================

async function apiGet(action) {
    if (!APPS_SCRIPT_URL) throw new Error('API URL not configured');
    const url = `${APPS_SCRIPT_URL}?action=${action}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`API Error: ${resp.status}`);
    return await resp.json();
}

async function apiAction(action, params) {
    if (!APPS_SCRIPT_URL) throw new Error('API URL not configured');

    // Use GET for ALL operations (POST has CORS/redirect issues with Apps Script)
    const urlParams = new URLSearchParams({ action, ...params });
    const url = `${APPS_SCRIPT_URL}?${urlParams.toString()}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`API Error: ${resp.status}`);
    return await resp.json();
}

// ============================================================
// Data Loading
// ============================================================

async function loadAllData() {
    showLoading(true);
    try {
        const [vehicleResp, defResp, sheetNameResp, configResp] = await Promise.all([
            apiGet('getData'),
            apiGet('getDeficiencies'),
            apiGet('getSheetName'),
            apiGet('getConfig').catch(() => null)
        ]);

        if (vehicleResp.error) throw new Error(vehicleResp.error);
        _vehicleData = vehicleResp.data || [];
        _deficiencyData = (defResp.data) || {};

        // Prefer server-stored template config; fall back to local cache
        if (configResp && configResp.config) {
            _config = normalizeConfig(configResp.config);
            localStorage.setItem('fleet_card_config', JSON.stringify(_config));
        } else {
            loadConfigFromCache();
        }

        const sheetName = sheetNameResp && sheetNameResp.name ? sheetNameResp.name : 'Google Sheets';
        showStatus(`מחובר ל-${sheetName}`, false);
        return true;
    } catch (err) {
        console.error('Load error:', err);
        showStatus('שגיאה בטעינת נתונים: ' + err.message, true);
        return false;
    } finally {
        showLoading(false);
    }
}

function getData() {
    return _vehicleData;
}

function loadDeficiencies() {
    return _deficiencyData;
}

function loadConfigFromCache() {
    try {
        const cached = localStorage.getItem('fleet_card_config');
        _config = normalizeConfig(cached ? JSON.parse(cached) : null);
    } catch (err) {
        _config = normalizeConfig(null);
    }
}

async function saveConfig(newConfig) {
    _config = normalizeConfig(newConfig);
    localStorage.setItem('fleet_card_config', JSON.stringify(_config));
    try {
        const result = await apiAction('saveConfig', { data: JSON.stringify(_config) });
        if (result.error) throw new Error(result.error);
        showSaveIndicator('תבנית הכרטיס נשמרה');
        return true;
    } catch (err) {
        showSaveIndicator('שגיאה בשמירת התבנית: ' + err.message, true);
        return false;
    }
}

// ============================================================
// Data Saving
// ============================================================

async function saveRecord(record) {
    // Update local cache immediately for fast UI
    const lookupKey = record.originalLicenseNumber || record.licenseNumber;
    const idx = _vehicleData.findIndex(r => r.licenseNumber === lookupKey);
    if (idx !== -1) {
        Object.assign(_vehicleData[idx], record);
        _vehicleData[idx].licenseNumber = record.licenseNumber;
        _vehicleData[idx].id = record.licenseNumber;
        delete _vehicleData[idx].originalLicenseNumber;
    }

    try {
        const result = await apiAction('updateRecord', { data: JSON.stringify(record) });
        if (result.error) throw new Error(result.error);
        showSaveIndicator('נשמר בהצלחה ב-Google Sheets');
        return true;
    } catch (err) {
        showSaveIndicator('שגיאה בשמירה: ' + err.message, true);
        return false;
    }
}

async function addNewRecord(record) {
    // Add to local cache immediately
    record.id = record.licenseNumber;
    _vehicleData.push(record);

    try {
        const result = await apiAction('addRecord', { data: JSON.stringify(record) });
        if (result.error) throw new Error(result.error);
        showSaveIndicator('רשומה חדשה נוספה');
        return true;
    } catch (err) {
        showSaveIndicator('שגיאה בהוספה: ' + err.message, true);
        return false;
    }
}

async function deleteRecord(licenseNumber) {
    // Remove from local cache immediately
    _vehicleData = _vehicleData.filter(r => r.licenseNumber !== licenseNumber);

    try {
        const result = await apiAction('deleteRecord', { licenseNumber });
        if (result.error) throw new Error(result.error);
        showSaveIndicator('רשומה נמחקה');
        return true;
    } catch (err) {
        showSaveIndicator('שגיאה במחיקה: ' + err.message, true);
        return false;
    }
}

async function saveDeficiencyData(licenseNumber, deficiencies) {
    try {
        const result = await apiAction('saveDeficiency', {
            licenseNumber,
            data: JSON.stringify(deficiencies)
        });
        if (result.error) throw new Error(result.error);
        _deficiencyData[licenseNumber] = deficiencies;
        return true;
    } catch (err) {
        showSaveIndicator('שגיאה בשמירת ליקויים: ' + err.message, true);
        return false;
    }
}

// ============================================================
// Date Utilities
// ============================================================

function today() {
    return new Date().toISOString().split('T')[0];
}

function daysUntil(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    const now = new Date(today());
    return Math.ceil((d - now) / (1000 * 60 * 60 * 24));
}

function getDateStatus(dateStr, field) {
    if (!dateStr) return 'empty';
    const days = daysUntil(dateStr);
    if (days < 0) return 'expired';
    if (days <= 2) return 'critical';
    if (days <= getExpiryDays(field)) return 'warning';
    return 'valid';
}

function getRecordWorstStatus(record) {
    let worst = 'valid';
    const priority = { expired: 0, critical: 1, warning: 2, valid: 3, empty: 4 };
    for (const field of allDateFields()) {
        const val = getDateFieldValue(record, field);
        if (!val) continue;
        const status = getDateStatus(val, field);
        if (status === 'empty') continue;
        if (priority[status] < priority[worst]) {
            worst = status;
        }
    }
    return worst;
}

function normalizeStr(s) {
    return (s || '').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\u00A0]/g, '').trim().replace(/\s+/g, ' ');
}

function dateFieldHtml(name, value) {
    const display = value ? formatDate(value) : '';
    return `<div style="display:flex;gap:4px;align-items:center">
        <input type="text" name="${name}" value="${display}" placeholder="DD/MM/YYYY" dir="ltr" readonly onclick="this.nextElementSibling.showPicker()" style="cursor:pointer;flex:1">
        <input type="date" value="${value || ''}" style="position:absolute;visibility:hidden;width:0;height:0" onchange="const t=this.previousElementSibling;t.value=this.value?formatDate(this.value):''">
        <button type="button" onclick="this.parentElement.querySelector('input[name]').value='';this.parentElement.querySelector('input[type=date]').value=''" style="color:#ef4444;font-size:1.2rem;padding:0 6px;cursor:pointer;background:none;border:none" title="נקה תאריך">&times;</button>
    </div>`;
}

function formatDate(dateStr) {
    if (!dateStr) return '-';
    const parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function parseDateInput(val) {
    if (!val) return '';
    const parts = val.split('/');
    if (parts.length !== 3) return val;
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
}

function statusLabel(status) {
    const labels = {
        expired: 'פג תוקף',
        critical: 'דחוף (1-2 ימים)',
        warning: 'קרוב (30 יום)',
        valid: 'תקין',
        empty: 'לא הוזן'
    };
    return labels[status] || status;
}

// ============================================================
// UI Helpers
// ============================================================

function showLoading(show) {
    _isLoading = show;
    const el = document.getElementById('loading-overlay');
    if (el) el.classList.toggle('hidden', !show);
}

function showStatus(text, isError) {
    const el = document.getElementById('server-status');
    if (!el) return;
    el.textContent = text;
    el.className = isError
        ? 'text-xs px-2 py-0.5 rounded-full bg-red-600 text-white'
        : 'text-xs px-2 py-0.5 rounded-full bg-green-600 text-white';
}

function showSaveIndicator(text, isError) {
    let el = document.getElementById('save-indicator');
    if (!el) {
        el = document.createElement('div');
        el.id = 'save-indicator';
        el.style.cssText = 'position:fixed;bottom:20px;left:20px;padding:10px 20px;border-radius:8px;font-size:0.85rem;z-index:9999;transition:opacity 0.3s;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,0.15);';
        document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.backgroundColor = isError ? '#fee2e2' : '#dcfce7';
    el.style.color = isError ? '#991b1b' : '#166534';
    el.style.opacity = '1';
    setTimeout(() => { el.style.opacity = '0'; }, 2500);
}

// ============================================================
// Navigation
// ============================================================

let currentPage = 'dashboard';

function navigate(page) {
    currentPage = page;
    document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
    document.getElementById(`page-${page}`).classList.remove('hidden');

    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`nav-${page}`).classList.add('active');

    renderCurrentPage();
}

function renderCurrentPage() {
    if (currentPage === 'dashboard') renderDashboard();
    else if (currentPage === 'work') renderWorkPage();
    else if (currentPage === 'manage') renderManagePage();
}

// ============================================================
// Populate Filters
// ============================================================

function populateFilters() {
    const data = getData();
    const locations = [...new Set(data.map(r => normalizeStr(r.location)))].filter(Boolean).sort();
    const customers = [...new Set(data.map(r => normalizeStr(r.customerName)))].filter(Boolean).sort();

    ['dash-location', 'work-location'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const current = el.value;
        el.innerHTML = '<option value="">הכל</option>';
        locations.forEach(loc => {
            const escaped = loc.replace(/"/g, '&quot;');
            el.innerHTML += `<option value="${escaped}" ${loc === current ? 'selected' : ''}>${loc}</option>`;
        });
    });

    const workCust = document.getElementById('work-customer');
    if (workCust) {
        const current = workCust.value;
        workCust.innerHTML = '<option value="">הכל</option>';
        customers.forEach(c => {
            const escaped = c.replace(/"/g, '&quot;');
            workCust.innerHTML += `<option value="${escaped}" ${c === current ? 'selected' : ''}>${c}</option>`;
        });
    }
}

// ============================================================
// Filter Indicator
// ============================================================

function updateFilterIndicator(filterIds, clearFn, containerId) {
    // Highlight active filters
    let activeCount = 0;
    filterIds.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const isActive = el.value !== '';
        el.classList.toggle('filter-active', isActive);
        if (isActive) activeCount++;
    });

    // Show/hide filter banner
    const existingBanner = document.getElementById(`${containerId}-filter-banner`);
    if (existingBanner) existingBanner.remove();

    if (activeCount > 0) {
        const banner = document.createElement('div');
        banner.id = `${containerId}-filter-banner`;
        banner.className = 'filter-banner';
        banner.innerHTML = `<span>מציג תוצאות מסוננות (${activeCount} ${activeCount === 1 ? 'פילטר פעיל' : 'פילטרים פעילים'})</span>
            <button onclick="${clearFn}" class="filter-clear-btn">נקה פילטרים &times;</button>`;
        const container = document.getElementById(containerId);
        if (container) container.insertBefore(banner, container.firstChild);
    }
}

// ============================================================
// Dashboard Page
// ============================================================

function clearDashFilters() {
    document.getElementById('dash-status').value = '';
    document.getElementById('dash-search').value = '';
    document.getElementById('dash-location').value = '';
    document.getElementById('dash-type').value = '';
    renderDashboard();
}

function renderDashboard() {
    const data = getData();
    const search = document.getElementById('dash-search')?.value?.toLowerCase() || '';
    const location = document.getElementById('dash-location')?.value || '';
    const vType = document.getElementById('dash-type')?.value || '';
    const statusFilter = document.getElementById('dash-status')?.value || '';

    let filtered = data.filter(r => {
        if (search && !r.customerName.toLowerCase().includes(search) && !r.licenseNumber.includes(search)) return false;
        if (location && normalizeStr(r.location) !== location) return false;
        if (vType && r.vehicleType !== vType) return false;
        if (statusFilter) {
            if (statusFilter === 'notVisited') {
                const monthStart = today().slice(0, 7) + '-01';
                if (r.inspectionDate && r.inspectionDate >= monthStart) return false;
            } else if (statusFilter === 'openDefs') {
                const defs = loadDeficiencies();
                const vehicleDefs = defs[r.licenseNumber] || [];
                const hasOpen = vehicleDefs.some(d => d.status === 'open' || d.status === 'in-progress');
                if (!hasOpen) return false;
            } else if (statusFilter === 'pendingSync') {
                if (r.appSynced === 'yes') return false;
            } else {
                const worst = getRecordWorstStatus(r);
                if (statusFilter !== worst) return false;
            }
        }
        return true;
    });

    // Summary cards - count vehicles by worst status
    const uniqueCustomers = new Set(data.map(r => r.customerName)).size;
    let expired = 0, critical = 0, warning = 0, valid = 0;
    data.forEach(r => {
        const worst = getRecordWorstStatus(r);
        if (worst === 'expired') expired++;
        else if (worst === 'critical') critical++;
        else if (worst === 'warning') warning++;
        else if (worst === 'valid') valid++;
    });

    // Count open deficiencies
    const defs = loadDeficiencies();
    let openDefs = 0;
    Object.values(defs).forEach(arr => {
        arr.forEach(d => {
            if (d.status === 'open' || d.status === 'in-progress') openDefs++;
        });
    });

    // Count vehicles not yet visited this month
    const monthStart = today().slice(0, 7) + '-01'; // YYYY-MM-01
    const notVisited = data.filter(r => !r.inspectionDate || r.inspectionDate < monthStart).length;

    // Display today's date
    const todayDate = new Date();
    const dateStr = todayDate.toLocaleDateString('he-IL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    document.getElementById('dashboard-date').textContent = dateStr;

    document.getElementById('summary-cards').innerHTML = `
        <div class="summary-card bg-white border-r-4 border-blue-500 cursor-pointer" onclick="document.getElementById('dash-status').value='';document.getElementById('dash-search').value='';document.getElementById('dash-location').value='';document.getElementById('dash-type').value='';renderDashboard()">
            <div class="text-3xl font-bold text-blue-600">${data.length}</div>
            <div class="text-sm text-gray-600">סה"כ כלי רכב</div>
            <div class="text-xs text-gray-400 mt-1">${uniqueCustomers} לקוחות</div>
        </div>
        <div class="summary-card bg-white border-r-4 border-cyan-600 cursor-pointer" onclick="document.getElementById('dash-status').value='notVisited';renderDashboard()">
            <div class="text-3xl font-bold text-cyan-700">${notVisited}</div>
            <div class="text-sm text-gray-600">נותרו לביקור החודש</div>
        </div>
        <div class="summary-card bg-white border-r-4 border-red-500 cursor-pointer" onclick="document.getElementById('dash-status').value='expired';renderDashboard()">
            <div class="text-3xl font-bold text-red-600">${expired}</div>
            <div class="text-sm text-gray-600">רכבים עם רישוי פג תוקף</div>
        </div>
        <div class="summary-card bg-white border-r-4 border-orange-500 cursor-pointer" onclick="document.getElementById('dash-status').value='critical';renderDashboard()">
            <div class="text-3xl font-bold text-orange-600">${critical}</div>
            <div class="text-sm text-gray-600">רכבים עם רישוי הפוקע ביומיים הקרובים</div>
        </div>
        <div class="summary-card bg-white border-r-4 border-yellow-500 cursor-pointer" onclick="document.getElementById('dash-status').value='warning';renderDashboard()">
            <div class="text-3xl font-bold text-yellow-600">${warning}</div>
            <div class="text-sm text-gray-600">רכבים פוקעים ב-30 יום</div>
        </div>
        <div class="summary-card bg-white border-r-4 border-green-500 cursor-pointer" onclick="document.getElementById('dash-status').value='valid';renderDashboard()">
            <div class="text-3xl font-bold text-green-600">${valid}</div>
            <div class="text-sm text-gray-600">רכבים עם רישוי תקין</div>
        </div>
        <div class="summary-card bg-white border-r-4 border-purple-500 cursor-pointer" onclick="document.getElementById('dash-status').value='openDefs';renderDashboard()">
            <div class="text-3xl font-bold text-purple-600">${openDefs}</div>
            <div class="text-sm text-gray-600">ליקויים פתוחים</div>
        </div>
        <div class="summary-card bg-white border-r-4 border-amber-500 cursor-pointer" onclick="document.getElementById('dash-status').value='pendingSync';renderDashboard()">
            <div class="text-3xl font-bold text-amber-600">${data.filter(r => r.appSynced !== 'yes').length}</div>
            <div class="text-sm text-gray-600">רכבים הממתינים לעדכון במערכת</div>
        </div>
    `;

    // Group by customer
    const byCustomer = {};
    filtered.forEach(r => {
        if (!byCustomer[r.customerName]) {
            const primary = getContacts(r)[0] || { name: '', phone: '' };
            byCustomer[r.customerName] = {
                location: r.location,
                contact: primary.name,
                phone: primary.phone,
                vehicles: []
            };
        }
        byCustomer[r.customerName].vehicles.push(r);
    });

    let html = '<div class="table-container">';
    html += '<table class="data-table">';
    html += `<thead><tr>
        <th></th><th>שם לקוח</th><th>מיקום</th><th>כלי רכב</th>
        <th>סטטוס</th><th>איש קשר</th><th>טלפון</th>
    </tr></thead><tbody>`;

    const allDefs = loadDeficiencies();
    Object.entries(byCustomer).sort((a, b) => a[0].localeCompare(b[0], 'he')).forEach(([name, info]) => {
        const worstStatuses = info.vehicles.map(v => getRecordWorstStatus(v));
        const priority = { expired: 0, critical: 1, warning: 2, valid: 3 };
        const worst = worstStatuses.reduce((a, b) => priority[a] < priority[b] ? a : b, 'valid');

        const customerOpenDefs = info.vehicles.reduce((sum, v) => {
            const vDefs = allDefs[v.licenseNumber] || [];
            return sum + vDefs.filter(d => d.status === 'open' || d.status === 'in-progress').length;
        }, 0);
        const defBadge = customerOpenDefs > 0 ? ` <span class="inline-block bg-purple-100 text-purple-700 text-xs font-bold px-1.5 py-0.5 rounded-full">${customerOpenDefs} ליקויים</span>` : '';

        const escapedName = name.replace(/'/g, "\\'");
        html += `<tr class="cursor-pointer" onclick="toggleCustomerExpand(this, '${escapedName}')">
            <td class="text-center">&#9664;</td>
            <td class="font-medium">${name}</td>
            <td>${info.location}</td>
            <td>${info.vehicles.length}</td>
            <td><span class="badge status-${worst}">${statusLabel(worst)}</span>${defBadge}</td>
            <td>${info.contact}</td>
            <td><a href="tel:${info.phone}" class="text-blue-600 hover:underline">${info.phone}</a></td>
        </tr>`;
    });

    html += '</tbody></table></div>';
    document.getElementById('dashboard-content').innerHTML = html;
    updateFilterIndicator(['dash-search', 'dash-location', 'dash-type', 'dash-status'], 'clearDashFilters()', 'page-dashboard');
}

function toggleCustomerExpand(row, customerName) {
    const existing = row.nextElementSibling;
    if (existing && existing.classList.contains('vehicle-detail-row')) {
        existing.remove();
        row.querySelector('td:first-child').innerHTML = '&#9664;';
        row.classList.remove('expanded-row');
        return;
    }

    document.querySelectorAll('.vehicle-detail-row').forEach(r => r.remove());
    document.querySelectorAll('.expanded-row').forEach(r => {
        r.classList.remove('expanded-row');
        r.querySelector('td:first-child').innerHTML = '&#9664;';
    });

    row.classList.add('expanded-row');
    row.querySelector('td:first-child').innerHTML = '&#9660;';

    const data = getData().filter(r => r.customerName === customerName);
    const expandDefs = loadDeficiencies();
    let detailHtml = '<td colspan="7" class="p-0"><div class="vehicle-detail bg-blue-50 p-4">';
    detailHtml += '<table class="data-table" style="font-size:0.75rem">';
    detailHtml += `<thead><tr>
        <th>רישוי</th><th>סוג</th><th>יצרן</th><th>משקל</th><th>ק״מ</th><th>חומ״ס</th>
        <th>תוקף רישוי</th><th>ביטוח חובה</th>
        <th>כיול</th><th>בלמים ח״ש</th>
        <th>מוביל</th><th>רמפה/מנוף</th><th>חורף</th><th>נחתם מוביל</th><th>בדיקה</th><th>ליקויים</th><th>צפייה</th>
    </tr></thead><tbody>`;

    data.forEach(v => {
        const vOpenDefs = (expandDefs[v.licenseNumber] || []).filter(d => d.status === 'open' || d.status === 'in-progress').length;
        const defCell = vOpenDefs > 0 ? `<span class="inline-block bg-purple-100 text-purple-700 text-xs font-bold px-1.5 py-0.5 rounded-full">${vOpenDefs}</span>` : '-';
        detailHtml += `<tr>
            <td class="font-medium">${v.licenseNumber}</td>
            <td>${v.vehicleType}</td>
            <td>${v.manufacturer || '-'}</td>
            <td>${v.totalWeight || '-'}</td>
            <td>${v.mileage || '-'}</td>
            <td>${v.hazmatCertified === 'yes' ? 'כן' : v.hazmatCertified === 'no' ? 'לא' : '-'}</td>
            <td class="date-${getDateStatus(v.licenseExpiry, 'licenseExpiry')}">${formatDate(v.licenseExpiry)}</td>
            <td class="date-${getDateStatus(v.mandatoryInsurance, 'mandatoryInsurance')}">${formatDate(v.mandatoryInsurance)}</td>
            <td class="date-${getDateStatus(v.calibrationExpiry, 'calibrationExpiry')}">${formatDate(v.calibrationExpiry)}</td>
            <td class="date-${getDateStatus(v.brakeTestExpiry, 'brakeTestExpiry')}">${formatDate(v.brakeTestExpiry)}</td>
            <td class="date-${getDateStatus(v.carrierLicense, 'carrierLicense')}">${formatDate(v.carrierLicense)}</td>
            <td class="date-${getDateStatus(v.rampCraneInspection, 'rampCraneInspection')}">${formatDate(v.rampCraneInspection)}</td>
            <td class="date-${getDateStatus(v.winterInspection, 'winterInspection')}">${formatDate(v.winterInspection)}</td>
            <td class="date-${getDateStatus(v.carrierLicenseSigned, 'carrierLicenseSigned')}">${formatDate(v.carrierLicenseSigned)}</td>
            <td>${formatDate(v.inspectionDate)}</td>
            <td>${defCell}</td>
            <td class="text-center">
                <button onclick="event.stopPropagation();openViewModal('${v.licenseNumber}')" class="view-btn" title="צפייה בכרטיס">&#128065;</button>
            </td>
        </tr>`;
    });

    detailHtml += '</tbody></table></div></td>';
    const detailRow = document.createElement('tr');
    detailRow.className = 'vehicle-detail-row';
    detailRow.innerHTML = detailHtml;
    row.after(detailRow);
}

// ============================================================
// Work Page
// ============================================================

function setWorkSort(column) {
    if (_workSort.column === column) {
        _workSort.direction = _workSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
        _workSort.column = column;
        _workSort.direction = 'asc';
    }
    renderWorkPage();
}

function sortHeader(column, label) {
    const active = _workSort.column === column;
    const arrow = active ? (_workSort.direction === 'asc' ? ' ▲' : ' ▼') : '';
    const cls = active ? 'work-sort-th work-sort-active' : 'work-sort-th';
    return `<th class="${cls}" onclick="setWorkSort('${column}')">${label}${arrow}</th>`;
}

const STATUS_PRIORITY = { expired: 0, critical: 1, warning: 2, valid: 3, empty: 4 };

function sortWorkVehicles(vehicles) {
    const { column, direction } = _workSort;
    const dir = direction === 'asc' ? 1 : -1;
    vehicles.sort((a, b) => dir * compareWorkRows(a, b, column));
}

function compareWorkRows(a, b, column) {
    const ra = a.record, rb = b.record;
    const cmpStr = (x, y) => (x || '').localeCompare(y || '', 'he');
    const cmpNum = (x, y) => x - y;
    const cmpDate = (x, y) => {
        if (!x && !y) return 0;
        if (!x) return 1;
        if (!y) return -1;
        return x.localeCompare(y);
    };
    switch (column) {
        case 'visited':   return cmpNum(a.visitedThisMonth ? 1 : 0, b.visitedThisMonth ? 1 : 0);
        case 'customerName': return cmpStr(ra.customerName, rb.customerName);
        case 'contactName':  return cmpStr(ra.contactName, rb.contactName);
        case 'licenseNumber': {
            const na = parseInt((ra.licenseNumber || '').replace(/\D/g, ''), 10);
            const nb = parseInt((rb.licenseNumber || '').replace(/\D/g, ''), 10);
            if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
            return cmpStr(ra.licenseNumber, rb.licenseNumber);
        }
        case 'vehicleType':  return cmpStr(ra.vehicleType, rb.vehicleType);
        case 'inspectionDate': return cmpDate(ra.inspectionDate, rb.inspectionDate);
        case 'carrierLicenseSigned': return cmpDate(ra.carrierLicenseSigned, rb.carrierLicenseSigned);
        case 'notes': {
            const na = (ra.notes || '').trim(), nb = (rb.notes || '').trim();
            if (!na && !nb) return 0;
            if (!na) return 1;
            if (!nb) return -1;
            return cmpStr(na, nb);
        }
        case 'openDefs':     return cmpNum(a.openDefs, b.openDefs);
        case 'appSynced':    return cmpNum(ra.appSynced === 'yes' ? 1 : 0, rb.appSynced === 'yes' ? 1 : 0);
        default: return 0;
    }
}

function renderWorkPage() {
    const data = getData();
    const location = document.getElementById('work-location')?.value || '';
    const customer = document.getElementById('work-customer')?.value || '';
    const syncFilter = document.getElementById('work-sync')?.value || '';

    const defs = loadDeficiencies();
    const monthStart = today().slice(0, 7) + '-01'; // YYYY-MM-01

    // Build vehicle list with visit status and issues
    const vehicles = [];
    data.forEach(record => {
        if (location && normalizeStr(record.location) !== location) return;
        if (customer && normalizeStr(record.customerName) !== customer) return;
        if (syncFilter === 'no' && record.appSynced === 'yes') return;
        if (syncFilter === 'yes' && record.appSynced !== 'yes') return;

        const vehicleDefs = defs[record.licenseNumber] || [];
        const openDefs = vehicleDefs.filter(d => d.status === 'open' || d.status === 'in-progress').length;
        const visitedThisMonth = record.inspectionDate && record.inspectionDate >= monthStart;

        vehicles.push({ record, openDefs, visitedThisMonth });
    });

    // Sort by selected column / direction
    sortWorkVehicles(vehicles);

    // Current month name
    const monthName = new Date().toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
    const visitedCount = vehicles.filter(v => v.visitedThisMonth).length;
    const remainingCount = vehicles.length - visitedCount;

    if (!vehicles.length) {
        document.getElementById('work-content').innerHTML = `<div class="bg-green-50 border border-green-200 rounded-lg p-8 text-center">
            <div class="text-4xl mb-2">&#10003;</div>
            <div class="text-lg font-bold text-green-700">אין רכבים להצגה</div>
        </div>`;
        updateFilterIndicator(['work-location', 'work-customer', 'work-sync'], 'clearWorkFilters()', 'page-work');
        return;
    }

    const sh = (col, label) => sortHeader(col, label);
    let html = `<div class="work-section">
        <div class="work-section-header bg-blue-700 text-white">
            <span>דף עבודה - ${monthName}</span>
            <span>${visitedCount}/${vehicles.length} בוקרו | ${remainingCount} נותרו</span>
        </div>
        <div class="table-container">
        <table class="work-table">
            <thead><tr>
                ${sh('visited', '')}
                ${sh('customerName', 'לקוח')}
                ${sh('contactName', 'איש קשר')}
                ${sh('licenseNumber', 'רכב')}
                ${sh('vehicleType', 'סוג')}
                ${sh('inspectionDate', 'ביקור אחרון')}
                ${sh('carrierLicenseSigned', 'נחתם רישיון מוביל עד')}
                ${sh('notes', 'הערות')}
                ${sh('openDefs', 'ליקויים')}
                ${sh('appSynced', 'מערכת')}
                <th></th>
            </tr></thead>
            <tbody>`;

    vehicles.forEach(({ record: rec, openDefs, visitedThisMonth }) => {
        const rowClass = visitedThisMonth ? 'work-row-visited' : 'work-row-not-visited';
        const visitIcon = visitedThisMonth ? '&#10003;' : '&#10007;';
        const visitIconClass = visitedThisMonth ? 'visit-icon-done' : 'visit-icon-pending';

        // Inspection date display
        let inspectionCell = '';
        if (!rec.inspectionDate) {
            inspectionCell = `<td class="work-cell work-cell-expired text-center"><div>-</div><div class="work-cell-days">לא בוקר</div></td>`;
        } else {
            const daysSince = -daysUntil(rec.inspectionDate);
            const daysText = daysSince === 0 ? 'היום' : daysSince === 1 ? 'אתמול' : `לפני ${daysSince} ימים`;
            const cellClass = visitedThisMonth ? 'work-cell-valid' : (daysSince > 45 ? 'work-cell-expired' : 'work-cell-warning');
            inspectionCell = `<td class="work-cell ${cellClass}"><div>${formatDate(rec.inspectionDate)}</div><div class="work-cell-days">${daysText}</div></td>`;
        }

        // Carrier license signed date display
        let carrierLicenseSignedCell = '';
        if (!rec.carrierLicenseSigned) {
            carrierLicenseSignedCell = `<td class="work-cell work-cell-empty text-center">-</td>`;
        } else {
            const status = getDateStatus(rec.carrierLicenseSigned, 'carrierLicenseSigned');
            const days = daysUntil(rec.carrierLicenseSigned);
            const daysText = days < 0 ? `פג ${Math.abs(days)}י'` : days === 0 ? 'פג היום' : `בעוד ${days}י'`;
            const cellClass = status === 'expired' ? 'work-cell-expired' : (status === 'critical' || status === 'warning') ? 'work-cell-warning' : 'work-cell-valid';
            carrierLicenseSignedCell = `<td class="work-cell ${cellClass}"><div>${formatDate(rec.carrierLicenseSigned)}</div><div class="work-cell-days">${daysText}</div></td>`;
        }

        // Notes cell - free text, truncated to 3 lines with full text on hover
        const notesText = (rec.notes || '').trim();
        let notesCell;
        if (!notesText) {
            notesCell = `<td class="work-cell work-cell-empty text-center">-</td>`;
        } else {
            const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const escapeAttr = s => escapeHtml(s).replace(/"/g, '&quot;').replace(/\n/g, ' ');
            notesCell = `<td class="work-cell-notes" title="${escapeAttr(notesText)}"><div class="work-notes-content">${escapeHtml(notesText)}</div></td>`;
        }

        // App sync status
        const isSynced = rec.appSynced === 'yes';
        const syncBtnClass = isSynced ? 'sync-btn-done' : 'sync-btn-pending';
        const syncIcon = isSynced ? '&#10003;' : '&#10007;';
        const syncTitle = isSynced ? 'עודכן במערכת' : 'לא עודכן במערכת';

        html += `<tr class="work-vehicle-row ${rowClass}">`;
        html += `<td class="text-center ${visitIconClass}">${visitIcon}</td>`;
        html += `<td class="font-semibold">${rec.customerName}</td>`;
        html += `<td>${renderContactsInline(rec)}</td>`;
        html += `<td class="font-bold">${rec.licenseNumber}</td>`;
        html += `<td class="text-gray-500">${rec.vehicleType}</td>`;
        html += inspectionCell;
        html += carrierLicenseSignedCell;
        html += notesCell;

        if (openDefs > 0) {
            html += `<td class="work-cell work-cell-expired text-center"><div>${openDefs}</div><div class="work-cell-days">פתוחים</div></td>`;
        } else {
            html += `<td class="work-cell work-cell-empty text-center">-</td>`;
        }

        html += `<td class="text-center">
            <button onclick="event.stopPropagation();toggleAppSync('${rec.licenseNumber}')"
                class="sync-btn ${syncBtnClass}" title="${syncTitle}">
                ${syncIcon}
            </button>
        </td>`;

        html += `<td class="whitespace-nowrap text-center">
            <button onclick="openViewModal('${rec.licenseNumber}')" class="act-btn act-btn-view" title="צפייה בכרטיס">
                <span class="act-icon">&#128065;</span><span>צפייה</span>
            </button>
            <button onclick="openEditModal('${rec.licenseNumber}')" class="act-btn act-btn-edit">
                <span class="act-icon">&#9998;</span><span>עדכן</span>
            </button>
        </td></tr>`;
    });

    html += '</tbody></table></div></div>';
    document.getElementById('work-content').innerHTML = html;
    updateFilterIndicator(['work-location', 'work-customer', 'work-sync'], 'clearWorkFilters()', 'page-work');
}

function clearWorkFilters() {
    document.getElementById('work-location').value = '';
    document.getElementById('work-customer').value = '';
    document.getElementById('work-sync').value = '';
    renderWorkPage();
}

// ============================================================
// Manage Page
// ============================================================

function renderManagePage() {
    const data = getData();
    const search = document.getElementById('manage-search')?.value?.toLowerCase() || '';

    let filtered = data;
    if (search) {
        filtered = data.filter(r =>
            r.customerName.toLowerCase().includes(search) ||
            r.licenseNumber.includes(search) ||
            r.location.toLowerCase().includes(search)
        );
    }

    const deficiencies = loadDeficiencies();

    let html = '<div class="table-container">';
    html += '<table class="data-table">';
    html += `<thead><tr>
        <th>#</th><th>לקוח</th><th>מיקום</th><th>רישוי</th><th>סוג</th>
        <th>תוקף רישוי</th><th>ביטוח חובה</th>
        <th>כיול</th><th>בלמים ח״ש</th><th>מוביל</th><th>רמפה/מנוף</th><th>חורף</th><th>נחתם מוביל</th>
        <th>ליקויים</th><th>פעולות</th>
    </tr></thead><tbody>`;

    filtered.forEach((r, i) => {
        const defCount = (deficiencies[r.licenseNumber] || []).filter(d => d.status !== 'resolved').length;
        html += `<tr>
            <td>${i + 1}</td>
            <td class="font-medium">${r.customerName}</td>
            <td>${r.location}</td>
            <td>${r.licenseNumber}</td>
            <td>${r.vehicleType}</td>
            <td class="date-${getDateStatus(r.licenseExpiry, 'licenseExpiry')}">${formatDate(r.licenseExpiry)}</td>
            <td class="date-${getDateStatus(r.mandatoryInsurance, 'mandatoryInsurance')}">${formatDate(r.mandatoryInsurance)}</td>
            <td class="date-${getDateStatus(r.calibrationExpiry, 'calibrationExpiry')}">${formatDate(r.calibrationExpiry)}</td>
            <td class="date-${getDateStatus(r.brakeTestExpiry, 'brakeTestExpiry')}">${formatDate(r.brakeTestExpiry)}</td>
            <td class="date-${getDateStatus(r.carrierLicense, 'carrierLicense')}">${formatDate(r.carrierLicense)}</td>
            <td class="date-${getDateStatus(r.rampCraneInspection, 'rampCraneInspection')}">${formatDate(r.rampCraneInspection)}</td>
            <td class="date-${getDateStatus(r.winterInspection, 'winterInspection')}">${formatDate(r.winterInspection)}</td>
            <td class="date-${getDateStatus(r.carrierLicenseSigned, 'carrierLicenseSigned')}">${formatDate(r.carrierLicenseSigned)}</td>
            <td class="text-center">
                ${defCount > 0 ? `<span class="badge status-expired">${defCount}</span>` : '<span class="text-gray-400">0</span>'}
            </td>
            <td class="whitespace-nowrap">
                <button onclick="openViewModal('${r.licenseNumber}')" class="view-btn" title="צפייה בכרטיס">&#128065;</button>
                <button onclick="openEditModal('${r.licenseNumber}')" class="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-blue-700">עריכה</button>
                <button onclick="confirmDelete('${r.licenseNumber}')" class="bg-red-100 text-red-700 px-3 py-1.5 rounded-lg text-sm hover:bg-red-200">מחיקה</button>
            </td>
        </tr>`;
    });

    html += '</tbody></table></div>';
    document.getElementById('manage-content').innerHTML = html;
}

// ============================================================
// Edit Modal
// ============================================================

let tempDeficiencies = [];
let tempContacts = [];
let editingLicenseNumber = '';
let editingOldInspectionDate = '';
let editingOldAppSynced = '';

// ============================================================
// Contacts editor (shared by add + edit forms)
// ============================================================

function contactsEditorHtml() {
    return `<div id="contacts-editor">${tempContacts.map((c, i) => contactRowHtml(c, i)).join('')}</div>
        <button type="button" onclick="addContactRow()" class="text-blue-600 text-base mt-1 py-2 hover:underline font-medium">+ הוסף איש קשר</button>`;
}

function contactRowHtml(contact, index) {
    return `<div class="contact-row" data-idx="${index}">
        <input type="text" value="${escapeText(contact.name || '')}" placeholder="שם איש קשר"
            oninput="updateContactField(${index},'name',this.value)" class="contact-name">
        <input type="tel" value="${escapeText(contact.phone || '')}" placeholder="טלפון" dir="ltr"
            inputmode="tel" oninput="updateContactField(${index},'phone',this.value)" class="contact-phone">
        <button type="button" onclick="removeContactRow(${index})" class="text-red-500 hover:text-red-700 text-2xl px-2" title="הסר">&times;</button>
    </div>`;
}

function addContactRow() {
    tempContacts.push({ name: '', phone: '' });
    refreshContactsEditor();
}

function updateContactField(index, field, value) {
    if (tempContacts[index]) tempContacts[index][field] = value;
}

function removeContactRow(index) {
    tempContacts.splice(index, 1);
    refreshContactsEditor();
}

function refreshContactsEditor() {
    const c = document.getElementById('contacts-editor');
    if (c) c.innerHTML = tempContacts.map((ct, i) => contactRowHtml(ct, i)).join('');
}

function collectContacts() {
    return tempContacts
        .map(c => ({ name: (c.name || '').trim(), phone: normalizePhone(c.phone) }))
        .filter(c => c.name || c.phone);
}

// ============================================================
// Custom field value collection
// ============================================================

function collectCustomFields(form) {
    const out = {};
    getCustomFields().forEach(f => {
        const el = form.elements['cf_' + f.key];
        if (!el) return;
        out[f.key] = f.type === 'date' ? parseDateInput(el.value) : el.value;
    });
    return out;
}

function openEditModal(licenseNumber) {
    const data = getData();
    const record = data.find(r => r.licenseNumber === licenseNumber || r.id === licenseNumber);
    if (!record) return;

    editingLicenseNumber = record.licenseNumber;
    editingOldInspectionDate = record.inspectionDate || '';
    editingOldAppSynced = record.appSynced || '';
    document.getElementById('modal-title').textContent = `עריכת רכב: ${record.licenseNumber} - ${record.customerName}`;

    const defs = loadDeficiencies();
    tempDeficiencies = JSON.parse(JSON.stringify(defs[record.licenseNumber] || []));
    tempContacts = getContacts(record).map(c => ({ name: c.name, phone: c.phone }));
    if (!tempContacts.length) tempContacts = [{ name: '', phone: '' }];

    let html = `<form id="edit-form" onsubmit="handleSaveEdit(event)">
        <input type="hidden" name="originalLicense" value="${record.licenseNumber}">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div class="modal-field">
                <label>שם לקוח</label>
                <input type="text" name="customerName" value="${record.customerName}" required>
            </div>
            <div class="modal-field">
                <label>מיקום</label>
                <input type="text" name="location" value="${record.location}" required>
            </div>
            <div class="modal-field">
                <label>מספר רישוי</label>
                <input type="text" name="licenseNumber" value="${record.licenseNumber}" required>
            </div>
            <div class="modal-field">
                <label>סוג רכב</label>
                <select name="vehicleType">
                    <option value="משא" ${record.vehicleType === 'משא' ? 'selected' : ''}>משא</option>
                    <option value="נגרר" ${record.vehicleType === 'נגרר' ? 'selected' : ''}>נגרר</option>
                </select>
            </div>
        </div>

        <h4 class="font-bold text-sm mt-4 mb-2 text-gray-700 border-b pb-1">פרטי רכב</h4>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div class="modal-field">
                <label>יצרן רכב</label>
                <input type="text" name="manufacturer" value="${record.manufacturer || ''}">
            </div>
            <div class="modal-field">
                <label>משקל כולל</label>
                <input type="text" name="totalWeight" value="${record.totalWeight || ''}">
            </div>
            <div class="modal-field">
                <label>מספר ק״מ</label>
                <input type="text" name="mileage" value="${record.mileage || ''}">
            </div>
            <div class="modal-field">
                <label>מורשה חומ״ס</label>
                <select name="hazmatCertified">
                    <option value="" ${!record.hazmatCertified ? 'selected' : ''}>-</option>
                    <option value="yes" ${record.hazmatCertified === 'yes' ? 'selected' : ''}>כן</option>
                    <option value="no" ${record.hazmatCertified === 'no' ? 'selected' : ''}>לא</option>
                </select>
            </div>
        </div>

        ${templateFieldsHtml(record)}

        <h4 class="font-bold text-sm mt-4 mb-2 text-gray-700 border-b pb-1">איש קשר</h4>
        <div class="modal-field"><label>כתובת</label><input type="text" name="address" value="${escapeText(record.address || '')}" placeholder="כתובת הלקוח / מוסך"></div>
        ${contactsEditorHtml()}

        <h4 class="font-bold text-sm mt-4 mb-2 text-gray-700 border-b pb-1">הערות</h4>
        <div class="modal-field"><textarea name="notes" rows="5" style="min-height:120px;resize:vertical" placeholder="הערות חופשיות לרכב...">${(record.notes || '').replace(/</g, '&lt;')}</textarea></div>

        <h4 class="font-bold text-sm mt-4 mb-2 text-gray-700 border-b pb-1">ליקויים</h4>
        <div id="deficiencies-list">${tempDeficiencies.map((d, i) => renderDeficiencyItem(d, i)).join('')}</div>
        <button type="button" onclick="addDeficiency()" class="text-blue-600 text-base mt-2 py-2 hover:underline font-medium">+ הוסף ליקוי</button>

        <div class="flex gap-3 mt-4 pt-3 border-t">
            <button type="submit" class="bg-blue-600 text-white px-8 py-3 rounded-lg hover:bg-blue-700 font-medium text-base">שמור שינויים</button>
            <button type="button" onclick="closeModal()" class="bg-gray-300 text-gray-700 px-8 py-3 rounded-lg hover:bg-gray-400 font-medium text-base">ביטול</button>
        </div>
    </form>`;

    document.getElementById('modal-content').innerHTML = html;
    document.getElementById('edit-modal').classList.remove('hidden');
}

function renderDeficiencyItem(def, index) {
    const statusClass = `deficiency-${def.status}`;
    return `<div class="deficiency-item ${statusClass}">
        <input type="text" value="${def.description}" onchange="updateDefField(${index},'description',this.value)"
            class="flex-1 border rounded px-2 py-1 text-sm" placeholder="תיאור הליקוי">
        <select onchange="updateDefField(${index},'status',this.value)" class="border rounded px-2 py-1 text-sm">
            <option value="open" ${def.status === 'open' ? 'selected' : ''}>פתוח</option>
            <option value="in-progress" ${def.status === 'in-progress' ? 'selected' : ''}>בטיפול</option>
            <option value="resolved" ${def.status === 'resolved' ? 'selected' : ''}>טופל</option>
        </select>
        <button type="button" onclick="removeDeficiency(${index})" class="text-red-500 hover:text-red-700 text-2xl px-2 py-1">&times;</button>
    </div>`;
}

function addDeficiency() {
    tempDeficiencies.push({ id: Date.now().toString(), description: '', status: 'open', createdAt: today() });
    refreshDeficienciesList();
}

function updateDefField(index, field, value) {
    if (tempDeficiencies[index]) {
        tempDeficiencies[index][field] = value;
        if (field === 'status' && value === 'resolved') tempDeficiencies[index].resolvedAt = today();
    }
}

function removeDeficiency(index) {
    tempDeficiencies.splice(index, 1);
    refreshDeficienciesList();
}

function refreshDeficienciesList() {
    const container = document.getElementById('deficiencies-list');
    if (container) container.innerHTML = tempDeficiencies.map((d, i) => renderDeficiencyItem(d, i)).join('');
}

async function handleSaveEdit(event) {
    event.preventDefault();
    const form = event.target;

    const record = {
        customerName: form.elements.customerName.value,
        location: form.elements.location.value,
        licenseNumber: form.elements.licenseNumber.value,
        originalLicenseNumber: form.elements.originalLicense.value, // original license to find row
        vehicleType: form.elements.vehicleType.value,
        manufacturer: form.elements.manufacturer.value,
        totalWeight: form.elements.totalWeight.value,
        mileage: form.elements.mileage.value,
        hazmatCertified: form.elements.hazmatCertified.value,
        ...collectBuiltinFields(form),
        inspectionDate: parseDateInput(form.elements.inspectionDate.value),
        address: form.elements.address ? form.elements.address.value : '',
        contacts: collectContacts(),
        notes: form.elements.notes ? form.elements.notes.value : '',
        customFields: collectCustomFields(form),
        appSynced: parseDateInput(form.elements.inspectionDate.value) !== editingOldInspectionDate ? 'no' : editingOldAppSynced
    };

    // Keep legacy single-contact columns in sync with the first contact
    record.contactName = record.contacts[0] ? record.contacts[0].name : '';
    record.contactPhone = record.contacts[0] ? record.contacts[0].phone : '';

    const success = await saveRecord(record);
    if (success) {
        await saveDeficiencyData(editingLicenseNumber, tempDeficiencies);
        closeModal();
        populateFilters();
        renderCurrentPage();
    }
}

function closeModal() {
    document.getElementById('edit-modal').classList.add('hidden');
}

// ============================================================
// View Modal (read-only card)
// ============================================================

function openViewModal(licenseNumber) {
    const data = getData();
    const record = data.find(r => r.licenseNumber === licenseNumber || r.id === licenseNumber);
    if (!record) return;

    document.getElementById('modal-title').textContent = `כרטיס רכב: ${record.licenseNumber} - ${record.customerName}`;

    const row = (label, value) => `<div class="view-field"><span class="view-label">${escapeText(label)}</span><span class="view-value">${value || '<span class="text-gray-400">-</span>'}</span></div>`;

    const dateRow = (field, label) => {
        const val = getDateFieldValue(record, field);
        if (!val) return row(label, '');
        const status = getDateStatus(val, field);
        return `<div class="view-field"><span class="view-label">${escapeText(label)}</span>
            <span class="view-value date-${status}">${formatDate(val)} <span class="text-xs">(${statusLabel(status)})</span></span></div>`;
    };

    const hazmat = record.hazmatCertified === 'yes' ? 'כן' : record.hazmatCertified === 'no' ? 'לא' : '';

    let html = `<div class="view-card">
        <div class="view-section-title">פרטים כלליים</div>
        ${row('שם לקוח', escapeText(record.customerName))}
        ${row('מיקום', escapeText(record.location))}
        ${row('מספר רישוי', escapeText(record.licenseNumber))}
        ${row('סוג רכב', escapeText(record.vehicleType))}

        <div class="view-section-title">פרטי רכב</div>
        ${row('יצרן רכב', escapeText(record.manufacturer))}
        ${row('משקל כולל', escapeText(record.totalWeight))}
        ${row('מספר ק״מ', escapeText(record.mileage))}
        ${row('מורשה חומ״ס', hazmat)}

        <div class="view-section-title">תאריכי תוקף</div>
        ${templateDateFields().filter(f => !f.hidden).map(f =>
            f.type === 'date' ? dateRow(f.key, f.label) : row(f.label, escapeText(record[f.key] || ''))).join('')}
        ${row('תאריך בדיקה אחרון', record.inspectionDate ? formatDate(record.inspectionDate) : '')}`;

    const customFields = getCustomFields();
    if (customFields.length) {
        html += `<div class="view-section-title">שדות נוספים</div>`;
        customFields.forEach(f => {
            if (f.type === 'date') html += dateRow(f.key, f.label);
            else html += row(f.label, escapeText((record.customFields || {})[f.key] || ''));
        });
    }

    html += `<div class="view-section-title">איש קשר</div>
        ${row('כתובת', escapeText(record.address))}`;
    const contacts = getContacts(record);
    if (contacts.length) {
        contacts.forEach(c => {
            const phone = c.phone ? `<a href="tel:${c.phone}" class="text-blue-600">${escapeText(c.phone)}</a>` : '';
            html += row(c.name || 'איש קשר', phone);
        });
    } else {
        html += row('אנשי קשר', '');
    }

    if ((record.notes || '').trim()) {
        html += `<div class="view-section-title">הערות</div>
            <div class="view-notes">${escapeText(record.notes).replace(/\n/g, '<br>')}</div>`;
    }

    const recDefs = (loadDeficiencies()[record.licenseNumber] || []);
    if (recDefs.length) {
        const defLabel = { open: 'פתוח', 'in-progress': 'בטיפול', resolved: 'טופל' };
        html += `<div class="view-section-title">ליקויים</div>`;
        recDefs.forEach(d => {
            html += `<div class="view-field"><span class="view-value">${escapeText(d.description)}</span>
                <span class="badge deficiency-${d.status} view-def-badge">${defLabel[d.status] || d.status}</span></div>`;
        });
    }

    html += `</div>
        <div class="flex gap-3 mt-4 pt-3 border-t">
            <button type="button" onclick="openEditModal('${record.licenseNumber}')" class="bg-blue-600 text-white px-8 py-3 rounded-lg hover:bg-blue-700 font-medium text-base">עריכה</button>
            <button type="button" onclick="closeModal()" class="bg-gray-300 text-gray-700 px-8 py-3 rounded-lg hover:bg-gray-400 font-medium text-base">סגור</button>
        </div>`;

    document.getElementById('modal-content').innerHTML = html;
    document.getElementById('edit-modal').classList.remove('hidden');
}

async function toggleAppSync(licenseNumber) {
    const data = getData();
    const record = data.find(r => r.licenseNumber === licenseNumber);
    if (!record) return;

    const newValue = record.appSynced === 'yes' ? 'no' : 'yes';
    record.appSynced = newValue;
    renderCurrentPage();

    try {
        await apiAction('updateAppSync', { licenseNumber, value: newValue });
        showSaveIndicator('עודכן בהצלחה');
    } catch (err) {
        showSaveIndicator('שגיאה בעדכון: ' + err.message, true);
        record.appSynced = record.appSynced === 'yes' ? 'no' : 'yes';
        renderCurrentPage();
    }
}

// ============================================================
// Customer Autocomplete
// ============================================================

function getUniqueCustomers() {
    const data = getData();
    const map = {};
    data.forEach(r => {
        if (r.customerName && !map[r.customerName]) {
            map[r.customerName] = r.location || '';
        }
    });
    return map;
}

function showCustomerSuggestions(input) {
    const dropdown = document.getElementById('customer-suggestions');
    const val = input.value.trim();
    if (!val) { dropdown.innerHTML = ''; dropdown.style.display = 'none'; return; }
    const customers = getUniqueCustomers();
    const matches = Object.keys(customers).filter(name => name.startsWith(val));
    if (matches.length === 0 || (matches.length === 1 && matches[0] === val)) {
        dropdown.innerHTML = ''; dropdown.style.display = 'none'; return;
    }
    dropdown.innerHTML = matches.map((name, i) =>
        `<div class="suggestion-item" data-idx="${i}" onmousedown="selectCustomerByIdx(${i})">${name}</div>`
    ).join('');
    dropdown._matches = matches;
    dropdown._customers = customers;
    dropdown.style.display = 'block';
}

function selectCustomerByIdx(idx) {
    const dropdown = document.getElementById('customer-suggestions');
    const name = dropdown._matches[idx];
    const location = dropdown._customers[name] || '';
    selectCustomer(name, location);
}

function selectCustomer(name, location) {
    const form = document.getElementById('add-form');
    form.elements.customerName.value = name;
    if (location) form.elements.location.value = location;
    const dropdown = document.getElementById('customer-suggestions');
    dropdown.innerHTML = ''; dropdown.style.display = 'none';
}

// ============================================================
// Add New Record
// ============================================================

function showAddForm() {
    document.getElementById('modal-title').textContent = 'הוספת רשומה חדשה';
    tempDeficiencies = [];
    tempContacts = [{ name: '', phone: '' }];

    let html = `<form id="add-form" onsubmit="handleAddRecord(event)">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div class="modal-field" style="position:relative"><label>שם לקוח</label><input type="text" name="customerName" required autocomplete="off" oninput="showCustomerSuggestions(this)"><div id="customer-suggestions" class="suggestions-dropdown"></div></div>
            <div class="modal-field"><label>מיקום</label><input type="text" name="location" required></div>
            <div class="modal-field"><label>מספר רישוי</label><input type="text" name="licenseNumber" required></div>
            <div class="modal-field">
                <label>סוג רכב</label>
                <select name="vehicleType"><option value="משא">משא</option><option value="נגרר">נגרר</option></select>
            </div>
        </div>
        <h4 class="font-bold text-sm mt-4 mb-2 text-gray-700 border-b pb-1">פרטי רכב</h4>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div class="modal-field"><label>יצרן רכב</label><input type="text" name="manufacturer"></div>
            <div class="modal-field"><label>משקל כולל</label><input type="text" name="totalWeight"></div>
            <div class="modal-field"><label>מספר ק״מ</label><input type="text" name="mileage"></div>
            <div class="modal-field">
                <label>מורשה חומ״ס</label>
                <select name="hazmatCertified"><option value="">-</option><option value="yes">כן</option><option value="no">לא</option></select>
            </div>
        </div>
        ${templateFieldsHtml(null)}

        <h4 class="font-bold text-sm mt-4 mb-2 text-gray-700 border-b pb-1">איש קשר</h4>
        <div class="modal-field"><label>כתובת</label><input type="text" name="address" placeholder="כתובת הלקוח / מוסך"></div>
        ${contactsEditorHtml()}
        <h4 class="font-bold text-sm mt-4 mb-2 text-gray-700 border-b pb-1">הערות</h4>
        <div class="modal-field"><textarea name="notes" rows="5" style="min-height:120px;resize:vertical" placeholder="הערות חופשיות לרכב..."></textarea></div>
        <div class="flex gap-3 mt-4 pt-3 border-t">
            <button type="submit" class="bg-green-600 text-white px-8 py-3 rounded-lg hover:bg-green-700 font-medium text-base">הוסף</button>
            <button type="button" onclick="closeModal()" class="bg-gray-300 text-gray-700 px-8 py-3 rounded-lg hover:bg-gray-400 font-medium text-base">ביטול</button>
        </div>
    </form>`;

    document.getElementById('modal-content').innerHTML = html;
    document.getElementById('edit-modal').classList.remove('hidden');
}

async function handleAddRecord(event) {
    event.preventDefault();
    const form = event.target;
    const record = {};
    ['customerName', 'location', 'licenseNumber', 'vehicleType',
     'manufacturer', 'totalWeight', 'mileage', 'hazmatCertified', 'address', 'notes'
    ].forEach(f => { record[f] = form.elements[f]?.value || ''; });

    Object.assign(record, collectBuiltinFields(form));
    record.inspectionDate = parseDateInput(form.elements.inspectionDate?.value || '');

    record.contacts = collectContacts();
    record.contactName = record.contacts[0] ? record.contacts[0].name : '';
    record.contactPhone = record.contacts[0] ? record.contacts[0].phone : '';
    record.customFields = collectCustomFields(form);

    const success = await addNewRecord(record);
    if (success) {
        closeModal();
        populateFilters();
        renderManagePage();
    }
}

// ============================================================
// Delete
// ============================================================

async function confirmDelete(licenseNumber) {
    const record = getData().find(r => r.licenseNumber === licenseNumber);
    if (!record) return;
    if (confirm(`האם למחוק את הרשומה של רכב ${record.licenseNumber} (${record.customerName})?`)) {
        await deleteRecord(licenseNumber);
        populateFilters();
        renderManagePage();
    }
}

// ============================================================
// Export CSV
// ============================================================

function exportData() {
    const data = getData();
    const deficiencies = loadDeficiencies();

    const headers = ['שם לקוח', 'מיקום', 'רישוי', 'סוג רכב', 'יצרן', 'משקל כולל', 'ק״מ', 'חומ״ס',
        'תוקף רישוי', 'ביטוח חובה', 'כיול', 'בלמים ח״ש', 'מוביל', 'רמפה/מנוף', 'חורף', 'נחתם מוביל',
        'בדיקה', 'כתובת', 'אנשי קשר', 'ליקויים פתוחים', 'הערות'];

    const rows = data.map(r => {
        const openDefs = (deficiencies[r.licenseNumber] || []).filter(d => d.status !== 'resolved').length;
        const notesCsv = (r.notes || '').replace(/"/g, '""').replace(/\r?\n/g, ' ');
        const contactsCsv = getContacts(r).map(c => `${c.name}${c.phone ? ' ' + c.phone : ''}`).join(' | ');
        return [r.customerName, r.location, r.licenseNumber, r.vehicleType,
            r.manufacturer || '', r.totalWeight || '', r.mileage || '', r.hazmatCertified || '',
            r.licenseExpiry, r.mandatoryInsurance,
            r.calibrationExpiry, r.brakeTestExpiry,
            r.carrierLicense, r.rampCraneInspection || '', r.winterInspection || '', r.carrierLicenseSigned || '',
            r.inspectionDate, r.address || '', contactsCsv, openDefs, notesCsv
        ].map(v => `"${v}"`).join(',');
    });

    const csv = '\uFEFF' + headers.join(',') + '\n' + rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vehicles-${today()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

// ============================================================
// Refresh button
// ============================================================

async function refreshData() {
    const success = await loadAllData();
    if (success) {
        populateFilters();
        renderCurrentPage();
    }
}

// ============================================================
// Settings hub (gear icon) — connection + card template editor
// ============================================================

function showSettings() {
    document.getElementById('modal-title').textContent = 'הגדרות';
    const html = `<div class="settings-hub">
        <button type="button" onclick="showConnectionSettings()" class="settings-hub-btn">
            <div class="settings-hub-icon">&#128279;</div>
            <div>
                <div class="settings-hub-title">הגדרות חיבור</div>
                <div class="settings-hub-desc">כתובת ה-Google Apps Script</div>
            </div>
        </button>
        <button type="button" onclick="showTemplateEditor()" class="settings-hub-btn">
            <div class="settings-hub-icon">&#128203;</div>
            <div>
                <div class="settings-hub-title">עריכת תבנית כרטיס רכב</div>
                <div class="settings-hub-desc">שמות שדות, שדות נוספים וזמני התראה (פג תוקף)</div>
            </div>
        </button>
    </div>`;
    document.getElementById('modal-content').innerHTML = html;
    document.getElementById('edit-modal').classList.remove('hidden');
}

function showConnectionSettings() {
    document.getElementById('modal-title').textContent = 'הגדרות חיבור';
    const currentUrl = APPS_SCRIPT_URL || '';

    let html = `<form onsubmit="saveSettings(event)">
        <div class="modal-field">
            <label>כתובת Google Apps Script URL</label>
            <input type="url" id="settings-url" value="${currentUrl}" placeholder="https://script.google.com/macros/s/..." class="text-left" dir="ltr" required>
            <p class="text-xs text-gray-500 mt-1">הכתובת שמקבלים אחרי Deploy של ה-Apps Script</p>
        </div>
        <div class="flex gap-3 mt-4">
            <button type="submit" class="bg-blue-600 text-white px-8 py-3 rounded-lg hover:bg-blue-700 font-medium text-base">שמור וחבר</button>
            <button type="button" onclick="closeModal()" class="bg-gray-300 text-gray-700 px-8 py-3 rounded-lg hover:bg-gray-400 font-medium text-base">ביטול</button>
        </div>
    </form>`;

    document.getElementById('modal-content').innerHTML = html;
    document.getElementById('edit-modal').classList.remove('hidden');
}

async function saveSettings(event) {
    event.preventDefault();
    const url = document.getElementById('settings-url').value.trim();
    APPS_SCRIPT_URL = url;
    localStorage.setItem('apps_script_url', url);
    closeModal();

    const success = await loadAllData();
    if (success) {
        document.getElementById('setup-banner').classList.add('hidden');
        populateFilters();
        renderCurrentPage();
    } else {
        document.getElementById('setup-banner').classList.remove('hidden');
        showStatus('שגיאה בחיבור', true);
    }
}

// ============================================================
// Card Template Editor
// ============================================================

let tempConfig = null;

function showTemplateEditor() {
    tempConfig = normalizeConfig(JSON.parse(JSON.stringify(_config)));
    document.getElementById('modal-title').textContent = 'עריכת תבנית כרטיס רכב';
    renderTemplateEditor();
    document.getElementById('edit-modal').classList.remove('hidden');
}

function renderTemplateEditor() {
    const builtinRows = DATE_FIELDS.map(f => builtinFieldEditorRow(f)).join('');

    const customRows = tempConfig.customFields.length
        ? tempConfig.customFields.map((cf, i) => customFieldEditorRow(cf, i)).join('')
        : '<div class="text-xs text-gray-400 mb-2">אין שדות נוספים. ניתן להוסיף שדה חדש למטה.</div>';

    const html = `
        <p class="text-xs text-gray-500 mb-3">שינוי שמות שדות, סוג השדה, ערכים לבחירה, מספר הימים לפני שתאריך נחשב כ"פג תוקף" (התראה), הסתרת שדות והוספת שדות חדשים לכרטיס הרכב.</p>

        <h4 class="font-bold text-sm mt-2 mb-2 text-gray-700 border-b pb-1">שדות קיימים</h4>
        ${builtinRows}

        <h4 class="font-bold text-sm mt-4 mb-2 text-gray-700 border-b pb-1">שדות נוספים</h4>
        <div id="tpl-custom-list">${customRows}</div>
        <button type="button" onclick="tplAddCustomField()" class="text-blue-600 text-base mt-1 py-2 hover:underline font-medium">+ הוסף שדה</button>

        <div class="flex gap-3 mt-4 pt-3 border-t">
            <button type="button" onclick="saveTemplateEditor()" class="bg-blue-600 text-white px-8 py-3 rounded-lg hover:bg-blue-700 font-medium text-base">שמור תבנית</button>
            <button type="button" onclick="showSettings()" class="bg-gray-300 text-gray-700 px-8 py-3 rounded-lg hover:bg-gray-400 font-medium text-base">חזרה</button>
        </div>`;
    document.getElementById('modal-content').innerHTML = html;
}

// Editor row for a built-in field — same controls as a new (custom) field
function builtinFieldEditorRow(key) {
    const label = tempConfig.labels[key] != null ? tempConfig.labels[key] : DEFAULT_FIELD_LABELS[key];
    const type = tempConfig.fieldTypes[key] || 'date';
    const days = tempConfig.expiryDays[key] != null ? tempConfig.expiryDays[key] : DEFAULT_EXPIRY_DAYS;
    const options = (tempConfig.fieldOptions[key] || []).join(', ');
    const hidden = !!tempConfig.hidden[key];
    return `<div class="tpl-custom-row ${hidden ? 'tpl-hidden' : ''}">
        <div class="tpl-custom-main">
            <input type="text" value="${escapeText(label)}" placeholder="${escapeText(DEFAULT_FIELD_LABELS[key])}"
                oninput="tplSetLabel('${key}', this.value)" class="tpl-label">
            <select onchange="tplSetBuiltinType('${key}', this.value)">
                <option value="date" ${type === 'date' ? 'selected' : ''}>תאריך</option>
                <option value="text" ${type === 'text' ? 'selected' : ''}>טקסט</option>
                <option value="select" ${type === 'select' ? 'selected' : ''}>בחירה מרשימה</option>
            </select>
            <button type="button" onclick="tplToggleHidden('${key}')" class="tpl-eye-btn" title="${hidden ? 'הצג בכרטיס' : 'הסתר מהכרטיס'}">${hidden ? '&#128683;' : '&#128065;'}</button>
        </div>
        ${type === 'date' ? `<div class="tpl-days"><input type="number" min="0" value="${days}" oninput="tplSetDays('${key}', this.value)"><span>ימים להתראה</span></div>` : ''}
        ${type === 'select' ? `<input type="text" value="${escapeText(options)}" placeholder="ערכים מופרדים בפסיק" oninput="tplSetBuiltinOptions('${key}', this.value)" class="tpl-options">` : ''}
    </div>`;
}

function tplSetBuiltinType(key, type) {
    if (type === 'date') delete tempConfig.fieldTypes[key];
    else tempConfig.fieldTypes[key] = type;
    if (type === 'select' && !Array.isArray(tempConfig.fieldOptions[key])) tempConfig.fieldOptions[key] = [];
    renderTemplateEditor();
}

function tplSetBuiltinOptions(key, value) {
    tempConfig.fieldOptions[key] = value.split(',').map(s => s.trim()).filter(Boolean);
}

function tplToggleHidden(key) {
    if (tempConfig.hidden[key]) delete tempConfig.hidden[key];
    else tempConfig.hidden[key] = true;
    renderTemplateEditor();
}

function customFieldEditorRow(cf, i) {
    const isDate = cf.type === 'date';
    const isSelect = cf.type === 'select';
    return `<div class="tpl-custom-row">
        <div class="tpl-custom-main">
            <input type="text" value="${escapeText(cf.label || '')}" placeholder="שם השדה"
                oninput="tplSetCustom(${i},'label',this.value)" class="tpl-label">
            <select onchange="tplSetCustomType(${i}, this.value)">
                <option value="text" ${cf.type === 'text' ? 'selected' : ''}>טקסט</option>
                <option value="date" ${isDate ? 'selected' : ''}>תאריך</option>
                <option value="select" ${isSelect ? 'selected' : ''}>בחירה מרשימה</option>
            </select>
            <button type="button" onclick="tplRemoveCustom(${i})" class="text-red-500 hover:text-red-700 text-2xl px-2" title="הסר">&times;</button>
        </div>
        ${isDate ? `<div class="tpl-days"><input type="number" min="0" value="${cf.expiryDays != null ? cf.expiryDays : DEFAULT_EXPIRY_DAYS}" oninput="tplSetCustom(${i},'expiryDays',this.value)"><span>ימים להתראה</span></div>` : ''}
        ${isSelect ? `<input type="text" value="${escapeText((cf.options || []).join(', '))}" placeholder="ערכים מופרדים בפסיק" oninput="tplSetCustomOptions(${i}, this.value)" class="tpl-options">` : ''}
    </div>`;
}

function tplSetLabel(field, value) {
    if (value && value.trim()) tempConfig.labels[field] = value.trim();
    else delete tempConfig.labels[field];
}

function tplSetDays(field, value) {
    const n = parseInt(value, 10);
    tempConfig.expiryDays[field] = isNaN(n) || n < 0 ? DEFAULT_EXPIRY_DAYS : n;
}

function tplSetCustom(i, field, value) {
    if (!tempConfig.customFields[i]) return;
    if (field === 'expiryDays') {
        const n = parseInt(value, 10);
        tempConfig.customFields[i].expiryDays = isNaN(n) || n < 0 ? DEFAULT_EXPIRY_DAYS : n;
    } else {
        tempConfig.customFields[i][field] = value;
    }
}

function tplSetCustomType(i, type) {
    if (!tempConfig.customFields[i]) return;
    tempConfig.customFields[i].type = type;
    if (type === 'select' && !Array.isArray(tempConfig.customFields[i].options)) {
        tempConfig.customFields[i].options = [];
    }
    if (type === 'date' && tempConfig.customFields[i].expiryDays == null) {
        tempConfig.customFields[i].expiryDays = DEFAULT_EXPIRY_DAYS;
    }
    renderTemplateEditor();
}

function tplSetCustomOptions(i, value) {
    if (!tempConfig.customFields[i]) return;
    tempConfig.customFields[i].options = value.split(',').map(s => s.trim()).filter(Boolean);
}

function tplAddCustomField() {
    const key = 'cf_' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
    tempConfig.customFields.push({ key, label: '', type: 'text', expiryDays: DEFAULT_EXPIRY_DAYS, options: [] });
    renderTemplateEditor();
}

function tplRemoveCustom(i) {
    tempConfig.customFields.splice(i, 1);
    renderTemplateEditor();
}

async function saveTemplateEditor() {
    // Drop custom fields without a label; ensure every field has a stable key
    tempConfig.customFields = tempConfig.customFields
        .filter(cf => cf.label && cf.label.trim())
        .map(cf => {
            cf.label = cf.label.trim();
            if (!cf.key) cf.key = 'cf_' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
            if (cf.type !== 'select') delete cf.options;
            if (cf.type !== 'date') delete cf.expiryDays;
            return cf;
        });

    await saveConfig(tempConfig);
    closeModal();
    populateFilters();
    renderCurrentPage();
}

// ============================================================
// Initialize
// ============================================================

async function init() {
    loadConfigFromCache();
    // Check if API URL is configured
    if (!APPS_SCRIPT_URL) {
        showStatus('לא מוגדר חיבור', true);
        document.getElementById('setup-banner').classList.remove('hidden');
    } else {
        const success = await loadAllData();
        if (success) {
            document.getElementById('setup-banner').classList.add('hidden');
        } else {
            document.getElementById('setup-banner').classList.remove('hidden');
        }
    }

    populateFilters();
    navigate('dashboard');
}

// Modal backdrop click
document.getElementById('edit-modal').addEventListener('click', function(e) {
    if (e.target === this) closeModal();
});

// Escape key
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeModal();
});

init();
