const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 🔧 CONFIG
const DHIS2_BASE_URL = process.env.DHIS2_BASE_URL;
const USERNAME = process.env.DHIS2_USERNAME;
const PASSWORD = process.env.DHIS2_PASSWORD;

// 🔑 ATTRIBUTE IDS (FROM .env)
const IMP_ID_ATTR    = process.env.IMP_ID_ATTRIBUTE_ID;
const OU_IMP_ID_ATTR = process.env.OU_IMP_ID_ATTRIBUTE_ID;

// 🏷️ The attribute on each dataElementGroup that stores the result/measure type
const RESULT_TYPE_ATTR_ID = process.env.RESULT_TYPE_ID;

let successCount = 0;
let failureCount = 0;

/* =========================
   🔐 DHIS2 LOGIN
========================= */
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === USERNAME && password === PASSWORD) {
        return res.json({ ok: true });
    }
    res.status(401).json({ error: 'Invalid credentials' });
});

/* =========================
   📦 FETCH GROUP SETS
========================= */
app.get('/api/dataElementGroupSets', async (_req, res) => {
    try {
        const response = await axios.get(
            `${DHIS2_BASE_URL}/dataElementGroupSets`,
            {
                params: {
                    paging: false,
                    fields: 'id,displayName,attributeValues[attribute[id],value],dataElementGroups[id,displayName,attributeValues[attribute[id],value]]'
                },
                auth: { username: USERNAME, password: PASSWORD }
            }
        );
        res.json(response.data.dataElementGroupSets);
    } catch (err) {
        console.error('❌ GroupSets error:', err.response?.data || err.message);
        res.status(500).json({ error: err.response?.data || err.message });
    }
});

/* =========================
   📅 ETHIOPIAN CALENDAR CONVERTER
   Converts Gregorian date to Ethiopian year/month/day
========================= */
function gregorianToEthiopian(gYear, gMonth, gDay) {
    const ETHIOPIAN_MONTHS = [
        'Meskerem', 'Tikimt', 'Hidar', 'Tahsas',
        'Tir', 'Yekatit', 'Megabit', 'Miyaziya',
        'Ginbot', 'Sene', 'Hamle', 'Nehase', 'Pagume'
    ];

    const jdn = Math.floor((14 - gMonth) / 12);
    const y   = gYear + 4800 - jdn;
    const m   = gMonth + 12 * jdn - 3;
    const julianDay = gDay + Math.floor((153 * m + 2) / 5) + 365 * y
        + Math.floor(y / 4) - Math.floor(y / 100)
        + Math.floor(y / 400) - 32045;

    const ethioEpoch = 1724220;
    const diff = julianDay - ethioEpoch;

    const r4 = diff % 1461;
    const n  = r4 % 365 + 365 * Math.floor(r4 / 1460);

    const preciseYear  = Math.floor(diff / 1461) * 4 + Math.floor(r4 / 365) - Math.floor(r4 / 1460);
    const preciseMonth = Math.floor(n / 30) + 1;
    const preciseDay   = (n % 30) + 1;

    return {
        year:      preciseYear + 1,
        month:     preciseMonth,
        monthName: ETHIOPIAN_MONTHS[preciseMonth - 1] || 'Pagume',
        day:       preciseDay
    };
}

/* =========================
   📅 BUILD ETHIOPIAN PERIOD NAME
========================= */
function buildEthiopianPeriodName(gregorianStartDate) {
    const [y, m, d] = gregorianStartDate.split('-').map(Number);
    const eth  = gregorianToEthiopian(y, m, d);
    const half = eth.day <= 15 ? 'HM-1' : 'HM-2';
    return `${half} ${eth.monthName} ${eth.year}`;
}

