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

// Field labels in Hebrew
const FIELD_LABELS = {
    licenseExpiry: 'תוקף רישוי',
    mandatoryInsurance: 'ביטוח חובה',
    comprehensiveInsurance: 'ביטוח מקיף',
    calibrationExpiry: 'כיול',
    equipmentExpiry: 'ציוד יעודי',
    brakeTestExpiry: 'בדיקת בלמים',
    carrierLicense: 'רשיון מוביל'
};

const DATE_FIELDS = Object.keys(FIELD_LABELS);

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
        const [vehicleResp, defResp, sheetNameResp] = await Promise.all([
            apiGet('getData'),
            apiGet('getDeficiencies'),
            apiGet('getSheetName')
        ]);

        if (vehicleResp.error) throw new Error(vehicleResp.error);
        _vehicleData = vehicleResp.data || [];
        _deficiencyData = (defResp.data) || {};

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

// ============================================================
// Data Saving
// ============================================================

async function saveRecord(record) {
    // Update local cache immediately for fast UI
    const idx = _vehicleData.findIndex(r => r.licenseNumber === record.licenseNumber);
    if (idx !== -1) {
        Object.assign(_vehicleData[idx], record);
        _vehicleData[idx].id = record.licenseNumber;
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

function getDateStatus(dateStr) {
    if (!dateStr) return 'empty';
    const days = daysUntil(dateStr);
    if (days < 0) return 'expired';
    if (days <= 2) return 'critical';
    if (days <= 30) return 'warning';
    return 'valid';
}

function getRecordWorstStatus(record) {
    let worst = 'valid';
    const priority = { expired: 0, critical: 1, warning: 2, valid: 3, empty: 4 };
    for (const field of DATE_FIELDS) {
        const val = record[field];
        if (!val) continue;
        const status = getDateStatus(val);
        if (status === 'empty') continue;
        if (priority[status] < priority[worst]) {
            worst = status;
        }
    }
    return worst;
}

function formatDate(dateStr) {
    if (!dateStr) return '-';
    const parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
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
    const locations = [...new Set(data.map(r => r.location))].sort();
    const customers = [...new Set(data.map(r => r.customerName))].sort();

    ['dash-location', 'work-location'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const current = el.value;
        el.innerHTML = '<option value="">הכל</option>';
        locations.forEach(loc => {
            el.innerHTML += `<option value="${loc}" ${loc === current ? 'selected' : ''}>${loc}</option>`;
        });
    });

    const workCust = document.getElementById('work-customer');
    if (workCust) {
        const current = workCust.value;
        workCust.innerHTML = '<option value="">הכל</option>';
        customers.forEach(c => {
            workCust.innerHTML += `<option value="${c}" ${c === current ? 'selected' : ''}>${c}</option>`;
        });
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
        if (location && r.location !== location) return false;
        if (vType && r.vehicleType !== vType) return false;
        if (statusFilter) {
            const worst = getRecordWorstStatus(r);
            if (statusFilter !== worst) return false;
        }
        return true;
    });

    // Summary cards
    const uniqueCustomers = new Set(data.map(r => r.customerName)).size;
    let expired = 0, critical = 0, warning = 0, valid = 0;
    data.forEach(r => {
        const s = getRecordWorstStatus(r);
        if (s === 'expired') expired++;
        else if (s === 'critical') critical++;
        else if (s === 'warning') warning++;
        else valid++;
    });

    function clearFilters() {
        document.getElementById('dash-status').value='';
        document.getElementById('dash-search').value='';
        document.getElementById('dash-location').value='';
        document.getElementById('dash-type').value='';
        renderDashboard();
    }

    document.getElementById('summary-cards').innerHTML = `
        <div class="summary-card bg-white border-r-4 border-blue-500 cursor-pointer" onclick="clearFilters()">
            <div class="text-3xl font-bold text-blue-600">${data.length}</div>
            <div class="text-sm text-gray-600">סה"כ כלי רכב</div>
            <div class="text-xs text-gray-400 mt-1">${uniqueCustomers} לקוחות</div>
        </div>
        <div class="summary-card bg-white border-r-4 border-red-500 cursor-pointer" onclick="document.getElementById('dash-status').value='expired';renderDashboard()">
            <div class="text-3xl font-bold text-red-600">${expired}</div>
            <div class="text-sm text-gray-600">כלי רכב פגי תוקף</div>
        </div>
        <div class="summary-card bg-white border-r-4 border-orange-500 cursor-pointer" onclick="document.getElementById('dash-status').value='critical';renderDashboard()">
            <div class="text-3xl font-bold text-orange-600">${critical}</div>
            <div class="text-sm text-gray-600">כלי רכב פוקעים ביומיים הקרובים</div>
        </div>
        <div class="summary-card bg-white border-r-4 border-yellow-500 cursor-pointer" onclick="document.getElementById('dash-status').value='warning';renderDashboard()">
            <div class="text-3xl font-bold text-yellow-600">${warning}</div>
            <div class="text-sm text-gray-600">פוקעים ב-30 יום</div>
        </div>
        <div class="summary-card bg-white border-r-4 border-green-500 cursor-pointer" onclick="document.getElementById('dash-status').value='valid';renderDashboard()">
            <div class="text-3xl font-bold text-green-600">${valid}</div>
            <div class="text-sm text-gray-600">כלי רכב תקינים</div>
        </div>
    `;

    // Group by customer
    const byCustomer = {};
    filtered.forEach(r => {
        if (!byCustomer[r.customerName]) {
            byCustomer[r.customerName] = {
                location: r.location,
                contact: r.contactName,
                phone: r.contactPhone,
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

    Object.entries(byCustomer).sort((a, b) => a[0].localeCompare(b[0], 'he')).forEach(([name, info]) => {
        const worstStatuses = info.vehicles.map(v => getRecordWorstStatus(v));
        const priority = { expired: 0, critical: 1, warning: 2, valid: 3 };
        const worst = worstStatuses.reduce((a, b) => priority[a] < priority[b] ? a : b, 'valid');

        const escapedName = name.replace(/'/g, "\\'");
        html += `<tr class="cursor-pointer" onclick="toggleCustomerExpand(this, '${escapedName}')">
            <td class="text-center">&#9654;</td>
            <td class="font-medium">${name}</td>
            <td>${info.location}</td>
            <td>${info.vehicles.length}</td>
            <td><span class="badge status-${worst}">${statusLabel(worst)}</span></td>
            <td>${info.contact}</td>
            <td><a href="tel:${info.phone}" class="text-blue-600 hover:underline">${info.phone}</a></td>
        </tr>`;
    });

    html += '</tbody></table></div>';
    document.getElementById('dashboard-content').innerHTML = html;
}

function toggleCustomerExpand(row, customerName) {
    const existing = row.nextElementSibling;
    if (existing && existing.classList.contains('vehicle-detail-row')) {
        existing.remove();
        row.querySelector('td:first-child').innerHTML = '&#9654;';
        row.classList.remove('expanded-row');
        return;
    }

    document.querySelectorAll('.vehicle-detail-row').forEach(r => r.remove());
    document.querySelectorAll('.expanded-row').forEach(r => {
        r.classList.remove('expanded-row');
        r.querySelector('td:first-child').innerHTML = '&#9654;';
    });

    row.classList.add('expanded-row');
    row.querySelector('td:first-child').innerHTML = '&#9660;';

    const data = getData().filter(r => r.customerName === customerName);
    let detailHtml = '<td colspan="7" class="p-0"><div class="vehicle-detail bg-blue-50 p-4">';
    detailHtml += '<table class="data-table" style="font-size:0.75rem">';
    detailHtml += `<thead><tr>
        <th>רישוי</th><th>סוג</th><th>תוקף רישוי</th><th>ביטוח חובה</th>
        <th>ביטוח מקיף</th><th>כיול</th><th>ציוד</th><th>בלמים</th>
        <th>מוביל</th><th>בדיקה</th><th>פעולות</th>
    </tr></thead><tbody>`;

    data.forEach(v => {
        detailHtml += `<tr>
            <td class="font-medium">${v.licenseNumber}</td>
            <td>${v.vehicleType}</td>
            <td class="date-${getDateStatus(v.licenseExpiry)}">${formatDate(v.licenseExpiry)}</td>
            <td class="date-${getDateStatus(v.mandatoryInsurance)}">${formatDate(v.mandatoryInsurance)}</td>
            <td class="date-${getDateStatus(v.comprehensiveInsurance)}">${formatDate(v.comprehensiveInsurance)}</td>
            <td class="date-${getDateStatus(v.calibrationExpiry)}">${formatDate(v.calibrationExpiry)}</td>
            <td class="date-${getDateStatus(v.equipmentExpiry)}">${formatDate(v.equipmentExpiry)}</td>
            <td class="date-${getDateStatus(v.brakeTestExpiry)}">${formatDate(v.brakeTestExpiry)}</td>
            <td class="date-${getDateStatus(v.carrierLicense)}">${formatDate(v.carrierLicense)}</td>
            <td>${formatDate(v.inspectionDate)}</td>
            <td><button onclick="event.stopPropagation();openEditModal('${v.licenseNumber}')" class="text-blue-600 hover:underline text-xs">עריכה</button></td>
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

function renderWorkPage() {
    const data = getData();
    const location = document.getElementById('work-location')?.value || '';
    const customer = document.getElementById('work-customer')?.value || '';
    const fieldFilter = document.getElementById('work-field')?.value || '';

    const alerts = { expired: [], critical: [], warning: [] };

    data.forEach(record => {
        if (location && record.location !== location) return;
        if (customer && record.customerName !== customer) return;

        const fieldsToCheck = fieldFilter ? [fieldFilter] : DATE_FIELDS;

        fieldsToCheck.forEach(field => {
            const val = record[field];
            if (!val) return;
            const status = getDateStatus(val);
            if (status === 'expired' || status === 'critical' || status === 'warning') {
                alerts[status].push({
                    record,
                    field,
                    fieldLabel: FIELD_LABELS[field],
                    date: val,
                    daysLeft: daysUntil(val)
                });
            }
        });
    });

    Object.values(alerts).forEach(arr => arr.sort((a, b) => a.daysLeft - b.daysLeft));

    let html = '';
    html += renderWorkSection('expired', 'פג תוקף - חמור!', alerts.expired, 'bg-red-600 text-white');
    html += renderWorkSection('critical', 'פוקע ב-1-2 ימים', alerts.critical, 'bg-orange-500 text-white');
    html += renderWorkSection('warning', 'פוקע ב-30 יום הקרובים', alerts.warning, 'bg-yellow-400 text-yellow-900');

    if (!alerts.expired.length && !alerts.critical.length && !alerts.warning.length) {
        html = `<div class="bg-green-50 border border-green-200 rounded-lg p-8 text-center">
            <div class="text-4xl mb-2">&#10003;</div>
            <div class="text-lg font-bold text-green-700">אין התראות!</div>
            <div class="text-sm text-green-600">כל הרישיונות תקינים בטווח הסינון הנוכחי</div>
        </div>`;
    }

    document.getElementById('work-content').innerHTML = html;
}

function renderWorkSection(type, title, items, headerClass) {
    if (!items.length) return '';

    // Group by location → customer → vehicle (license number)
    const grouped = {};
    items.forEach(item => {
        const loc = item.record.location;
        const cust = item.record.customerName;
        const license = item.record.licenseNumber;
        const locKey = loc;
        const custKey = `${loc}|||${cust}`;
        const vehKey = `${loc}|||${cust}|||${license}`;

        if (!grouped[locKey]) grouped[locKey] = { location: loc, customers: {} };
        if (!grouped[locKey].customers[custKey]) {
            grouped[locKey].customers[custKey] = {
                customer: cust,
                contact: item.record.contactName,
                phone: item.record.contactPhone,
                vehicles: {}
            };
        }
        if (!grouped[locKey].customers[custKey].vehicles[vehKey]) {
            grouped[locKey].customers[custKey].vehicles[vehKey] = {
                licenseNumber: license,
                vehicleType: item.record.vehicleType,
                record: item.record
            };
        }
    });

    // Count unique vehicles
    let vehicleCount = 0;
    Object.values(grouped).forEach(loc => {
        Object.values(loc.customers).forEach(cust => {
            vehicleCount += Object.keys(cust.vehicles).length;
        });
    });

    const fieldFilter = document.getElementById('work-field')?.value || '';
    const fieldsToShow = fieldFilter ? [fieldFilter] : DATE_FIELDS;
    const totalCols = fieldsToShow.length + 3; // vehicle + type + fields + button

    let html = `<div class="work-section">
        <div class="work-section-header ${headerClass}">
            <span>${title}</span>
            <span class="text-sm font-normal">${vehicleCount} כלי רכב | ${items.length} פריטים</span>
        </div>
        <div class="table-container">
        <table class="work-table">
            <thead><tr>
                <th>רכב</th>
                <th>סוג</th>
                ${fieldsToShow.map(f => `<th>${FIELD_LABELS[f]}</th>`).join('')}
                <th></th>
            </tr></thead>
            <tbody>`;

    // Sort locations
    const sortedLocations = Object.values(grouped).sort((a, b) =>
        a.location.localeCompare(b.location, 'he'));

    sortedLocations.forEach(locGroup => {
        html += `<tr class="work-location-row"><td colspan="${totalCols}">${locGroup.location}</td></tr>`;

        const sortedCustomers = Object.values(locGroup.customers).sort((a, b) =>
            a.customer.localeCompare(b.customer, 'he'));

        sortedCustomers.forEach(custGroup => {
            html += `<tr class="work-customer-row"><td colspan="${totalCols}">
                ${custGroup.customer}
                <span class="text-gray-500">(${custGroup.contact} -
                <a href="tel:${custGroup.phone}" class="text-blue-600">${custGroup.phone}</a>)</span>
            </td></tr>`;

            Object.values(custGroup.vehicles).forEach(vehicle => {
                const rec = vehicle.record;
                html += `<tr class="work-vehicle-row">
                    <td class="font-bold">${vehicle.licenseNumber}</td>
                    <td class="text-gray-500">${vehicle.vehicleType}</td>`;

                fieldsToShow.forEach(field => {
                    const val = rec[field];
                    const status = getDateStatus(val);
                    if (!val) {
                        html += `<td class="work-cell work-cell-empty">-</td>`;
                    } else {
                        const days = daysUntil(val);
                        const daysText = days < 0
                            ? `פג לפני ${Math.abs(days)} ימים`
                            : days === 0 ? 'פג היום!'
                            : `עוד ${days} ימים`;
                        html += `<td class="work-cell work-cell-${status}">
                            <div>${formatDate(val)}</div>
                            <div class="work-cell-days">${daysText}</div>
                        </td>`;
                    }
                });

                html += `<td>
                    <button onclick="openEditModal('${vehicle.licenseNumber}')"
                        class="bg-blue-600 text-white px-3 py-1 rounded text-xs hover:bg-blue-700 whitespace-nowrap">
                        עדכן
                    </button>
                </td></tr>`;
            });
        });
    });

    html += '</tbody></table></div></div>';
    return html;
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
        <th>תוקף רישוי</th><th>ביטוח חובה</th><th>ביטוח מקיף</th>
        <th>כיול</th><th>ציוד</th><th>בלמים</th><th>מוביל</th>
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
            <td class="date-${getDateStatus(r.licenseExpiry)}">${formatDate(r.licenseExpiry)}</td>
            <td class="date-${getDateStatus(r.mandatoryInsurance)}">${formatDate(r.mandatoryInsurance)}</td>
            <td class="date-${getDateStatus(r.comprehensiveInsurance)}">${formatDate(r.comprehensiveInsurance)}</td>
            <td class="date-${getDateStatus(r.calibrationExpiry)}">${formatDate(r.calibrationExpiry)}</td>
            <td class="date-${getDateStatus(r.equipmentExpiry)}">${formatDate(r.equipmentExpiry)}</td>
            <td class="date-${getDateStatus(r.brakeTestExpiry)}">${formatDate(r.brakeTestExpiry)}</td>
            <td class="date-${getDateStatus(r.carrierLicense)}">${formatDate(r.carrierLicense)}</td>
            <td class="text-center">
                ${defCount > 0 ? `<span class="badge status-expired">${defCount}</span>` : '<span class="text-gray-400">0</span>'}
            </td>
            <td>
                <button onclick="openEditModal('${r.licenseNumber}')" class="text-blue-600 hover:underline text-xs ml-2">עריכה</button>
                <button onclick="confirmDelete('${r.licenseNumber}')" class="text-red-600 hover:underline text-xs">מחיקה</button>
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
let editingLicenseNumber = '';

function openEditModal(licenseNumber) {
    const data = getData();
    const record = data.find(r => r.licenseNumber === licenseNumber || r.id === licenseNumber);
    if (!record) return;

    editingLicenseNumber = record.licenseNumber;
    document.getElementById('modal-title').textContent = `עריכת רכב: ${record.licenseNumber} - ${record.customerName}`;

    const defs = loadDeficiencies();
    tempDeficiencies = JSON.parse(JSON.stringify(defs[record.licenseNumber] || []));

    const dateFieldEntries = [
        ['licenseExpiry', 'תוקף רישוי'],
        ['mandatoryInsurance', 'ביטוח חובה'],
        ['comprehensiveInsurance', 'ביטוח מקיף'],
        ['calibrationExpiry', 'כיול'],
        ['equipmentExpiry', 'ציוד יעודי'],
        ['brakeTestExpiry', 'בדיקת בלמים'],
        ['carrierLicense', 'רשיון מוביל'],
        ['inspectionDate', 'תאריך בדיקה']
    ];

    let html = `<form id="edit-form" onsubmit="handleSaveEdit(event)">
        <input type="hidden" name="originalLicense" value="${record.licenseNumber}">
        <div class="grid grid-cols-2 gap-3">
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

        <h4 class="font-bold text-sm mt-4 mb-2 text-gray-700 border-b pb-1">תאריכי תוקף</h4>
        <div class="grid grid-cols-2 gap-3">`;

    dateFieldEntries.forEach(([field, label]) => {
        const status = getDateStatus(record[field]);
        const statusClass = field !== 'inspectionDate' ? `date-${status}` : '';
        html += `<div class="modal-field">
            <label>${label} <span class="${statusClass} text-xs">${field !== 'inspectionDate' && record[field] ? '(' + statusLabel(status) + ')' : ''}</span></label>
            <input type="date" name="${field}" value="${record[field] || ''}">
        </div>`;
    });

    html += `</div>
        <div class="grid grid-cols-2 gap-3 mt-3">
            <div class="modal-field"><label>איש קשר</label><input type="text" name="contactName" value="${record.contactName}"></div>
            <div class="modal-field"><label>טלפון</label><input type="text" name="contactPhone" value="${record.contactPhone}"></div>
        </div>

        <h4 class="font-bold text-sm mt-4 mb-2 text-gray-700 border-b pb-1">ליקויים</h4>
        <div id="deficiencies-list">${tempDeficiencies.map((d, i) => renderDeficiencyItem(d, i)).join('')}</div>
        <button type="button" onclick="addDeficiency()" class="text-blue-600 text-sm mt-2 hover:underline">+ הוסף ליקוי</button>

        <div class="flex gap-3 mt-4 pt-3 border-t">
            <button type="submit" class="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 font-medium">שמור שינויים</button>
            <button type="button" onclick="closeModal()" class="bg-gray-300 text-gray-700 px-6 py-2 rounded-lg hover:bg-gray-400 font-medium">ביטול</button>
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
        <button type="button" onclick="removeDeficiency(${index})" class="text-red-500 hover:text-red-700 text-lg px-1">&times;</button>
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
        licenseNumber: form.elements.originalLicense.value, // original license to find row
        vehicleType: form.elements.vehicleType.value,
        licenseExpiry: form.elements.licenseExpiry.value,
        mandatoryInsurance: form.elements.mandatoryInsurance.value,
        comprehensiveInsurance: form.elements.comprehensiveInsurance.value,
        calibrationExpiry: form.elements.calibrationExpiry.value,
        equipmentExpiry: form.elements.equipmentExpiry.value,
        brakeTestExpiry: form.elements.brakeTestExpiry.value,
        carrierLicense: form.elements.carrierLicense.value,
        inspectionDate: form.elements.inspectionDate.value,
        contactName: form.elements.contactName.value,
        contactPhone: form.elements.contactPhone.value
    };

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
// Add New Record
// ============================================================

function showAddForm() {
    document.getElementById('modal-title').textContent = 'הוספת רשומה חדשה';
    tempDeficiencies = [];

    let html = `<form id="add-form" onsubmit="handleAddRecord(event)">
        <div class="grid grid-cols-2 gap-3">
            <div class="modal-field"><label>שם לקוח</label><input type="text" name="customerName" required></div>
            <div class="modal-field"><label>מיקום</label><input type="text" name="location" required></div>
            <div class="modal-field"><label>מספר רישוי</label><input type="text" name="licenseNumber" required></div>
            <div class="modal-field">
                <label>סוג רכב</label>
                <select name="vehicleType"><option value="משא">משא</option><option value="נגרר">נגרר</option></select>
            </div>
        </div>
        <h4 class="font-bold text-sm mt-4 mb-2 text-gray-700 border-b pb-1">תאריכי תוקף</h4>
        <div class="grid grid-cols-2 gap-3">
            <div class="modal-field"><label>תוקף רישוי</label><input type="date" name="licenseExpiry"></div>
            <div class="modal-field"><label>ביטוח חובה</label><input type="date" name="mandatoryInsurance"></div>
            <div class="modal-field"><label>ביטוח מקיף</label><input type="date" name="comprehensiveInsurance"></div>
            <div class="modal-field"><label>כיול</label><input type="date" name="calibrationExpiry"></div>
            <div class="modal-field"><label>ציוד יעודי</label><input type="date" name="equipmentExpiry"></div>
            <div class="modal-field"><label>בדיקת בלמים</label><input type="date" name="brakeTestExpiry"></div>
            <div class="modal-field"><label>רשיון מוביל</label><input type="date" name="carrierLicense"></div>
            <div class="modal-field"><label>תאריך בדיקה</label><input type="date" name="inspectionDate"></div>
        </div>
        <div class="grid grid-cols-2 gap-3 mt-3">
            <div class="modal-field"><label>איש קשר</label><input type="text" name="contactName"></div>
            <div class="modal-field"><label>טלפון</label><input type="text" name="contactPhone"></div>
        </div>
        <div class="flex gap-3 mt-4 pt-3 border-t">
            <button type="submit" class="bg-green-600 text-white px-6 py-2 rounded-lg hover:bg-green-700 font-medium">הוסף</button>
            <button type="button" onclick="closeModal()" class="bg-gray-300 text-gray-700 px-6 py-2 rounded-lg hover:bg-gray-400 font-medium">ביטול</button>
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
     'licenseExpiry', 'mandatoryInsurance', 'comprehensiveInsurance',
     'calibrationExpiry', 'equipmentExpiry', 'brakeTestExpiry',
     'carrierLicense', 'inspectionDate', 'contactName', 'contactPhone'
    ].forEach(f => { record[f] = form.elements[f]?.value || ''; });

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

    const headers = ['שם לקוח', 'מיקום', 'רישוי', 'סוג רכב', 'תוקף רישוי', 'ביטוח חובה',
        'ביטוח מקיף', 'כיול', 'ציוד יעודי', 'בלמים', 'מוביל', 'בדיקה', 'איש קשר', 'טלפון', 'ליקויים פתוחים'];

    const rows = data.map(r => {
        const openDefs = (deficiencies[r.licenseNumber] || []).filter(d => d.status !== 'resolved').length;
        return [r.customerName, r.location, r.licenseNumber, r.vehicleType,
            r.licenseExpiry, r.mandatoryInsurance, r.comprehensiveInsurance,
            r.calibrationExpiry, r.equipmentExpiry, r.brakeTestExpiry,
            r.carrierLicense, r.inspectionDate, r.contactName, r.contactPhone, openDefs
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
// Settings - API URL
// ============================================================

function showSettings() {
    document.getElementById('modal-title').textContent = 'הגדרות חיבור';
    const currentUrl = APPS_SCRIPT_URL || '';

    let html = `<form onsubmit="saveSettings(event)">
        <div class="modal-field">
            <label>כתובת Google Apps Script URL</label>
            <input type="url" id="settings-url" value="${currentUrl}" placeholder="https://script.google.com/macros/s/..." class="text-left" dir="ltr" required>
            <p class="text-xs text-gray-500 mt-1">הכתובת שמקבלים אחרי Deploy של ה-Apps Script</p>
        </div>
        <div class="flex gap-3 mt-4">
            <button type="submit" class="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 font-medium">שמור וחבר</button>
            <button type="button" onclick="closeModal()" class="bg-gray-300 text-gray-700 px-6 py-2 rounded-lg hover:bg-gray-400 font-medium">ביטול</button>
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
// Initialize
// ============================================================

async function init() {
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
