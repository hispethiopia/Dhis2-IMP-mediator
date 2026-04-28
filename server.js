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
const IMP_ID_ATTR = process.env.IMP_ID_ATTRIBUTE_ID;
const MEASURE_TYPE_ATTR = process.env.MEASURE_TYPE_ATTRIBUTE_ID;
const OU_IMP_ID_ATTR = process.env.OU_IMP_ID_ATTRIBUTE_ID;

let successCount = 0;
let failureCount = 0;

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        // Verify credentials against DHIS2
        await axios.get(`${DHIS2_BASE_URL}/me`, {
            auth: { username, password }
        });
        res.json({ ok: true });
    } catch (err) {
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

/* =========================
   📦 FETCH GROUP SETS
========================= */
app.get('/api/dataElementGroupSets', async (req, res) => {
    try {
        const response = await axios.get(
            `${DHIS2_BASE_URL}/dataElementGroupSets`,
            {
                params: {
                    paging: false,
                    fields: 'id,displayName,attributeValues[attribute[id],value],dataElementGroups[id,displayName]'
                },
                auth: { username: USERNAME, password: PASSWORD }
            }
        );

        res.json(response.data.dataElementGroupSets);

    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: err.message });
    }
});
/* =========================
   📅 ETHIOPIAN CALENDAR CONVERTER
   Converts Gregorian date → Ethiopian year/month/day
========================= */
function gregorianToEthiopian(gYear, gMonth, gDay) {
    const ETHIOPIAN_MONTHS = [
        'Meskerem', 'Tikimt', 'Hidar', 'Tahsas',
        'Tir', 'Yekatit', 'Megabit', 'Miyaziya',
        'Ginbot', 'Sene', 'Hamle', 'Nehase', 'Pagume'
    ];

    // Julian Day Number for the Gregorian date
    const a = Math.floor((14 - gMonth) / 12);
    const y = gYear + 4800 - a;
    const m = gMonth + 12 * a - 3;
    const jdn = gDay + Math.floor((153 * m + 2) / 5) + 365 * y
        + Math.floor(y / 4) - Math.floor(y / 100)
        + Math.floor(y / 400) - 32045;

    // Ethiopian epoch JDN = 1724221 (Meskerem 1, 1 ET = August 29, 8 AD)
    const ethiopianEpoch = 1724221;
    const r = (jdn - ethiopianEpoch) % 1461;
    const n = (r % 365) + 365 * Math.floor(r / 1460);

    const eYear  = Math.floor((jdn - ethiopianEpoch) / 1461) * 4 + Math.floor(r / 365) - Math.floor(r / 1460);
    const eMonth = Math.floor(n / 30) + 1;
    const eDay   = (n % 30) + 1;

    return {
        year: eYear,
        month: eMonth,
        monthName: ETHIOPIAN_MONTHS[eMonth - 1] || 'Pagume',
        day: eDay
    };
}

/* =========================
   📅 BUILD ETHIOPIAN PERIOD NAME
   Matches IMP format: "HM-1 Hamle 2016" or "HM-2 Hamle 2016"
   HM-1 = days 1-15, HM-2 = days 16-end
========================= */
function buildEthiopianPeriodName(gregorianStartDate) {
    const [y, m, d] = gregorianStartDate.split('-').map(Number);
    const eth = gregorianToEthiopian(y, m, d);
    const half = eth.day <= 15 ? 'HM-1' : 'HM-2';
    return `${half} ${eth.monthName} ${eth.year}`;
}