/* =========================
   🗓️ ETHIOPIAN HM NAME HELPER
========================= */
function toEthiopianHMName(startDateStr) {
    const [y, m, d] = startDateStr.split('-').map(Number);
    const eth  = gregorianToEthiopian(y, m, d);
    const half = eth.day <= 15 ? 'HM-1' : 'HM-2';
    const name = `${half} ${eth.monthName} ${eth.year}`;
    console.log(`🗓️ ${startDateStr} → ET: day=${eth.day}, month=${eth.monthName}, year=${eth.year} → ${name}`);
    return name;
}
function normalizeMeasureType(type) {
    const norm = (type || '').trim().toLowerCase();

    const map = {
        'pjg': 'project goal',
        'pjc': 'project outcome',
        'pjp': 'project output',
        'pjw': 'project workstream',
        'pja': 'project activity',
        'prg': 'program goal',
        'prc': 'program outcome',
        'prp': 'program output',
        'sob': 'strategic'
    };

    return map[norm] || norm;
}
/* =========================
   📅 PERIOD TYPE FROM MEASURE TYPE
   Reads the human-readable value of cwEYtMqAfie on the group
========================= */
function getPeriodType(measureType) {
    const norm = normalizeMeasureType(measureType);

    if (norm === 'program goal' || norm === 'program outcome') return 'annually';
    if (norm === 'project goal' || norm === 'project outcome') return 'annually';
    if (norm === 'program output') return 'six-monthly';
    if (norm === 'project output' || norm === 'project workstream') return 'monthly';
    if (norm === 'project activity' || norm === 'activity') return 'biweekly';

    console.warn(`⚠️ Unknown measure type for period: "${measureType}", defaulting to annually`);
    return 'annually';
}

/* =========================
   🔗 IMP ENDPOINT ROUTER
   Uses the raw attribute string from cwEYtMqAfie e.g. "Project Goal"
========================= */
function getEndpoint(type) {
    const norm = normalizeMeasureType(type);

    if (norm === 'project goal')     return 'project-goal-measure-unit-distributions';
    if (norm === 'project outcome')  return 'project-outcome-measure-unit-distributions';
    if (norm === 'project output')   return 'project-output-measure-unit-distributions';
    if (norm === 'program goal')     return 'program-goal-measure-unit-distributions';
    if (norm === 'program outcome')  return 'program-outcome-measure-unit-distributions';
    if (norm === 'program output')   return 'program-output-measure-unit-distributions';
    if (norm === 'strategic')        return 'strategic-measure-unit-distributions';
    if (norm === 'project workstream' || norm === 'workstream')
        return 'workstream-measure-unit-distributions';
    if (norm === 'project activity' || norm === 'activity')
        return 'activities';

    throw new Error(`Unknown measure type for endpoint: "${type}"`);
}

/* =========================
   🔑 MEASURE KEY HELPER
   e.g. "Project Goal" → "project_goal_measure"
========================= */
function getMeasureKey(type) {
    const norm = normalizeMeasureType(type);

    if (norm === 'project goal')                                return 'project_goal_measure';
    if (norm === 'project outcome')                             return 'project_outcome_measure';
    if (norm === 'project output')                              return 'project_output_measure';
    if (norm === 'program goal')                                return 'program_goal_measure';
    if (norm === 'program outcome')                             return 'program_outcome_measure';
    if (norm === 'program output')                              return 'program_output_measure';
    if (norm === 'strategic')                                   return 'strategic_measure';
    if (norm === 'project workstream' || norm === 'workstream') return 'workstream_measure';
    if (norm === 'project activity'   || norm === 'activity')   return null;

    console.warn(`⚠️ Unknown measure type for measureKey: "${type}"`);
    return null;
}

/* =========================
   🔐 IMP LOGIN
========================= */
async function getToken() {
    const res = await axios.post(
        `${process.env.IMP_BASE_URL}/auth/token/login/`,
        {
            email:    process.env.IMP_EMAIL,
            password: process.env.IMP_PASSWORD
        }
    );
    return res.data.auth_token;
}

/* =========================
   🔧 ATTRIBUTE HELPER
========================= */
function getAttr(attrs, attrId) {
    const found = attrs?.find(a => a.attribute.id === attrId);
    return found ? found.value : null;
}

/* =========================
   📅 PARSE BIWEEK PERIOD
========================= */
function parseBiweekPeriod(pe) {
    if (pe.includes('_')) {
        const [start, end] = pe.split('_');
        return { start, end };
    }

    const match = pe.match(/(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})/);
    if (match) return { start: match[1], end: match[2] };

    console.warn('⚠️ Unrecognised period format:', pe);
    return null;
}

