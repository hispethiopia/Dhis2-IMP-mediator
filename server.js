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

        // 🔁 Group by measure type
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

            // 🔍 Fetch all existing records for this type once
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
                    continue;
                }

                // 1️⃣ PATCH data
                const patchUrl = `${baseUrl}/${existing.id}`;
                const patchPayload = {
                    implementing_unit,
                    [measureKey]: measureValue,
                    period_distributions: [
                        {
                            name: `EFY ${Number(item.pe) - 7}`,
                            start_date: `${item.pe}-07-08`,
                            end_date: `${Number(item.pe) + 1}-07-07`,
                            actual: item.actual,
                            target: item.target,
                            period_frequency: "annually"
                        }
                    ]
                };

                console.log(`📝 PATCHing [${type}] to:`, patchUrl);
                console.log("📦 Payload:", patchPayload);

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

        res.json({ message: "✅ All done", results });

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