/* =========================
   🔍 FIND PERIOD BY GREGORIAN DATE RANGE
   (with fallback to Ethiopian name matching)
========================= */
function findPeriodForActivity(distributions, gStart, gEnd) {
    // Strategy 1: exact Gregorian date match
    for (const dist of distributions) {
        if (isSameRange(dist.start_date, dist.end_date, gStart, gEnd)) {
            return dist;
        }
        if (dist.children) {
            const found = findPeriodForActivity(dist.children, gStart, gEnd);
            if (found) return found;
        }
    }

    // Strategy 2: match by Ethiopian period name derived from start date
    const ethName = buildEthiopianPeriodName(gStart);
    console.log(`🔍 Trying Ethiopian name match: "${ethName}"`);
    for (const dist of distributions) {
        if (dist.name === ethName) {
            return dist;
        }
        if (dist.children) {
            for (const child of dist.children) {
                if (child.name === ethName) return child;
            }
        }
    }

    return null;
}
function mapToStatus(value) {
    if (value === null || value === undefined || value === "") {
        return null; // 🚫 skip
    }

    const v = String(value).toLowerCase().replace(/\s+/g, '');  // strip spaces

    if (v === "1" || v === "true" || v === "complete") return "complete";
    if (v === "0" || v === "false" || v === "incomplete") return "Not Started";
    if (v === "in progress") return "in progress";

    return null; // unknown → skip
}

async function transformActivitiesPayload(data) {
    const dxIds = [...new Set(data.map(r => r.dx))];
    const ouKeys = [...new Set(data.map(r => r.ou))];

    const elements = await getDataElementDetails(dxIds);
    const orgUnits = await getOrgUnitDetails(ouKeys);

    const elMap = {};
    elements.forEach(e => elMap[e.id] = e);

    const ouMapById = {};
    orgUnits.forEach(o => ouMapById[o.id] = o);

    return data
        .map(row => {
            const el = elMap[row.dx];
            const ou = ouMapById[row.ou];

            if (!el || !ou) return null;

            const imp_id = getAttr(el.attributeValues, IMP_ID_ATTR);
            const implementing_unit = getAttr(ou.attributeValues, OU_IMP_ID_ATTR);

            if (!imp_id || !implementing_unit) return null;

            const status = mapToStatus(row.value);   // ✅ FIXED

            if (!status) return null;

            return {
                imp_id,                          // ✅ consistent
                implementing_unit,
                pe: row.pe,
                raw_value: status
            };
        })
        .filter(Boolean);
}
function isSameRange(aStart, aEnd, bStart, bEnd) {
    const a1 = new Date(aStart).getTime();
    const a2 = new Date(aEnd).getTime();
    const b1 = new Date(bStart).getTime();
    const b2 = new Date(bEnd).getTime();

    const tolerance = 24 * 60 * 60 * 1000; // 1 day

    return (
        Math.abs(a1 - b1) <= tolerance &&
        Math.abs(a2 - b2) <= tolerance
    );
}

function findPeriod(distributions, start, end) {
    for (const dist of distributions) {

        if (isSameRange(dist.start_date, dist.end_date, start, end)) {
            return dist;
        }

        if (dist.children) {
            const found = findPeriod(dist.children, start, end);
            if (found) return found;
        }
    }
    return null;
}
app.get('/api/config', (req, res) => {
    res.json({
        periodTypeAttributeId: process.env.PERIOD_TYPE_ATTRIBUTE_ID
    });
});