/* =========================
   🔍 DATE RANGE COMPARISON (1-day tolerance)
========================= */
function isSameRange(aStart, aEnd, bStart, bEnd) {
    const tolerance = 24 * 60 * 60 * 1000;
    return (
        Math.abs(new Date(aStart) - new Date(bStart)) <= tolerance &&
        Math.abs(new Date(aEnd)   - new Date(bEnd))   <= tolerance
    );
}

function findPeriod(distributions, start, end) {
    for (const dist of distributions) {
        if (isSameRange(dist.start_date, dist.end_date, start, end)) return dist;
        if (dist.children) {
            const found = findPeriod(dist.children, start, end);
            if (found) return found;
        }
    }
    return null;
}

/* =========================
   📦 ORG UNITS
========================= */
app.get('/api/organisationUnits', async (req, res) => {
    try {
        const GROUP_ID = process.env.OU_GROUP_ID;
        const ATTR_ID  = process.env.OU_IMP_ID_ATTRIBUTE_ID;

        const response = await axios.get(
            `${DHIS2_BASE_URL}/organisationUnitGroups/${GROUP_ID}`,
            {
                params: { fields: 'organisationUnits[id,displayName,attributeValues[attribute[id],value]]' },
                auth:   { username: USERNAME, password: PASSWORD }
            }
        );

        const filtered = (response.data.organisationUnits || [])
            .map(ou => {
                const attr = ou.attributeValues?.find(a => a.attribute.id === ATTR_ID);
                if (!attr) return null;
                return { id: ou.id, displayName: ou.displayName, imp_id: attr.value };
            })
            .filter(Boolean);

        res.json(filtered);
    } catch (err) {
        console.error('❌ OrgUnit error:', err.response?.data || err.message);
        res.status(500).json({ error: err.message });
    }
});

