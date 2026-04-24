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

/* =========================
   🔁 TRANSFORM DATA
========================= */
async function transformToPayload(data) {

    const dxIds = [...new Set(data.map(r => r.dx))];
    const ouKeys = [...new Set(data.map(r => r.ou))];

    const elements = await getDataElementDetails(dxIds);
    const orgUnits = await getOrgUnitDetails(ouKeys);

    const elMap = {};
    elements.forEach(e => {
        elMap[e.id] = e;
    });

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
            row.co === "Physical-Target";

        if (!isValid) {
            console.log("⛔ Skipped CO:", row.co);
            return;
        }

        const el = elMap[row.dx];

        // ✅ FIX: try BOTH id and name for org unit
        const ou =
            ouMapById[row.ou] ||
            ouMapByName[row.ou];

        if (!el) {
            console.log("❌ Missing element:", row.dx);
            return;
        }

        if (!ou) {
            console.log("❌ Missing orgUnit:", row.ou);
            return;
        }

        const imp_id = getAttr(el.attributeValues, IMP_ID_ATTR);
        const measure_type = getAttr(el.attributeValues, MEASURE_TYPE_ATTR);
        const implementing_unit = getAttr(ou.attributeValues, OU_IMP_ID_ATTR);
        console.log("🔑 IMP_ID_ATTR:", IMP_ID_ATTR)
        console.log("🧩 ATTRS:", {
            imp_id,
            measure_type,
            implementing_unit
        });

        if (!imp_id || !measure_type || !implementing_unit) {
            console.log("❌ Missing attributes → skipping row");
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
                pe: row.pe
            };
        }

        const value = Number(row.value || 0);

        if (row.co === "Physical-Actual") {
            grouped[key].actual += value;
        }

        if (row.co === "Physical-Target") {
            grouped[key].target += value;
        }

        console.log("📦 GROUP:", grouped[key]);
    });

    console.log("✅ FINAL GROUPED DATA:", grouped);

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
                    // ✅ CASE 1: No nested periods — wrap in period_distributions using EFY dates
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
                    // ✅ CASE 2: Has nested period_distributions — find and update matching period
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
                        console.warn(`⚠️ No matching period for pe=${item.pe} → EFY ${efyYear}, start=${targetStartDate}, end=${targetEndDate}`);
                        console.log("📋 Available periods:", existing.period_distributions.map(d => ({
                            name: d.name,
                            start: d.start_date,
                            end: d.end_date
                        })));
                        results.push({ type, imp_id: item.imp_id, status: "period not found" });
                        failureCount++;
                        continue;
                    }

                    console.log(`✅ Matched period: ${matchedPeriod.name}`);

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
/* =========================
   🚀 START SERVER
========================= */
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});