/* =========================
   📦 ORG UNITS
========================= */
app.get('/api/organisationUnits', async (req, res) => {
    try {
        const response = await axios.get(
            `${DHIS2_BASE_URL}/organisationUnits?paging=false&fields=id,displayName,attributeValues[attribute[id],value]`,
            {
                auth: {
                    username: USERNAME,
                    password: PASSWORD
                }
            }
        );

        const ATTR_ID = process.env.OU_IMP_ID_ATTRIBUTE_ID; 

        // ✅ FILTER ONLY ORG UNITS THAT HAVE IMP ID
        const filtered = response.data.organisationUnits
            .map(ou => {
                const attr = ou.attributeValues?.find(
                    a => a.attribute.id === ATTR_ID
                );

                if (!attr) return null;

                return {
                    id: ou.id,
                    displayName: ou.displayName,
                    imp_id: attr.value // useful later
                };
            })
            .filter(Boolean);

        res.json(filtered);

    } catch (err) {
        console.error("❌ OrgUnit error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

/* =========================
   📊 ANALYTICS
========================= */
app.get('/api/analytics', async (req, res) => {
    const { groupId, period, orgUnit ,groupSetId} = req.query;

    try {
        const coDimension =
            'lBnoNc1T39R:Mbq12GujYxI;kgXWhJFcw33;Ql3Sy6YjrSN;TLixouvYRPF;SAXhVtAwMEh;pKWpjLWZK0a;snD5u6yDER3';

        const url = `${DHIS2_BASE_URL}/analytics` +
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
                    obj[h.name] = value; // keep raw ID for processing
                    // ✅ Also store the display name separately
                    obj[`${h.name}Name`] = metaData.items[value]?.name || value;
                } else {
                    if (metaData.items[value]) {
                        value = metaData.items[value].name;
                    }
                    obj[h.name] = value;
                }
            });
        
            return obj;
        });

        res.json(table);

    } catch (err) {
        console.error("❌ Analytics error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

/* =========================
   🔍 FETCH DATA ELEMENT ATTRIBUTES
========================= */
async function getDataElementDetails(ids) {
    const url = `${DHIS2_BASE_URL}/dataElements?` +
        `filter=id:in:[${ids.join(',')}]&` +
        `fields=id,displayName,attributeValues[attribute[id],value]`;

    const res = await axios.get(url, {
        auth: { username: USERNAME, password: PASSWORD }
    });

    return res.data.dataElements;
}

/* =========================
   🔍 FETCH ORG UNIT ATTRIBUTES
========================= */
async function getOrgUnitDetails(ids) {
    const url = `${DHIS2_BASE_URL}/organisationUnits?` +
        `filter=id:in:[${ids.join(',')}]&` +
        `fields=id,displayName,attributeValues[attribute[id],value]`;

    const res = await axios.get(url, {
        auth: { username: USERNAME, password: PASSWORD }
    });

    return res.data.organisationUnits;
}

/* =========================
   🔧 ATTRIBUTE HELPER
========================= */
function getAttr(attrs, attrId) {
    const found = attrs?.find(a => a.attribute.id === attrId);
    return found ? found.value : null;
}
function parseBiweekPeriod(pe) {
    // Try underscore format first: "2024-07-08_2024-07-22"
    if (pe.includes('_')) {
        const [start, end] = pe.split('_');
        return { start, end };
    }

    // Try DHIS2 biweek display: "Bi-Week 1 2025-12-29 - 2026-01-11"
    const match = pe.match(/(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})/);
    if (match) {
        return { start: match[1], end: match[2] };
    }

    console.warn("⚠️ Unrecognised period format:", pe);
    return null;
}
/* =========================
   🔁 TRANSFORM DATA
========================= */
async function transformToPayload(data) {
    const dxIds = [...new Set(data.map(r => r.dx))];
    const ouKeys = [...new Set(data.map(r => r.ou))];

    const elements = await getDataElementDetails(dxIds);
    const orgUnits = await getOrgUnitDetails(ouKeys);

    const elMap = {};
    elements.forEach(e => { elMap[e.id] = e; });

    const ouMapById = {};
    const ouMapByName = {};
    orgUnits.forEach(o => {
        ouMapById[o.id] = o;
        ouMapByName[o.displayName] = o;
    });

    const grouped = {};

    data.forEach(row => {
        console.log("➡️ ROW:", row);

        if (!row) return;

        const isValid =
            row.co === "Physical-Actual" ||
            row.co === "Physical-Target" ||
            row.co === "default";

        if (!isValid) {
            console.log("⛔ Skipped CO:", row.co);
            return;
        }

        const el = elMap[row.dx];
        const ou = ouMapById[row.ou] || ouMapByName[row.ou];

        if (!el || !ou) {
            console.log("❌ Missing element or orgUnit:", row.dx, row.ou);
            return;
        }

        const imp_id       = getAttr(el.attributeValues, IMP_ID_ATTR);
        const measure_type = getAttr(el.attributeValues, MEASURE_TYPE_ATTR);
        const implementing_unit = getAttr(ou.attributeValues, OU_IMP_ID_ATTR);

        if (!imp_id || !measure_type || !implementing_unit) {
            console.log("❌ Missing attributes → skipping");
            return;
        }

        const key = `${row.pe}_${row.dx}`;

        if (!grouped[key]) {
            grouped[key] = {
                actual: 0,
                target: 0,
                imp_id,
                measure_type,
                implementing_unit,
                pe: row.pe,
                raw_value: row.value   // ← keep raw value for activity status
            };
        }

        const value = Number(row.value || 0);
        if (row.co === "Physical-Actual") grouped[key].actual += value;
        if (row.co === "Physical-Target") grouped[key].target += value;
    });

    return Object.values(grouped);
}

/* =========================
   🔗 IMP ENDPOINT ROUTER
========================= */
function getEndpoint(type) {
    switch (type) {
        case "project_goal":
            return "project-goal-measure-unit-distributions";
        case "project_outcome":
            return "project-outcome-measure-unit-distributions";
        case "project_output":
            return "project-output-measure-unit-distributions";
        case "program_goal":
            return "program-goal-measure-unit-distributions";
        case "program_outcome":
            return "program-outcome-measure-unit-distributions";
        case "program_output":
            return "program-output-measure-unit-distributions";
        case "strategic":
            return "strategic-measure-unit-distributions";
        case "activity":
            return "activities";
        default:
            throw new Error("Unknown type: " + type);
    }
}


/* =========================
   🔐 LOGIN
========================= */
async function getToken() {
    const res = await axios.post(
        `${process.env.IMP_BASE_URL}/auth/token/login/`,
        {
            email: process.env.IMP_EMAIL,
            password: process.env.IMP_PASSWORD
        }
    );

    return res.data.auth_token;
}

/* =========================
   🚀 PUSH DATA
========================= */
app.post('/api/pushData', async (req, res) => {
    try {
        const rawData = req.body;
        const items = await transformToPayload(rawData);

        if (!items.length) {
            return res.status(400).json({ error: "No valid data" });
        }

        const token = await getToken();

        const groupedByType = {};
        items.forEach(i => {
            if (!groupedByType[i.measure_type]) groupedByType[i.measure_type] = [];
            groupedByType[i.measure_type].push(i);
        });

        const results = [];

        for (const type in groupedByType) {

            // ✅ HANDLE ACTIVITIES SEPARATELY
            if (type === "activity") {
                console.log("🚀 Processing activities...");
        
                const activityResults = await pushActivityItems(groupedByType[type], token);
        
                results.push(...activityResults);
                successCount += activityResults.length;
        
                continue; // ⛔ skip the normal measure logic
            }
            const endpoint = getEndpoint(type);
            const baseUrl = `${process.env.IMP_BASE_URL}/${endpoint}`;
            const measureKey = `${type}_measure`;

            const existingRes = await axios.get(baseUrl, {
                headers: { Authorization: `Token ${token}` }
            });

            for (const item of groupedByType[type]) {
                const implementing_unit = Number(item.implementing_unit);
                const measureValue = Number(item.imp_id);

                // 🔍 Find matching existing record
                const existing = existingRes.data.find(r =>
                    Number(r.implementing_unit) === implementing_unit &&
                    Number(r[measureKey]) === measureValue
                );

                if (!existing) {
                    console.warn(`⚠️ No existing record found for type=${type}, imp_id=${item.imp_id}, unit=${item.implementing_unit}`);
                    results.push({ type, imp_id: item.imp_id, status: "not found" });
                    failureCount++;
                    continue;
                }

                // 📅 DHIS2 pe=2025 → EFY 2017 → start: 2024-07-08, end: 2025-07-07
                const targetStartDate = `${Number(item.pe) - 1}-07-08`;
                const targetEndDate   = `${item.pe}-07-07`;
                const efyYear = Number(item.pe) - 8;

                console.log(`📅 DHIS2 pe=${item.pe} → EFY ${efyYear}, start=${targetStartDate}, end=${targetEndDate}`);

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
                    console.log("📋 No period_distributions, building period from EFY dates");
                
                    const filteredFields = Object.fromEntries(
                        Object.entries(allFields).filter(([k, v]) => v !== null)
                    );
                
                    patchPayload = {
                        implementing_unit,
                        [measureKey]: measureValue,
                        period_distributions: [
                            {
                                name: `EFY ${efyYear}`,
                                start_date: targetStartDate,
                                end_date: targetEndDate,
                                period_frequency: "annually",
                                ...filteredFields
                            }
                        ]
                    };
                } else {
                    function findPeriod(distributions) {
                        for (const dist of distributions) {
                            if (dist.start_date === targetStartDate && dist.end_date === targetEndDate) {
                                return dist;
                            }
                            if (dist.children) {
                                const found = findPeriod(dist.children);
                                if (found) return found;
                            }
                        }
                        return null;
                    }

                    const matchedPeriod = findPeriod(existing.period_distributions);

                    if (!matchedPeriod) {
                        console.log(`➕ Creating new period for EFY ${efyYear}`);
                    
                        const filteredFields = Object.fromEntries(
                            Object.entries(allFields).filter(([k, v]) => v !== null)
                        );
                    
                        const newPeriod = {
                            name: `EFY ${efyYear}`,
                            start_date: targetStartDate,
                            end_date: targetEndDate,
                            period_frequency: "annually",
                            ...filteredFields
                        };
                    
                        patchPayload = {
                            implementing_unit,
                            [measureKey]: measureValue,
                            period_distributions: [
                                ...(existing.period_distributions || []),
                                newPeriod
                            ]
                        };
                    
                    } else {
                                            
                        const filteredFields = Object.fromEntries(
                            Object.entries(allFields).filter(([k, v]) => k in matchedPeriod && v !== null)
                        );
                    
                        const updatedPeriod = { ...matchedPeriod, ...filteredFields };
                    
                        function replacePeriod(distributions) {
                            return distributions.map(dist => {
                                if (dist.start_date === targetStartDate && dist.end_date === targetEndDate) {
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
                console.log(`📝 PATCHing [${type}] to:`, patchUrl);
                console.log("📦 Payload:", JSON.stringify(patchPayload, null, 2));

                await axios.patch(patchUrl, patchPayload, {
                    headers: {
                        Authorization: `Token ${token}`,
                        'Content-Type': 'application/json'
                    },
                    maxRedirects: 0
                });

                console.log(`✅ Patched [${type}] id=${existing.id}`);

                // 2️⃣ Approval request
                const approvalUrl = `${baseUrl}/${existing.id}/approval-request/`;
                console.log(`📤 Approval for [${type}]:`, approvalUrl);
                successCount++;
                const approvalResponse = await axios.put(
                    approvalUrl,
                    { comments: "Auto-submitted from DHIS2 integration" },
                    {
                        headers: {
                            Authorization: `Token ${token}`,
                            'Content-Type': 'application/json'
                        },
                        maxRedirects: 0
                    }
                );

                results.push({
                    type,
                    imp_id: item.imp_id,
                    recordId: existing.id,
                    status: "✅ patched + approved",
                    approval: approvalResponse.data
                });
            }
        }

        if (successCount === 0) {
            return res.status(400).json({
                error: "No records were updated. All items failed or were not found.",
                results
            });
        }
        
        if (failureCount > 0) {
            return res.status(207).json({   // 207 = partial success
                message: "⚠️ Partial success",
                successCount,
                failureCount,
                results
            });
        }
        
        res.json({
            message: "✅ All records updated successfully",
            successCount,
            results
        });
    } catch (err) {
        console.error("❌ Push error:", err.response?.data || err.message);
        res.status(500).json({ error: err.response?.data || err.message });
    }
});
async function pushActivityItems(items, token) {
    const baseUrl = `${process.env.IMP_BASE_URL}/activity-unit-distributions`;
    const activitiesUrl = `${process.env.IMP_BASE_URL}/activities`;

    const activitiesRes = await axios.get(activitiesUrl, {
        headers: { Authorization: `Token ${token}` }
    });

    const activities = activitiesRes.data;
    const results = [];

    for (const item of items) {
        console.log("➡️ Activity item:", item);

        // 1️⃣ Parse period
        const range = parseBiweekPeriod(item.pe);
        if (!range) {
            console.warn(`⚠️ Invalid period: ${item.pe}`);
            results.push({ activity: item.imp_id, result: "invalid period" });
            continue;
        }

        const { start, end } = range;

        // 2️⃣ Find activity by imp_id
        const activity = activities.find(
            a => Number(a.id) === Number(item.imp_id)
        );

        if (!activity) {
            console.warn(`⚠️ Activity not found: imp_id=${item.imp_id}`);
            results.push({ activity: item.imp_id, result: "activity not found" });
            continue;
        }

        console.log(`✅ Found activity id=${activity.id}`);

        // 3️⃣ Find unit distribution by implementing_unit
        const unitDist = activity.unit_distributions?.find(
            u => Number(u.implementing_unit) === Number(item.implementing_unit)
        );

        if (!unitDist) {
            console.warn(`⚠️ Unit distribution not found — activity=${activity.id}, unit=${item.implementing_unit}`);
            results.push({
                activity: item.imp_id,
                unit: item.implementing_unit,
                result: "unit distribution not found"
            });
            continue;
        }

        console.log(`✅ Found unit distribution id=${unitDist.id}`);

        // 4️⃣ Map status
        const status = mapToStatus(item.raw_value);

        if (!status) {
            console.warn(`⚠️ Invalid status value: ${item.raw_value}`);
            results.push({ activity: item.imp_id, result: "invalid status" });
            continue;
        }

        // 5️⃣ Build updated period_distributions
        let periods = Array.isArray(unitDist.period_distributions)
            ? [...unitDist.period_distributions]
            : [];

        const matchedIndex = periods.findIndex(
            p => p.start_date === start && p.end_date === end
        );

        if (matchedIndex === -1) {
            console.log(`➕ No matching period found, creating new: ${start} → ${end}`);
            periods.push({
                name: `${start} - ${end}`,
                start_date: start,
                end_date: end,
                status
            });
        } else {
            console.log(`✏️ Updating existing period: ${start} → ${end}`);
            periods[matchedIndex] = {
                ...periods[matchedIndex],
                status
            };
        }

        // 6️⃣ PATCH unit distribution
        const patchUrl = `${baseUrl}/${unitDist.id}/`;
        console.log(`📝 PATCHing activity unit distribution: ${patchUrl}`);
        console.log("📦 Payload:", JSON.stringify({ period_distributions: periods }, null, 2));

        try {
            await axios.patch(
                patchUrl,
                { period_distributions: periods },
                {
                    headers: {
                        Authorization: `Token ${token}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            console.log(`✅ PATCH success for unit distribution id=${unitDist.id}`);
        } catch (patchErr) {
            console.error(`❌ PATCH failed for unit distribution id=${unitDist.id}:`, patchErr.response?.data || patchErr.message);
            results.push({
                activity: activity.id,
                unit: item.implementing_unit,
                period: `${start} → ${end}`,
                result: "❌ patch failed",
                error: patchErr.response?.data || patchErr.message
            });
            continue;
        }

        // 7️⃣ POST approval request
        const activityApprovalUrl = `${baseUrl}/${unitDist.id}/approval-request/`;
        console.log(`📤 Posting approval request: ${activityApprovalUrl}`);

        try {
            await axios.post(
                activityApprovalUrl,
                { comments: "Auto-submitted from DHIS2 integration" },
                {
                    headers: {
                        Authorization: `Token ${token}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            console.log(`✅ Approval request sent for unit distribution id=${unitDist.id}`);
        } catch (approvalErr) {
            console.error(`❌ Approval failed for unit distribution id=${unitDist.id}:`, approvalErr.response?.data || approvalErr.message);
            results.push({
                activity: activity.id,
                unit: item.implementing_unit,
                period: `${start} → ${end}`,
                status,
                result: "⚠️ patched but approval failed",
                error: approvalErr.response?.data || approvalErr.message
            });
            continue;
        }

        // 8️⃣ Success
        results.push({
            activity: activity.id,
            unitDistributionId: unitDist.id,
            unit: item.implementing_unit,
            period: `${start} → ${end}`,
            status,
            result: "✅ patched + approval requested"
        });
    }

    return results;
}
/* =========================
   🚀 START SERVER
========================= */
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});