/* =========================
   📊 ANALYTICS
========================= */
app.get('/api/analytics', async (req, res) => {
    const { groupId, period, orgUnit } = req.query;

    try {
        const coDimension =
            'lBnoNc1T39R:Mbq12GujYxI;kgXWhJFcw33;Ql3Sy6YjrSN;TLixouvYRPF;SAXhVtAwMEh;pKWpjLWZK0a;snD5u6yDER3';

        const url =
            `${DHIS2_BASE_URL}/analytics` +
            `?dimension=dx:DE_GROUP-${groupId}` +
            `&dimension=pe:${period}` +
            `&dimension=ou:${orgUnit}` +
            `&dimension=co:${coDimension}` +
            `&displayProperty=NAME` +
            `&includeMetadataDetails=true`;

        const response = await axios.get(url, {
            auth: { username: USERNAME, password: PASSWORD }
        });

        const { headers, rows, metaData } = response.data;

        const table = rows.map(row => {
            const obj = {};
            headers.forEach((h, i) => {
                let value = row[i];
                if (h.name === 'dx' || h.name === 'ou') {
                    obj[h.name]          = value;
                    obj[`${h.name}Name`] = metaData.items[value]?.name || value;
                } else {
                    if (metaData.items[value]) value = metaData.items[value].name;
                    obj[h.name] = value;
                }
            });
            return obj;
        });

        res.json(table);
    } catch (err) {
        console.error('❌ Analytics error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

/* =========================
   🔍 FETCH DATA ELEMENT DETAILS
   Also fetches each element's group and reads cwEYtMqAfie to get measure_type
========================= */
async function getDataElementDetails(ids) {
    if (!ids.length) return [];

    // Step 1: fetch data elements, including their group memberships
    const deUrl =
        `${DHIS2_BASE_URL}/dataElements` +
        `?filter=id:in:[${ids.join(',')}]` +
        `&fields=id,displayName,attributeValues[attribute[id],value],dataElementGroups[id]` +
        `&paging=false`;

    const deRes      = await axios.get(deUrl, { auth: { username: USERNAME, password: PASSWORD } });
    const dataElements = deRes.data.dataElements;

    // Step 2: collect all unique group IDs referenced by these elements
    const groupIds = [
        ...new Set(
            dataElements.flatMap(de => (de.dataElementGroups || []).map(g => g.id))
        )
    ];

    // Step 3: fetch those groups and read the cwEYtMqAfie attribute from each
    let groupMap = {};
    if (groupIds.length) {
        const grpUrl =
            `${DHIS2_BASE_URL}/dataElementGroups` +
            `?filter=id:in:[${groupIds.join(',')}]` +
            `&fields=id,displayName,attributeValues[attribute[id],value]` +
            `&paging=false`;

        const grpRes = await axios.get(grpUrl, { auth: { username: USERNAME, password: PASSWORD } });
        grpRes.data.dataElementGroups.forEach(g => { groupMap[g.id] = g; });
    }

    // Step 4: attach measure_type to each data element from its first group that has the attribute
    return dataElements.map(de => {
        let measure_type = null;
        for (const grpRef of (de.dataElementGroups || [])) {
            const grp = groupMap[grpRef.id];
            if (!grp) continue;

            const val = getAttr(grp.attributeValues, RESULT_TYPE_ATTR_ID);
            console.log(val)
            if (val) {
                measure_type = val;
                console.log(`🏷️  DE ${de.id} → group "${grp.displayName}" → measure_type="${val}"`);
                break;
            }
        }

        if (!measure_type) {
            console.warn(`⚠️ No cwEYtMqAfie found for DE ${de.id} (${de.displayName}) — will be skipped`);
        }

        return { ...de, measure_type };
    });
}

/* =========================
   🔍 FETCH ORG UNIT ATTRIBUTES
========================= */
async function getOrgUnitDetails(ids) {
    if (!ids.length) return [];

    const url =
        `${DHIS2_BASE_URL}/organisationUnits` +
        `?filter=id:in:[${ids.join(',')}]` +
        `&fields=id,displayName,attributeValues[attribute[id],value]` +
        `&paging=false`;

    const res = await axios.get(url, { auth: { username: USERNAME, password: PASSWORD } });
    return res.data.organisationUnits;
}

/* =========================
   🔁 TRANSFORM DATA
   measure_type now comes from the group's cwEYtMqAfie attribute
========================= */
async function transformToPayload(data) {
    const dxIds  = [...new Set(data.map(r => r.dx))];
    const ouKeys = [...new Set(data.map(r => r.ou))];

    const elements = await getDataElementDetails(dxIds); // enriched with measure_type
    const orgUnits = await getOrgUnitDetails(ouKeys);

    const elMap       = {};
    const ouMapById   = {};
    const ouMapByName = {};

    elements.forEach(e => { elMap[e.id] = e; });
    orgUnits.forEach(o => {
        ouMapById[o.id]            = o;
        ouMapByName[o.displayName] = o;
    });

    const grouped = {};

    const VALID_COS = new Set([
        'Physical-Actual', 'Physical-Target',
        'Men', 'Women', 'Youth',
        'Budget-Actual', 'Budget-Target',
        'default'
    ]);

    data.forEach(row => {
        console.log('➡️ ROW:', row);
        if (!row) return;

        if (!VALID_COS.has(row.co)) {
            console.log('⛔ Skipped CO:', row.co);
            return;
        }

        const el = elMap[row.dx];
        const ou = ouMapById[row.ou] || ouMapByName[row.ou];

        if (!el || !ou) {
            console.log('❌ Missing element or orgUnit:', row.dx, row.ou);
            return;
        }

        // imp_id still comes from the data element's own attribute
        const imp_id            = getAttr(el.attributeValues, IMP_ID_ATTR);
        // measure_type now comes from the group's cwEYtMqAfie attribute
        const measure_type      = el.measure_type;
        const implementing_unit = getAttr(ou.attributeValues, OU_IMP_ID_ATTR);

        if (!imp_id || !measure_type || !implementing_unit) {
            console.log(`❌ Missing attributes → skipping (imp_id=${imp_id}, measure_type=${measure_type}, unit=${implementing_unit})`);
            return;
        }

        const key = `${row.pe}_${row.dx}`;

        if (!grouped[key]) {
            grouped[key] = {
                actual:        null,
                target:        null,
                actual_male:   null,
                actual_female: null,
                actual_youth:  null,
                actual_budget: null,
                target_budget: null,
                imp_id,
                measure_type,
                implementing_unit,
                pe:        row.pe,
                raw_value: row.value
            };
        }

        const value = Number(row.value || 0);
        if (row.co === 'Physical-Actual') grouped[key].actual = (grouped[key].actual ?? 0) + value;
        if (row.co === 'Physical-Target') grouped[key].target = (grouped[key].target ?? 0) + value;
        if (row.co === 'Men')             grouped[key].actual_male   = value;
        if (row.co === 'Women')           grouped[key].actual_female = value;
        if (row.co === 'Youth')           grouped[key].actual_youth  = value;
        if (row.co === 'Budget-Actual')   grouped[key].actual_budget = value;
        if (row.co === 'Budget-Target')   grouped[key].target_budget = value;
    });

    return Object.values(grouped);
}

/* =========================
   🔑 STATUS MAPPER (for activities)
========================= */
function mapToStatus(value) {
    if (value === null || value === undefined || value === '') return null;
    const v = String(value).toLowerCase().replace(/\s+/g, '');
    if (v === '1' || v === 'true'  || v === 'complete')                         return 'complete';
    if (v === '0' || v === 'false' || v === 'incomplete' || v === 'notstarted') return 'not started';
    if (v === 'inprogress')                                                      return 'in progress';
    return null;
}

/* =========================
   🚀 PUSH DATA
========================= */
app.post('/api/pushData', async (req, res) => {
    // Reset counters per request
    successCount = 0;
    failureCount = 0;

    try {
        const rawData = req.body;
        const items   = await transformToPayload(rawData);

        if (!items.length) {
            return res.status(400).json({ error: 'No valid data' });
        }

        const token = await getToken();

        // Group items by their raw measure_type string (e.g. "Project Output")
        const groupedByType = {};
        items.forEach(i => {
            if (!groupedByType[i.measure_type]) groupedByType[i.measure_type] = [];
            groupedByType[i.measure_type].push(i);
        });

        const results = [];

        for (const type in groupedByType) {
            const norm = (type || '').trim().toLowerCase();

            // ✅ HANDLE ACTIVITIES SEPARATELY
            if (norm === 'project activity' || norm === 'activity') {
                console.log('🚀 Processing activities...');
                const activityResults = await pushActivityItems(groupedByType[type], token);
                results.push(...activityResults);
                successCount += activityResults.filter(r => r.result?.startsWith('✅')).length;
                failureCount += activityResults.filter(r => !r.result?.startsWith('✅')).length;
                continue;
            }

            // Derive endpoint, measureKey and period frequency from the raw type string
            let endpoint, measureKey, periodFreq;
            try {
                console.log(type);
                endpoint   = getEndpoint(type);
                measureKey = getMeasureKey(type);
                periodFreq = getPeriodType(type);
            } catch (e) {
                console.warn(`⚠️ Skipping unknown type: "${type}" — ${e.message}`);
                continue;
            }

            const baseUrl     = `${process.env.IMP_BASE_URL}/${endpoint}`;
            const existingRes = await axios.get(baseUrl, {
                headers: { Authorization: `Token ${token}` }
            });

            for (const item of groupedByType[type]) {
                const implementing_unit = Number(item.implementing_unit);
                const measureValue      = Number(item.imp_id);

                const existing = existingRes.data.find(r =>
                    Number(r.implementing_unit) === implementing_unit &&
                    Number(r[measureKey])        === measureValue
                );

                if (!existing) {
                    console.warn(`⚠️ No existing record for type="${type}", imp_id=${item.imp_id}, unit=${item.implementing_unit}`);
                    results.push({ type, imp_id: item.imp_id, status: 'not found' });
                    failureCount++;
                    continue;
                }

                // 📅 Build period dates based on period frequency
                let targetStartDate, targetEndDate, periodName;

                if (periodFreq === 'annually') {
                    targetStartDate = `${Number(item.pe) - 1}-07-08`;
                    targetEndDate   = `${item.pe}-07-07`;
                    const efyYear   = Number(item.pe) - 8;
                    periodName      = `EFY ${efyYear}`;
                    console.log(`📅 [annually] pe=${item.pe} → ${periodName}, ${targetStartDate} – ${targetEndDate}`);

                } else if (periodFreq === 'six-monthly') {
                    const sixMatch = String(item.pe).match(/^(\d{4})S([12])$/);
                    if (sixMatch) {
                        const yr   = Number(sixMatch[1]);
                        const half = Number(sixMatch[2]);
                        if (half === 1) {
                            targetStartDate = `${yr}-01-01`;
                            targetEndDate   = `${yr}-06-30`;
                            periodName      = `S1 ${yr}`;
                        } else {
                            targetStartDate = `${yr}-07-01`;
                            targetEndDate   = `${yr}-12-31`;
                            periodName      = `S2 ${yr}`;
                        }
                    } else {
                        targetStartDate = `${item.pe}-01-01`;
                        targetEndDate   = `${item.pe}-06-30`;
                        periodName      = `S1 ${item.pe}`;
                    }
                    console.log(`📅 [six-monthly] pe=${item.pe} → ${periodName}, ${targetStartDate} – ${targetEndDate}`);

                } else if (periodFreq === 'monthly') {
                    const monthMatch = String(item.pe).match(/^(\d{4})(\d{2})$/);
                    if (monthMatch) {
                        const yr      = Number(monthMatch[1]);
                        const mo      = Number(monthMatch[2]);
                        const lastDay = new Date(yr, mo, 0).getDate();
                        targetStartDate = `${yr}-${String(mo).padStart(2, '0')}-01`;
                        targetEndDate   = `${yr}-${String(mo).padStart(2, '0')}-${lastDay}`;
                        periodName      = new Date(yr, mo - 1, 1)
                            .toLocaleString('en-US', { month: 'long', year: 'numeric' });
                    } else {
                        targetStartDate = `${item.pe}-01-01`;
                        targetEndDate   = `${item.pe}-01-31`;
                        periodName      = item.pe;
                    }
                    console.log(`📅 [monthly] pe=${item.pe} → ${periodName}, ${targetStartDate} – ${targetEndDate}`);

                } else {
                    // biweekly fallback (non-activity path, just in case)
                    const range     = parseBiweekPeriod(item.pe);
                    targetStartDate = range?.start || item.pe;
                    targetEndDate   = range?.end   || item.pe;
                    periodName      = toEthiopianHMName(targetStartDate);
                    console.log(`📅 [biweekly] pe=${item.pe} → ${periodName}`);
                }

                // ✅ All possible fields to update
                const allFields = {
                    actual:        item.actual        ?? null,
                    target:        item.target        ?? null,
                    actual_male:   item.actual_male   ?? null,
                    target_male:   item.target_male   ?? null,
                    actual_female: item.actual_female ?? null,
                    target_female: item.target_female ?? null,
                    actual_youth:  item.actual_youth  ?? null,
                    target_youth:  item.target_youth  ?? null,
                    actual_budget: item.actual_budget ?? null,
                    target_budget: item.target_budget ?? null,
                };

                let patchPayload;

                if (!existing.period_distributions) {
                    console.log(`📋 No period_distributions yet, creating: ${periodName}`);
                    const filteredFields = Object.fromEntries(
                        Object.entries(allFields).filter(([, v]) => v !== null)
                    );
                    patchPayload = {
                        implementing_unit,
                        [measureKey]: measureValue,
                        period_distributions: [{
                            name:             periodName,
                            start_date:       targetStartDate,
                            end_date:         targetEndDate,
                            period_frequency: periodFreq,
                            ...filteredFields
                        }]
                    };

                } else {
                    const matchedPeriod = findPeriod(existing.period_distributions, targetStartDate, targetEndDate);

                    if (!matchedPeriod) {
                        console.log(`➕ Adding new period: ${periodName}`);
                        const filteredFields = Object.fromEntries(
                            Object.entries(allFields).filter(([, v]) => v !== null)
                        );
                        patchPayload = {
                            implementing_unit,
                            [measureKey]: measureValue,
                            period_distributions: [
                                ...existing.period_distributions,
                                {
                                    name:             periodName,
                                    start_date:       targetStartDate,
                                    end_date:         targetEndDate,
                                    period_frequency: periodFreq,
                                    ...filteredFields
                                }
                            ]
                        };

                    } else {
                        // Send all fields (including null) to allow clearing values
                        const updateFields = Object.fromEntries(
                            Object.entries(allFields).filter(([k]) => k in matchedPeriod)
                        );

                        // Update only the matched period level; strip children so sub-period
                        // 0-values don't override the annual entry in the IMP UI
                        const updatedPeriod = {
                            ...matchedPeriod,
                            name:             periodName,
                            period_frequency: periodFreq,
                            ...updateFields,
                            children:         null
                        };

                        function replacePeriod(distributions) {
                            return distributions.map(dist => {
                                if (isSameRange(dist.start_date, dist.end_date, targetStartDate, targetEndDate)) {
                                    return updatedPeriod;
                                }
                                if (dist.children) {
                                    return { ...dist, children: replacePeriod(dist.children) };
                                }
                                return dist;
                            });
                        }

                        patchPayload = {
                            implementing_unit,
                            [measureKey]: measureValue,
                            period_distributions: replacePeriod(existing.period_distributions)
                        };
                    }
                }

                const patchUrl = `${baseUrl}/${existing.id}`;
                console.log(`📝 PATCHing [${type}] → ${patchUrl}`);
                console.log('📦 Payload:', JSON.stringify(patchPayload, null, 2));

                await axios.patch(patchUrl, patchPayload, {
                    headers: {
                        Authorization:  `Token ${token}`,
                        'Content-Type': 'application/json'
                    },
                    maxRedirects: 0
                });

                console.log(`✅ Patched [${type}] id=${existing.id}`);

                // Approval request
                const approvalUrl = `${baseUrl}/${existing.id}/approval-request/`;
                console.log(`📤 Approval → ${approvalUrl}`);

                const approvalResponse = await axios.put(
                    approvalUrl,
                    { comments: 'Auto-submitted from DHIS2 integration' },
                    {
                        headers: {
                            Authorization:  `Token ${token}`,
                            'Content-Type': 'application/json'
                        },
                        maxRedirects: 0
                    }
                );

                successCount++;
                results.push({
                    type,
                    imp_id:   item.imp_id,
                    recordId: existing.id,
                    status:   '✅ patched + approved',
                    approval: approvalResponse.data
                });
            }
        }

        if (successCount === 0) {
            return res.status(400).json({
                error: 'No records were updated. All items failed or were not found.',
                results
            });
        }

        if (failureCount > 0) {
            return res.status(207).json({
                message: '⚠️ Partial success',
                successCount,
                failureCount,
                results
            });
        }

        res.json({
            message: '✅ All records updated successfully',
            successCount,
            results
        });

    } catch (err) {
        console.error('❌ Push error:', err.response?.data || err.message);
        res.status(500).json({ error: err.response?.data || err.message });
    }
});

/* =========================
   🏃 PUSH ACTIVITY ITEMS
========================= */
async function pushActivityItems(items, token) {
    const baseUrl       = `${process.env.IMP_BASE_URL}/activity-unit-distributions`;
    const activitiesUrl = `${process.env.IMP_BASE_URL}/activities`;

    const activitiesRes = await axios.get(activitiesUrl, {
        headers: { Authorization: `Token ${token}` }
    });

    const activities = activitiesRes.data;
    const results    = [];

    for (const item of items) {
        console.log('➡️ Activity item:', item);

        const range = parseBiweekPeriod(item.pe);
        if (!range) {
            console.warn(`⚠️ Invalid period: ${item.pe}`);
            results.push({ activity: item.imp_id, result: 'invalid period' });
            continue;
        }

        const { start, end } = range;

        const activity = activities.find(a => Number(a.id) === Number(item.imp_id));
        if (!activity) {
            console.warn(`⚠️ Activity not found: imp_id=${item.imp_id}`);
            results.push({ activity: item.imp_id, result: 'activity not found' });
            continue;
        }
        console.log(`✅ Found activity id=${activity.id}`);

        const unitDist = activity.unit_distributions?.find(
            u => Number(u.implementing_unit) === Number(item.implementing_unit)
        );
        if (!unitDist) {
            console.warn(`⚠️ Unit distribution not found — activity=${activity.id}, unit=${item.implementing_unit}`);
            results.push({ activity: item.imp_id, unit: item.implementing_unit, result: 'unit distribution not found' });
            continue;
        }
        console.log(`✅ Found unit distribution id=${unitDist.id}`);

        const status = mapToStatus(item.raw_value);
        if (!status) {
            console.warn(`⚠️ Invalid status value: ${item.raw_value}`);
            results.push({ activity: item.imp_id, result: 'invalid status' });
            continue;
        }

        let existingUnitDist;
        try {
            const getRes = await axios.get(`${baseUrl}/${unitDist.id}/`, {
                headers: { Authorization: `Token ${token}` }
            });
            existingUnitDist = getRes.data;
            console.log('✅ Fetched full unit distribution:', JSON.stringify(existingUnitDist, null, 2));
        } catch (getErr) {
            console.error(`❌ Failed to fetch unit distribution id=${unitDist.id}:`, getErr.response?.data || getErr.message);
            results.push({
                activity: activity.id,
                unit:     item.implementing_unit,
                result:   '❌ failed to fetch unit distribution',
                error:    getErr.response?.data || getErr.message
            });
            continue;
        }

        let periods = Array.isArray(existingUnitDist.period_distributions)
            ? [...existingUnitDist.period_distributions]
            : [];

        const matchedIndex = periods.findIndex(p => p.start_date === start && p.end_date === end);

        if (matchedIndex === -1) {
            const ethName            = toEthiopianHMName(start);
            const duplicateNameIndex = periods.findIndex(p => p.name === ethName);

            if (duplicateNameIndex !== -1) {
                console.log(`♻️ Period "${ethName}" already exists, updating dates`);
                periods[duplicateNameIndex] = {
                    ...periods[duplicateNameIndex],
                    name:             ethName,
                    start_date:       start,
                    end_date:         end,
                    status,
                    period_frequency: 'biweekly'
                };
            } else {
                console.log(`➕ Creating new period: ${ethName} (${start} → ${end})`);
                periods.push({
                    name:             ethName,
                    start_date:       start,
                    end_date:         end,
                    status,
                    period_frequency: 'biweekly'
                });
            }
        } else {
            const ethName = toEthiopianHMName(start);
            console.log(`✏️ Updating existing period → ${ethName} (${start} → ${end})`);
            periods[matchedIndex] = {
                ...periods[matchedIndex],
                name:             ethName,
                start_date:       start,
                end_date:         end,
                status,
                period_frequency: 'biweekly'
            };
        }

        const putPayload = {
            activity:             existingUnitDist.activity,
            implementing_unit:    existingUnitDist.implementing_unit,
            start_date:           existingUnitDist.start_date,
            end_date:             existingUnitDist.end_date,
            status:               existingUnitDist.status,
            children:             null,
            period_distributions: periods
        };

        console.log(`📝 PUTting activity unit distribution: ${baseUrl}/${unitDist.id}/`);
        console.log('📦 Payload:', JSON.stringify(putPayload, null, 2));

        try {
            await axios.put(`${baseUrl}/${unitDist.id}/`, putPayload, {
                headers: {
                    Authorization:  `Token ${token}`,
                    'Content-Type': 'application/json'
                }
            });
            console.log(`✅ PUT success for unit distribution id=${unitDist.id}`);
        } catch (putErr) {
            console.error('❌ PUT failed:', putErr.response?.data || putErr.message);
            results.push({
                activity: activity.id,
                unit:     item.implementing_unit,
                period:   `${start} → ${end}`,
                result:   '❌ put failed',
                error:    putErr.response?.data || putErr.message
            });
            continue;
        }

        results.push({
            activity:           activity.id,
            unitDistributionId: unitDist.id,
            unit:               item.implementing_unit,
            period:             `${start} → ${end}`,
            status,
            result:             '✅ PUT success (approval pending backend support)'
        });
    }

    return results;
}

/* =========================
   ⚙️ CONFIG ENDPOINT
========================= */
app.get('/api/config', (req, res) => {
    res.json({
        periodTypeAttributeId: process.env.PERIOD_TYPE_ATTRIBUTE_ID,
        resultTypeAttributeId: process.env.RESULT_TYPE_ID 
    });
});

/* =========================
   🚀 START SERVER
========================= */
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});