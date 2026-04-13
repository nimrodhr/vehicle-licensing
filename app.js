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

function normalizeStr(s) {
    return (s || '').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\u00A0]/g, '').trim().replace(/\s+/g, ' ');
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
            const worst = getRecordWorstStatus(r);
            if (statusFilter !== worst) return false;
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
        <div class="summary-card bg-white border-r-4 border-cyan-600">
            <div class="text-3xl font-bold text-cyan-700">${notVisited}</div>
            <div class="text-sm text-gray-600">נותרו לביקור החודש</div>
        </div>
        <div class="summary-card bg-white border-r-4 border-red-500 cursor-pointer" onclick="document.getElementById('dash-status').value='expired';renderDashboard()">
            <div class="text-3xl font-bold text-red-600">${expired}</div>
            <div class="text-sm text-gray-600">רכבים עם רישוי פג תוקף</div>
        </div>
        <div class="summary-card bg-white border-r-4 border-orange-500 cursor-pointer" onclick="document.getElementById('dash-status').value='critical';renderDashboard()">
            <div class="text-3xl font-bold text-orange-600">${critical}</div>
            <div class="text-sm text-gray-600">רכבים פוקעים ביומיים</div>
        </div>
        <div class="summary-card bg-white border-r-4 border-yellow-500 cursor-pointer" onclick="document.getElementById('dash-status').value='warning';renderDashboard()">
            <div class="text-3xl font-bold text-yellow-600">${warning}</div>
            <div class="text-sm text-gray-600">רכבים פוקעים ב-30 יום</div>
        </div>
        <div class="summary-card bg-white border-r-4 border-green-500 cursor-pointer" onclick="document.getElementById('dash-status').value='valid';renderDashboard()">
            <div class="text-3xl font-bold text-green-600">${valid}</div>
            <div class="text-sm text-gray-600">רכבים תקינים</div>
        </div>
        <div class="summary-card bg-white border-r-4 border-purple-500">
            <div class="text-3xl font-bold text-purple-600">${openDefs}</div>
            <div class="text-sm text-gray-600">ליקויים פתוחים</div>
        </div>
        <div class="summary-card bg-white border-r-4 border-amber-500">
            <div class="text-3xl font-bold text-amber-600">${data.filter(r => r.appSynced !== 'yes').length}</div>
            <div class="text-sm text-gray-600">ממתינים לעדכון במערכת</div>
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
            <td class="text-center">&#9664;</td>
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
            <td><button onclick="event.stopPropagation();openEditModal('${v.licenseNumber}')" class="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-blue-700">עריכה</button></td>
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
    const syncFilter = document.getElementById('work-sync')?.value || '';

    const defs = loadDeficiencies();
    const monthStart = today().slice(0, 7) + '-01'; // YYYY-MM-01

    // Build vehicle list with visit status and issues
    const vehicles = [];
    data.forEach(record => {
        if (location && normalizeStr(record.location) !== location) return;
        if (customer && normalizeStr(record.customerName) !== customer) {
            console.log('FILTER MISMATCH:', JSON.stringify(Array.from(record.customerName)).toString(), 'vs', JSON.stringify(Array.from(customer)).toString());
            return;
        }
        if (syncFilter === 'no' && record.appSynced === 'yes') return;
        if (syncFilter === 'yes' && record.appSynced !== 'yes') return;

        const vehicleDefs = defs[record.licenseNumber] || [];
        const openDefs = vehicleDefs.filter(d => d.status === 'open' || d.status === 'in-progress').length;
        const visitedThisMonth = record.inspectionDate && record.inspectionDate >= monthStart;

        vehicles.push({ record, openDefs, visitedThisMonth });
    });

    // Sort by inspectionDate ascending (oldest/empty first = needs visit most)
    vehicles.sort((a, b) => {
        const dateA = a.record.inspectionDate || '0000-00-00';
        const dateB = b.record.inspectionDate || '0000-00-00';
        return dateA.localeCompare(dateB);
    });

    // Current month name
    const monthName = new Date().toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
    const visitedCount = vehicles.filter(v => v.visitedThisMonth).length;
    const remainingCount = vehicles.length - visitedCount;

    if (!vehicles.length) {
        document.getElementById('work-content').innerHTML = `<div class="bg-green-50 border border-green-200 rounded-lg p-8 text-center">
            <div class="text-4xl mb-2">&#10003;</div>
            <div class="text-lg font-bold text-green-700">אין רכבים להצגה</div>
        </div>`;
        updateFilterIndicator(['work-location', 'work-customer', 'work-field', 'work-sync'], 'clearWorkFilters()', 'page-work');
        return;
    }

    const fieldsToCheck = fieldFilter ? [fieldFilter] : DATE_FIELDS;
    let html = `<div class="work-section">
        <div class="work-section-header bg-blue-700 text-white">
            <span>דף עבודה - ${monthName}</span>
            <span>${visitedCount}/${vehicles.length} בוקרו | ${remainingCount} נותרו</span>
        </div>
        <div class="table-container">
        <table class="work-table">
            <thead><tr>
                <th></th>
                <th>לקוח</th>
                <th>איש קשר</th>
                <th>רכב</th>
                <th>סוג</th>
                <th>ביקור אחרון</th>
                <th>סטטוס רישויים</th>
                <th>ליקויים</th>
                <th>מערכת</th>
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

        // License status summary - consolidate 7 date fields into one cell
        const issues = [];
        fieldsToCheck.forEach(field => {
            const val = rec[field];
            if (!val) return;
            const status = getDateStatus(val);
            if (status === 'expired' || status === 'critical' || status === 'warning') {
                issues.push({ label: FIELD_LABELS[field], status, days: daysUntil(val) });
            }
        });

        let licenseCell = '';
        if (issues.length === 0) {
            licenseCell = `<td class="work-cell work-cell-valid text-center"><div>תקין</div></td>`;
        } else {
            const badges = issues.map(i => {
                const daysText = i.days < 0 ? `פג ${Math.abs(i.days)}י'` : i.days === 0 ? 'פג היום' : `${i.days}י'`;
                return `<span class="license-badge license-badge-${i.status}">${i.label} ${daysText}</span>`;
            }).join('');
            const worstStatus = issues.some(i => i.status === 'expired') ? 'expired' : issues.some(i => i.status === 'critical') ? 'critical' : 'warning';
            licenseCell = `<td class="work-cell work-cell-${worstStatus} license-badges-cell">${badges}</td>`;
        }

        // App sync status
        const isSynced = rec.appSynced === 'yes';
        const syncBtnClass = isSynced ? 'sync-btn-done' : 'sync-btn-pending';
        const syncIcon = isSynced ? '&#10003;' : '&#10007;';
        const syncTitle = isSynced ? 'עודכן במערכת' : 'לא עודכן במערכת';

        html += `<tr class="work-vehicle-row ${rowClass}">`;
        html += `<td class="text-center ${visitIconClass}">${visitIcon}</td>`;
        html += `<td class="font-semibold">${rec.customerName}</td>`;
        html += `<td>
            <div class="text-xs">${rec.contactName || '-'}</div>
            ${rec.contactPhone ? `<div class="text-xs"><a href="tel:${rec.contactPhone}" class="text-blue-600">${rec.contactPhone}</a></div>` : ''}
        </td>`;
        html += `<td class="font-bold">${rec.licenseNumber}</td>`;
        html += `<td class="text-gray-500">${rec.vehicleType}</td>`;
        html += inspectionCell;
        html += licenseCell;

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

        html += `<td>
            <button onclick="openEditModal('${rec.licenseNumber}')"
                class="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 whitespace-nowrap">
                עדכן
            </button>
        </td></tr>`;
    });

    html += '</tbody></table></div></div>';
    document.getElementById('work-content').innerHTML = html;
    updateFilterIndicator(['work-location', 'work-customer', 'work-field', 'work-sync'], 'clearWorkFilters()', 'page-work');
}

function clearWorkFilters() {
    document.getElementById('work-location').value = '';
    document.getElementById('work-customer').value = '';
    document.getElementById('work-field').value = '';
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
let editingLicenseNumber = '';
let editingOldInspectionDate = '';
let editingOldAppSynced = '';

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

        <h4 class="font-bold text-sm mt-4 mb-2 text-gray-700 border-b pb-1">תאריכי תוקף</h4>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">`;

    dateFieldEntries.forEach(([field, label]) => {
        const status = getDateStatus(record[field]);
        const statusClass = field !== 'inspectionDate' ? `date-${status}` : '';
        const displayVal = record[field] ? formatDate(record[field]) : '';
        html += `<div class="modal-field">
            <label>${label} <span class="${statusClass} text-xs">${field !== 'inspectionDate' && record[field] ? '(' + statusLabel(status) + ')' : ''}</span></label>
            <input type="text" name="${field}" value="${displayVal}" placeholder="DD/MM/YYYY" dir="ltr" readonly onclick="this.nextElementSibling.showPicker()" style="cursor:pointer">
            <input type="date" value="${record[field] || ''}" style="position:absolute;visibility:hidden;width:0;height:0" onchange="const t=this.previousElementSibling;t.value=this.value?formatDate(this.value):''">
        </div>`;
    });

    html += `</div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
            <div class="modal-field"><label>איש קשר</label><input type="text" name="contactName" value="${record.contactName}"></div>
            <div class="modal-field"><label>טלפון</label><input type="text" name="contactPhone" value="${record.contactPhone}"></div>
        </div>

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
        licenseExpiry: parseDateInput(form.elements.licenseExpiry.value),
        mandatoryInsurance: parseDateInput(form.elements.mandatoryInsurance.value),
        comprehensiveInsurance: parseDateInput(form.elements.comprehensiveInsurance.value),
        calibrationExpiry: parseDateInput(form.elements.calibrationExpiry.value),
        equipmentExpiry: parseDateInput(form.elements.equipmentExpiry.value),
        brakeTestExpiry: parseDateInput(form.elements.brakeTestExpiry.value),
        carrierLicense: parseDateInput(form.elements.carrierLicense.value),
        inspectionDate: parseDateInput(form.elements.inspectionDate.value),
        contactName: form.elements.contactName.value,
        contactPhone: form.elements.contactPhone.value,
        appSynced: parseDateInput(form.elements.inspectionDate.value) !== editingOldInspectionDate ? 'no' : editingOldAppSynced
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
// Add New Record
// ============================================================

function showAddForm() {
    document.getElementById('modal-title').textContent = 'הוספת רשומה חדשה';
    tempDeficiencies = [];

    let html = `<form id="add-form" onsubmit="handleAddRecord(event)">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div class="modal-field"><label>שם לקוח</label><input type="text" name="customerName" required></div>
            <div class="modal-field"><label>מיקום</label><input type="text" name="location" required></div>
            <div class="modal-field"><label>מספר רישוי</label><input type="text" name="licenseNumber" required></div>
            <div class="modal-field">
                <label>סוג רכב</label>
                <select name="vehicleType"><option value="משא">משא</option><option value="נגרר">נגרר</option></select>
            </div>
        </div>
        <h4 class="font-bold text-sm mt-4 mb-2 text-gray-700 border-b pb-1">תאריכי תוקף</h4>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div class="modal-field"><label>תוקף רישוי</label><input type="text" name="licenseExpiry" placeholder="DD/MM/YYYY" dir="ltr" readonly onclick="this.nextElementSibling.showPicker()" style="cursor:pointer"><input type="date" style="position:absolute;visibility:hidden;width:0;height:0" onchange="this.previousElementSibling.value=this.value?formatDate(this.value):''"></div>
            <div class="modal-field"><label>ביטוח חובה</label><input type="text" name="mandatoryInsurance" placeholder="DD/MM/YYYY" dir="ltr" readonly onclick="this.nextElementSibling.showPicker()" style="cursor:pointer"><input type="date" style="position:absolute;visibility:hidden;width:0;height:0" onchange="this.previousElementSibling.value=this.value?formatDate(this.value):''"></div>
            <div class="modal-field"><label>ביטוח מקיף</label><input type="text" name="comprehensiveInsurance" placeholder="DD/MM/YYYY" dir="ltr" readonly onclick="this.nextElementSibling.showPicker()" style="cursor:pointer"><input type="date" style="position:absolute;visibility:hidden;width:0;height:0" onchange="this.previousElementSibling.value=this.value?formatDate(this.value):''"></div>
            <div class="modal-field"><label>כיול</label><input type="text" name="calibrationExpiry" placeholder="DD/MM/YYYY" dir="ltr" readonly onclick="this.nextElementSibling.showPicker()" style="cursor:pointer"><input type="date" style="position:absolute;visibility:hidden;width:0;height:0" onchange="this.previousElementSibling.value=this.value?formatDate(this.value):''"></div>
            <div class="modal-field"><label>ציוד יעודי</label><input type="text" name="equipmentExpiry" placeholder="DD/MM/YYYY" dir="ltr" readonly onclick="this.nextElementSibling.showPicker()" style="cursor:pointer"><input type="date" style="position:absolute;visibility:hidden;width:0;height:0" onchange="this.previousElementSibling.value=this.value?formatDate(this.value):''"></div>
            <div class="modal-field"><label>בדיקת בלמים</label><input type="text" name="brakeTestExpiry" placeholder="DD/MM/YYYY" dir="ltr" readonly onclick="this.nextElementSibling.showPicker()" style="cursor:pointer"><input type="date" style="position:absolute;visibility:hidden;width:0;height:0" onchange="this.previousElementSibling.value=this.value?formatDate(this.value):''"></div>
            <div class="modal-field"><label>רשיון מוביל</label><input type="text" name="carrierLicense" placeholder="DD/MM/YYYY" dir="ltr" readonly onclick="this.nextElementSibling.showPicker()" style="cursor:pointer"><input type="date" style="position:absolute;visibility:hidden;width:0;height:0" onchange="this.previousElementSibling.value=this.value?formatDate(this.value):''"></div>
            <div class="modal-field"><label>תאריך בדיקה</label><input type="text" name="inspectionDate" placeholder="DD/MM/YYYY" dir="ltr" readonly onclick="this.nextElementSibling.showPicker()" style="cursor:pointer"><input type="date" style="position:absolute;visibility:hidden;width:0;height:0" onchange="this.previousElementSibling.value=this.value?formatDate(this.value):''"></div>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
            <div class="modal-field"><label>איש קשר</label><input type="text" name="contactName"></div>
            <div class="modal-field"><label>טלפון</label><input type="text" name="contactPhone"></div>
        </div>
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
    const dateFields = ['licenseExpiry', 'mandatoryInsurance', 'comprehensiveInsurance',
     'calibrationExpiry', 'equipmentExpiry', 'brakeTestExpiry', 'carrierLicense', 'inspectionDate'];
    ['customerName', 'location', 'licenseNumber', 'vehicleType',
     ...dateFields, 'contactName', 'contactPhone'
    ].forEach(f => {
        const val = form.elements[f]?.value || '';
        record[f] = dateFields.includes(f) ? parseDateInput(val) : val;
    });

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
